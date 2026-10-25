const express = require('express');
const path = require('path');
const fs = require('fs');
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

app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));
