# Publicar la página en Amazon Lightsail con un dominio de NIC Chile

Esta guía deja la página funcionando en `https://tudominio.cl`, con la contraseña de administrador definida por ti, HTTPS automático y respaldos de la base de datos.

Reemplaza `tudominio.cl` por tu dominio real en todos los pasos. Los comandos se escriben en la terminal del servidor (paso 4), salvo que se indique otra cosa.

> **Costos:** Lightsail se cobra mensualmente (el plan más barato cuesta unos US$5 al mes; los precios y las ofertas para cuentas nuevas cambian, revísalos en la consola de AWS). El dominio `.cl` se paga aparte, a NIC Chile.

## Qué vas a necesitar
- Una cuenta de AWS (con verificación en dos pasos, MFA, activada).
- El dominio `.cl` inscrito en https://www.nic.cl (cuenta de NIC Chile).
- El proyecto subido a GitHub (sin el archivo `.env` ni `taller.db`; el `.gitignore` ya los excluye).

---

## 1. Crear el servidor en Lightsail
1. Entra a https://lightsail.aws.amazon.com y elige **Create instance**.
2. Región: una cercana a Chile (por ejemplo **São Paulo**, si aparece en la lista).
3. Plataforma **Linux/Unix**, **Only OS** (solo sistema operativo) → **Ubuntu 24.04 LTS**.
4. Plan: el más barato suele bastar (la aplicación es liviana). Ponle un nombre, por ejemplo `taller` y crea la instancia.

## 2. IP fija y firewall
1. En Lightsail: **Networking → Create static IP** → asóciala a la instancia `taller`. Anota la IP (la usarás en el paso 6). La IP fija no se cobra mientras esté asociada a una instancia.
2. Abre la instancia → pestaña **Networking → IPv4 Firewall**. Deja solo estas reglas:
   - **SSH (22):** actívala con **Restrict to IP address** y escribe tu IP (así solo tú puedes entrar por terminal).
   - **HTTP (80):** abierta.
   - **HTTPS (443):** agrégala (**Add rule → HTTPS**).

   El puerto 3000 de la aplicación **no** se abre: solo se accede a él a través de Caddy.

## 3. Activar MFA y una alarma de costos (una sola vez)
- En AWS (menú de tu cuenta → **Security credentials**) activa MFA en la cuenta raíz.
- En **Billing → Budgets** crea un presupuesto con aviso por correo, para no llevarte sorpresas.

## 4. Preparar el servidor
En la página de la instancia, pulsa **Connect using SSH** (terminal en el navegador). Luego:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git sqlite3 curl

# Node.js 26 (esta versión del proyecto lo exige: usa node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_26.x -o nodesource_setup.sh
sudo -E bash nodesource_setup.sh
sudo apt install -y nodejs
node -v        # debe mostrar v26.x
which node     # debe mostrar /usr/bin/node
```

## 5. Instalar la aplicación y definir la contraseña
```bash
# Usuario del sistema que ejecuta la aplicación (sin acceso de login)
sudo adduser --system --group --home /opt/taller --no-create-home taller

# Descargar el proyecto
sudo git clone https://github.com/IgnacioArau/TEI401_Taller_JMP.git /opt/taller
sudo chown -R taller:taller /opt/taller
cd /opt/taller
sudo -H -u taller npm install --omit=dev
```

Ahora define **tu contraseña de administrador**:

```bash
sudo -u taller cp /opt/taller/.env.example /opt/taller/.env
openssl rand -base64 18        # genera una contraseña larga; cópiala (o inventa una tuya)
sudo -u taller nano /opt/taller/.env
```

En el editor cambia la línea `ADMIN_PASSWORD="CAMBIA-ESTA-CLAVE-LARGA"` por tu contraseña entre comillas (y `ADMIN_USER` si quieres otro usuario). Guarda con **Ctrl+O**, Enter, y sal con **Ctrl+X**. Luego protege el archivo:

```bash
sudo chmod 600 /opt/taller/.env
```

> Guarda la contraseña en un administrador de contraseñas. El archivo `.env` existe solo en el servidor; no se sube a GitHub.

## 6. Dejar la aplicación encendida siempre (systemd)
```bash
sudo cp /opt/taller/deploy/taller.service /etc/systemd/system/taller.service
sudo systemctl daemon-reload
sudo systemctl enable --now taller
sudo systemctl status taller --no-pager      # debe decir "active (running)"
curl -s http://127.0.0.1:3000/api/config | head -c 200
```

Si no arranca, mira el motivo con `sudo journalctl -u taller -n 50 --no-pager`. Por seguridad, en el servidor el programa **no inicia** si falta la contraseña o si dejaste la de ejemplo.

## 7. Apuntar el dominio al servidor (NIC Chile + DNS de Lightsail)
Se usa la zona DNS gratuita de Lightsail para manejar los registros del dominio.

1. En Lightsail: **Networking → Create DNS zone** → escribe `tudominio.cl`. Lightsail te mostrará **4 servidores de nombres** (algo como `ns-123.awsdns-45.com`). Anótalos.
2. Dentro de la zona, agrega dos registros **A**: uno para el dominio raíz (`@`) y otro para `www`, ambos con la **IP fija** del paso 2.
3. Entra a https://www.nic.cl → tu cuenta → tu dominio → modificar datos del dominio → sección **Servidores de nombre (DNS)**, y reemplaza los servidores actuales por los 4 de Lightsail. Guarda los cambios. (Si NIC Chile los rechaza, verifica que la zona ya exista en Lightsail y tenga los registros A.)
4. Espera la propagación (de unos minutos a 24–48 horas). Comprueba desde tu computador:
   ```
   nslookup tudominio.cl
   ```
   Debe mostrar la IP fija de tu servidor.

## 8. HTTPS con Caddy (hazlo cuando el dominio ya apunte al servidor)
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```
(Si algún comando falla, revisa las instrucciones vigentes en https://caddyserver.com/docs/install.)

Copia la configuración y pon tu dominio:
```bash
sudo cp /opt/taller/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # cambia tudominio.cl por tu dominio, en las dos líneas
sudo systemctl reload caddy
sudo journalctl -u caddy -n 30 --no-pager
```
Caddy obtiene el certificado solo. Abre `https://tudominio.cl` (la página) y `https://tudominio.cl/admin` (el panel, con tu usuario y contraseña).

## 9. Respaldos
La base `taller.db` guarda todas las reservas, con nombres, teléfonos y patentes. Hay dos capas:

**a) Copia diaria de la base (script incluido)**
```bash
sudo chmod +x /opt/taller/deploy/backup.sh
sudo /opt/taller/deploy/backup.sh          # prueba manual: debe decir "Respaldo creado: ..."
sudo crontab -e
```
Agrega esta línea al final (corre cada día a las 03:00, hora del servidor, que es UTC) y guarda:
```
0 3 * * * /opt/taller/deploy/backup.sh >> /var/log/taller-backup.log 2>&1
```
Las copias quedan en `/var/backups/taller` y se conservan 14 días.

**b) Snapshots automáticos de Lightsail**: abre la instancia → pestaña **Snapshots** → activa **Automatic snapshots** y elige una hora. Guardan el disco completo y tienen un costo pequeño por GB. Haz también un snapshot manual antes de cambios grandes.

*(Opcional)* Para guardar además las copias en Amazon S3, crea un bucket y un usuario de AWS con permiso solo sobre ese bucket, configura `aws configure` en el servidor y quita el `#` de la última línea de `backup.sh`.

**Restaurar una copia**
```bash
sudo systemctl stop taller
sudo sh -c 'gunzip -c /var/backups/taller/taller_FECHA.db.gz > /opt/taller/taller.db'
sudo chown taller:taller /opt/taller/taller.db
sudo systemctl start taller
```

---

## Tareas de mantenimiento

**Actualizar la página** (después de subir cambios a GitHub):
```bash
cd /opt/taller
sudo -H -u taller git pull
sudo -H -u taller npm install --omit=dev
sudo systemctl restart taller
```

**Cambiar la contraseña de administrador:**
```bash
sudo -u taller nano /opt/taller/.env
sudo systemctl restart taller
```

**Gestionar mecánicos por terminal** (también se puede desde el panel):
```bash
cd /opt/taller && sudo -H -u taller npm run mecanicos -- listar
```

**Ver si algo falla:** `sudo journalctl -u taller -n 50 --no-pager` (aplicación) y `sudo journalctl -u caddy -n 50 --no-pager` (HTTPS).

## Problemas frecuentes
- **Caddy no consigue el certificado:** el dominio aún no apunta a la IP del servidor (paso 7), o los puertos 80 y 443 no están abiertos (paso 2).
- **El panel responde "Demasiados intentos fallidos":** se escribió mal la contraseña 10 veces; espera 15 minutos o reinicia con `sudo systemctl restart taller`.
- **El servicio no inicia y dice "falta definir una contraseña":** revisa el archivo `.env` (paso 5): debe existir en `/opt/taller` y tener tu contraseña, no la de ejemplo.
- **La página pública carga pero no se pueden hacer reservas:** revisa `sudo journalctl -u taller -n 50`.

## Lista de seguridad
- [ ] MFA activado en la cuenta de AWS y alarma de presupuesto creada.
- [ ] Puerto 22 (SSH) restringido a tu IP; solo 80 y 443 abiertos al público.
- [ ] Contraseña de administrador larga y propia, guardada en un administrador de contraseñas.
- [ ] `https://tudominio.cl/admin` pide contraseña y funciona con HTTPS (candado en el navegador).
- [ ] Respaldos diarios probados (una restauración de prueba al menos una vez).
- [ ] Actualizaciones del sistema: Ubuntu instala las de seguridad automáticamente; haz además `sudo apt update && sudo apt upgrade` de vez en cuando y reinicia el servidor tras actualizaciones del kernel.
- [ ] Tienes un aviso de privacidad para los clientes, porque la página guarda nombre, teléfono y patente (consulta con un abogado qué debes informar según la ley chilena de protección de datos).
