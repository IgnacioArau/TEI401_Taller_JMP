# Reservas Taller Automotriz

## Archivos
- `index.html`, `styles.css`, `script.js`: la página (frontend).
- `server.js`: servidor (Node.js + Express) que entrega la página y guarda las reservas.
- `schema.sql`: estructura de la base de datos SQL (SQLite). Se crea sola en `taller.db`.
- `mecanicos.js`: comandos para gestionar mecánicos y ausencias.
- `admin.html`, `admin.css`, `admin.js`: panel de administración (ver más abajo).
- `assets/`: logo e imágenes del taller.

## Cómo ejecutarlo
1. Instala Node.js 18 o superior.
2. En la carpeta del proyecto: `npm install`
3. `npm start`
4. Abre http://localhost:3000

## Cupos por hora según mecánicos
Cada mecánico activo atiende 1 auto por hora, así que los cupos de una hora = mecánicos activos sin ausencia ese día.
El servidor asigna automáticamente un mecánico libre al reservar (repartiendo la carga).

    npm run mecanicos -- listar
    npm run mecanicos -- renombrar 1 "Juan Pérez"
    npm run mecanicos -- agregar "Juan Pérez"
    npm run mecanicos -- desactivar 2
    npm run mecanicos -- ausencia 1 2026-11-04 vacaciones
    npm run mecanicos -- quitar-ausencia 1 2026-11-04

Si ya tenías `taller.db` de la versión anterior, se migra sola al iniciar el servidor.

## Panel de administración
Está en http://localhost:3000/admin y pide usuario y contraseña.

    ADMIN_USER=admin ADMIN_PASSWORD="una-clave-larga" npm start

- Si no defines `ADMIN_PASSWORD`, el servidor genera una contraseña al azar en cada arranque y la muestra en la consola.
- Si publicas el sitio en internet, sírvelo con HTTPS (si no, la contraseña viaja sin cifrar).
- **Reservas**: lista agrupada por día con filtros (fechas, mecánico, búsqueda por patente, nombre o teléfono). Permite crear una reserva manualmente, editarla (datos, fecha, hora o mecánico) y eliminarla. El formulario muestra los cupos de cada hora y solo ofrece los mecánicos libres a esa hora; si no eliges mecánico, se asigna uno automáticamente.
- **Mecánicos**: agregar, renombrar, dar de baja o reactivar (esto cambia los cupos por hora) y registrar o quitar días de ausencia. Las reservas ya hechas no se mueven solas: el panel avisa cuántas quedan afectadas para que las reasignes con "Editar".
- Las reservas manuales siguen las mismas reglas de cupos y horario del taller, pero el administrador puede registrar horas del mismo día o de días pasados.

## Qué editar
- Nombre, eslogan, teléfono, dirección, horario y logo del taller: bloque `TALLER` en `server.js`.
- Horarios, almuerzo, días hacia adelante y lista de tipos de atención: arriba en `server.js`.
- Colores: variables al inicio de `styles.css`.
- Textos del formulario: `index.html`.

## Ver las reservas guardadas
    sqlite3 taller.db "SELECT r.*, m.nombre AS mecanico FROM reservas r JOIN mecanicos m ON m.id = r.mecanico_id ORDER BY fecha, hora;"
(o abre `taller.db` con DB Browser for SQLite).
