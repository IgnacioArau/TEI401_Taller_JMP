-- Esquema de la base de datos (SQLite). Se ejecuta automáticamente al iniciar el servidor.

CREATE TABLE IF NOT EXISTS mecanicos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre  TEXT NOT NULL UNIQUE,
  activo  INTEGER NOT NULL DEFAULT 1          -- 1 = trabaja en el taller, 0 = dado de baja
);

-- Días en que un mecánico específico no está (vacaciones, licencia, etc.)
CREATE TABLE IF NOT EXISTS ausencias (
  mecanico_id INTEGER NOT NULL REFERENCES mecanicos (id),
  fecha       TEXT NOT NULL,                  -- formato YYYY-MM-DD
  motivo      TEXT,
  PRIMARY KEY (mecanico_id, fecha)
);

CREATE TABLE IF NOT EXISTS reservas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patente       TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  telefono      TEXT NOT NULL,
  tipo_atencion TEXT NOT NULL,
  detalle_otros TEXT,                         -- solo se llena si tipo_atencion = 'Otros'
  fecha         TEXT NOT NULL,                -- formato YYYY-MM-DD
  hora          TEXT NOT NULL,                -- formato HH:MM
  mecanico_id   INTEGER NOT NULL REFERENCES mecanicos (id),
  creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (fecha, hora, mecanico_id)           -- un mecánico no puede tener dos autos a la misma hora
);

CREATE INDEX IF NOT EXISTS idx_reservas_patente ON reservas (patente);
