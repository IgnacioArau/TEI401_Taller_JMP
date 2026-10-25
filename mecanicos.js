// Gestión de mecánicos desde la terminal. Uso: npm run mecanicos -- <comando>
//   listar
//   agregar "Nombre Apellido"
//   renombrar <id> "Nuevo nombre"
//   desactivar <id>          (deja de recibir reservas nuevas)
//   activar <id>
//   ausencia <id> <AAAA-MM-DD> [motivo]     (ese día no cuenta como disponible)
//   quitar-ausencia <id> <AAAA-MM-DD>
// Ejecuta primero `npm start` una vez para que la base de datos se cree/migre.
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'taller.db'));

const [cmd, a, b, ...resto] = process.argv.slice(2);
const fechaOk = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '');
const falta = (msg) => { console.error(msg); process.exit(1); };

try {
  if (cmd === 'listar') {
    console.table(db.prepare('SELECT id, nombre, activo FROM mecanicos ORDER BY id').all());
    console.table(db.prepare(`SELECT a.mecanico_id AS id, m.nombre, a.fecha, a.motivo FROM ausencias a
      JOIN mecanicos m ON m.id = a.mecanico_id WHERE a.fecha >= date('now') ORDER BY a.fecha`).all());
  } else if (cmd === 'agregar') {
    if (!a) falta('Falta el nombre.');
    console.log('Creado con id', db.prepare('INSERT INTO mecanicos (nombre) VALUES (?)').run(a).lastInsertRowid);
  } else if (cmd === 'renombrar') {
    if (!Number(a) || !b) falta('Uso: renombrar <id> "Nuevo nombre"');
    console.log(db.prepare('UPDATE mecanicos SET nombre = ? WHERE id = ?').run(b, Number(a)).changes ? 'Listo.' : 'No existe ese id.');
  } else if (cmd === 'activar' || cmd === 'desactivar') {
    const r = db.prepare('UPDATE mecanicos SET activo = ? WHERE id = ?').run(cmd === 'activar' ? 1 : 0, Number(a));
    console.log(r.changes ? 'Listo.' : 'No existe ese id.');
  } else if (cmd === 'ausencia') {
    if (!Number(a) || !fechaOk(b)) falta('Uso: ausencia <id> <AAAA-MM-DD> [motivo]');
    db.prepare('INSERT OR REPLACE INTO ausencias (mecanico_id, fecha, motivo) VALUES (?, ?, ?)')
      .run(Number(a), b, resto.join(' ') || null);
    console.log('Ausencia registrada. Las reservas ya hechas ese día no se mueven solas: revísalas.');
  } else if (cmd === 'quitar-ausencia') {
    if (!Number(a) || !fechaOk(b)) falta('Uso: quitar-ausencia <id> <AAAA-MM-DD>');
    console.log(db.prepare('DELETE FROM ausencias WHERE mecanico_id = ? AND fecha = ?').run(Number(a), b).changes ? 'Listo.' : 'No había ausencia.');
  } else {
    falta('Comandos: listar | renombrar <id> "Nombre" | agregar "Nombre" | activar <id> | desactivar <id> | ausencia <id> <fecha> [motivo] | quitar-ausencia <id> <fecha>');
  }
} catch (e) {
  falta('Error: ' + e.message + ' (¿ya ejecutaste `npm start` al menos una vez?)');
}
