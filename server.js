const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ====== Configuración del taller (edítala aquí) ======
const PORT = process.env.PORT || 3000;
const ZONA_HORARIA = 'America/Santiago';
const MAX_DIAS_ADELANTE = 60;        // hasta cuántos días en el futuro se puede reservar

// Horario por día de la semana (0 = domingo ... 6 = sábado). Omite un día para dejarlo cerrado.
// Cada bloque dura 1 hora: inicio 9 y fin 18 => 09:00, 10:00, ... 17:00
const HORARIOS = {
  1: { inicio: 9, fin: 18 },
  2: { inicio: 9, fin: 18 },
  3: { inicio: 9, fin: 18 },
  4: { inicio: 9, fin: 18 },
  5: { inicio: 9, fin: 18 },
  6: { inicio: 9, fin: 13 }
};
const ALMUERZO = { inicio: 13, fin: 14 };   // horas sin atención (de lunes a viernes)

// Mecánicos que se crean la primera vez que arranca el servidor (después se gestionan con `npm run mecanicos`).
// Cada mecánico = 1 reserva por hora. Con 5 mecánicos activos caben 5 reservas en la misma hora.
const MECANICOS_INICIALES = ['Mecánico 1', 'Mecánico 2', 'Mecánico 3', 'Mecánico 4', 'Mecánico 5'];

// Datos del taller que se muestran en la página (reemplázalos por los reales).
const TALLER = {
  nombre: 'Automotriz JMP',
  eslogan: 'Reserva tu hora de atención en línea',
  telefono: '+56 9 1234 5678',
  direccion: 'Padre Orellana 1194',
  horarioTexto: 'Lunes a viernes 9:00–18:00 · Sábado 9:00–13:00',
  logo: null        // ej: '/assets/logo.png' (guarda el archivo en la carpeta assets/)
};

// Tipos de atención que verá el cliente. "Otros" debe quedar al final.
const TIPOS = [
  'Revisión técnica',
  'Mantención (cambio de aceite y filtros)',
  'Cambio de frenos',
  'Alineación y balanceo',
  'Cambio de neumáticos',
  'Revisión de batería',
  'Scanner / diagnóstico computarizado',
  'Aire acondicionado',
  'Otros'
];

// ====== Base de datos ======
const db = new Database(path.join(__dirname, 'taller.db'));
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// Si la base viene de la versión anterior (sin mecanico_id), se migra conservando las reservas.
const existeReservas = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reservas'").get();
const migrar = Boolean(existeReservas) &&
  !db.prepare('PRAGMA table_info(reservas)').all().some((c) => c.name === 'mecanico_id');

db.transaction(() => {
  if (migrar) db.exec('ALTER TABLE reservas RENAME TO reservas_antigua; DROP INDEX IF EXISTS idx_reservas_patente;');
  db.exec(schema);
  if (db.prepare('SELECT COUNT(*) AS n FROM mecanicos').get().n === 0) {
    const crear = db.prepare('INSERT INTO mecanicos (nombre) VALUES (?)');
    MECANICOS_INICIALES.forEach((n) => crear.run(n));
  }
  if (migrar) {
    db.exec(`
      INSERT INTO reservas (id, patente, nombre, telefono, tipo_atencion, detalle_otros, fecha, hora, creado_en, mecanico_id)
      SELECT id, patente, nombre, telefono, tipo_atencion, detalle_otros, fecha, hora, creado_en,
             (SELECT MIN(id) FROM mecanicos)
      FROM reservas_antigua;
      DROP TABLE reservas_antigua;`);
  }
})();

// Mecánicos libres en una fecha y hora: activos, sin ausencia ese día y sin auto asignado a esa hora.
// Se ordenan por carga del día para repartir el trabajo entre ellos.
const mecanicosLibres = db.prepare(`
  SELECT m.id
  FROM mecanicos m
  WHERE m.activo = 1
    AND NOT EXISTS (SELECT 1 FROM ausencias a WHERE a.mecanico_id = m.id AND a.fecha = @fecha)
    AND NOT EXISTS (SELECT 1 FROM reservas r WHERE r.mecanico_id = m.id AND r.fecha = @fecha AND r.hora = @hora)
  ORDER BY (SELECT COUNT(*) FROM reservas r2 WHERE r2.mecanico_id = m.id AND r2.fecha = @fecha), m.id
`);

// ====== Utilidades ======
function ahoraChile() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const dato = (t) => partes.find((p) => p.type === t).value;
  return {
    fecha: `${dato('year')}-${dato('month')}-${dato('day')}`,
    hora: Number(dato('hour')),
    minuto: Number(dato('minute'))
  };
}

function diaDeSemana(fecha) {
  return new Date(fecha + 'T12:00:00Z').getUTCDay();
}

function sumarDias(fecha, dias) {
  const d = new Date(fecha + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function fechaValida(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const d = new Date(fecha + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === fecha;
}

// Devuelve las horas que el taller ofrece ese día (sin considerar las ya reservadas)
function horasDelDia(fecha) {
  const ahora = ahoraChile();
  if (fecha < ahora.fecha) return [];
  if (fecha > sumarDias(ahora.fecha, MAX_DIAS_ADELANTE)) return [];

  const dia = diaDeSemana(fecha);
  const horario = HORARIOS[dia];
  if (!horario) return [];

  const horas = [];
  for (let h = horario.inicio; h < horario.fin; h++) {
    if (dia >= 1 && dia <= 5 && h >= ALMUERZO.inicio && h < ALMUERZO.fin) continue;
    if (fecha === ahora.fecha && h <= ahora.hora) continue;   // horas que ya pasaron
    horas.push(`${String(h).padStart(2, '0')}:00`);
  }
  return horas;
}

// ====== Servidor ======
const app = express();
app.use(express.json());

// Archivos del frontend
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));   // logo e imágenes

// Configuración para el formulario
app.get('/api/config', (req, res) => {
  res.json({
    tipos: TIPOS,
    diasAbiertos: Object.keys(HORARIOS).map(Number),
    hoy: ahoraChile().fecha,
    maxDias: MAX_DIAS_ADELANTE,
    taller: TALLER
  });
});

// Disponibilidad de un día
app.get('/api/disponibilidad', (req, res) => {
  const fecha = String(req.query.fecha || '');
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });

  const horas = horasDelDia(fecha).map((hora) => {
    const cupos = mecanicosLibres.all({ fecha, hora }).length;
    return { hora, disponible: cupos > 0, cupos };
  });
  res.json({ fecha, horas });
});

// Crear reserva
const insertar = db.prepare(`
  INSERT INTO reservas (patente, nombre, telefono, tipo_atencion, detalle_otros, fecha, hora, mecanico_id)
  VALUES (@patente, @nombre, @telefono, @tipo, @detalle, @fecha, @hora, @mecanico_id)
`);
const patenteYaReservada = db.prepare('SELECT 1 FROM reservas WHERE patente = ? AND fecha = ? AND hora = ?');

// Asigna un mecánico libre y guarda la reserva en un solo paso (atómico: evita pasarse del cupo).
// Devuelve el id de la reserva, o null si ya no quedan mecánicos libres a esa hora.
const reservar = db.transaction((datos) => {
  const libre = mecanicosLibres.all({ fecha: datos.fecha, hora: datos.hora })[0];
  if (!libre) return null;
  return insertar.run({ ...datos, mecanico_id: libre.id }).lastInsertRowid;
});

app.post('/api/reservas', (req, res) => {
  const b = req.body || {};
  const patente = String(b.patente || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nombre = String(b.nombre || '').trim();
  const telefono = String(b.telefono || '').trim();
  const tipo = String(b.tipo || '');
  const detalle = String(b.detalle || '').trim();
  const fecha = String(b.fecha || '');
  const hora = String(b.hora || '');

  if (!/^([A-Z]{4}\d{2}|[A-Z]{2}\d{4}|[A-Z]{3}\d{2})$/.test(patente))
    return res.status(400).json({ error: 'La patente no es válida.' });
  if (nombre.length < 3 || nombre.length > 80)
    return res.status(400).json({ error: 'El nombre no es válido.' });
  if (!/^\+?[0-9 ]{8,15}$/.test(telefono))
    return res.status(400).json({ error: 'El teléfono no es válido.' });
  if (!TIPOS.includes(tipo))
    return res.status(400).json({ error: 'El tipo de atención no es válido.' });
  if (tipo === 'Otros' && detalle.length < 5)
    return res.status(400).json({ error: 'Describe qué necesitas en "Otros".' });
  if (!fechaValida(fecha) || !horasDelDia(fecha).includes(hora))
    return res.status(400).json({ error: 'La fecha u hora elegida no está disponible.' });

  if (patenteYaReservada.get(patente, fecha, hora))
    return res.status(409).json({ error: 'Esa patente ya tiene una reserva a esa hora.' });

  try {
    const id = reservar({
      patente, nombre, telefono, tipo,
      detalle: tipo === 'Otros' ? detalle.slice(0, 300) : null,
      fecha, hora
    });
    if (id === null)
      return res.status(409).json({ error: 'Esa hora acaba de llenarse. Elige otra, por favor.' });
    res.status(201).json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ======================================================================
// ====== Administración (panel en /admin) ==============================
// ======================================================================
// Acceso protegido con usuario y contraseña (HTTP Basic).
//   ADMIN_USER      usuario (por defecto "admin")
//   ADMIN_PASSWORD  contraseña. Si no la defines, se genera una al azar en cada arranque y se muestra en la consola.
// IMPORTANTE: si publicas el sitio en internet, sírvelo con HTTPS; de lo contrario la contraseña viaja sin cifrar.
const ADMIN_USUARIO = process.env.ADMIN_USER || 'admin';
const ADMIN_CLAVE_DEFINIDA = Boolean(process.env.ADMIN_PASSWORD);
const ADMIN_CLAVE = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');

function textoIgual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requiereAdmin(req, res, next) {
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (m) {
    const credenciales = Buffer.from(m[1], 'base64').toString('utf8');
    const i = credenciales.indexOf(':');
    const usuario = i >= 0 ? credenciales.slice(0, i) : credenciales;
    const clave = i >= 0 ? credenciales.slice(i + 1) : '';
    const okUsuario = textoIgual(usuario, ADMIN_USUARIO);
    const okClave = textoIgual(clave, ADMIN_CLAVE);
    if (okUsuario && okClave) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Administracion del taller", charset="UTF-8"');
  res.status(401).type('text/plain').send('Acceso restringido.');
}

app.use(['/admin', '/admin.css', '/admin.js', '/api/admin'], requiereAdmin);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.css', (req, res) => res.sendFile(path.join(__dirname, 'admin.css')));
app.get('/admin.js', (req, res) => res.sendFile(path.join(__dirname, 'admin.js')));

// Horas que el taller atiende ese día, sin filtrar por hora actual ni por límite de días
// (el administrador puede registrar o editar reservas de hoy o de días pasados).
function horasDeAtencion(fecha) {
  const dia = diaDeSemana(fecha);
  const horario = HORARIOS[dia];
  if (!horario) return [];
  const horas = [];
  for (let h = horario.inicio; h < horario.fin; h++) {
    if (dia >= 1 && dia <= 5 && h >= ALMUERZO.inicio && h < ALMUERZO.fin) continue;
    horas.push(`${String(h).padStart(2, '0')}:00`);
  }
  return horas;
}

// Igual que `mecanicosLibres`, pero ignorando una reserva (@excluir) para poder editarla; 0 = ninguna.
const mecanicosLibresExcl = db.prepare(`
  SELECT m.id
  FROM mecanicos m
  WHERE m.activo = 1
    AND NOT EXISTS (SELECT 1 FROM ausencias a WHERE a.mecanico_id = m.id AND a.fecha = @fecha)
    AND NOT EXISTS (SELECT 1 FROM reservas r WHERE r.mecanico_id = m.id AND r.fecha = @fecha AND r.hora = @hora AND r.id != @excluir)
  ORDER BY (SELECT COUNT(*) FROM reservas r2 WHERE r2.mecanico_id = m.id AND r2.fecha = @fecha AND r2.id != @excluir), m.id
`);
const patenteDuplicada = db.prepare('SELECT 1 FROM reservas WHERE patente = ? AND fecha = ? AND hora = ? AND id != ?');
const reservaPorId = db.prepare('SELECT * FROM reservas WHERE id = ?');
const actualizarReserva = db.prepare(`
  UPDATE reservas SET patente = @patente, nombre = @nombre, telefono = @telefono, tipo_atencion = @tipo,
    detalle_otros = @detalle, fecha = @fecha, hora = @hora, mecanico_id = @mecanico_id
  WHERE id = @id
`);

// Valida los datos de una reserva ingresada por el administrador.
function validarReservaAdmin(b) {
  const patente = String(b.patente || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nombre = String(b.nombre || '').trim();
  const telefono = String(b.telefono || '').trim();
  const tipo = String(b.tipo || '');
  const detalle = String(b.detalle || '').trim();
  const fecha = String(b.fecha || '');
  const hora = String(b.hora || '');
  const mecanicoPedido = b.mecanico_id ? Number(b.mecanico_id) : null;

  if (!/^([A-Z]{4}\d{2}|[A-Z]{2}\d{4}|[A-Z]{3}\d{2})$/.test(patente)) return { error: 'La patente no es válida.' };
  if (nombre.length < 3 || nombre.length > 80) return { error: 'El nombre no es válido (3 a 80 caracteres).' };
  if (!/^\+?[0-9 ]{8,15}$/.test(telefono)) return { error: 'El teléfono no es válido.' };
  if (!TIPOS.includes(tipo)) return { error: 'El tipo de atención no es válido.' };
  if (tipo === 'Otros' && detalle.length < 5) return { error: 'Describe qué necesita el cliente en "Otros".' };
  if (!fechaValida(fecha)) return { error: 'La fecha no es válida.' };
  if (!horasDeAtencion(fecha).includes(hora)) return { error: 'El taller no atiende en ese día u hora.' };
  if (mecanicoPedido !== null && !Number.isInteger(mecanicoPedido)) return { error: 'El mecánico no es válido.' };

  return {
    datos: { patente, nombre, telefono, tipo, detalle: tipo === 'Otros' ? detalle.slice(0, 300) : null, fecha, hora },
    mecanicoPedido
  };
}

const MSG_MECANICO_NO_LIBRE = 'Ese mecánico no está disponible a esa hora (ausente, desactivado u ocupado).';
const MSG_SIN_CUPO = 'No quedan mecánicos libres a esa hora.';

const crearReservaAdmin = db.transaction((d, mecanicoPedido) => {
  if (patenteDuplicada.get(d.patente, d.fecha, d.hora, 0)) return { conflicto: 'Esa patente ya tiene una reserva a esa hora.' };
  const libres = mecanicosLibresExcl.all({ fecha: d.fecha, hora: d.hora, excluir: 0 }).map((r) => r.id);
  let mecanicoId;
  if (mecanicoPedido) {
    if (!libres.includes(mecanicoPedido)) return { conflicto: MSG_MECANICO_NO_LIBRE };
    mecanicoId = mecanicoPedido;
  } else {
    mecanicoId = libres[0];
    if (!mecanicoId) return { conflicto: MSG_SIN_CUPO };
  }
  return { id: insertar.run({ ...d, mecanico_id: mecanicoId }).lastInsertRowid };
});

const editarReservaAdmin = db.transaction((id, d, mecanicoPedido) => {
  const actual = reservaPorId.get(id);
  if (!actual) return { noExiste: true };
  if (patenteDuplicada.get(d.patente, d.fecha, d.hora, id)) return { conflicto: 'Esa patente ya tiene una reserva a esa hora.' };

  let mecanicoId = actual.mecanico_id;
  const cambiaHorario = actual.fecha !== d.fecha || actual.hora !== d.hora;
  const cambiaMecanico = Boolean(mecanicoPedido) && mecanicoPedido !== actual.mecanico_id;

  // Solo se revisa la disponibilidad si cambia el horario o el mecánico; así se puede corregir
  // un teléfono aunque el mecánico asignado ya esté marcado como ausente.
  if (cambiaHorario || cambiaMecanico) {
    const libres = mecanicosLibresExcl.all({ fecha: d.fecha, hora: d.hora, excluir: id }).map((r) => r.id);
    if (cambiaMecanico) {
      if (!libres.includes(mecanicoPedido)) return { conflicto: MSG_MECANICO_NO_LIBRE };
      mecanicoId = mecanicoPedido;
    } else if (!libres.includes(mecanicoId)) {
      mecanicoId = libres[0];                       // el mecánico actual no puede: se reasigna otro
      if (!mecanicoId) return { conflicto: MSG_SIN_CUPO };
    }
  }
  actualizarReserva.run({ ...d, id, mecanico_id: mecanicoId });
  return { id, mecanico_id: mecanicoId, reasignado: cambiaHorario && !cambiaMecanico && mecanicoId !== actual.mecanico_id };
});

const idDeParametro = (valor) => {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const escaparLike = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);

const admin = express.Router();
admin.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Datos básicos para armar el panel
admin.get('/config', (req, res) => {
  res.json({
    tipos: TIPOS,
    hoy: ahoraChile().fecha,
    diasAbiertos: Object.keys(HORARIOS).map(Number),
    taller: { nombre: TALLER.nombre }
  });
});

// Horas del día con cupos y mecánicos libres. `excluir` = id de la reserva que se está editando.
admin.get('/disponibilidad', (req, res) => {
  const fecha = String(req.query.fecha || '');
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
  const excluir = idDeParametro(req.query.excluir) || 0;
  const horas = horasDeAtencion(fecha).map((hora) => {
    const libres = mecanicosLibresExcl.all({ fecha, hora, excluir }).map((r) => r.id);
    return { hora, cupos: libres.length, libres };
  });
  res.json({ fecha, cerrado: horas.length === 0, horas });
});

// Listado de reservas con filtros: desde, hasta, mecanico, q (patente, nombre o teléfono)
admin.get('/reservas', (req, res) => {
  const desde = req.query.desde ? String(req.query.desde) : ahoraChile().fecha;
  const hasta = req.query.hasta ? String(req.query.hasta) : '9999-12-31';
  if (!fechaValida(desde) || !fechaValida(hasta)) return res.status(400).json({ error: 'Rango de fechas inválido.' });
  const mecanico = idDeParametro(req.query.mecanico) || 0;
  const q = String(req.query.q || '').trim().slice(0, 60);

  const filas = db.prepare(`
    SELECT r.id, r.patente, r.nombre, r.telefono, r.tipo_atencion AS tipo, r.detalle_otros AS detalle,
           r.fecha, r.hora, r.mecanico_id, m.nombre AS mecanico, r.creado_en
    FROM reservas r JOIN mecanicos m ON m.id = r.mecanico_id
    WHERE r.fecha >= @desde AND r.fecha <= @hasta
      AND (@mecanico = 0 OR r.mecanico_id = @mecanico)
      AND (@q = '' OR r.patente LIKE @like ESCAPE '\\' OR r.nombre LIKE @like ESCAPE '\\' OR r.telefono LIKE @like ESCAPE '\\')
    ORDER BY r.fecha, r.hora, r.id
    LIMIT 1000
  `).all({ desde, hasta, mecanico, q, like: `%${escaparLike(q)}%` });
  res.json({ reservas: filas, limite: filas.length === 1000 });
});

admin.post('/reservas', (req, res) => {
  const v = validarReservaAdmin(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = crearReservaAdmin(v.datos, v.mecanicoPedido);
    if (r.conflicto) return res.status(409).json({ error: r.conflicto });
    res.status(201).json({ id: r.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

admin.put('/reservas/:id', (req, res) => {
  const id = idDeParametro(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido.' });
  const v = validarReservaAdmin(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = editarReservaAdmin(id, v.datos, v.mecanicoPedido);
    if (r.noExiste) return res.status(404).json({ error: 'La reserva no existe.' });
    if (r.conflicto) return res.status(409).json({ error: r.conflicto });
    res.json({ id: r.id, reasignado: r.reasignado });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

admin.delete('/reservas/:id', (req, res) => {
  const id = idDeParametro(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido.' });
  const r = db.prepare('DELETE FROM reservas WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'La reserva no existe.' });
  res.json({ ok: true });
});

// Mecánicos, con sus reservas futuras y ausencias próximas
admin.get('/mecanicos', (req, res) => {
  const hoy = ahoraChile().fecha;
  const mecanicos = db.prepare(`
    SELECT m.id, m.nombre, m.activo,
           (SELECT COUNT(*) FROM reservas r WHERE r.mecanico_id = m.id AND r.fecha >= @hoy) AS reservas_futuras
    FROM mecanicos m ORDER BY m.id
  `).all({ hoy });
  const ausencias = db.prepare('SELECT mecanico_id, fecha, motivo FROM ausencias WHERE fecha >= ? ORDER BY fecha').all(hoy);
  mecanicos.forEach((m) => {
    m.activo = Boolean(m.activo);
    m.ausencias = ausencias.filter((a) => a.mecanico_id === m.id).map(({ fecha, motivo }) => ({ fecha, motivo }));
  });
  res.json({ hoy, mecanicos });
});

admin.post('/mecanicos', (req, res) => {
  const nombre = String((req.body || {}).nombre || '').trim();
  if (nombre.length < 2 || nombre.length > 60) return res.status(400).json({ error: 'El nombre debe tener entre 2 y 60 caracteres.' });
  try {
    const id = db.prepare('INSERT INTO mecanicos (nombre) VALUES (?)').run(nombre).lastInsertRowid;
    res.status(201).json({ id });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ya existe un mecánico con ese nombre.' });
    console.error(e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

admin.put('/mecanicos/:id', (req, res) => {
  const id = idDeParametro(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido.' });
  const actual = db.prepare('SELECT * FROM mecanicos WHERE id = ?').get(id);
  if (!actual) return res.status(404).json({ error: 'El mecánico no existe.' });

  const b = req.body || {};
  let nombre = actual.nombre;
  let activo = actual.activo;
  if (b.nombre !== undefined) {
    nombre = String(b.nombre).trim();
    if (nombre.length < 2 || nombre.length > 60) return res.status(400).json({ error: 'El nombre debe tener entre 2 y 60 caracteres.' });
  }
  if (b.activo !== undefined) activo = b.activo ? 1 : 0;

  try {
    db.prepare('UPDATE mecanicos SET nombre = ?, activo = ? WHERE id = ?').run(nombre, activo, id);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ya existe un mecánico con ese nombre.' });
    console.error(e);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
  // Las reservas ya hechas no se mueven solas: se avisa cuántas quedan con un mecánico dado de baja.
  const futuras = activo ? 0 : db.prepare('SELECT COUNT(*) AS n FROM reservas WHERE mecanico_id = ? AND fecha >= ?').get(id, ahoraChile().fecha).n;
  res.json({ ok: true, reservas_afectadas: futuras });
});

admin.post('/mecanicos/:id/ausencias', (req, res) => {
  const id = idDeParametro(req.params.id);
  const fecha = String((req.body || {}).fecha || '');
  const motivo = String((req.body || {}).motivo || '').trim().slice(0, 100) || null;
  if (!id || !db.prepare('SELECT 1 FROM mecanicos WHERE id = ?').get(id)) return res.status(404).json({ error: 'El mecánico no existe.' });
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'La fecha no es válida.' });
  db.prepare('INSERT OR REPLACE INTO ausencias (mecanico_id, fecha, motivo) VALUES (?, ?, ?)').run(id, fecha, motivo);
  const n = db.prepare('SELECT COUNT(*) AS n FROM reservas WHERE mecanico_id = ? AND fecha = ?').get(id, fecha).n;
  res.status(201).json({ ok: true, reservas_afectadas: n });
});

admin.delete('/mecanicos/:id/ausencias/:fecha', (req, res) => {
  const id = idDeParametro(req.params.id);
  if (!id || !fechaValida(req.params.fecha)) return res.status(400).json({ error: 'Datos inválidos.' });
  const r = db.prepare('DELETE FROM ausencias WHERE mecanico_id = ? AND fecha = ?').run(id, req.params.fecha);
  if (!r.changes) return res.status(404).json({ error: 'No había ausencia en esa fecha.' });
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// JSON mal formado -> 400 en vez de una página de error
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos mal formados.' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
  console.log(`Panel de administración: http://localhost:${PORT}/admin`);
  console.log(`  Usuario: ${ADMIN_USUARIO}`);
  console.log(ADMIN_CLAVE_DEFINIDA
    ? '  Contraseña: la definida en ADMIN_PASSWORD'
    : `  Contraseña (temporal, cambia en cada arranque): ${ADMIN_CLAVE}\n  Para fijarla usa la variable de entorno ADMIN_PASSWORD.`);
});
