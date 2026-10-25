// ====== Configuración ======
const API_URL = '/api'; // Si el servidor está en otra dirección, cámbialo aquí (ej: 'https://mitaller.cl/api')

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Formatos de patente chilena: BCDF12 (actual), AB1234 (antigua), ABC12 (moto)
const REGEX_PATENTE = /^([A-Z]{4}\d{2}|[A-Z]{2}\d{4}|[A-Z]{3}\d{2})$/;
const REGEX_TELEFONO = /^\+?[0-9 ]{8,15}$/;

// ====== Estado ======
let config = null;          // { tipos, diasAbiertos, hoy, maxDias }
let mesVisible = null;      // { anio, mes }  (mes: 0-11)
let fechaSel = null;        // 'YYYY-MM-DD'
let horaSel = null;         // 'HH:MM'

// ====== Elementos ======
const $ = (id) => document.getElementById(id);
const form = $('form-reserva');
const campoPatente = $('patente');
const campoTipo = $('tipo');
const campoDetalle = $('detalle');
const campoNombre = $('nombre');
const campoTelefono = $('telefono');

// ====== Utilidades ======
const pad = (n) => String(n).padStart(2, '0');
const aTexto = (anio, mes, dia) => `${anio}-${pad(mes + 1)}-${pad(dia)}`;

function normalizarPatente(valor) {
  return valor.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function setError(campo, mensaje) {
  const caja = $('error-' + campo);
  if (caja) caja.textContent = mensaje || '';
  const input = $(campo);
  if (input) input.classList.toggle('invalido', Boolean(mensaje));
}

function limpiarErrores() {
  ['patente', 'tipo', 'detalle', 'fecha', 'hora', 'nombre', 'telefono'].forEach((c) => setError(c, ''));
}

function mostrarMensaje(texto, tipo) {
  const caja = $('mensaje');
  caja.textContent = texto;
  caja.className = 'mensaje ' + (tipo === 'ok' ? 'ok' : 'error-msg');
  caja.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function ocultarMensaje() {
  $('mensaje').className = 'mensaje oculto';
}

// ====== Datos del taller (vienen de TALLER en server.js) ======
function aplicarTaller(t) {
  document.title = `Reserva de hora | ${t.nombre}`;
  $('taller-nombre').textContent = t.nombre;
  $('taller-eslogan').textContent = t.eslogan;
  if (t.logo) {
    $('logo').src = t.logo;
    $('logo').alt = `Logo de ${t.nombre}`;
    $('logo').classList.remove('oculto');
  }
  $('pie-direccion').textContent = t.direccion || '';
  $('pie-horario').textContent = t.horarioTexto || '';
  if (t.telefono) {
    $('pie-telefono').textContent = t.telefono;
    $('pie-telefono').href = 'tel:' + t.telefono.replace(/[^+0-9]/g, '');
  }
  $('pie-copy').textContent = `${t.nombre} · Todos los derechos reservados`;
}

// ====== Carga inicial ======
async function iniciar() {
  try {
    const resp = await fetch(`${API_URL}/config`);
    config = await resp.json();
  } catch (e) {
    mostrarMensaje('No se pudo conectar con el servidor. Intenta nuevamente más tarde.', 'error');
    return;
  }

  if (config.taller) aplicarTaller(config.taller);

  // Llenar la lista de tipos de atención
  config.tipos.forEach((t) => {
    const op = document.createElement('option');
    op.value = t;
    op.textContent = t;
    campoTipo.appendChild(op);
  });

  const [anio, mes] = config.hoy.split('-').map(Number);
  mesVisible = { anio, mes: mes - 1 };
  dibujarCalendario();
}

// ====== Calendario ======
function diaDisponible(anio, mes, dia) {
  const texto = aTexto(anio, mes, dia);
  if (texto < config.hoy) return false;
  const limite = new Date(config.hoy + 'T12:00:00');
  limite.setDate(limite.getDate() + config.maxDias);
  const textoLimite = aTexto(limite.getFullYear(), limite.getMonth(), limite.getDate());
  if (texto > textoLimite) return false;
  const diaSemana = new Date(anio, mes, dia).getDay(); // 0 = domingo
  return config.diasAbiertos.includes(diaSemana);
}

function dibujarCalendario() {
  const { anio, mes } = mesVisible;
  $('mes-titulo').textContent = `${MESES[mes]} ${anio}`;

  const contenedor = $('calendario-dias');
  contenedor.innerHTML = '';

  const primerDia = (new Date(anio, mes, 1).getDay() + 6) % 7; // semana parte en lunes
  const totalDias = new Date(anio, mes + 1, 0).getDate();

  for (let i = 0; i < primerDia; i++) {
    const vacio = document.createElement('span');
    vacio.className = 'dia-vacio';
    contenedor.appendChild(vacio);
  }

  for (let dia = 1; dia <= totalDias; dia++) {
    const texto = aTexto(anio, mes, dia);
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'dia';
    boton.textContent = dia;
    boton.disabled = !diaDisponible(anio, mes, dia);
    if (texto === config.hoy) boton.classList.add('hoy');
    if (texto === fechaSel) boton.classList.add('seleccionado');
    boton.addEventListener('click', () => seleccionarFecha(texto));
    contenedor.appendChild(boton);
  }

  // Bloquear navegación a meses pasados
  const [anioHoy, mesHoy] = config.hoy.split('-').map(Number);
  $('mes-anterior').disabled = anio === anioHoy && mes === mesHoy - 1;
}

$('mes-anterior').addEventListener('click', () => {
  mesVisible.mes--;
  if (mesVisible.mes < 0) { mesVisible.mes = 11; mesVisible.anio--; }
  dibujarCalendario();
});

$('mes-siguiente').addEventListener('click', () => {
  mesVisible.mes++;
  if (mesVisible.mes > 11) { mesVisible.mes = 0; mesVisible.anio++; }
  dibujarCalendario();
});

async function seleccionarFecha(texto) {
  fechaSel = texto;
  horaSel = null;
  setError('fecha', '');
  dibujarCalendario();
  await cargarHoras(texto);
}

// ====== Horas disponibles ======
async function cargarHoras(fecha) {
  const bloque = $('bloque-horas');
  const contenedor = $('horas');
  const [a, m, d] = fecha.split('-').map(Number);
  $('horas-titulo').textContent = `Horas disponibles para el ${d} de ${MESES[m - 1]}`;
  bloque.classList.remove('oculto');
  contenedor.innerHTML = '<span class="sin-horas">Cargando…</span>';

  try {
    const resp = await fetch(`${API_URL}/disponibilidad?fecha=${fecha}`);
    const datos = await resp.json();
    contenedor.innerHTML = '';

    if (!datos.horas || datos.horas.length === 0) {
      contenedor.innerHTML = '<span class="sin-horas">No hay horas para este día.</span>';
      return;
    }

    datos.horas.forEach(({ hora, disponible }) => {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'hora';
      boton.textContent = hora;
      boton.disabled = !disponible;
      if (hora === horaSel) boton.classList.add('seleccionada');
      boton.addEventListener('click', () => {
        horaSel = hora;
        setError('hora', '');
        contenedor.querySelectorAll('.hora').forEach((b) => b.classList.remove('seleccionada'));
        boton.classList.add('seleccionada');
      });
      contenedor.appendChild(boton);
    });
  } catch (e) {
    contenedor.innerHTML = '<span class="sin-horas">No se pudo cargar la disponibilidad.</span>';
  }
}

// ====== Campos ======
campoPatente.addEventListener('input', () => {
  campoPatente.value = normalizarPatente(campoPatente.value);
});

campoTipo.addEventListener('change', () => {
  const esOtros = campoTipo.value === 'Otros';
  $('bloque-otros').classList.toggle('oculto', !esOtros);
  if (!esOtros) { campoDetalle.value = ''; setError('detalle', ''); }
});

// ====== Validación y envío ======
function validar() {
  limpiarErrores();
  let ok = true;

  const patente = normalizarPatente(campoPatente.value);
  if (!REGEX_PATENTE.test(patente)) {
    setError('patente', 'Ingresa una patente válida (ej: BCDF12).');
    ok = false;
  }

  if (!campoTipo.value) {
    setError('tipo', 'Selecciona el tipo de atención.');
    ok = false;
  }

  if (campoTipo.value === 'Otros' && campoDetalle.value.trim().length < 5) {
    setError('detalle', 'Describe brevemente qué necesitas (mínimo 5 caracteres).');
    ok = false;
  }

  if (!fechaSel) {
    setError('fecha', 'Selecciona un día en el calendario.');
    ok = false;
  } else if (!horaSel) {
    setError('hora', 'Selecciona una hora.');
    ok = false;
  }

  if (campoNombre.value.trim().length < 3) {
    setError('nombre', 'Ingresa tu nombre.');
    ok = false;
  }

  if (!REGEX_TELEFONO.test(campoTelefono.value.trim())) {
    setError('telefono', 'Ingresa un teléfono válido.');
    ok = false;
  }

  return ok;
}

form.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  ocultarMensaje();
  if (!validar()) return;

  const boton = $('btn-reservar');
  boton.disabled = true;
  boton.textContent = 'Reservando…';

  const datos = {
    patente: normalizarPatente(campoPatente.value),
    tipo: campoTipo.value,
    detalle: campoDetalle.value.trim(),
    fecha: fechaSel,
    hora: horaSel,
    nombre: campoNombre.value.trim(),
    telefono: campoTelefono.value.trim()
  };

  try {
    const resp = await fetch(`${API_URL}/reservas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos)
    });
    const resultado = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      if (resp.status === 409) {   // Alguien tomó la hora antes
        horaSel = null;
        await cargarHoras(fechaSel);
      }
      mostrarMensaje(resultado.error || 'No se pudo completar la reserva.', 'error');
    } else {
      const [a, m, d] = datos.fecha.split('-').map(Number);
      mostrarMensaje(
        `¡Reserva confirmada! (N° ${resultado.id}) Te esperamos el ${d} de ${MESES[m - 1]} a las ${datos.hora} con la patente ${datos.patente}.`,
        'ok'
      );
      form.reset();
      $('bloque-otros').classList.add('oculto');
      $('bloque-horas').classList.add('oculto');
      fechaSel = null;
      horaSel = null;
      dibujarCalendario();
    }
  } catch (e) {
    mostrarMensaje('Error de conexión. Intenta nuevamente.', 'error');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Reservar hora';
  }
});

iniciar();
