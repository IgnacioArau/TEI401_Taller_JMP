// ====== Panel de administración ======
const API = '/api/admin';
const REGEX_PATENTE = /^([A-Z]{4}\d{2}|[A-Z]{2}\d{4}|[A-Z]{3}\d{2})$/;
const REGEX_TELEFONO = /^\+?[0-9 ]{8,15}$/;

const $ = (id) => document.getElementById(id);

// ====== Estado ======
let config = null;      // { tipos, hoy, taller }
let mecanicos = [];     // [{ id, nombre, activo, reservas_futuras, ausencias }]
let reservas = [];
let editandoId = null;  // id de la reserva abierta en el diálogo (null = nueva)

// ====== Utilidades ======
// Crea elementos con textContent (nunca innerHTML), así lo que escriban los clientes no puede inyectar HTML.
function el(tag, props = {}, ...hijos) {
  const nodo = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') nodo.className = v;
    else if (k.startsWith('on')) nodo.addEventListener(k.slice(2), v);
    else nodo.setAttribute(k, v === true ? '' : v);
  }
  hijos.flat().forEach((h) => {
    if (h === null || h === undefined || h === false) return;
    nodo.append(h instanceof Node ? h : document.createTextNode(String(h)));
  });
  return nodo;
}

async function api(metodo, ruta, cuerpo) {
  const resp = await fetch(API + ruta, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const datos = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = new Error(datos.error || 'No se pudo completar la operación.');
    e.status = resp.status;
    throw e;
  }
  return datos;
}

let temporizadorMensaje = null;
function mensaje(texto, tipo = 'ok') {
  const caja = $('mensaje');
  caja.textContent = texto;
  caja.className = 'mensaje ' + (tipo === 'ok' ? 'ok' : 'error-msg');
  clearTimeout(temporizadorMensaje);
  if (tipo === 'ok') temporizadorMensaje = setTimeout(() => caja.classList.add('oculto'), 6000);
}

const normalizarPatente = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
const fechaLarga = (f) => {
  const t = new Date(f + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const fechaCorta = (f) => new Date(f + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' });
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// ====== Pestañas ======
function mostrarPestana(nombre) {
  ['reservas', 'mecanicos'].forEach((n) => {
    const activa = n === nombre;
    $('panel-' + n).classList.toggle('oculto', !activa);
    $('tab-' + n).classList.toggle('activa', activa);
    $('tab-' + n).setAttribute('aria-selected', String(activa));
  });
  if (nombre === 'mecanicos') cargarMecanicos();
}
$('tab-reservas').addEventListener('click', () => mostrarPestana('reservas'));
$('tab-mecanicos').addEventListener('click', () => mostrarPestana('mecanicos'));

// ====== Reservas: listado ======
function parametrosFiltro() {
  const p = new URLSearchParams();
  if ($('f-desde').value) p.set('desde', $('f-desde').value);
  if ($('f-hasta').value) p.set('hasta', $('f-hasta').value);
  if ($('f-mecanico').value) p.set('mecanico', $('f-mecanico').value);
  if ($('f-q').value.trim()) p.set('q', $('f-q').value.trim());
  return p.toString();
}

let numeroCarga = 0;   // evita que una respuesta lenta y antigua pise a una más reciente
async function cargarReservas() {
  const miCarga = ++numeroCarga;
  try {
    const datos = await api('GET', '/reservas?' + parametrosFiltro());
    if (miCarga !== numeroCarga) return;
    reservas = datos.reservas;
    dibujarReservas(datos.limite);
  } catch (e) {
    mensaje(e.message, 'error');
  }
}

function dibujarReservas(limite) {
  const cont = $('lista-reservas');
  cont.replaceChildren();

  const hoy = reservas.filter((r) => r.fecha === config.hoy).length;
  const resumen = $('resumen-reservas');
  resumen.replaceChildren(
    dato(reservas.length, 'reservas en el filtro'),
    dato(hoy, 'de hoy en este filtro'),
    dato(mecanicos.filter((m) => m.activo).length, 'mecánicos activos')
  );

  if (limite) cont.append(el('p', { class: 'nota-limite' }, 'Se muestran las primeras 1000 reservas. Acota el rango de fechas para ver el resto.'));

  if (!reservas.length) {
    cont.append(el('div', { class: 'vacio' }, 'No hay reservas con estos filtros.'));
    return;
  }

  const porDia = new Map();
  reservas.forEach((r) => {
    if (!porDia.has(r.fecha)) porDia.set(r.fecha, []);
    porDia.get(r.fecha).push(r);
  });

  porDia.forEach((lista, fecha) => {
    const filas = lista.map((r) => el('tr', {},
      el('td', { class: 'hora-col' }, r.hora),
      el('td', { class: 'patente-col' }, r.patente),
      el('td', {}, r.nombre, el('span', { class: 'sub' }, r.telefono)),
      el('td', {}, r.tipo, r.detalle ? el('span', { class: 'sub' }, r.detalle) : null),
      el('td', {}, r.mecanico),
      el('td', { class: 'acciones' },
        el('button', { type: 'button', class: 'btn-chico', onclick: () => abrirDialogo(r) }, 'Editar'),
        el('button', { type: 'button', class: 'btn-chico peligro', onclick: () => eliminarReserva(r) }, 'Eliminar')
      )
    ));

    cont.append(el('div', { class: 'grupo-dia' },
      el('h3', {}, fechaLarga(fecha), el('small', {}, plural(lista.length, 'reserva', 'reservas')), fecha === config.hoy ? el('span', { class: 'insignia ok' }, 'Hoy') : null),
      el('div', { class: 'tabla-scroll' },
        el('table', {},
          el('thead', {}, el('tr', {}, ...['Hora', 'Patente', 'Cliente', 'Atención', 'Mecánico', ''].map((t) => el('th', {}, t)))),
          el('tbody', {}, filas)
        )
      )
    ));
  });
}

function dato(numero, texto) {
  return el('div', { class: 'dato' }, el('strong', {}, numero), el('span', {}, texto));
}

async function eliminarReserva(r) {
  if (!confirm(`¿Eliminar la reserva de ${r.nombre} (${r.patente}) del ${fechaCorta(r.fecha)} a las ${r.hora}?\nEsta acción no se puede deshacer.`)) return;
  try {
    await api('DELETE', '/reservas/' + r.id);
    mensaje('Reserva eliminada.');
    cargarReservas();
  } catch (e) {
    mensaje(e.message, 'error');
  }
}

// Filtros
['f-desde', 'f-hasta', 'f-mecanico'].forEach((id) => $(id).addEventListener('change', cargarReservas));
let temporizadorBusqueda = null;
$('f-q').addEventListener('input', () => {
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(cargarReservas, 300);
});
$('filtros').addEventListener('submit', (e) => e.preventDefault());
$('f-limpiar').addEventListener('click', () => {
  $('f-desde').value = config.hoy;
  $('f-hasta').value = '';
  $('f-mecanico').value = '';
  $('f-q').value = '';
  cargarReservas();
});

// ====== Reservas: diálogo para crear / editar ======
const dlg = $('dlg-reserva');
let disponibilidad = [];   // horas del día elegido en el diálogo

function errorDialogo(texto) { $('r-error').textContent = texto || ''; }

async function abrirDialogo(reserva) {
  editandoId = reserva ? reserva.id : null;
  $('dlg-titulo').textContent = reserva ? `Editar reserva N° ${reserva.id}` : 'Nueva reserva';
  errorDialogo('');

  $('r-patente').value = reserva ? reserva.patente : '';
  $('r-tipo').value = reserva ? reserva.tipo : '';
  $('r-detalle').value = reserva && reserva.detalle ? reserva.detalle : '';
  $('r-bloque-detalle').classList.toggle('oculto', $('r-tipo').value !== 'Otros');
  $('r-nombre').value = reserva ? reserva.nombre : '';
  $('r-telefono').value = reserva ? reserva.telefono : '';
  $('r-fecha').value = reserva ? reserva.fecha : '';
  $('r-hora').replaceChildren(el('option', { value: '' }, 'Elige una fecha'));
  $('r-hora').disabled = true;
  $('r-mecanico').replaceChildren(el('option', { value: '' }, reserva ? 'Mantener actual' : 'Automático'));
  $('r-mecanico').disabled = true;
  $('r-ayuda').textContent = '';

  dlg.showModal();
  if (reserva) await cargarHorasDialogo(reserva.hora, reserva.mecanico_id);
  else $('r-patente').focus();
}

// Carga las horas del día elegido con sus cupos; al editar, la reserva no cuenta contra su propio cupo.
async function cargarHorasDialogo(horaPreseleccionada, mecanicoPreseleccionado) {
  const fecha = $('r-fecha').value;
  const selHora = $('r-hora');
  disponibilidad = [];
  if (!fecha) {
    selHora.replaceChildren(el('option', { value: '' }, 'Elige una fecha'));
    selHora.disabled = true;
    actualizarMecanicosDialogo();
    return;
  }
  try {
    const q = new URLSearchParams({ fecha });
    if (editandoId) q.set('excluir', editandoId);
    const datos = await api('GET', '/disponibilidad?' + q);
    if ($('r-fecha').value !== fecha) return;   // el usuario cambió la fecha mientras cargaba
    disponibilidad = datos.horas;
    if (datos.cerrado) {
      selHora.replaceChildren(el('option', { value: '' }, 'El taller no atiende ese día'));
      selHora.disabled = true;
      $('r-ayuda').textContent = '';
      actualizarMecanicosDialogo();
      return;
    }
    selHora.replaceChildren(
      el('option', { value: '' }, 'Elige una hora…'),
      ...datos.horas.map((h) => el('option', { value: h.hora, disabled: h.cupos === 0 }, `${h.hora} · ${h.cupos === 0 ? 'sin cupos' : plural(h.cupos, 'cupo', 'cupos')}`))
    );
    selHora.disabled = false;
    if (horaPreseleccionada && datos.horas.some((h) => h.hora === horaPreseleccionada)) selHora.value = horaPreseleccionada;
    actualizarMecanicosDialogo(mecanicoPreseleccionado);
  } catch (e) {
    errorDialogo(e.message);
  }
}

// Lista solo los mecánicos libres a la hora elegida.
function actualizarMecanicosDialogo(preseleccionado) {
  const sel = $('r-mecanico');
  const previo = preseleccionado !== undefined ? String(preseleccionado) : sel.value;
  const hora = disponibilidad.find((h) => h.hora === $('r-hora').value);
  sel.replaceChildren(el('option', { value: '' }, editandoId ? 'Mantener actual' : 'Automático'));

  if (!hora) { sel.disabled = true; $('r-ayuda').textContent = ''; return; }

  hora.libres.forEach((id) => {
    const m = mecanicos.find((x) => x.id === id);
    if (m) sel.append(el('option', { value: id }, m.nombre));
  });
  sel.disabled = false;
  sel.value = [...sel.options].some((o) => o.value === previo) ? previo : '';
  $('r-ayuda').textContent = `Mecánicos libres a las ${hora.hora}: ${hora.libres.length}.`;
}

$('r-fecha').addEventListener('change', () => cargarHorasDialogo());
$('r-hora').addEventListener('change', () => actualizarMecanicosDialogo());
$('r-patente').addEventListener('input', (e) => { e.target.value = normalizarPatente(e.target.value); });
$('r-tipo').addEventListener('change', () => {
  $('r-bloque-detalle').classList.toggle('oculto', $('r-tipo').value !== 'Otros');
});
$('btn-nueva').addEventListener('click', () => abrirDialogo(null));
$('r-cancelar').addEventListener('click', () => dlg.close());

$('form-reserva-admin').addEventListener('submit', async (e) => {
  e.preventDefault();
  errorDialogo('');

  const datos = {
    patente: normalizarPatente($('r-patente').value),
    tipo: $('r-tipo').value,
    detalle: $('r-detalle').value.trim(),
    nombre: $('r-nombre').value.trim(),
    telefono: $('r-telefono').value.trim(),
    fecha: $('r-fecha').value,
    hora: $('r-hora').value,
    mecanico_id: $('r-mecanico').value ? Number($('r-mecanico').value) : null
  };

  if (!REGEX_PATENTE.test(datos.patente)) return errorDialogo('Ingresa una patente válida (ej: BCDF12).');
  if (!datos.tipo) return errorDialogo('Selecciona el tipo de atención.');
  if (datos.tipo === 'Otros' && datos.detalle.length < 5) return errorDialogo('Describe qué necesita el cliente (mínimo 5 caracteres).');
  if (datos.nombre.length < 3) return errorDialogo('Ingresa el nombre del cliente.');
  if (!REGEX_TELEFONO.test(datos.telefono)) return errorDialogo('Ingresa un teléfono válido.');
  if (!datos.fecha) return errorDialogo('Selecciona la fecha.');
  if (!datos.hora) return errorDialogo('Selecciona la hora.');

  const boton = $('r-guardar');
  boton.disabled = true;
  try {
    if (editandoId) {
      const r = await api('PUT', '/reservas/' + editandoId, datos);
      mensaje(r.reasignado ? 'Reserva actualizada. Se asignó otro mecánico porque el anterior no estaba libre a esa hora.' : 'Reserva actualizada.');
    } else {
      const r = await api('POST', '/reservas', datos);
      mensaje(`Reserva N° ${r.id} creada.`);
    }
    dlg.close();
    // Si la reserva queda fuera del rango filtrado, se amplía para que se vea.
    if ($('f-desde').value && datos.fecha < $('f-desde').value) $('f-desde').value = datos.fecha;
    if ($('f-hasta').value && datos.fecha > $('f-hasta').value) $('f-hasta').value = datos.fecha;
    await cargarMecanicosDatos();
    await cargarReservas();
  } catch (err) {
    errorDialogo(err.message);
    if (err.status === 409) cargarHorasDialogo(datos.hora, datos.mecanico_id);   // refresca los cupos
  } finally {
    boton.disabled = false;
  }
});

// ====== Mecánicos ======
async function cargarMecanicosDatos() {
  const datos = await api('GET', '/mecanicos');
  mecanicos = datos.mecanicos;
  const sel = $('f-mecanico');
  const actual = sel.value;
  sel.replaceChildren(el('option', { value: '' }, 'Todos'), ...mecanicos.map((m) => el('option', { value: m.id }, m.nombre + (m.activo ? '' : ' (de baja)'))));
  sel.value = actual;
}

async function cargarMecanicos() {
  try {
    await cargarMecanicosDatos();
    dibujarMecanicos();
  } catch (e) {
    mensaje(e.message, 'error');
  }
}

function dibujarMecanicos() {
  const activos = mecanicos.filter((m) => m.activo);
  const disponiblesHoy = activos.filter((m) => !m.ausencias.some((a) => a.fecha === config.hoy));
  $('resumen-mecanicos').replaceChildren(
    dato(activos.length, `mecánicos activos (de ${mecanicos.length})`),
    dato(disponiblesHoy.length, 'cupos por hora hoy (activos sin ausencia)')
  );

  const cont = $('lista-mecanicos');
  cont.replaceChildren(...mecanicos.map(tarjetaMecanico));
}

function tarjetaMecanico(m) {
  const ausenteHoy = m.ausencias.some((a) => a.fecha === config.hoy);
  const inputNombre = el('input', { type: 'text', value: m.nombre, maxlength: '60', 'aria-label': `Nombre del mecánico ${m.id}` });
  const inputFecha = el('input', { type: 'date', min: config.hoy, 'aria-label': 'Fecha de ausencia' });
  const inputMotivo = el('input', { type: 'text', maxlength: '100', placeholder: 'Motivo (opcional)', 'aria-label': 'Motivo de ausencia' });

  const guardarNombre = async () => {
    const nuevo = inputNombre.value.trim();
    if (nuevo === m.nombre) return;
    try {
      await api('PUT', '/mecanicos/' + m.id, { nombre: nuevo });
      mensaje('Nombre actualizado.');
      await cargarMecanicos();
      cargarReservas();
    } catch (e) {
      mensaje(e.message, 'error');
      inputNombre.value = m.nombre;
    }
  };

  const cambiarActivo = async () => {
    if (m.activo && !confirm(`¿Dar de baja a ${m.nombre}? Dejará de recibir reservas nuevas.\nSus reservas futuras (${m.reservas_futuras}) no se mueven solas.`)) return;
    try {
      const r = await api('PUT', '/mecanicos/' + m.id, { activo: !m.activo });
      mensaje(m.activo
        ? `${m.nombre} dado de baja.` + (r.reservas_afectadas ? ` Tiene ${plural(r.reservas_afectadas, 'reserva futura', 'reservas futuras')}: revísalas y reasígnalas.` : '')
        : `${m.nombre} activado.`, m.activo && r.reservas_afectadas ? 'error' : 'ok');
      await cargarMecanicos();
    } catch (e) {
      mensaje(e.message, 'error');
    }
  };

  const agregarAusencia = async (ev) => {
    ev.preventDefault();
    if (!inputFecha.value) return mensaje('Elige la fecha de la ausencia.', 'error');
    try {
      const r = await api('POST', `/mecanicos/${m.id}/ausencias`, { fecha: inputFecha.value, motivo: inputMotivo.value });
      const aviso = r.reservas_afectadas
        ? `Ausencia registrada, pero ${m.nombre} ya tiene ${plural(r.reservas_afectadas, 'reserva', 'reservas')} ese día. Edítalas para reasignarlas.`
        : 'Ausencia registrada.';
      mensaje(aviso, r.reservas_afectadas ? 'error' : 'ok');
      await cargarMecanicos();
    } catch (e) {
      mensaje(e.message, 'error');
    }
  };

  const quitarAusencia = async (a) => {
    try {
      await api('DELETE', `/mecanicos/${m.id}/ausencias/${a.fecha}`);
      mensaje('Ausencia eliminada.');
      await cargarMecanicos();
    } catch (e) {
      mensaje(e.message, 'error');
    }
  };

  return el('article', { class: 'mecanico' + (m.activo ? '' : ' inactivo') },
    el('div', { class: 'mecanico-cab' },
      inputNombre,
      el('button', { type: 'button', class: 'btn-chico', onclick: guardarNombre }, 'Guardar')
    ),
    el('div', { class: 'mecanico-meta' },
      el('span', {},
        el('span', { class: 'insignia ' + (m.activo ? 'ok' : 'baja') }, m.activo ? 'Activo' : 'De baja'), ' ',
        ausenteHoy && m.activo ? el('span', { class: 'insignia aus' }, 'Ausente hoy') : null
      ),
      el('span', {}, plural(m.reservas_futuras, 'reserva futura', 'reservas futuras')),
      el('button', { type: 'button', class: 'btn-chico' + (m.activo ? ' peligro' : ''), onclick: cambiarActivo }, m.activo ? 'Dar de baja' : 'Activar')
    ),
    el('h4', {}, 'Días no disponibles'),
    el('div', { class: 'chips' },
      m.ausencias.length
        ? m.ausencias.map((a) => el('span', { class: 'chip' },
            fechaCorta(a.fecha) + (a.motivo ? ` · ${a.motivo}` : ''),
            el('button', { type: 'button', 'aria-label': `Quitar ausencia del ${a.fecha}`, onclick: () => quitarAusencia(a) }, '×')))
        : el('span', { class: 'sin-datos' }, 'Sin ausencias registradas')
    ),
    el('form', { class: 'form-ausencia', onsubmit: agregarAusencia }, inputFecha, inputMotivo, el('button', { type: 'submit', class: 'btn-chico' }, 'Registrar ausencia'))
  );
}

$('form-mecanico').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('m-nombre').value.trim();
  try {
    await api('POST', '/mecanicos', { nombre });
    $('m-nombre').value = '';
    mensaje(`Mecánico "${nombre}" agregado.`);
    await cargarMecanicos();
  } catch (err) {
    mensaje(err.message, 'error');
  }
});

// ====== Inicio ======
async function iniciar() {
  try {
    config = await api('GET', '/config');
    document.title = `Administración | ${config.taller.nombre}`;
    $('taller-nombre').textContent = config.taller.nombre;

    $('r-tipo').append(...config.tipos.map((t) => el('option', { value: t }, t)));
    $('f-desde').value = config.hoy;

    await cargarMecanicosDatos();
    await cargarReservas();
  } catch (e) {
    mensaje(e.message, 'error');
  }
}

iniciar();
