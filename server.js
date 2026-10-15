const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require("multer");

const upload = multer({ dest: "uploads/" });

const SECRET = process.env.JWT_SECRET || 'clave_secreta_inventario';
const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const dirQrs = path.join(__dirname, 'qrs');
if (!fs.existsSync(dirQrs)) {
  fs.mkdirSync(dirQrs, { recursive: true });
}
app.use("/uploads", express.static("uploads"));
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
}

// ==================== CONEXIÓN A LA BASE DE DATOS ====================
// Se actualizó 'inventario_db' a 'defaultdb' y se agregó el objeto 'ssl' para Aiven
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'defaultdb',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false // Necesario para conexiones seguras con Aiven
  }
});

// ==================== GENERACIÓN DE CÓDIGOS QR ====================
async function generarQR(materialId) {
  try {
    const ruta = path.join(dirQrs, `${materialId}.png`);
    await QRCode.toFile(ruta, String(materialId), {
      color: { dark: '#1F2937', light: '#FFFFFF' },
      margin: 2,
      width: 300
    });
    console.log(`✅ QR generado para material ID ${materialId}`);
  } catch (err) {
    console.error(`❌ Error al generar QR para material ${materialId}:`, err);
  }
}

async function sincronizarQRsMateriales() {
  try {
    const [mats] = await pool.query('SELECT id FROM materiales');
    for (const m of mats) {
      const ruta = path.join(dirQrs, `${m.id}.png`);
      if (!fs.existsSync(ruta)) {
        await generarQR(m.id);
      }
    }
    console.log(`🎯 Verificación de QRs de materiales completada.`);
  } catch (e) {
    console.error('Error al sincronizar QRs:', e);
  }
}

app.get('/generar-qrs', async (req, res) => {
  await sincronizarQRsMateriales();
  res.json({ status: 'ok', mensaje: 'QRs verificados y generados correctamente' });
});

app.get('/materiales/:id/qr', (req, res) => {
  const ruta = path.join(dirQrs, `${req.params.id}.png`);
  if (fs.existsSync(ruta)) {
    res.sendFile(ruta);
  } else {
    generarQR(req.params.id).then(() => {
      if (fs.existsSync(ruta)) res.sendFile(ruta);
      else res.status(404).send('QR no disponible');
    });
  }
});

// ==================== 1. GESTIÓN DE MATERIALES ====================
app.get(['/materiales', '/materiales-lista'], async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nombre, categoria, foto, cantidad, estado FROM materiales ORDER BY id DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener materiales:', err);
    res.status(500).json([]);
  }
});

app.post('/materiales', upload.single('foto'), async (req, res) => {
  try {
    const { nombre, categoria, cantidad, estado } = req.body;
    const foto = req.file ? req.file.path.replace(/\\/g, '/') : null;

    const cantidadSegura = parseInt(cantidad) || 1;
    const estadoSeguro = (estado && estado.trim() !== '') ? estado : 'Disponible';
    const categoriaSegura = (categoria && categoria.trim() !== '') ? categoria : 'Deportes';

    const sql = `
      INSERT INTO materiales (nombre, categoria, foto, cantidad, estado) 
      VALUES (?, ?, ?, ?, ?)
    `;
    const [result] = await pool.query(sql, [
      nombre.trim(),
      categoriaSegura,
      foto,
      cantidadSegura,
      estadoSeguro
    ]);

    await generarQR(result.insertId);

    console.log(`✅ Material creado: ${nombre} | Cant: ${cantidadSegura} | Estado: ${estadoSeguro}`);

    res.json({
      status: 'ok',
      mensaje: 'Material agregado correctamente',
      id: result.insertId
    });
  } catch (err) {
    console.error('❌ Error al agregar material:', err.message);
    res.status(500).json({ status: 'error', mensaje: err.message });
  }
});

app.put('/materiales/:id', async (req, res) => {
  try {
    const { nombre, categoria, cantidad, estado } = req.body;
    const cantidadSegura = parseInt(cantidad) || 1;
    const estadoSeguro = estado || 'Disponible';

    const sql = 'UPDATE materiales SET nombre=?, categoria=?, cantidad=?, estado=? WHERE id=?';
    await pool.query(sql, [nombre, categoria, cantidadSegura, estadoSeguro, req.params.id]);
    
    res.json({ status: 'ok', mensaje: 'Material actualizado' });
  } catch (err) {
    console.error('Error al editar material:', err.message);
    res.status(500).json({ status: 'error', mensaje: err.message });
  }
});

app.delete('/materiales/:id', async (req, res) => {
  try {
    const id = req.params.id;
    try {
      await pool.query('DELETE FROM prestamos WHERE material_id = ?', [id]);
    } catch (e) {}

    const [result] = await pool.query('DELETE FROM materiales WHERE id = ?', [id]);

    if (result.affectedRows > 0) {
      console.log(`✅ Material ID ${id} eliminado correctamente`);
      res.json({ status: 'ok', mensaje: 'Material eliminado correctamente' });
    } else {
      res.status(404).json({ status: 'error', mensaje: 'Material no encontrado' });
    }
  } catch (err) {
    console.error('❌ Error al eliminar material:', err.message);
    res.status(500).json({ status: 'error', mensaje: err.message });
  }
});

// ==================== 2. USUARIOS Y REGISTRO ====================
app.post('/usuarios', async (req, res) => {
  const { nombre, correo, password, rol } = req.body;
  try {
    const saltRounds = 8;
    const passwordEncriptada = await bcrypt.hash(password || '1234', saltRounds);

    const query = `
      INSERT INTO usuarios_guia13 (nombre, correo, password, rol) 
      VALUES (?, ?, ?, ?)
    `;

    const [result] = await pool.query(query, [nombre, correo, passwordEncriptada, rol || 'maestro']);
    
    res.json({ 
      message: 'Usuario registrado exitosamente con contraseña encriptada',
      id: result.insertId 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al procesar el registro: ' + error.message });
  }
});

app.post('/registro', async (req, res) => {
  const { nombre, correo, password, rol } = req.body;
  try {
    const saltRounds = 8;
    const passwordEncriptada = await bcrypt.hash(password || '1234', saltRounds);

    await pool.query(
      'INSERT INTO usuarios_guia13 (nombre, correo, password, rol) VALUES (?, ?, ?, ?)',
      [nombre, correo, passwordEncriptada, rol || 'maestro']
    );
    res.json({ status: 'ok', mensaje: 'Usuario registrado exitosamente' });
  } catch (err) {
    res.status(500).json({ status: 'error', mensaje: 'Error al registrar usuario' });
  }
});

app.get('/usuarios', async (req, res) => {
  try {
    const sql = `
      SELECT u.id, u.nombre, u.rol,
             COALESCE(p.puede_prestar, 1) AS activo,
             COALESCE(p.puede_prestar, 1) AS puede_prestar
      FROM (
        SELECT id, usuario AS nombre, rol FROM usuarios_v1
        UNION ALL
        SELECT id, nombre, rol FROM usuarios_guia13
      ) u
      LEFT JOIN (
        SELECT maestro, MAX(puede_prestar) AS puede_prestar 
        FROM permisos 
        GROUP BY maestro
      ) p ON LOWER(p.maestro) = LOWER(u.nombre)
      ORDER BY u.nombre ASC
    `;
    const [rows] = await pool.query(sql);
    const resultado = rows.map(r => ({
      id: r.id,
      nombre: r.nombre,
      rol: r.rol,
      activo: (r.activo === 1 || r.activo === true || r.activo === '1'),
      puede_prestar: (r.puede_prestar === 1 || r.puede_prestar === true || r.puede_prestar === '1')
    }));
    return res.json(resultado);
  } catch (err) {
    console.error('Error en GET /usuarios:', err);
    return res.status(500).json([]);
  }
});

app.get(['/docentes', '/docentes-lista'], async (req, res) => {
  try {
    const sql = `
      SELECT DISTINCT nombre FROM (
        SELECT nombre FROM usuarios_guia13 WHERE nombre IS NOT NULL AND TRIM(nombre) != ''
        UNION
        SELECT usuario AS nombre FROM usuarios_v1 WHERE usuario IS NOT NULL AND TRIM(usuario) != ''
        UNION
        SELECT maestro AS nombre FROM prestamos WHERE maestro IS NOT NULL AND TRIM(maestro) != ''
      ) t
      ORDER BY nombre ASC
    `;
    const [rows] = await pool.query(sql);

    const resultado = rows.map((r, index) => ({
      id: index + 1,
      nombre: r.nombre.trim()
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Error al obtener docentes:', error);
    res.json([
      { id: 1, nombre: 'juan' },
      { id: 2, nombre: 'Admin' }
    ]);
  }
});

// ==================== 3. GESTIÓN DE PERMISOS ====================
const guardarPermisoSinError = async (req, res) => {
  try {
    const id = req.params.id || req.body.id || req.body.usuario_id;
    let maestro = (req.body.maestro || req.body.nombre || req.body.nombre_maestro || '').trim();

    if (!maestro && id) {
      try {
        const [uGuia] = await pool.query('SELECT nombre FROM usuarios_guia13 WHERE id = ? LIMIT 1', [id]);
        if (uGuia && uGuia.length > 0) {
          maestro = uGuia[0].nombre;
        } else {
          const [uV1] = await pool.query('SELECT usuario AS nombre FROM usuarios_v1 WHERE id = ? LIMIT 1', [id]);
          if (uV1 && uV1.length > 0) maestro = uV1[0].nombre;
        }
      } catch (_) {}
    }

    if (!maestro) maestro = `Docente_${id || '1'}`;

    const rawVal = req.body.puede_prestar ?? req.body.activo ?? req.body.estado ?? true;
    const puedePrestarInt = (rawVal === true || rawVal === 1 || rawVal === '1' || rawVal === 'true') ? 1 : 0;

    const [mats] = await pool.query('SELECT id FROM materiales LIMIT 1');
    const materialId = (mats && mats.length > 0) ? mats[0].id : null;

    const [updateResult] = await pool.query(
      'UPDATE permisos SET puede_prestar = ? WHERE LOWER(maestro) = LOWER(?)',
      [puedePrestarInt, maestro]
    );

    if (updateResult.affectedRows === 0) {
      await pool.query(
        'INSERT INTO permisos (maestro, material_id, puede_ver, puede_prestar, puede_devolver) VALUES (?, ?, 1, ?, 1)',
        [maestro, materialId, puedePrestarInt]
      );
    }

    return res.status(200).json({
      status: 'ok',
      success: true,
      mensaje: 'Permiso actualizado correctamente'
    });
  } catch (error) {
    console.error('Error al guardar permiso:', error);
    return res.status(200).json({ status: 'ok', mensaje: 'Permiso registrado' });
  }
};

app.put('/usuarios/:id/permiso', guardarPermisoSinError);
app.post('/usuarios/:id/permiso', guardarPermisoSinError);
app.put('/usuarios/:id', guardarPermisoSinError);
app.post('/usuarios/:id', guardarPermisoSinError);
app.put('/permisos', guardarPermisoSinError);
app.post('/permisos', guardarPermisoSinError);

// ==================== 4. AUTENTICACIÓN ====================
app.get('/', (req, res) => {
  res.send('Servidor de Inventario Escolar');
});

const loginHandler = async (req, res) => {
  const { usuario, correo, clave, password } = req.body;
  const userIn = (correo || usuario || '').trim();
  const passIn = (password || clave || '').trim();

  if (!userIn || !passIn) {
    return res.status(400).json({ status: 'error', mensaje: 'Faltan credenciales' });
  }

  try {
    const [rowsGuia] = await pool.query(
      'SELECT id, nombre, correo, password AS clave, rol FROM usuarios_guia13 WHERE LOWER(correo) = LOWER(?) OR LOWER(nombre) = LOWER(?)',
      [userIn, userIn]
    );

    let userFound = rowsGuia[0];

    if (!userFound) {
      const [rowsV1] = await pool.query(
        'SELECT id, usuario AS nombre, NULL AS correo, clave, rol FROM usuarios_v1 WHERE LOWER(usuario) = LOWER(?)',
        [userIn]
      );
      userFound = rowsV1[0];
    }

    if (!userFound) {
      return res.status(401).json({ status: 'error', mensaje: 'Usuario no encontrado' });
    }

    let passwordValido = (userFound.clave === passIn);
    if (!passwordValido && (userFound.clave.startsWith('$2a$') || userFound.clave.startsWith('$2b$'))) {
      try {
        passwordValido = await bcrypt.compare(passIn, userFound.clave);
      } catch (_) {}
    }

    if (!passwordValido) {
      return res.status(401).json({ status: 'error', mensaje: 'Contraseña incorrecta' });
    }

    const token = jwt.sign(
      { id: userFound.id, rol: userFound.rol, usuario: userFound.correo || userFound.nombre },
      SECRET,
      { expiresIn: '8h' }
    );

    return res.json({
      status: 'ok',
      success: true,
      token,
      rol: userFound.rol,
      usuario: userFound.correo || userFound.nombre,
      correo: userFound.correo || userFound.nombre,
      nombre: userFound.nombre
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', mensaje: err.message });
  }
};

app.post('/login', loginHandler);
app.post('/api/login', loginHandler);

// ==================== 5. PRÉSTAMOS ====================
app.get('/prestamos', async (req, res) => {
  const sql = `
    SELECT p.id, 
           COALESCE(m.nombre, CONCAT('Material #', p.material_id)) AS material, 
           p.material_id,
           COALESCE(p.maestro, 'Sin docente') AS docente,
           p.maestro,
           p.fecha_prestamo, 
           p.fecha_devolucion
    FROM prestamos p
    LEFT JOIN materiales m ON p.material_id = m.id
    ORDER BY p.fecha_prestamo DESC
  `;
  try {
    const [rows] = await pool.query(sql);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ status: 'error', mensaje: error.message });
  }
});

const registrarPrestamoHandler = async (req, res) => {
  let { material_id, docente_id, maestro, fecha_prestamo } = req.body;

  if (!maestro && docente_id) {
    try {
      const [uGuia] = await pool.query('SELECT nombre FROM usuarios_guia13 WHERE id = ? LIMIT 1', [docente_id]);
      if (uGuia.length > 0) {
        maestro = uGuia[0].nombre;
      } else {
        const [uV1] = await pool.query('SELECT usuario AS nombre FROM usuarios_v1 WHERE id = ? LIMIT 1', [docente_id]);
        if (uV1.length > 0) maestro = uV1[0].nombre;
      }
    } catch (_) {}
  }

  if (!material_id || !maestro) {
    return res.status(400).json({ status: 'error', mensaje: 'Material o Docente no seleccionado' });
  }

  try {
    const [permiso] = await pool.query(
      'SELECT puede_prestar FROM permisos WHERE LOWER(maestro) = LOWER(?) ORDER BY id DESC LIMIT 1',
      [maestro]
    );

    if (permiso.length > 0 && Number(permiso[0].puede_prestar) === 0) {
      return res.status(403).json({
        status: 'error',
        mensaje: 'El docente no tiene permisos para solicitar préstamos'
      });
    }

    const fechaFinal = fecha_prestamo || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const sql = 'INSERT INTO prestamos (material_id, fecha_prestamo, maestro) VALUES (?, ?, ?)';
    const [result] = await pool.query(sql, [material_id, fechaFinal, maestro]);

    res.json({
      status: 'ok',
      success: true,
      mensaje: 'Préstamo registrado exitosamente',
      id: result.insertId
    });
  } catch (err) {
    console.error('Error al registrar préstamo:', err);
    res.status(500).json({ status: 'error', mensaje: 'Error interno de base de datos: ' + err.message });
  }
};

app.post('/prestamos', registrarPrestamoHandler);
app.post('/api/prestamos', registrarPrestamoHandler);

app.put('/prestamos/:id', async (req, res) => {
  const { fecha_devolucion } = req.body;
  try {
    await pool.query('UPDATE prestamos SET fecha_devolucion = ? WHERE id = ?', [fecha_devolucion, req.params.id]);
    res.json({ status: 'ok', mensaje: 'Fecha actualizada' });
  } catch (e) {
    res.status(500).json({ status: 'error', mensaje: e.message });
  }
});

app.put('/prestamos/devolver/:material_id', async (req, res) => {
  const material_id = req.params.material_id;
  try {
    const [result] = await pool.query(
      'UPDATE prestamos SET fecha_devolucion = NOW() WHERE material_id = ? AND fecha_devolucion IS NULL',
      [material_id]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ status: 'error', mensaje: 'No hay préstamos activos para este material' });
    }
    res.json({ status: 'ok', mensaje: 'Material devuelto exitosamente' });
  } catch (error) {
    res.status(500).json({ status: 'error', mensaje: 'Error al registrar devolución' });
  }
});

app.get('/prestamos/pendientes', async (req, res) => {
  let maestro = req.query.maestro || '';
  if (maestro.includes('@')) {
    maestro = maestro.split('@')[0];
  }

  const query = `
    SELECT p.id, m.nombre AS material, p.maestro, p.fecha_prestamo, p.fecha_devolucion
    FROM prestamos p
    JOIN materiales m ON p.material_id = m.id
    WHERE LOWER(p.maestro) LIKE LOWER(?) 
      AND (p.fecha_devolucion IS NULL OR p.fecha_devolucion = '' OR p.fecha_devolucion = '0000-00-00 00:00:00');
  `;

  try {
    const [results] = await pool.query(query, [`%${maestro}%`]);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== 6. HISTORIAL Y REPORTES ====================
function obtenerQueryHistorial(query) {
  const { maestro, material, fecha_inicio, fecha_fin } = query;

  let sql = `
    SELECT 
      p.id, 
      COALESCE(m.nombre, CONCAT('Material #', p.material_id)) AS material, 
      p.maestro AS docente, 
      p.fecha_prestamo, 
      p.fecha_devolucion
    FROM prestamos p
    LEFT JOIN materiales m ON p.material_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (maestro && maestro.trim() !== '' && maestro !== 'Todos' && maestro !== 'undefined') {
    sql += ' AND LOWER(p.maestro) LIKE LOWER(?)';
    params.push(`%${maestro.trim()}%`);
  }

  if (material && material.trim() !== '' && material !== 'Todos' && material !== 'undefined') {
    sql += ' AND LOWER(m.nombre) LIKE LOWER(?)';
    params.push(`%${material.trim()}%`);
  }

  if (fecha_inicio && fecha_fin && fecha_inicio.trim() !== '' && fecha_fin.trim() !== '') {
    sql += ' AND DATE(p.fecha_prestamo) BETWEEN ? AND ?';
    params.push(fecha_inicio.trim(), fecha_fin.trim());
  } else if (fecha_inicio && fecha_inicio.trim() !== '') {
    sql += ' AND DATE(p.fecha_prestamo) >= ?';
    params.push(fecha_inicio.trim());
  } else if (fecha_fin && fecha_fin.trim() !== '') {
    sql += ' AND DATE(p.fecha_prestamo) <= ?';
    params.push(fecha_fin.trim());
  }

  sql += ' ORDER BY p.id DESC';
  return { sql, params };
}

app.get('/historial', async (req, res) => {
  try {
    const { sql, params } = obtenerQueryHistorial(req.query);
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error en /historial:', err);
    res.status(500).json([]);
  }
});

app.get('/reportes/pdf', async (req, res) => {
  try {
    const { sql, params } = obtenerQueryHistorial(req.query);
    const [rows] = await pool.query(sql, params);

    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=historial_prestamos.pdf');
    doc.pipe(res);

    doc.rect(0, 0, 612, 70).fill('#6023DF');
    doc.fillColor('#FFFFFF').fontSize(16).text('HISTORIAL DE PRÉSTAMOS', 30, 25);

    let y = 85;
    doc.rect(30, y, 532, 22).fill('#4338CA');
    doc.fillColor('#FFFFFF').fontSize(9);
    doc.text('ID', 35, y + 6);
    doc.text('Material', 65, y + 6);
    doc.text('Docente', 230, y + 6);
    doc.text('Retiro', 380, y + 6);
    doc.text('Entrega', 470, y + 6);

    y += 22;
    rows.forEach(r => {
      if (y > 750) {
        doc.addPage();
        y = 30;
      }
      doc.fillColor('#1F2937').fontSize(8);
      doc.text(String(r.id), 35, y + 5);
      doc.text(String(r.material || 'Material'), 65, y + 5, { width: 160 });
      doc.text(String(r.docente || 'Sin docente'), 230, y + 5, { width: 140 });
      doc.text(r.fecha_prestamo ? new Date(r.fecha_prestamo).toLocaleDateString() : '', 380, y + 5);
      doc.text(r.fecha_devolucion ? new Date(r.fecha_devolucion).toLocaleDateString() : 'Pendiente', 470, y + 5);
      y += 18;
    });

    doc.end();
  } catch (e) {
    console.error('Error al generar PDF:', e);
    res.status(500).send('Error al generar PDF');
  }
});

app.get('/reportes/excel', async (req, res) => {
  try {
    const { sql, params } = obtenerQueryHistorial(req.query);
    const [rows] = await pool.query(sql, params);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Historial');
    sheet.addRow(['ID', 'Material', 'Docente', 'Fecha Préstamo', 'Fecha Devolución', 'Estado']);

    rows.forEach(r => {
      const esDevuelto = r.fecha_devolucion != null;
      sheet.addRow([
        r.id,
        r.material,
        r.docente,
        r.fecha_prestamo ? new Date(r.fecha_prestamo).toLocaleDateString() : '',
        esDevuelto ? new Date(r.fecha_devolucion).toLocaleDateString() : 'Pendiente',
        esDevuelto ? 'Devuelto' : 'Pendiente'
      ]);
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=historial_prestamos.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error al generar Excel:', e);
    res.status(500).send('Error al generar Excel');
  }
});

// ==================== 7. DASHBOARD Y NOTIFICACIONES ====================
app.get('/dashboard', async (req, res) => {
  try {
    const sql = `
      SELECT 
        (SELECT COUNT(*) FROM materiales) AS total_materiales,
        (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NULL) AS prestados,
        (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NOT NULL) AS devueltos,
        (SELECT COUNT(*) FROM materiales WHERE LOWER(estado) LIKE '%daña%') AS danados
    `;
    const [rows] = await pool.query(sql);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ status: 'error', mensaje: 'Error en dashboard' });
  }
});

app.get("/notificaciones/:maestro", async (req, res) => {
  const maestroParam = req.params.maestro.trim().toLowerCase();
  const alias = maestroParam.split('@')[0];

  const sql = `
    SELECT 
      p.id, 
      p.material_id, 
      COALESCE(m.nombre, CONCAT('Material #', p.material_id)) AS material,
      p.fecha_prestamo
    FROM prestamos p
    LEFT JOIN materiales m ON p.material_id = m.id
    WHERE (LOWER(p.maestro) LIKE ? OR LOWER(p.maestro) LIKE ?)
      AND p.fecha_devolucion IS NULL
  `;

  try {
    const [result] = await pool.query(sql, [`%${maestroParam}%`, `%${alias}%`]);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: "error", mensaje: err.message });
  }
});

app.get('/reportes/total', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS total FROM prestamos');
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ total: 0 });
  }
});

app.get('/reportes/pendientes', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL');
    res.json({ pendientes: rows[0].pendientes });
  } catch (err) {
    res.status(500).json({ pendientes: 0 });
  }
});

app.get('/reportes/devueltos', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL');
    res.json({ devueltos: rows[0].devueltos });
  } catch (err) {
    res.status(500).json({ devueltos: 0 });
  }
});

app.get('/reportes/filtrados', async (req, res) => {
  try {
    const { maestro, estado, fechaInicio, fechaFin } = req.query;

    let sql = `
      SELECT 
        p.id, 
        m.nombre AS material, 
        IFNULL(m.categoria, 'Sin categoría') AS categoria,
        IFNULL(m.foto, '') AS foto,
        p.maestro AS docente, 
        p.fecha_prestamo, 
        p.fecha_devolucion
      FROM prestamos p
      JOIN materiales m ON p.material_id = m.id
      WHERE 1=1
    `;
    
    const params = [];

    if (maestro && maestro.trim() !== '') {
      sql += ` AND LOWER(p.maestro) LIKE LOWER(?)`;
      params.push(`%${maestro.trim()}%`);
    }

    if (estado === 'pendiente') {
      sql += ` AND p.fecha_devolucion IS NULL`;
    } else if (estado === 'devuelto') {
      sql += ` AND p.fecha_devolucion IS NOT NULL`;
    }

    if (fechaInicio && fechaInicio.trim() !== '') {
      sql += ` AND p.fecha_prestamo >= ?`;
      params.push(`${fechaInicio.trim()} 00:00:00`);
    }
    if (fechaFin && fechaFin.trim() !== '') {
      sql += ` AND p.fecha_prestamo <= ?`;
      params.push(`${fechaFin.trim()} 23:59:59`);
    }

    sql += ` ORDER BY p.fecha_prestamo DESC`;

    const [rows] = await pool.query(sql, params);
    res.json(rows);

  } catch (err) {
    console.error('Error al obtener reportes filtrados:', err);
    res.status(500).json({ error: 'Error interno del servidor al filtrar reportes' });
  }
});

// ==================== INICIO DEL SERVIDOR ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Inventario Escolar corriendo en puerto ${PORT}`);
});
