/**
 * =================================================================
 * ¿LLEGARON LOS REPORTES DE LICENCIAS VEEAM AL DRIVE?
 * =================================================================
 *
 * El ciclo de licencias Veeam corre el último día hábil del mes y arma el mail al POD leyendo
 * los CSV que alguien subió a Drive entre el 27 y ese día (tarea mensual OPS-VEM-0XX). Hasta
 * ahora, si un cliente no subía el suyo no se enteraba nadie — y hay algo peor que el silencio:
 * `obtenerSubcarpetaMasReciente()` toma la carpeta de fecha MÁS RECIENTE, no la del mes en curso.
 * O sea que si falta octubre, el ciclo lee septiembre y manda el mail como si los datos fueran
 * de hoy. Un reporte viejo presentado como actual es peor que no tener reporte.
 *
 * Este archivo chequea, por cliente activo en Veeam, que exista la carpeta del mes EN CURSO con
 * al menos un CSV legible, y lo avisa al canal de logs. Dos momentos, a propósito:
 *
 *   - `gatilloAvisoLicenciasVeeam()` — el día 28. Recordatorio con tiempo de sobra para subir lo
 *     que falte. Se avisa el 28 y punto, sin corrimiento por fin de semana: el mensaje queda en
 *     el canal hasta que alguien lo lee, así que mover la fecha sólo agregaría aritmética que
 *     puede fallar sin ganar nada.
 *   - `avisarLicenciasVeeamPendientesAntesDelCiclo()` — el último día hábil, justo antes de que
 *     arranque la auditoría. Este es el que importa: después de ese punto el mail sale con lo
 *     que haya en el Drive.
 *
 * ES DE SOLO LECTURA: abre carpetas y lee CSVs. No escribe en Drive, ni en la planilla, ni toca
 * el estado del ciclo.
 *
 * La configuración sale de la misma solapa que usa el ciclo (`leerConfiguracionLicencias`), así
 * que la lista de clientes y los IDs de carpeta no se mantienen acá: si alguien da de alta un
 * cliente en Veeam, este chequeo lo incluye solo (AGENTS.md §5).
 */

const LIC_PEND_OK            = 'OK';
const LIC_PEND_SIN_ANIO      = 'SIN_CARPETA_ANIO';
const LIC_PEND_SIN_MES       = 'SIN_CARPETA_DEL_MES';
const LIC_PEND_SIN_CSV       = 'SIN_CSV';
const LIC_PEND_CSV_ILEGIBLE  = 'CSV_ILEGIBLE';
const LIC_PEND_ERROR_CARPETA = 'ERROR_ABRIENDO_CARPETA';

// Apps Script corta a los 6 minutos. Abrir carpetas y parsear CSVs de ~20 clientes entra
// cómodo, pero si algún día no entra, mejor cortar ordenadamente y decir por dónde se iba
// que morir a mitad de camino sin reportar nada.
const LIC_PEND_MINUTOS_MAX = 4.5;

/**
 * Revisa el Drive de cada cliente activo en Veeam y clasifica qué encontró.
 *
 * @param {Object} [opciones]
 * @param {Date}   [opciones.fecha] Fecha de referencia; por defecto hoy. Sirve para revisar un
 *   mes anterior sin tocar nada (`{fecha: new Date(2026, 8, 15)}` revisa septiembre).
 * @param {boolean} [opciones.validarCsv=true] En false sólo chequea que haya un CSV, sin leerlo.
 *   Es bastante más rápido; el ciclo real lo deja en true porque un CSV que no parsea es
 *   exactamente igual de inútil que uno que no está.
 * @returns {{mes: string, revisados: number, clientes: Array, faltantes: Array, cortadoEn: ?string}}
 */
function revisarReportesVeeamDelMes(opciones) {
  const opts = opciones || {};
  const t0 = Date.now();
  const limiteMs = LIC_PEND_MINUTOS_MAX * 60 * 1000;
  const validarCsv = opts.validarCsv !== false;

  const hoy = opts.fecha || new Date();
  const anio = String(hoy.getFullYear());
  const mes = ('0' + (hoy.getMonth() + 1)).slice(-2);
  const prefijoMes = anio + mes;

  const { datos, cols } = leerConfiguracionLicencias(LIC_TECNOLOGIA_VEEAM);

  const clientes = [];
  let cortadoEn = null;

  for (let i = 1; i < datos.length; i++) {
    const fila = leerFilaLicencias(datos[i], cols);
    if (!filaLicenciasCompleta(fila) || !fila.activo) continue;

    if (Date.now() - t0 > limiteMs) {
      cortadoEn = String(fila.cliente);
      Logger.log(`[LicenciasPendientes] Presupuesto de tiempo agotado antes de "${cortadoEn}".`);
      break;
    }

    clientes.push(_licPendRevisarCliente(fila, prefijoMes, validarCsv));
  }

  const faltantes = clientes.filter(c => c.estado !== LIC_PEND_OK);

  return {
    mes: anio + '-' + mes,
    revisados: clientes.length,
    clientes: clientes,
    faltantes: faltantes,
    cortadoEn: cortadoEn
  };
}

/**
 * Un cliente: busca la carpeta del mes y, si está, mira los CSV que tiene adentro.
 */
function _licPendRevisarCliente(fila, prefijoMes, validarCsv) {
  const base = {
    cliente: String(fila.cliente).trim(),
    pod: String(fila.pod || '').trim() || 'Sin POD',
    ruta: '',
    detalle: ''
  };

  let anioFolder;
  try {
    const raiz = DriveApp.getFolderById(fila.carpeta);
    anioFolder = _licPendSubcarpetaPorNombre(raiz, prefijoMes.slice(0, 4));
  } catch (e) {
    // AGENTS.md §7: una carpeta que no se pudo abrir no puede confundirse con "falta el reporte".
    base.estado = LIC_PEND_ERROR_CARPETA;
    base.detalle = e.message;
    return base;
  }

  if (!anioFolder) {
    base.estado = LIC_PEND_SIN_ANIO;
    base.detalle = `no existe la carpeta de año ${prefijoMes.slice(0, 4)}`;
    return base;
  }

  const carpetaMes = _licPendCarpetaDeFechaDelMes(anioFolder, prefijoMes);
  if (!carpetaMes) {
    base.estado = LIC_PEND_SIN_MES;
    base.detalle = `${anioFolder.getName()} no tiene ninguna carpeta ${prefijoMes}xx`;
    return base;
  }

  base.ruta = anioFolder.getName() + ' > ' + carpetaMes.getName();

  const csvs = _licPendCsvsDe(carpetaMes);
  if (csvs.length === 0) {
    base.estado = LIC_PEND_SIN_CSV;
    base.detalle = 'la carpeta del mes existe pero no tiene ningún .csv';
    return base;
  }

  if (!validarCsv) {
    base.estado = LIC_PEND_OK;
    base.detalle = `${csvs.length} CSV (sin validar contenido)`;
    return base;
  }

  const validacion = _licPendValidarCsvs(base.cliente, csvs);
  if (validacion.licencias === 0) {
    base.estado = LIC_PEND_CSV_ILEGIBLE;
    base.detalle = `${csvs.length} CSV pero ninguna licencia legible` +
      (validacion.errores.length ? ` — ${validacion.errores[0]}` : '');
    return base;
  }

  base.estado = LIC_PEND_OK;
  base.detalle = `${csvs.length} CSV, ${validacion.licencias} licencias legibles`;
  if (validacion.errores.length) {
    base.detalle += ` (con ${validacion.errores.length} aviso(s): ${validacion.errores[0]})`;
  }
  return base;
}

/**
 * Subcarpeta por nombre exacto. `getFoldersByName` trae todas las que coincidan; alcanza con la
 * primera, pero si hay más de una con el mismo nombre queda en el log: es un problema del Drive
 * que conviene ver antes de que sea un problema del reporte.
 */
function _licPendSubcarpetaPorNombre(carpetaPadre, nombre) {
  const it = carpetaPadre.getFoldersByName(nombre);
  if (!it.hasNext()) return null;
  const primera = it.next();
  if (it.hasNext()) {
    Logger.log(`[LicenciasPendientes] Hay más de una carpeta llamada "${nombre}" en "${carpetaPadre.getName()}". Se usa la primera.`);
  }
  return primera;
}

/**
 * La carpeta de fecha del mes pedido, la más reciente si hay varias.
 *
 * A diferencia de `obtenerSubcarpetaMasReciente()`, que toma la fecha más alta que encuentre sin
 * mirar de qué mes es, acá el mes es parte del filtro. Esa diferencia es el motivo de este
 * archivo: tomar "la más reciente" es lo que hace que un reporte de septiembre pase por el de
 * octubre cuando octubre no se subió.
 */
function _licPendCarpetaDeFechaDelMes(anioFolder, prefijoMes) {
  const subs = anioFolder.getFolders();
  let elegida = null;
  let nombreElegido = '';

  while (subs.hasNext()) {
    const carpeta = subs.next();
    const nombre = carpeta.getName().trim();
    if (!_licPendEsNombreDeFecha(nombre)) continue;
    if (nombre.slice(0, 6) !== prefijoMes) continue;
    if (nombre > nombreElegido) {
      nombreElegido = nombre;
      elegida = carpeta;
    }
  }

  return elegida;
}

/**
 * ¿Arranca con 8 dígitos (YYYYMMDD)? Sin expresiones regulares a propósito: este proyecto ya
 * perdió una barra invertida en un regex al editarlo con herramientas de texto, y un chequeo de
 * 8 dígitos no necesita una.
 */
function _licPendEsNombreDeFecha(nombre) {
  if (!nombre || nombre.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    const c = nombre.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** Los .csv de una carpeta. */
function _licPendCsvsDe(carpeta) {
  const archivos = carpeta.getFiles();
  const csvs = [];
  while (archivos.hasNext()) {
    const archivo = archivos.next();
    const nombre = archivo.getName().toLowerCase();
    if (nombre.length > 4 && nombre.slice(-4) === '.csv') csvs.push(archivo);
  }
  return csvs;
}

/**
 * Lee los CSV con el MISMO parser y el MISMO analizador que usa el ciclo real
 * (`parseCsvDeReporte` + `analizarLicenciasVeeam`). Si acá dan licencias, el ciclo también las va
 * a leer; si acá no dan ninguna, el ciclo iba a mandar un mail vacío. Validar con otro parser
 * sería adivinar (AGENTS.md §5).
 */
function _licPendValidarCsvs(cliente, archivos) {
  let licencias = 0;
  const errores = [];

  archivos.forEach(archivo => {
    try {
      const parsed = parseCsvDeReporte(archivo.getBlob().getDataAsString());
      const resultado = analizarLicenciasVeeam(parsed, cliente);
      licencias += (resultado.licencias || []).length;
      (resultado.errores || []).forEach(e => {
        errores.push(`${archivo.getName()}: ${e.mensaje || e.servidor || e}`);
      });
    } catch (e) {
      errores.push(`${archivo.getName()}: ${e.message}`);
    }
  });

  return { licencias: licencias, errores: errores };
}

/**
 * Arma el mensaje para Slack, agrupado por POD. El POD sale de la misma solapa, así que el
 * mensaje queda ordenado por quién tiene que actuar y no como una lista plana de clientes.
 */
function _licPendMensajeSlack(resultado, encabezado) {
  const lineas = [];
  lineas.push(`*${encabezado}*`);
  lineas.push(`Mes ${resultado.mes} · ${resultado.revisados} cliente(s) activo(s) en Veeam revisado(s) · faltan ${resultado.faltantes.length}`);

  if (resultado.faltantes.length === 0) {
    lineas.push('');
    lineas.push('Están todos los reportes del mes en el Drive.');
  } else {
    const porPod = {};
    resultado.faltantes.forEach(c => {
      if (!porPod[c.pod]) porPod[c.pod] = [];
      porPod[c.pod].push(c);
    });

    Object.keys(porPod).sort().forEach(pod => {
      lineas.push('');
      lineas.push(`*${pod}*`);
      porPod[pod].forEach(c => {
        lineas.push(`• ${c.cliente} — ${c.detalle}`);
      });
    });
  }

  if (resultado.cortadoEn) {
    lineas.push('');
    lineas.push(`:warning: La revisión se cortó por tiempo en "${resultado.cortadoEn}": hay clientes sin revisar.`);
  }

  return lineas.join('\n');
}

/**
 * Revisa y deja todo en el log, sin mandar nada a Slack.
 *
 * Script Alarmas no tiene Playground: se prueba en producción. Esta función existe para esa
 * primera corrida — se mira el resultado contra el Drive a mano y recién después se instala el
 * activador que avisa de verdad.
 */
function manual_revisarLicenciasVeeamPendientes() {
  const resultado = revisarReportesVeeamDelMes();
  Logger.log('=== REVISIÓN DE REPORTES DE LICENCIAS VEEAM (solo log, no se envía nada) ===');
  Logger.log(_licPendMensajeSlack(resultado, 'Licencias Veeam — reportes del mes en el Drive'));
  Logger.log('');
  Logger.log('--- detalle de TODOS los clientes, incluidos los que están bien ---');
  resultado.clientes.forEach(c => {
    Logger.log(`[${c.estado}] ${c.pod} / ${c.cliente}${c.ruta ? ' (' + c.ruta + ')' : ''} — ${c.detalle}`);
  });
  return resultado;
}

/** Revisa y manda el aviso al canal de logs, sin esperar al día 28. */
function manual_avisarLicenciasVeeamPendientes() {
  return _licPendRevisarYAvisar('Licencias Veeam — reportes del mes en el Drive');
}

/**
 * Recordatorio del día 28. Se instala como activador diario y aborta solo el resto del mes.
 */
function gatilloAvisoLicenciasVeeam() {
  const hoy = new Date();
  if (hoy.getDate() !== 28) {
    Logger.log(`[LicenciasPendientes] Hoy es ${hoy.getDate()}, el recordatorio sale el 28. Nada que hacer.`);
    return;
  }
  return _licPendRevisarYAvisar('Licencias Veeam — recordatorio: faltan reportes del mes');
}

/**
 * El aviso del último día hábil, justo antes de que arranque la auditoría.
 *
 * Se llama desde `gatilloDiarioVeeamLic()`, antes de encolar el ciclo, y nunca lanza: si la
 * revisión falla, el ciclo tiene que correr igual. Un chequeo que impide la auditoría es peor
 * que no tener chequeo.
 */
function avisarLicenciasVeeamPendientesAntesDelCiclo() {
  try {
    return _licPendRevisarYAvisar('Licencias Veeam — último día hábil: el ciclo arranca con lo que haya en el Drive');
  } catch (e) {
    Logger.log(`[LicenciasPendientes] La revisión previa al ciclo falló (${e.message}). El ciclo sigue igual.`);
    return null;
  }
}

function _licPendRevisarYAvisar(encabezado) {
  const resultado = revisarReportesVeeamDelMes();
  const mensaje = _licPendMensajeSlack(resultado, encabezado);
  Logger.log(mensaje);
  SlackService.enviarLogTexto(mensaje);
  return resultado;
}

/**
 * =================================================================
 * EL RESUMEN DE CADA CICLO DE LICENCIAS, QUE NUNCA SE ENVIABA
 * =================================================================
 *
 * Los dos ciclos (vSphere y Veeam) terminaban llamando a `enviarResumenSlack(...)`, una función
 * que vive en el proyecto de **Ops** y no en este. Los llamados estaban envueltos en
 * `typeof enviarResumenSlack === "function"`, así que no hacían nada y nadie se enteró: el
 * resumen de la auditoría de licencias nunca llegó a Slack.
 *
 * Son dos proyectos de Apps Script separados y no pueden compartir código, así que esta es la
 * versión local. Va al canal de **logs**, no al de guardia: es un proceso interno del área, no
 * una alarma de fin de semana.
 */
function enviarResumenLicenciasALogs(operationName, summaryReport) {
  const r = summaryReport || {};
  const exitos = r.exitos || [];
  const errores = r.errores || [];
  const advertencias = r.advertencias || [];
  if (exitos.length === 0 && errores.length === 0 && advertencias.length === 0) return;

  const detalle = (item) => {
    if (item === null || item === undefined) return '';
    if (typeof item === 'string') return item;
    return [item.cliente, item.error || item.problema || item.mensaje, item.detalle]
      .filter(Boolean).join(' — ');
  };

  const lineas = [`*${operationName}*`];
  lineas.push(`${exitos.length} ok · ${errores.length} error(es) · ${advertencias.length} advertencia(s)`);

  // Se recortan las listas largas: un resumen de 60 líneas en Slack no lo lee nadie, y el
  // detalle completo queda en el log de la ejecución.
  const bloque = (titulo, items, tope) => {
    if (items.length === 0) return;
    lineas.push('');
    lineas.push(`*${titulo}*`);
    items.slice(0, tope).forEach(i => lineas.push(`• ${detalle(i)}`));
    if (items.length > tope) lineas.push(`• ...y ${items.length - tope} más (ver el log de la ejecución)`);
  };

  bloque('Errores', errores, 15);
  bloque('Advertencias', advertencias, 10);

  SlackService.enviarLogTexto(lineas.join('\n'));
}

/**
 * Instala el activador diario del recordatorio. Hay que correrla una vez, a mano, con la cuenta
 * que corre el resto de los activadores (alarmas@): los activadores quedan atados a quien los
 * crea.
 */
function instalarActivadorAvisoLicenciasVeeam() {
  const yaEsta = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'gatilloAvisoLicenciasVeeam');
  if (yaEsta) {
    Logger.log('El activador de gatilloAvisoLicenciasVeeam ya estaba instalado. No se duplica.');
    return;
  }
  ScriptApp.newTrigger('gatilloAvisoLicenciasVeeam').timeBased().everyDays(1).atHour(9).create();
  Logger.log('Activador instalado: gatilloAvisoLicenciasVeeam, todos los días a las 9 (aborta salvo el 28).');
}
