#!/usr/bin/env bash
# Respaldo de la base de datos de reservas (taller.db).
# Hace una copia consistente (aunque el servidor esté funcionando), la comprime y borra las de más de 14 días.
# Uso manual:      sudo /opt/taller/deploy/backup.sh
# Programado:      ver deploy/GUIA-LIGHTSAIL.md (paso "Respaldos")
set -euo pipefail

DB="${DB:-/opt/taller/taller.db}"
DEST="${DEST:-/var/backups/taller}"
DIAS="${DIAS:-14}"

if [ ! -f "$DB" ]; then
  echo "No existe la base de datos: $DB" >&2
  exit 1
fi

mkdir -p "$DEST"
chmod 700 "$DEST"                     # la base contiene nombres, teléfonos y patentes
ARCHIVO="$DEST/taller_$(date +%F_%H%M%S).db"

sqlite3 "$DB" ".backup '$ARCHIVO'"
gzip "$ARCHIVO"
find "$DEST" -name 'taller_*.db.gz' -mtime +"$DIAS" -delete

echo "Respaldo creado: $ARCHIVO.gz"

# Opcional: enviar también una copia a un bucket de Amazon S3 (requiere AWS CLI configurado).
# Quita el "#" de la línea siguiente y escribe el nombre de tu bucket:
# aws s3 cp "$ARCHIVO.gz" "s3://NOMBRE-DE-TU-BUCKET/taller/"
