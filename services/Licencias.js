
function escribirLogAuditoria(hoja, fila, col, exito, detalle) {
  try {
    const celda = hoja.getRange(fila, col);
    celda.setValue(detalle);
    celda.setBackground(exito ? '#d9ead3' : '#f4cccc');
  } catch (e) {
    console.warn("Error escribiendo log en planilla: " + e.message);
  }
}

/**
 * =================================================================
 * SCRIPT DE AUDITORÍA DE LICENCIAS UNIFICADO (vSphere + Veeam)
 * =================================================================
 */

// --- PARSER CSV ---
function detectarSeparadorCsv(contenido, lineasAMuestrear = 5) {
  const lineas = Array.isArray(contenido) ? contenido : String(contenido || '').split(/\r\n|\n|\r/);
  const muestra = lineas.filter(l => l.trim() !== '').slice(0, lineasAMuestrear);

  let comas = 0;
  let puntosYComa = 0;

  for (const linea of muestra) {
    let inQuotes = false;
    for (let i = 0; i < linea.length; i++) {
      const char = linea[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (!inQuotes) {
        if (char === ',') comas++;
        else if (char === ';') puntosYComa++;
      }
    }
  }

  return puntosYComa > comas ? ';' : ',';
}

/**
 * Un analizador de CSV robusto que maneja comillas internas, saltos de línea y detecta separadores (coma o punto y coma).
 * @param {string} csvText El contenido del archivo CSV como texto.
 * @param {string} [separator=null] Separador opcional (si no se indica, autodetecta por la primera línea).
 * @returns {Array<Array<string>>} Un array 2D con los datos del CSV.
 */
function parseCsvDeReporte(csvText) {
  const filas = parseCsvRobust(csvText);

  const separador = detectarSeparadorCsv(csvText);
  const quedoEnUnaSolaColumna = filas.length > 0 && filas.every(fila => fila.length === 1);
  const necesitaDesenvolverse = quedoEnUnaSolaColumna && filas.some(fila => fila[0].includes(separador));

  if (!necesitaDesenvolverse) return filas;

  const desenvuelto = csvText.split(/\r\n|\n|\r/).map(linea => {
    const limpia = linea.trim();
    if (limpia.startsWith('"') && limpia.endsWith('"')) {
      return limpia.substring(1, limpia.length - 1).replace(/""/g, '"');
    }
    return limpia;
  }).join("\n");

  Logger.log("[parseCsvDeReporte] El CSV venía con la fila entera entre comillas: se desenvolvió y reparseó.");
  return parseCsvRobust(desenvuelto, separador);
}


// --- VSPHERE ---
/**
 * =================================================================
 * SCRIPT DE AUDITORÍA DE LICENCIAS (RVTOOLS) - WETCOM (PRODUCCIÓN)
 * LIBRERÍA CORE: "Automatizar Operaciones"
 * =================================================================
 * Lee TODOS los archivos de la subcarpeta YYYY -> YYYYMMDD
 * Pestaña de configuración: "Licencias"
 */

const LICENCIAS_OPERATION_NAME = "Auditoría de Licencias";
const NOMBRE_PESTANA_CONFIG = "Licencias";

const LICENSE_TAB_NAME = "vLicense";
const DIAS_UMBRAL_VENCIMIENTO = 90; // <---------------- ⚠️ Umbral para disparar el aviso.

// Límite de seguridad de Google: 4.5 minutos (270,000 ms). Max permitido es 6 min.
const MAX_TIEMPO_EJECUCION = 270000;

// --- CONTROL DE CONCURRENCIA E IDEMPOTENCIA ---
// Si dos triggers 'gatilloDiarioGuardián' conviven (uno por cada usuario que corrió
// el instalador), ambos disparan el mismo día y duplican los mails. Estas marcas
// garantizan un único ciclo por mes y un único mail por cliente por ciclo.
const PROP_CICLO      = 'LICENCIAS_CICLO';     // "yyyy-MM" del ciclo ya iniciado
const PROP_ENVIADOS   = 'LICENCIAS_ENVIADOS';  // clientes ya notificados en el ciclo
const PROP_BOOKMARK   = 'LICENCIAS_BOOKMARK';
const PROP_REPORTE    = 'LICENCIAS_REPORT';
const LOCK_ESPERA_MS  = 5000;                  // no encolamos: si otro corre, abortamos

/**
 * =================================================================
 * PLANILLA DE CONFIGURACIÓN (solapa "Licencias")
 * =================================================================
 */

/**
 * El script está vinculado a la planilla, así que alcanza con getActiveSpreadsheet(),
 * que en un proyecto vinculado también responde desde un trigger. La Script Property
 * MASTER_INDEX_SHEET_ID queda sólo para correrlo desde un proyecto no vinculado: antes
 * era obligatoria y, si faltaba, vSphere no abría nada y Veeam caía en el ID fijo de
 * otra planilla.
 */
function abrirIndiceLicencias() {
  const activa = SpreadsheetApp.getActiveSpreadsheet();
  if (activa) return activa;
  const id = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
  if (!id) throw new Error("El script no está vinculado a una planilla y no está definida la Script Property MASTER_INDEX_SHEET_ID.");
  return SpreadsheetApp.openById(id);
}

const LIC_TECNOLOGIA_VSPHERE = 'vsphere';
const LIC_TECNOLOGIA_VEEAM   = 'veeam';

// Las columnas se ubican por el encabezado, no por posición: con índices fijos, sumar una
// columna (como pasó al separar "Activo" por tecnología) corría todo en silencio y el
// script leía un "SI" como ID de carpeta y escribía los logs encima de otra columna.
// Por cada dato, los encabezados aceptados ya normalizados, en orden de preferencia.
// "activo" a secas es la columna única de antes de separar por tecnología.
const LIC_ENCABEZADOS = {
  comunes: {
    email:   ['destinatario', 'destinatarios'],
    pod:     ['pods', 'pod'],
    cliente: ['cliente']
  },
  vsphere: {
    carpeta: ['idcarpetalicenciasvsphere', 'idcarpetavsphere'],
    activo:  ['activovsphere', 'activo'],
    log:     ['logsvsphere', 'logvsphere']
  },
  veeam: {
    carpeta: ['idcarpetalicenciasveeam', 'idcarpetaveeam'],
    activo:  ['activoveeam', 'activo'],
    log:     ['logsveeam', 'logveeam']
  }
};

/** "ID Carpeta Licencias vSphere " -> "idcarpetalicenciasvsphere" */
function normalizarEncabezadoLicencias(texto) {
  return (texto === null || texto === undefined ? '' : texto.toString())
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * @param {Array} encabezados - la fila 1 de la solapa.
 * @param {string} tecnologia - LIC_TECNOLOGIA_VSPHERE | LIC_TECNOLOGIA_VEEAM
 * @returns {{email:number, pod:number, cliente:number, carpeta:number, activo:number, log:number}}
 *   Índices 0-based. pod y log valen -1 si no están: se puede auditar sin ellos.
 * @throws si falta una columna sin la que no se puede auditar.
 */
function mapearColumnasLicencias(encabezados, tecnologia) {
  const normalizados = encabezados.map(normalizarEncabezadoLicencias);
  const buscar = (candidatos) => {
    for (const c of candidatos) {
      const idx = normalizados.indexOf(c);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const grupos = [LIC_ENCABEZADOS.comunes, LIC_ENCABEZADOS[tecnologia]];
  const cols = {};
  grupos.forEach(g => Object.keys(g).forEach(k => { cols[k] = buscar(g[k]); }));

  const faltantes = ['email', 'cliente', 'carpeta', 'activo'].filter(k => cols[k] === -1);
  if (faltantes.length > 0) {
    throw new Error(`A la solapa "${NOMBRE_PESTANA_CONFIG}" le faltan columnas de ${tecnologia}: ${faltantes.join(', ')}. ` +
                    `Encabezados encontrados: ${encabezados.filter(h => h !== '' && h !== null).join(' | ')}`);
  }
  if (cols.log === -1) {
    console.warn(`⚠️ No se encontró la columna de logs de ${tecnologia}: el resultado no va a quedar escrito en la planilla.`);
  }
  return cols;
}

/** Una fila de la solapa, leída con el mapa de columnas de su tecnología. */
function leerFilaLicencias(fila, cols) {
  const valor = (idx) => (idx === -1 ? '' : fila[idx]);
  return {
    email:   valor(cols.email),
    pod:     valor(cols.pod),
    cliente: valor(cols.cliente),
    carpeta: (valor(cols.carpeta) || '').toString().trim(),
    // Sólo "NO" excluye: vacío cuenta como activo, igual que antes de separar por tecnología.
    activo:  (valor(cols.activo) || '').toString().trim().toUpperCase() !== 'NO'
  };
}

/** Tiene lo mínimo para auditar esa tecnología (sin mirar "Activo"). */
function filaLicenciasCompleta(f) {
  return !!(f.cliente && f.email && f.carpeta);
}

/** La fila donde el operador tiene el cursor (filaHoja 1-based), leída con sus columnas. */
function leerFilaSeleccionadaLicencias(hoja, filaHoja, tecnologia) {
  const ancho = hoja.getLastColumn();
  const encabezados = hoja.getRange(1, 1, 1, ancho).getValues()[0];
  const cols = mapearColumnasLicencias(encabezados, tecnologia);
  const fila = leerFilaLicencias(hoja.getRange(filaHoja, 1, 1, ancho).getValues()[0], cols);
  return { cols, fila };
}

/** filaHoja es 1-based, como en la planilla. */
function escribirLogLicencias(hoja, filaHoja, cols, exito, detalle) {
  if (cols.log === -1) return;
  escribirLogAuditoria(hoja, filaHoja, cols.log + 1, exito, detalle);
}

/**
 * Abre la solapa y resuelve sus columnas. Si algo falla lanza, y el motor se va antes de
 * marcar el ciclo: así el mes no queda dado por hecho y alcanza con corregir y volver a correr.
 */
function leerConfiguracionLicencias(tecnologia) {
  const hoja = abrirIndiceLicencias().getSheetByName(NOMBRE_PESTANA_CONFIG);
  if (!hoja) throw new Error(`No existe la solapa "${NOMBRE_PESTANA_CONFIG}".`);
  const datos = hoja.getDataRange().getValues();
  const cols = mapearColumnasLicencias(datos[0] || [], tecnologia);
  return { hoja, datos, cols };
}

/**
 * =================================================================
 * ESTADO, COLA Y DESPACHO DE CORRIDAS
 * =================================================================
 * vSphere y Veeam comparten el candado de script, así que nunca corren a la vez. Una
 * corrida larga se corta cada ~4,5 min y sigue en segundo plano; mientras tanto el
 * candado queda libre entre tramo y tramo. Sin cola, lo que arrancaba en ese hueco le
 * robaba el candado a la continuación, que abandonaba sin reprogramarse. Ahora toda
 * corrida pasa por ejecutarAuditoriaLicencias(): si hay otra a medias, queda en cola y
 * arranca sola cuando esa termina. El avance queda en Script Properties para que
 * "Ver estado de licencias" lo muestre aunque la corrida siga en segundo plano.
 */
const LIC_PROP_COLA   = 'LICENCIAS_COLA';
const LIC_PROP_ESTADO = { vsphere: 'LICENCIAS_ESTADO_VSPHERE', veeam: 'LICENCIAS_ESTADO_VEEAM' };
const LIC_NOMBRE      = { vsphere: 'vSphere', veeam: 'Veeam' };
// Una corrida viva actualiza su estado en cada cliente y retoma al minuto de cortarse.
// Si pasa este tiempo sin novedades, se cortó de verdad y no debe trabar la cola.
const LIC_MINUTOS_SIN_AVANCE = 15;

function leerEstadoLicencias(tecnologia) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(LIC_PROP_ESTADO[tecnologia]);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function guardarEstadoLicencias(tecnologia, cambios) {
  const estado = Object.assign(leerEstadoLicencias(tecnologia), cambios, { actualizado: Date.now() });
  PropertiesService.getScriptProperties().setProperty(LIC_PROP_ESTADO[tecnologia], JSON.stringify(estado));
}

function leerColaLicencias() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(LIC_PROP_COLA);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function guardarColaLicencias(cola) {
  PropertiesService.getScriptProperties().setProperty(LIC_PROP_COLA, JSON.stringify(cola));
}

function estaEnCursoLicencias(estado) {
  return estado.estado === 'en-curso' &&
         Date.now() - (estado.actualizado || 0) < LIC_MINUTOS_SIN_AVANCE * 60 * 1000;
}

/** La tecnología que tiene una corrida a medias (en curso o esperando su continuación), o null. */
function tecnologiaEnCursoLicencias() {
  return [LIC_TECNOLOGIA_VSPHERE, LIC_TECNOLOGIA_VEEAM]
    .find(t => estaEnCursoLicencias(leerEstadoLicencias(t))) || null;
}

function encolarLicencias(tecnologia, forzar) {
  const cola = leerColaLicencias();
  if (!cola.some(c => c.tecnologia === tecnologia)) {
    cola.push({ tecnologia, forzar: !!forzar });
    guardarColaLicencias(cola);
  }
  guardarEstadoLicencias(tecnologia, { estado: 'en-cola', cliente: '' });
  console.log(`🕒 ${LIC_NOMBRE[tecnologia]} queda en cola detrás de la corrida en curso.`);
}

/**
 * Punto único para correr una auditoría: triggers, editor y menú pasan por acá.
 * @param {{nuevoCiclo:boolean, forzar:boolean, alProgresar:Function}} opciones
 *   Las de los motores, más alProgresar(n, total, cliente) para mostrar el avance en pantalla.
 * @returns {string} el estado del motor, o 'en-cola' / 'ya-en-curso' si no llegó a correr.
 */
function ejecutarAuditoriaLicencias(tecnologia, opciones) {
  const opts = opciones || {};

  if (opts.nuevoCiclo) {
    const enCurso = tecnologiaEnCursoLicencias();
    if (enCurso === tecnologia) {
      console.warn(`⏳ ${LIC_NOMBRE[tecnologia]} ya tiene una corrida a medias. No se lanza otra.`);
      return 'ya-en-curso';
    }
    if (enCurso) {
      encolarLicencias(tecnologia, opts.forzar);
      return 'en-cola';
    }
  }

  const motor = tecnologia === LIC_TECNOLOGIA_VEEAM ? procesarTodasLasLicenciasVeeam : procesarTodasLasLicencias;
  let resultado;
  try {
    resultado = motor(opts);
  } catch (e) {
    guardarEstadoLicencias(tecnologia, { estado: 'error', mensaje: e.message, fin: Date.now() });
    programarSiguienteEnColaLicencias();
    throw e;
  }

  if (resultado === 'ocupado') {
    if (opts.nuevoCiclo) {
      encolarLicencias(tecnologia, opts.forzar);
      return 'en-cola';
    }
    // Una continuación que encuentra el candado tomado reintenta en vez de abandonar.
    const handler = tecnologia === LIC_TECNOLOGIA_VEEAM ? 'continuarProcesamientoVeeamLic' : 'continuarProcesamiento';
    ScriptApp.newTrigger(handler).timeBased().after(60 * 1000).create();
    return 'continua';
  }

  if (resultado === 'ciclo-hecho' && leerEstadoLicencias(tecnologia).estado === 'en-cola') {
    // Salió de la cola pero el mes ya estaba auditado: que no quede "en cola" para siempre.
    guardarEstadoLicencias(tecnologia, { estado: 'omitido', mensaje: 'El mes ya estaba auditado; no se reenvió.', fin: Date.now() });
  }
  if (resultado !== 'continua') programarSiguienteEnColaLicencias();
  return resultado;
}

/**
 * La siguiente de la cola arranca por trigger y no llamándola directo: el motor mide sus
 * 4,5 minutos desde que empieza, así que heredar el tiempo ya gastado por la corrida
 * anterior lo haría chocar contra el corte duro de 6 minutos de Google.
 */
function programarSiguienteEnColaLicencias() {
  if (leerColaLicencias().length === 0) return;
  ScriptApp.newTrigger('iniciarSiguienteEnColaLicencias').timeBased().after(60 * 1000).create();
}

function iniciarSiguienteEnColaLicencias() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'iniciarSiguienteEnColaLicencias')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Si justo hay otra a medias, la cola sigue esperando: esa la dispara al terminar.
  if (tecnologiaEnCursoLicencias()) return;

  const cola = leerColaLicencias();
  const siguiente = cola.shift();
  if (!siguiente) return;
  guardarColaLicencias(cola);
  console.log(`▶️ Arranca ${LIC_NOMBRE[siguiente.tecnologia]}, que estaba en cola.`);
  ejecutarAuditoriaLicencias(siguiente.tecnologia, { nuevoCiclo: true, forzar: siguiente.forzar });
}

/**
 * Lleva el avance de una corrida en su estado y, si la lanzó alguien desde el menú,
 * lo muestra en pantalla. Cuenta sólo los clientes activos con datos completos.
 */
function crearSeguimientoLicencias(tecnologia, datos, cols, alProgresar) {
  const procesables = [];
  for (let i = 1; i < datos.length; i++) {
    const f = leerFilaLicencias(datos[i], cols);
    if (filaLicenciasCompleta(f) && f.activo) procesables.push(i);
  }
  const total = procesables.length;
  const hechosAntesDe = (i) => procesables.filter(idx => idx < i).length;

  return {
    total,
    iniciar: (nuevo) => guardarEstadoLicencias(tecnologia, nuevo
      ? { estado: 'en-curso', total, hechos: 0, errores: 0, cliente: '', inicio: Date.now(), fin: null, mensaje: '' }
      : { estado: 'en-curso', total }),
    avanzar: (i, cliente, errores) => {
      const hechos = hechosAntesDe(i);
      guardarEstadoLicencias(tecnologia, { hechos, cliente, errores });
      if (alProgresar) alProgresar(hechos + 1, total, cliente);
    },
    cortar: (i, errores) => guardarEstadoLicencias(tecnologia, { hechos: hechosAntesDe(i), cliente: '', errores }),
    terminar: (errores) => guardarEstadoLicencias(tecnologia, { estado: 'finalizado', hechos: total, cliente: '', errores, fin: Date.now() })
  };
}

/** Una línea legible del estado de una tecnología, para "Ver estado de licencias". */
function describirEstadoLicencias(tecnologia) {
  const e = leerEstadoLicencias(tecnologia);
  const nombre = LIC_NOMBRE[tecnologia];
  const hora = (ms) => Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), "dd/MM HH:mm");
  const conErrores = (n) => (n ? `, ${n} con error (en rojo en "Logs ${nombre}")` : ", sin errores");

  switch (e.estado) {
    case 'en-curso':
      if (!estaEnCursoLicencias(e)) {
        return `⚠️ Sin avance desde ${hora(e.actualizado)} (iba ${e.hechos || 0} de ${e.total || 0}). ` +
               `Probablemente se cortó: se puede volver a lanzar.`;
      }
      return `⏳ En curso: ${e.hechos || 0} de ${e.total || 0} cliente(s) procesados` +
             (e.cliente ? `, ahora ${e.cliente}` : `, retoma en segundo plano`) + `. Actualizado ${hora(e.actualizado)}.`;
    case 'en-cola':
      return `🕒 En cola desde ${hora(e.actualizado)}: arranca solo cuando termine lo que está en curso.`;
    case 'finalizado':
      return `✅ Terminado el ${hora(e.fin)}: ${e.total || 0} cliente(s)${conErrores(e.errores)}.`;
    case 'error':
      return `❌ Falló el ${hora(e.fin)}: ${e.mensaje}`;
    case 'omitido':
      return `⏭️ ${hora(e.fin)}: ${e.mensaje}`;
    default:
      return "Sin corridas registradas.";
  }
}

/**
 * =================================================================
 * 1. MÉTODOS DE ENTRADA (TRIGGERS Y PUENTES)
 * =================================================================
 */

// 1. Ejecución Manual On-Demand (Ignora el calendario y la marca de ciclo)
function ejecutarManual() {
  console.log("🚀 Iniciando ejecución manual...");
  ejecutarAuditoriaLicencias(LIC_TECNOLOGIA_VSPHERE, { nuevoCiclo: true, forzar: true });
}

// 2. Instalador del Trigger (Ahora es DIARIO)
function instalarTriggerMensual() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'gatilloDiarioGuardián') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('gatilloDiarioGuardián').timeBased().everyDays(1).atHour(7).create();
  console.log("✅ Trigger Diario (Guardián) instalado a las 7 AM.");
  console.warn("⚠️ getProjectTriggers() sólo ve los triggers de TU usuario. Si otra persona " +
               "instaló el suyo, sigue vivo y va a duplicar la corrida. Revisá Activadores > " +
               "columna 'Propiedad de'; el dueño tiene que borrarlo desde su cuenta.");
}

/**
 * Diagnóstico: cuántos 'gatilloDiarioGuardián' veo con mi usuario.
 * Sirve para chequear el estado sin tocar nada.
 */
function auditarTriggersLicencias() {
  const mios = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'gatilloDiarioGuardián');
  console.log(`🔎 Triggers 'gatilloDiarioGuardián' visibles con MI usuario: ${mios.length}`);
  console.log("⚠️ Los de otros usuarios NO aparecen acá. Verificalos en la UI (Activadores).");

  const props = PropertiesService.getScriptProperties();
  console.log(`📌 Ciclo registrado: ${props.getProperty(PROP_CICLO) || "(ninguno)"}`);
  console.log(`📌 Marcapáginas: ${props.getProperty(PROP_BOOKMARK) || "(ninguno)"}`);
  const enviados = leerEnviados(props);
  console.log(`📌 Clientes ya notificados en el ciclo: ${enviados.size}`);
}

/**
 * Borra el estado del ciclo. Usar sólo si hay que rehacer una auditoría
 * desde cero dentro del mismo mes.
 */
function resetearCicloLicencias() {
  const props = PropertiesService.getScriptProperties();
  [PROP_CICLO, PROP_BOOKMARK, PROP_REPORTE, PROP_ENVIADOS].forEach(p => props.deleteProperty(p));
  limpiarTriggersContinuacion();
  console.log("🧹 Estado del ciclo reseteado. La próxima corrida arranca de cero.");
}

// 3. El Guardián (Se ejecuta todos los días pero solo avanza el último día hábil)
function gatilloDiarioGuardián() {
  if (esUltimoDiaHabilMes()) {
    console.log("📅 HOY ES EL ÚLTIMO DÍA HÁBIL DEL MES. Iniciando auditoría global...");
    ejecutarAuditoriaLicencias(LIC_TECNOLOGIA_VSPHERE, { nuevoCiclo: true });
  } else {
    console.log("💤 Hoy no es el último día hábil del mes. Abortando ejecución.");
  }
}

// 4. El Resucitador (Usado cuando el script se corta por Time-Out)
function continuarProcesamiento() {
  console.log("🔄 Reanudando procesamiento desde el marcapáginas...");
  limpiarTriggersContinuacion(); // el que disparó ya no sirve; no dejamos que se acumulen
  ejecutarAuditoriaLicencias(LIC_TECNOLOGIA_VSPHERE, { nuevoCiclo: false });
}

// 5. Puente Front-End (BotonCheckbox)
function internal_procesarLicenciasManualLibreria(cliente, destinatario, folderId, pod) {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  try {
    const resultadoMotor = procesarInfraestructuraCliente(cliente, destinatario, folderId, pod, summaryReport);
    if (summaryReport.errores.length > 0) {
      return { success: false, message: summaryReport.errores[0].detalle, ruta: resultadoMotor.ruta, archivos: resultadoMotor.archivos };
    }
    return { success: true, message: `Reporte enviado a ${destinatario}`, ruta: resultadoMotor.ruta, archivos: resultadoMotor.archivos };
  } catch (e) {
    return { success: false, message: e.message, ruta: "Error de acceso", archivos: "N/A" };
  }
}

/**
 * =================================================================
 * 2. MOTOR PRINCIPAL Y CONTROL DE TIEMPO
 * =================================================================
 */

/**
 * Motor. Protegido por candado de script: nunca corren dos instancias a la vez.
 * @param {{nuevoCiclo:boolean, forzar:boolean}} opciones
 *   nuevoCiclo: arranca el lote desde cero (lo usa el gatillo diario y el manual).
 *   forzar: ignora la marca de "este mes ya se corrió" (sólo ejecución manual).
 * @returns {string} 'ocupado' | 'ciclo-hecho' | 'error-config' | 'continua' | 'finalizado'
 *   Los triggers lo ignoran; lo usa el menú de la planilla para avisar qué pasó.
 */
function procesarTodasLasLicencias(opciones) {
  const opts = opciones || { nuevoCiclo: false, forzar: false };
  const tiempoInicio = Date.now();
  const props = PropertiesService.getScriptProperties();

  // ── CANDADO ──────────────────────────────────────────────────────────────
  // Sin esto, dos triggers que disparan con minutos de diferencia se pisan:
  // el segundo borra el marcapáginas del primero y reenvía todo desde la fila 1.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_ESPERA_MS)) {
    console.warn("🔒 Ya hay otra ejecución del motor de licencias en curso. " +
                 "Esta se aborta para no duplicar mails.");
    return 'ocupado';
  }

  try {
    const ciclo = cicloActual();

    // ── GUARD DE CICLO ─────────────────────────────────────────────────────
    // Si hay más de un 'gatilloDiarioGuardián' instalado (uno por usuario),
    // el segundo entra acá y se va sin mandar nada.
    if (opts.nuevoCiclo && !opts.forzar && props.getProperty(PROP_CICLO) === ciclo) {
      console.warn(`🛑 El ciclo ${ciclo} ya fue iniciado por otra ejecución ` +
                   `(trigger duplicado). Abortando para no reenviar mails.`);
      return 'ciclo-hecho';
    }

    let config;
    try {
      config = leerConfiguracionLicencias(LIC_TECNOLOGIA_VSPHERE);
    } catch (e) {
      console.error(`❌ No se pudo leer la configuración: ${e.message}`);
      guardarEstadoLicencias(LIC_TECNOLOGIA_VSPHERE, { estado: 'error', mensaje: e.message, fin: Date.now() });
      return 'error-config';
    }
    const { hoja, datos, cols } = config;
    const seguimiento = crearSeguimientoLicencias(LIC_TECNOLOGIA_VSPHERE, datos, cols, opts.alProgresar);

    if (opts.nuevoCiclo) {
      console.log(`🆕 Arrancando ciclo ${ciclo}.`);
      limpiarTriggersContinuacion();
      props.setProperty(PROP_CICLO, ciclo);
      props.deleteProperty(PROP_BOOKMARK);
      props.deleteProperty(PROP_REPORTE);
      props.deleteProperty(PROP_ENVIADOS);
    }

    let indexInicial = parseInt(props.getProperty(PROP_BOOKMARK)) || 1;
    let summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };

    const reporteGuardado = props.getProperty(PROP_REPORTE);
    if (reporteGuardado) {
      summaryReport = JSON.parse(reporteGuardado);
    }

    const enviados = leerEnviados(props);
    seguimiento.iniciar(opts.nuevoCiclo);

    if (indexInicial === 1) {
      console.log(`📋 Iniciando lote nuevo: ${seguimiento.total} clientes activos.`);
    } else {
      console.log(`📋 Reanudando en la fila ${indexInicial} (${enviados.size} clientes ya notificados).`);
    }

    for (let i = indexInicial; i < datos.length; i++) {
      if (Date.now() - tiempoInicio > MAX_TIEMPO_EJECUCION) {
        console.warn(`⏳ TIEMPO LÍMITE ALCANZADO (Fila ${i}). Guardando marcapáginas y reiniciando en 1 minuto...`);
        props.setProperty(PROP_BOOKMARK, i.toString());
        props.setProperty(PROP_REPORTE, JSON.stringify(summaryReport));
        seguimiento.cortar(i, summaryReport.errores.length);

        ScriptApp.newTrigger('continuarProcesamiento')
          .timeBased()
          .after(60 * 1000)
          .create();

        return 'continua';
      }

      const { email: emailDestino, pod, cliente, carpeta: folderId, activo } = leerFilaLicencias(datos[i], cols);

      if (!cliente || !emailDestino || !folderId) continue;

      if (!activo) {
        console.log(`⏭️ Fila ${i} - ${cliente}: marcado como INACTIVO en vSphere. Se omite.`);
        continue;
      }

      // ── IDEMPOTENCIA ─────────────────────────────────────────────────────
      // Red de seguridad: aunque algo reprocese este rango, no se reenvía.
      const marca = `${i}|${cliente}`;
      if (enviados.has(marca)) {
        console.log(`↩️ Fila ${i} - ${cliente}: ya notificado en este ciclo. Se omite.`);
        continue;
      }

      seguimiento.avanzar(i, cliente, summaryReport.errores.length);
      console.log(`\n🔎 Procesando fila ${i} - Cliente: ${cliente} (POD: ${pod})...`);
      const erroresAntes = summaryReport.errores.length;
        try {
          const resultado = procesarInfraestructuraCliente(cliente, emailDestino, folderId, pod, summaryReport);
          let detalleLog = "📁 Ruta: " + resultado.ruta + "\n📄 Archivos:\n" + resultado.archivos;
          if (summaryReport.errores.length > erroresAntes) {
            escribirLogLicencias(hoja, i + 1, cols, false, "❌ Errores:\n" + summaryReport.errores[summaryReport.errores.length - 1].detalle);
          } else {
            escribirLogLicencias(hoja, i + 1, cols, true, detalleLog);
          }
        } catch (e) {
          escribirLogLicencias(hoja, i + 1, cols, false, "❌ Error Crítico: " + e.message);
          summaryReport.errores.push({ detalle: e.message });
        }

        // Sólo marcamos como enviado si no hubo error: un cliente fallido puede reintentarse.
      if (summaryReport.errores.length === erroresAntes) {
        enviados.add(marca);
        guardarEnviados(props, enviados);
      }

      // Avanzamos el marcapáginas DESPUÉS de cada cliente. Antes sólo se escribía
      // en el corte blando, así que un corte duro de Google reprocesaba el lote entero.
      props.setProperty(PROP_BOOKMARK, (i + 1).toString());
      props.setProperty(PROP_REPORTE, JSON.stringify(summaryReport));
    }

    console.log("\n🏁 CICLO DE AUDITORÍA TOTALMENTE FINALIZADO.");
    props.deleteProperty(PROP_BOOKMARK);
    props.deleteProperty(PROP_REPORTE);
    props.deleteProperty(PROP_ENVIADOS);
    // PROP_CICLO se conserva: es la marca de que este mes ya se auditó.
    seguimiento.terminar(summaryReport.errores.length);

    // Antes esto llamaba a enviarResumenSlack(), que vive en el proyecto de Ops y no acá: el
    // typeof siempre daba false y el resumen nunca se envió. Ver enviarResumenLicenciasALogs.
    enviarResumenLicenciasALogs(LICENCIAS_OPERATION_NAME, summaryReport);
    return 'finalizado';
  } finally {
    lock.releaseLock();
  }
}

/** Identificador del ciclo mensual, "yyyy-MM" en la zona horaria del script. */
function cicloActual() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
}

/** Set de marcas "fila|cliente" ya notificadas en el ciclo en curso. */
function leerEnviados(props) {
  try {
    const raw = props.getProperty(PROP_ENVIADOS);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    console.warn("⚠️ No se pudo leer la marca de enviados, se asume vacía: " + e.message);
    return new Set();
  }
}

function guardarEnviados(props, set) {
  props.setProperty(PROP_ENVIADOS, JSON.stringify(Array.from(set)));
}

function procesarInfraestructuraCliente(cliente, emailDestino, rootFolderId, pod, summaryReport) {
  let rutaLog = "";
  let nombresArchivos = [];
  try {
    const rootFolder = DriveApp.getFolderById(rootFolderId);
    const anioFolder = obtenerSubcarpetaMasReciente(rootFolder, /^\d{4}/);
    if (!anioFolder) throw new Error("No se encontró carpeta de Año (YYYY)");
    const fechaFolder = obtenerSubcarpetaMasReciente(anioFolder, /^\d{8}/);
    if (!fechaFolder) throw new Error(`No se encontró carpeta de Fecha en ${anioFolder.getName()}`);

    let targetFolder = fechaFolder;
    if ((pod || "").toString().trim().toUpperCase() === "WPC") {
      const rvToolsFolder = buscarCarpetaPorNombre(fechaFolder, "RVTools");
      if (!rvToolsFolder) throw new Error(`No se encontró carpeta 'RVTools'`);
      targetFolder = rvToolsFolder;
      rutaLog = `${anioFolder.getName()} > ${fechaFolder.getName()} > RVTools`;
    } else {
      rutaLog = `${anioFolder.getName()} > ${fechaFolder.getName()}`;
    }

    console.log(`📂 Ruta resuelta: ${rutaLog}`);

    const files = targetFolder.getFiles();
    let archivosAProcesar = [];
    while (files.hasNext()) {
      let file = files.next();
      let name = file.getName().toLowerCase();
      if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
        archivosAProcesar.push(file);
        nombresArchivos.push(file.getName());
      }
    }

    if (archivosAProcesar.length === 0) throw new Error(`Sin archivos Excel válidos en la ruta`);

    console.log(`📄 Se encontraron ${archivosAProcesar.length} archivo(s) Excel. Leyendo...`);

    let todasLasLicenciasCliente = [];
    let errorCriticoCliente = false;

    for (const file of archivosAProcesar) {
      let tempSheetId = null;
      let exitoArchivo = false;
      let intentos = 0;
      const MAX_INTENTOS = 3;

      while (intentos < MAX_INTENTOS && !exitoArchivo) {
        try {
          intentos++;
          console.log(`⏳ [${cliente}] Abriendo archivo: ${file.getName()} (Intento ${intentos})`);
          const tempSheetFile = executeDriveWithBackoff(() => Drive.Files.copy({ mimeType: MimeType.GOOGLE_SHEETS, name: `[TEMP_LIC]` }, file.getId()));
          tempSheetId = tempSheetFile.id;
          Utilities.sleep(10000); 
          const tempSpreadsheet = SpreadsheetApp.openById(tempSheetId);
          
          const licenciasArchivo = analizarPestanaLicencias(tempSpreadsheet);
          todasLasLicenciasCliente = todasLasLicenciasCliente.concat(licenciasArchivo);
          
          exitoArchivo = true;
        } catch (e) {
          if (intentos >= MAX_INTENTOS) {
            console.error(`❌ [${cliente}] Fallo definitivo al leer el archivo ${file.getName()}: ${e.message}`);
            errorCriticoCliente = true;
            summaryReport.errores.push({ error: `[${cliente}] Timeout archivo`, detalle: `Fallo tras ${MAX_INTENTOS} intentos en ${file.getName()}` });
          } else {
            console.warn(`⚠️ [${cliente}] Problema al abrir, reintentando en breve...`);
            Utilities.sleep(5000 * intentos);
          }
        } finally {
          if (tempSheetId) DriveApp.getFileById(tempSheetId).setTrashed(true);
        }
      }
      if (errorCriticoCliente) break;
    }

    if (errorCriticoCliente) {
      return { ruta: rutaLog, archivos: nombresArchivos.join("\n") };
    }

    let licenciasUnicas = [];
    let setDuplicados = new Set();
    todasLasLicenciasCliente.forEach(lic => {
      let key = `${lic.sitio}|${lic.clave}|${lic.nombre}|${lic.vencimiento}|${lic.usadas}`;
      if (!setDuplicados.has(key)) {
        setDuplicados.add(key);
        licenciasUnicas.push(lic);
      }
    });

    console.log(`📧 Despachando reporte de ${cliente} a ${emailDestino} (${licenciasUnicas.length} licencias procesadas).`);
    enviarAlertaLicencias(cliente, emailDestino, licenciasUnicas);
    enviarAlertaSlackDetallada(cliente, licenciasUnicas);
    // Mismo resultado que el mail, escrito para que el dashboard lo muestre.
    guardarEstadoLicenciasDelCliente(LIC_TECNOLOGIA_VSPHERE, cliente, pod,
      clasificarLicenciasVsphere(licenciasUnicas), summaryReport);
    
    summaryReport.exitos.push({ mensaje: `*${cliente}*: Reporte OK` });
    return { ruta: rutaLog, archivos: nombresArchivos.join("\n") };

  } catch (e) {
    console.error(`❌ [${cliente}] Error: ${e.message}`);
    summaryReport.errores.push({ error: `Fallo ${cliente}`, detalle: e.message });
    return { ruta: rutaLog || "Error", archivos: nombresArchivos.length > 0 ? nombresArchivos.join("\n") : "Ninguno" };
  }
}

/**
 * =================================================================
 * 3. HERRAMIENTAS DE PROCESAMIENTO Y CALENDARIO
 * =================================================================
 */

function limpiarTriggersContinuacion() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'continuarProcesamiento') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/**
 * 💡 NUEVO: Lógica inteligente para determinar el último día hábil del mes,
 * integrando el Calendario Oficial de Feriados de Argentina.
 */
function esUltimoDiaHabilMes() {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth();
  const diaHoy = hoy.getDate();

  // 1. Intentar obtener los feriados del mes usando el calendario de Google
  let feriadosDelMes = [];
  try {
    const calendarId = PropertiesService.getScriptProperties().getProperty("HOLIDAYS_CALENDAR_ID"); // Calendario oficial AR
    const cal = CalendarApp.getCalendarById(calendarId);
    
    if (cal) {
      const primerDiaMes = new Date(anio, mes, 1);
      const primerDiaProximoMes = new Date(anio, mes + 1, 1);
      const eventos = cal.getEvents(primerDiaMes, primerDiaProximoMes);
      
      // Guardamos en un array solo los números de los días feriados
      feriadosDelMes = eventos.map(e => e.getStartTime().getDate());
    }
  } catch (e) {
    console.warn("⚠️ No se pudo acceder al calendario de feriados. Usando fallback (solo detectará fines de semana).", e.message);
  }

  // 2. Calcular cuál es el último día hábil iterando hacia atrás
  const ultimoDiaDelMes = new Date(anio, mes + 1, 0).getDate();
  let ultimoDiaHabil = ultimoDiaDelMes;

  for (let dia = ultimoDiaDelMes; dia > 0; dia--) {
    const fechaTest = new Date(anio, mes, dia);
    const diaSemana = fechaTest.getDay(); // 0: Dom, 6: Sab

    // Si es fin de semana, saltar
    if (diaSemana === 0 || diaSemana === 6) continue;

    // Si es feriado oficial, saltar
    if (feriadosDelMes.includes(dia)) continue;

    // Si pasó los filtros, encontramos el último día hábil real
    ultimoDiaHabil = dia;
    break;
  }

  return (diaHoy === ultimoDiaHabil);
}

function obtenerSubcarpetaMasReciente(carpetaPadre, regexPatron) {
  const subcarpetas = carpetaPadre.getFolders();
  let carpetaMasReciente = null;
  let nombreMasReciente = "";
  while (subcarpetas.hasNext()) {
    let carpetaActual = subcarpetas.next();
    let nombreActual = carpetaActual.getName();
    if (regexPatron && !regexPatron.test(nombreActual)) continue;
    if (nombreActual > nombreMasReciente) {
      nombreMasReciente = nombreActual;
      carpetaMasReciente = carpetaActual;
    }
  }
  return carpetaMasReciente;
}

function buscarCarpetaPorNombre(carpetaPadre, nombreExacto) {
  const subcarpetas = carpetaPadre.getFolders();
  const nombreLower = nombreExacto.toLowerCase();
  while (subcarpetas.hasNext()) {
    let carpetaActual = subcarpetas.next();
    if (carpetaActual.getName().toLowerCase() === nombreLower) return carpetaActual;
  }
  return null;
}

function obtenerSitio(spreadsheet) {
  const sheet = spreadsheet.getSheetByName("vMetaData");
  if (!sheet) return "Desconocido";
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return "Desconocido";
  
  const headers = data[0].map(h => h.toString().toLowerCase().trim());
  const idxServer = headers.findIndex(h => h === "server" || h === "vcenter" || h.includes("vcenter server"));
  
  if (idxServer !== -1 && data[1][idxServer]) {
    return data[1][idxServer].toString().trim();
  }
  return "Desconocido";
}

function interpretarFecha(val) {
  if (!val) return null;

  // El valor crudo de una celda de fecha ya llega como Date, así que no hay que
  // adivinar si "05/06/2028" es 5 de junio o 6 de mayo.
  if (Object.prototype.toString.call(val) === "[object Date]") {
    return isNaN(val.getTime()) ? null : { obj: new Date(val.getTime()) };
  }

  let str = String(val).trim();
  let dateOnly = str.split(" ")[0]; 
  let parts = dateOnly.split(/[\/\-]/);
  let d;
  if (parts.length >= 3) {
    let p1 = parseInt(parts[0], 10), p2 = parseInt(parts[1], 10), p3 = parseInt(parts[2], 10);
    if (p1 > 1000) d = new Date(p1, p2 - 1, p3);
    else if (p3 > 1000) {
      if (p1 > 12) d = new Date(p3, p2 - 1, p1);
      else d = new Date(p3, p1 - 1, p2);
    } else { d = new Date(str); }
  } else { d = new Date(str); }
  
  if (d && !isNaN(d.getTime())) {
    return { obj: d };
  }
  return null;
}

/**
 * Devuelve el número real de una celda.
 * Prioriza el valor crudo: getDisplayValues() aplica separador de miles
 * ("1.272") y parseInt lo truncaría a 1.
 */
function normalizarNumero(valorCrudo, valorMostrado) {
  if (typeof valorCrudo === "number" && !isNaN(valorCrudo)) return valorCrudo;
  const s = (valorMostrado === null || valorMostrado === undefined) ? "" : valorMostrado.toString().trim();
  if (s === "" || !/\d/.test(s)) return 0; // "Unlimited", "N/A", vacío...

  // Un decimal ("5000,0" o "5000.0") hay que truncarlo, no limpiarlo: borrarle el
  // separador lo convierte en 50000. Un separador seguido de 1 o 2 dígitos es decimal;
  // los miles siempre van de a 3 ("5.000"), así que esos caen en el limpiado de abajo.
  const decimal = s.match(/^(-?\d+)[.,]\d{1,2}$/);
  if (decimal) {
    const d = parseInt(decimal[1], 10);
    return isNaN(d) ? 0 : d;
  }

  const n = parseInt(s.replace(/[^\d-]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Formatea el consumo para el reporte con separador de miles.
 */
function formatearNumero(n) {
  if (typeof n !== "number" || isNaN(n)) return String(n);
  const partes = n.toString().split(".");
  partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return partes.length > 1 ? `${partes[0]},${partes[1]}` : partes[0];
}

function analizarPestanaLicencias(spreadsheet) {
  const sitioEncontrado = obtenerSitio(spreadsheet); 
  const sheet = spreadsheet.getSheetByName(LICENSE_TAB_NAME);
  if (!sheet) return [];
  
  const rango = sheet.getDataRange();
  const data = rango.getDisplayValues(); // texto ya formateado (nombres, fechas legibles)
  const crudo = rango.getValues();       // valores reales: números sin separador de miles, fechas como Date
  if (data.length < 2) return [];
  
  const headers = data[0].map(h => h.toString().toLowerCase().trim());
  const idxName = headers.findIndex(h => h === "name" || h.includes("license name"));
  const idxExpiration = headers.findIndex(h => h.includes("expiration"));
  const idxUsed = headers.findIndex(h => h === "used" || h.includes("used licenses") || h === "count");
  const idxTotal = headers.findIndex(h => h === "total" || h.includes("capacity"));
  const idxCostUnit = headers.findIndex(h => h.includes("cost unit"));
  const idxKey = headers.findIndex(h => h === "key" || h.includes("license key"));

  if (idxName === -1 || idxExpiration === -1 || idxUsed === -1) return [];
  
  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  const todasLasLicencias = [];
  
  data.slice(1).forEach((row, i) => {
    const filaCruda = crudo[i + 1];

    // RVTools deja celdas sueltas debajo de la tabla; sin nombre no es una licencia real.
    const nombreLic = (row[idxName] || "").toString().trim();
    if (!nombreLic) return;

    const used = normalizarNumero(filaCruda[idxUsed], row[idxUsed]);
    
    let rawExp = row[idxExpiration] ? row[idxExpiration].toString().trim() : "";
    let valStr = rawExp.toLowerCase();

    let diasRestantes = 999999; 

    if (valStr !== "" && valStr !== "never") {
      if (valStr.includes("expir") || valStr.includes("vencid")) {
        diasRestantes = -1; 
      } else {
        let expDate = interpretarFecha(filaCruda[idxExpiration] || rawExp); 
        if (expDate) {
          expDate.obj.setHours(0, 0, 0, 0); 
          diasRestantes = Math.ceil((expDate.obj.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
        }
      }
    }

    todasLasLicencias.push({
      sitio: sitioEncontrado,
      clave: idxKey !== -1 ? (row[idxKey] || "") : "",
      nombre: nombreLic,
      vencimiento: rawExp, 
      diasRestantes: diasRestantes,
      usadas: used,
      total: idxTotal !== -1 ? (row[idxTotal] || "N/A") : "N/A",
      metrica: idxCostUnit !== -1 ? (row[idxCostUnit] || "Unidades") : "Unidades"
    });
  });
  return todasLasLicencias;
}

/**
 * =================================================================
 * 4. SISTEMA DE ALERTAS (REPORTING MULTI-ESTADO COMPLETO)
 * =================================================================
 */

function enviarAlertaLicencias(cliente, destinatarioRaw, todasLasLicencias) {
  const emailsAEnviar = destinatarioRaw.toString().split(',').map(e => e.trim()).filter(e => e !== "").join(',');
  
  // Clasifica services/LicenciasEstado.js, que es de donde sale tambien lo que ve el
  // dashboard: el mail y el dashboard no pueden discrepar (AGENTS.md §5).
  const clas = clasificarLicenciasVsphere(todasLasLicencias);
  const vencidas = clas.vencidas;
  const proximas = clas.proximas;
  const sanasEnUso = clas.sanasEnUso;
  const sinUso = clas.sinUso;

  const sortSitioDias = (a, b) => {
    if (a.sitio < b.sitio) return -1;
    if (a.sitio > b.sitio) return 1;
    return a.diasRestantes - b.diasRestantes;
  };
  const sortSitioNombre = (a, b) => {
    if (a.sitio < b.sitio) return -1;
    if (a.sitio > b.sitio) return 1;
    return a.nombre.localeCompare(b.nombre);
  };

  vencidas.sort(sortSitioDias);
  proximas.sort(sortSitioDias);
  sanasEnUso.sort(sortSitioNombre);
  sinUso.sort(sortSitioNombre);

  const todoOK = (vencidas.length === 0 && proximas.length === 0);

  let colorHeader = "#5cb85c"; // Verde
  let iconoHeader = "✅";
  let statusTxt = "Auditoría Exitosa";
  let situacionTxt = "Todas las licencias en uso se encuentran vigentes y operativas.";

  if (vencidas.length > 0) {
    colorHeader = "#d9534f"; // Rojo
    iconoHeader = "❌";
    statusTxt = "Licencias Vencidas Detectadas";
    situacionTxt = "Se requiere acción inmediata para renovar licencias expiradas en uso.";
  } else if (proximas.length > 0) {
    colorHeader = "#f0ad4e"; // Naranja
    iconoHeader = "⚠️";
    statusTxt = "Atención: Licencias Próximas a Vencer";
    situacionTxt = "Se han detectado licencias en uso que vencerán en el corto plazo.";
  }

  // --- NUEVO FORMATO DE ASUNTO ---
  const fechaHoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy");
  const asunto = `${iconoHeader} Estado de Licencias vSphere - Wetcom / ${cliente} - ${fechaHoy}`;
  // -------------------------------
  
  let cuerpoHtml = `
  <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; max-width: 850px;">
    <div style="border: 1px solid #ddd; border-left: 6px solid ${colorHeader}; padding: 20px; background-color: #f9f9f9; border-radius: 4px;">
      <h2 style="margin-top: 0; color: ${colorHeader}; font-size: 18px;">${statusTxt}</h2>
      <p style="font-size: 14px;">Auditoría completa para <b>${cliente}</b>.</p>
      <p style="font-size: 14px;"><b>Situación:</b> ${situacionTxt}</p>
  `;

  // --- CUADRO 1: CRÍTICAS (ROJO) ---
  if (vencidas.length > 0) {
    cuerpoHtml += `
      <div style="margin-top: 20px;">
        <table style="border-collapse: collapse; width: 100%; background-color: white; font-size: 13px; border: 1px solid #ddd;">
          <tr style="background-color: #d9534f; color: white;">
            <th colspan="5" style="padding: 10px; border: 1px solid #ddd; text-align: left; font-size: 14px;">CRÍTICO - LICENCIAS VENCIDAS (EN USO)</th>
          </tr>
          <tr style="background-color: #fdf7f7; color: #761c19;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Sitio</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Licencia</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Vencimiento</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Días</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Uso</th>
          </tr>`;
    vencidas.forEach(a => {
      cuerpoHtml += `<tr>
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">${a.sitio}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; color: #d9534f;"><b>${a.vencimiento}</b></td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; color: #d9534f;"><b>VENCIDA</b></td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${formatearNumero(a.usadas)} de ${a.total} (${a.metrica})</td>
      </tr>`;
    });
    cuerpoHtml += `</table></div>`;
  }

  // --- CUADRO 2: ADVERTENCIAS (NARANJA) ---
  if (proximas.length > 0) {
    cuerpoHtml += `
      <div style="margin-top: 20px;">
        <table style="border-collapse: collapse; width: 100%; background-color: white; font-size: 13px; border: 1px solid #ddd;">
          <tr style="background-color: #f0ad4e; color: white;">
            <th colspan="5" style="padding: 10px; border: 1px solid #ddd; text-align: left; font-size: 14px;">ATENCIÓN - PRÓXIMAS A VENCER</th>
          </tr>
          <tr style="background-color: #fcf8f2; color: #8a6d3b;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Sitio</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Licencia</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Vencimiento</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Días</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Uso</th>
          </tr>`;
    proximas.forEach(a => {
      cuerpoHtml += `<tr>
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">${a.sitio}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.vencimiento}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; color: #d9534f;"><b>${a.diasRestantes}</b></td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${formatearNumero(a.usadas)} de ${a.total} (${a.metrica})</td>
      </tr>`;
    });
    cuerpoHtml += `</table></div>`;
  }

  // --- CUADRO 3: ESTADO OK Y SIN USO (ESTILO DINÁMICO) ---
  if (sanasEnUso.length > 0 || sinUso.length > 0) {
    let bgHeaderSanas = todoOK ? "#5cb85c" : "#e2e3e5"; 
    let colorHeaderSanas = todoOK ? "white" : "#495057";
    let bgSubHeaderSanas = todoOK ? "#f9fdf9" : "#f8f9fa";
    let colorSubHeaderSanas = todoOK ? "#2b542c" : "#495057";

    cuerpoHtml += `
      <div style="margin-top: 20px;">
        <table style="border-collapse: collapse; width: 100%; background-color: white; font-size: 13px; border: 1px solid #ddd;">
          <tr style="background-color: ${bgHeaderSanas}; color: ${colorHeaderSanas};">
            <th colspan="5" style="padding: 10px; border: 1px solid #ddd; text-align: left; font-size: 14px;">SALUDABLE - ESTADO OK / NO UTILIZADAS</th>
          </tr>
          <tr style="background-color: ${bgSubHeaderSanas}; color: ${colorSubHeaderSanas};">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Sitio</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Licencia</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Vencimiento</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Días</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Uso</th>
          </tr>`;
    
    sanasEnUso.forEach(a => {
      let diasDisplay = (a.diasRestantes === 999999) ? "-" : a.diasRestantes;
      cuerpoHtml += `<tr style="background-color: #ffffff;">
        <td style="padding: 10px; border: 1px solid #ddd;">${a.sitio}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.vencimiento}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${diasDisplay}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${formatearNumero(a.usadas)} de ${a.total} (${a.metrica})</td>
      </tr>`;
    });

    sinUso.forEach(a => {
      let diasDisplay = (a.diasRestantes === 999999 || a.diasRestantes < 0) ? "-" : a.diasRestantes;
      cuerpoHtml += `<tr style="background-color: #f2f2f2; color: #666666;">
        <td style="padding: 10px; border: 1px solid #ddd;">${a.sitio}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.vencimiento}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${diasDisplay}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${formatearNumero(a.usadas)} de ${a.total} (${a.metrica})</td>
      </tr>`;
    });
    cuerpoHtml += `</table></div>`;
  }

  cuerpoHtml += `<p style="font-size: 14px; margin-top: 20px;">Este reporte es meramente informativo.</p></div><p style="margin-top: 25px; font-size: 12px; color: #666;">Saludos,<br><b>Wetcom Proactive Center</b></p></div>`;
  
  if (emailsAEnviar) {
    // Adaptado para Script-Alarmas
    EmailService.enviarReporteGuardia(emailsAEnviar, asunto, cuerpoHtml);
  }
}

function enviarAlertaSlackDetallada(cliente, alertas) {
  // SLACK_WEBHOOK_URL no está declarada en ningún archivo de este proyecto, así que este
  // guard daba siempre verdadero y la función salía sin enviar nada. Los webhooks reales
  // los resuelve Config desde Script Properties, y de eso ya se encarga SlackService.
  const clas = clasificarLicenciasVsphere(alertas);
  const vencidas = clas.vencidas;
  const proximas = clas.proximas;
  if (vencidas.length === 0 && proximas.length === 0) return; 
  
  let msg = `*Reporte de Licencias - ${cliente}*\n`;
  if (vencidas.length > 0) msg += `🔴 *CRÍTICO:* ${vencidas.length} licencias vencidas en uso.\n`;
  if (proximas.length > 0) msg += `🟡 *WARNING:* ${proximas.length} próximas a vencer.\n`;
  SlackService.enviarLogTexto(msg);
}

/**
 * Crea un menú personalizado en la hoja de cálculo al abrirse.
 */


/**
 * Detecta la fila seleccionada por el usuario y ejecuta la auditoría 
 * solo para ese cliente específico.
 */
function ejecutarClienteSeleccionadoLicencias() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(NOMBRE_PESTANA_CONFIG); // "Licencias"
  
  if (!hoja) {
    ui.alert("❌ Error", `No se encontró la pestaña "${NOMBRE_PESTANA_CONFIG}".`, ui.ButtonSet.OK);
    return;
  }
  
  // 1. Obtener la fila donde el usuario tiene el cursor
  const celdaActiva = hoja.getActiveCell();
  const fila = celdaActiva.getRow();
  
  // Evitar procesar la cabecera (Fila 1)
  if (fila === 1) {
    ui.alert("⚠️ Advertencia", "Por favor, selecciona una fila de cliente válida (Fila 2 en adelante).", ui.ButtonSet.OK);
    return;
  }
  
  // 2. Leer la fila con las columnas resueltas por encabezado
  let cols, datosFila;
  try {
    ({ cols, fila: datosFila } = leerFilaSeleccionadaLicencias(hoja, fila, LIC_TECNOLOGIA_VSPHERE));
  } catch (e) {
    ui.alert("❌ Error", e.message, ui.ButtonSet.OK);
    return;
  }
  const { email: emailDestino, pod, cliente, carpeta: folderId, activo } = datosFila;

  // 3. Validar que la fila contenga los datos mínimos indispensables
  if (!cliente || !emailDestino || !folderId) {
    ui.alert("⚠️ Fila Incompleta", `La fila ${fila} no tiene configurados todos los campos necesarios (Cliente, Destinatario o ID de Carpeta vSphere).`, ui.ButtonSet.OK);
    return;
  }

  if (!activo) {
    ui.alert("⚠️ Cliente Inactivo", `El cliente ${cliente} está marcado como inactivo en "Activo vSphere". No se ejecutará la auditoría.`, ui.ButtonSet.OK);
    return;
  }
  
  // 4. Confirmación visual para el operador
  const respuesta = ui.alert(
    "Confirmar Auditoría",
    `¿Deseas lanzar la auditoría individual para el cliente?\n\n• Cliente: ${cliente}\n• POD: ${pod || 'N/A'}\n• Destinatario: ${emailDestino}`,
    ui.ButtonSet.YES_NO
  );
  
  if (respuesta !== ui.Button.YES) {
    console.log("❌ Ejecución individual cancelada por el usuario.");
    return;
  }
  
  // 5. Lanzar el motor para este cliente específico
  console.log(`\n🔎 [Manual Individual] Procesando Fila ${fila} - Cliente: ${cliente} (POD: ${pod})...`);
  
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  
  // Mostrar un Toast/Notificación flotante en el Excel para avisar que inició
  ss.toast(`Procesando licencias de ${cliente}...`, "🚀 Auditoría en Curso", -1);
  
  try {
    const resultado = procesarInfraestructuraCliente(cliente, emailDestino, folderId, pod, summaryReport);
      
      let detalleLog = "📁 Ruta: " + resultado.ruta + "\n📄 Archivos:\n" + resultado.archivos;
      
      // 6. Informar el resultado en la UI de la planilla
      if (summaryReport.errores.length > 0) {
        escribirLogLicencias(hoja, fila, cols, false, "❌ Errores:\n" + summaryReport.errores[0].detalle);
        ui.alert("❌ Finalizado con Errores", `Hubo un problema al procesar el cliente ${cliente}:\n${summaryReport.errores[0].detalle}`, ui.ButtonSet.OK);
      } else {
        escribirLogLicencias(hoja, fila, cols, true, detalleLog);
        ui.alert("✅ Auditoría Exitosa", `El reporte de ${cliente} ha sido procesado y enviado a ${emailDestino} de forma conforme.`, ui.ButtonSet.OK);
      }
    } catch (error) {
      escribirLogLicencias(hoja, fila, cols, false, "❌ Error Crítico: " + error.message);
      ui.alert("❌ Error Crítico", `Ocurrió un error inesperado en el motor: ${error.message}`, ui.ButtonSet.OK);
  } finally {
    // Quitar la notificación flotante
    ss.toast("Proceso finalizado.", "🏁 Wetcom Ops", 3);
  }
}


// --- VEEAM ---
/**
 * =================================================================
 * SCRIPT DE AUDITORÍA DE LICENCIAS (VEEAM) - WETCOM (PRODUCCIÓN)
 * LIBRERÍA CORE: "Automatizar Operaciones"
 * =================================================================
 * Lee TODOS los archivos de la subcarpeta YYYY -> YYYYMMDD
 * Pestaña de configuración: "Licencias"
 */

const VEEAM_LIC_OPERATION_NAME = "Auditoría de Licencias Veeam";
const VEEAM_LIC_DIAS_UMBRAL = 90;
// Las columnas de la solapa "Licencias" se resuelven por encabezado: ver mapearColumnasLicencias().

const VEEAM_LIC_PROP_CICLO    = 'VEEAM_LIC_CICLO';
const VEEAM_LIC_PROP_ENVIADOS = 'VEEAM_LIC_ENVIADOS';
const VEEAM_LIC_PROP_BOOKMARK = 'VEEAM_LIC_BOOKMARK';
const VEEAM_LIC_PROP_REPORTE  = 'VEEAM_LIC_REPORT';
const VEEAM_LIC_LOCK_ESPERA   = 5000;
const VEEAM_LIC_MAX_TIEMPO    = 270000;

// 1. Ejecución Manual On-Demand (Ignora el calendario)
function ejecutarManualVeeamLic() {
  console.log("🚀 Iniciando ejecución manual Veeam...");
  ejecutarAuditoriaLicencias(LIC_TECNOLOGIA_VEEAM, { nuevoCiclo: true, forzar: true });
}

// 2. Instalador del Trigger
function instalarTriggerVeeamLic() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'gatilloDiarioVeeamLic') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('gatilloDiarioVeeamLic').timeBased().everyDays(1).atHour(8).create();
  console.log("✅ Trigger Diario Veeam (Guardián) instalado a las 8 AM.");
}

// 3. El Guardián (Se ejecuta todos los días pero solo avanza el último día hábil)
function gatilloDiarioVeeamLic() {
  if (typeof esUltimoDiaHabilMes === "function" && esUltimoDiaHabilMes()) {
    console.log("📅 HOY ES EL ÚLTIMO DÍA HÁBIL DEL MES. Iniciando auditoría Veeam...");
    // Antes de arrancar, avisar qué clientes no subieron el reporte de este mes. Después de
    // este punto el mail sale con lo que haya en el Drive, y como la navegación de carpetas
    // toma la fecha más reciente sin mirar de qué mes es, un reporte del mes pasado se
    // informaría como si fuera de hoy. No lanza: si la revisión falla, el ciclo corre igual.
    avisarLicenciasVeeamPendientesAntesDelCiclo();

    // Si vSphere (7 AM) todavía no terminó, queda en cola en vez de perder el mes.
    ejecutarAuditoriaLicencias(LIC_TECNOLOGIA_VEEAM, { nuevoCiclo: true });
  } else {
    console.log("💤 Hoy no es el último día hábil del mes. Abortando ejecución Veeam.");
  }
}

// 4. El Resucitador (Usado cuando el script se corta por Time-Out)
function continuarProcesamientoVeeamLic() {
  console.log("🔄 Reanudando procesamiento Veeam desde el marcapáginas...");
  limpiarTriggersContinuacionVeeamLic(); // el que disparó ya no sirve; no dejamos que se acumulen
  ejecutarAuditoriaLicencias(LIC_TECNOLOGIA_VEEAM, { nuevoCiclo: false });
}

function limpiarTriggersContinuacionVeeamLic() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'continuarProcesamientoVeeamLic') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function resetearCicloVeeamLic() {
  const props = PropertiesService.getScriptProperties();
  [VEEAM_LIC_PROP_CICLO, VEEAM_LIC_PROP_BOOKMARK, VEEAM_LIC_PROP_REPORTE, VEEAM_LIC_PROP_ENVIADOS].forEach(p => props.deleteProperty(p));
  limpiarTriggersContinuacionVeeamLic();
  console.log("🧹 Estado del ciclo Veeam reseteado.");
}

// ── MOTOR PRINCIPAL ──
/** Mismo contrato que procesarTodasLasLicencias(), incluido el estado que devuelve. */
function procesarTodasLasLicenciasVeeam(opciones) {
  const opts = opciones || { nuevoCiclo: false, forzar: false };
  const tiempoInicio = Date.now();
  const props = PropertiesService.getScriptProperties();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(VEEAM_LIC_LOCK_ESPERA)) {
    console.warn("🔒 Ya hay otra ejecución de licencias Veeam en curso. Abortando.");
    return 'ocupado';
  }

  try {
    const ciclo = typeof cicloActual === "function" ? cicloActual() : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");

    if (opts.nuevoCiclo && !opts.forzar && props.getProperty(VEEAM_LIC_PROP_CICLO) === ciclo) {
      console.warn(`🛑 El ciclo Veeam ${ciclo} ya fue iniciado. Abortando.`);
      return 'ciclo-hecho';
    }

    // Se lee antes de marcar el ciclo: si la planilla no abre, el mes no queda dado por hecho.
    let config;
    try {
      config = leerConfiguracionLicencias(LIC_TECNOLOGIA_VEEAM);
    } catch (e) {
      console.error(`❌ No se pudo leer la configuración: ${e.message}`);
      guardarEstadoLicencias(LIC_TECNOLOGIA_VEEAM, { estado: 'error', mensaje: e.message, fin: Date.now() });
      return 'error-config';
    }
    const { hoja, datos, cols } = config;
    const seguimiento = crearSeguimientoLicencias(LIC_TECNOLOGIA_VEEAM, datos, cols, opts.alProgresar);

    if (opts.nuevoCiclo) {
      console.log(`🆕 Arrancando ciclo Veeam ${ciclo}.`);
      limpiarTriggersContinuacionVeeamLic();
      props.setProperty(VEEAM_LIC_PROP_CICLO, ciclo);
      props.deleteProperty(VEEAM_LIC_PROP_BOOKMARK);
      props.deleteProperty(VEEAM_LIC_PROP_REPORTE);
      props.deleteProperty(VEEAM_LIC_PROP_ENVIADOS);
    }

    let indexInicial = parseInt(props.getProperty(VEEAM_LIC_PROP_BOOKMARK)) || 1;
    let summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };

    const reporteGuardado = props.getProperty(VEEAM_LIC_PROP_REPORTE);
    if (reporteGuardado) summaryReport = JSON.parse(reporteGuardado);

    let rawEnviados = props.getProperty(VEEAM_LIC_PROP_ENVIADOS);
    const enviados = new Set(rawEnviados ? JSON.parse(rawEnviados) : []);
    seguimiento.iniciar(opts.nuevoCiclo);

    for (let i = indexInicial; i < datos.length; i++) {
      if (Date.now() - tiempoInicio > VEEAM_LIC_MAX_TIEMPO) {
        console.warn(`⏳ TIEMPO LÍMITE ALCANZADO (Fila ${i}). Guardando marcapáginas Veeam...`);
        props.setProperty(VEEAM_LIC_PROP_BOOKMARK, i.toString());
        props.setProperty(VEEAM_LIC_PROP_REPORTE, JSON.stringify(summaryReport));
        seguimiento.cortar(i, summaryReport.errores.length);
        ScriptApp.newTrigger('continuarProcesamientoVeeamLic').timeBased().after(60 * 1000).create();
        return 'continua';
      }

      const { email: emailDestino, pod, cliente, carpeta: folderId, activo } = leerFilaLicencias(datos[i], cols);

      if (!cliente || !emailDestino || !folderId) continue;
      if (!activo) {
        console.log(`⏭️ Fila ${i} - ${cliente}: INACTIVO en Veeam. Se omite.`);
        continue;
      }

      const marca = `${i}|${cliente}`;
      if (enviados.has(marca)) {
        console.log(`↩️ Fila ${i} - ${cliente}: ya notificado. Se omite.`);
        continue;
      }

      seguimiento.avanzar(i, cliente, summaryReport.errores.length);
      console.log(`\n🔎 Procesando fila ${i} - Cliente: ${cliente} (Veeam)...`);
      const erroresAntes = summaryReport.errores.length;
        try {
          const res = procesarInfraestructuraClienteVeeam(cliente, emailDestino, folderId, pod, summaryReport);
          let detalleLog = "📁 Ruta: " + res.ruta + "\n📄 Archivos:\n" + res.archivos;
          if (summaryReport.errores.length > erroresAntes) {
            escribirLogLicencias(hoja, i + 1, cols, false, "❌ Errores:\n" + summaryReport.errores[summaryReport.errores.length - 1].detalle);
          } else {
            escribirLogLicencias(hoja, i + 1, cols, true, detalleLog);
          }
        } catch (e) {
          escribirLogLicencias(hoja, i + 1, cols, false, "❌ Error Crítico: " + e.message);
          summaryReport.errores.push({ detalle: e.message });
        }

        if (summaryReport.errores.length === erroresAntes) {
        enviados.add(marca);
        props.setProperty(VEEAM_LIC_PROP_ENVIADOS, JSON.stringify(Array.from(enviados)));
      }

      props.setProperty(VEEAM_LIC_PROP_BOOKMARK, (i + 1).toString());
      props.setProperty(VEEAM_LIC_PROP_REPORTE, JSON.stringify(summaryReport));
    }

    console.log("\n🏁 CICLO DE AUDITORÍA VEEAM FINALIZADO.");
    props.deleteProperty(VEEAM_LIC_PROP_BOOKMARK);
    props.deleteProperty(VEEAM_LIC_PROP_REPORTE);
    props.deleteProperty(VEEAM_LIC_PROP_ENVIADOS);
    seguimiento.terminar(summaryReport.errores.length);

    // Mismo caso que en vSphere: enviarResumenSlack() no existe en este proyecto.
    enviarResumenLicenciasALogs(VEEAM_LIC_OPERATION_NAME, summaryReport);
    return 'finalizado';
  } finally {
    lock.releaseLock();
  }
}

function procesarInfraestructuraClienteVeeam(cliente, emailDestino, rootFolderId, pod, summaryReport) {
  let rutaLog = "";
  let nombresArchivos = [];
  try {
    const rootFolder = DriveApp.getFolderById(rootFolderId);

    // El mes EN CURSO, no "la carpeta más reciente". Antes se tomaba la fecha más alta que
    // hubiera sin mirar de qué mes era: si el cliente no subía el reporte de este mes, se
    // auditaba el del mes pasado y el mail al POD salía como si los datos fueran de hoy. Un
    // reporte viejo presentado como actual es peor que no tener reporte.
    //
    // Ahora ese cliente falla solo: el catch de quien llama deja el motivo en su fila de la
    // planilla, lo suma a summaryReport.errores y sigue con el siguiente. El resumen del final
    // del ciclo lo publica en el canal de logs de Slack.
    //
    // La búsqueda la hacen las mismas funciones que usa el chequeo previo
    // (services/LicenciasPendientes.js), así que el aviso del día 28 y lo que el ciclo
    // realmente lee no pueden discrepar (AGENTS.md §5).
    const hoy = new Date();
    const anioEnCurso = String(hoy.getFullYear());
    const prefijoMes = anioEnCurso + ('0' + (hoy.getMonth() + 1)).slice(-2);

    const anioFolder = _licPendSubcarpetaPorNombre(rootFolder, anioEnCurso);
    if (!anioFolder) throw new Error(`No existe la carpeta de año ${anioEnCurso} en el Drive de licencias.`);

    const fechaFolder = _licPendCarpetaDeFechaDelMes(anioFolder, prefijoMes);
    if (!fechaFolder) throw new Error(`No se subió el reporte de licencias de ${anioEnCurso}-${prefijoMes.slice(4)}: la carpeta ${anioFolder.getName()} no tiene ninguna ${prefijoMes}xx. No se audita, para no informar datos de un mes anterior.`);

    rutaLog = `${anioFolder.getName()} > ${fechaFolder.getName()}`;
    console.log(`📂 Ruta resuelta Veeam: ${rutaLog}`);

    const files = fechaFolder.getFiles();
    let archivosAProcesar = [];
    while (files.hasNext()) {
      let file = files.next();
      let name = file.getName().toLowerCase();
      if (name.endsWith(".csv")) {
        archivosAProcesar.push(file);
        nombresArchivos.push(file.getName());
      }
    }

    if (archivosAProcesar.length === 0) throw new Error(`Sin archivos CSV válidos en la ruta`);
    
    let todasLasLicenciasCliente = [];
    let erroresCliente = [];

    for (const file of archivosAProcesar) {
      console.log(`⏳ [${cliente}] Leyendo CSV: ${file.getName()}`);
      const content = file.getBlob().getDataAsString();
      let parsedData;
      if (typeof parseCsvDeReporte === "function") {
        parsedData = parseCsvDeReporte(content, file.getName());
      } else {
        throw new Error("Librería de parseo CSV no encontrada.");
      }

      const resultado = analizarLicenciasVeeam(parsedData, cliente);
      todasLasLicenciasCliente = todasLasLicenciasCliente.concat(resultado.licencias);
      resultado.errores.forEach(e => erroresCliente.push({
        archivo: file.getName(),
        servidor: e.servidor,
        mensaje: e.mensaje
      }));
    }

    let licenciasUnicas = [];
    let setDuplicados = new Set();
    todasLasLicenciasCliente.forEach(lic => {
      let key = `${lic.servidor}|${lic.nombre}|${lic.tipo}|${lic.vencimiento}|${lic.usadas}|${lic.workload}`;
      if (!setDuplicados.has(key)) {
        setDuplicados.add(key);
        licenciasUnicas.push(lic);
      }
    });

    erroresCliente.forEach(e => {
      console.error(`❌ [${cliente}] El extractor falló en ${e.servidor}: ${e.mensaje}`);
      summaryReport.errores.push({
        error: `Extracción Veeam falló: ${cliente} (${e.servidor})`,
        detalle: `${e.mensaje} [${e.archivo}]`
      });
    });

    if (licenciasUnicas.length > 0) {
      console.log(`📧 Despachando reporte Veeam de ${cliente} a ${emailDestino} (${licenciasUnicas.length} licencias procesadas).`);
      enviarAlertaLicenciasVeeam(cliente, emailDestino, licenciasUnicas);
      enviarAlertaSlackVeeamLic(cliente, licenciasUnicas);
      // Mismo resultado que el mail, escrito para que el dashboard lo muestre.
      guardarEstadoLicenciasDelCliente(LIC_TECNOLOGIA_VEEAM, cliente, pod,
        clasificarLicenciasVeeam(licenciasUnicas), summaryReport);
    } else if (erroresCliente.length === 0) {
      console.warn(`⚠️ [${cliente}] Archivo procesado pero no se encontraron datos de licencias válidos.`);
      summaryReport.advertencias.push({ ticket: "-", problema: `[${cliente}] CSV vacío o formato inválido`, accion: "Revisar archivo en Drive" });
    }

    // Un cliente cuya extracción falló no cuenta como éxito.
    if (erroresCliente.length === 0) {
      summaryReport.exitos.push({ mensaje: `*${cliente}*: Reporte Veeam OK` });
    } else if (licenciasUnicas.length > 0) {
      summaryReport.exitos.push({ mensaje: `*${cliente}*: Reporte Veeam parcial (${erroresCliente.length} servidor/es con error)` });
    }
    return { ruta: rutaLog, archivos: nombresArchivos.join("\n") };

  } catch (e) {
    console.error(`❌ [${cliente}] Error Veeam: ${e.message}`);
    summaryReport.errores.push({ error: `Fallo ${cliente}`, detalle: e.message });
    return { ruta: rutaLog || "Error", archivos: nombresArchivos.length > 0 ? nombresArchivos.join("\n") : "Ninguno" };
  }
}

function normalizarColumnaVeeam(texto) {
  return texto.toString().trim().toLowerCase().replace(/[\s\-_]+/g, '');
}

/**
 * @returns {{licencias: Array<Object>, errores: Array<{servidor: string, mensaje: string}>}}
 *   Los errores son servidores donde el extractor falló (Status=ERROR en el CSV).
 */
function analizarLicenciasVeeam(parsedData, clienteFallback) {
  if (!parsedData || parsedData.length < 2) return { licencias: [], errores: [] };

  const rawHeaders = parsedData[0];
  const headers = rawHeaders.map(h => normalizarColumnaVeeam(h));

  const map = {
    server:     ["server", "servidor", "vbrserver", "hostname"],
    edition:    ["edition", "licenseedition", "edición", "product"],
    type:       ["type", "licensetype", "tipo"],
    status:     ["status", "estado"],
    expiration: ["expirationdate", "expiration", "vencimiento"],
    licensed:   ["licensedinstances", "total", "capacity", "licensedsocketsnumber", "licensedsockets"],
    used:       ["usedinstances", "used", "consumidas", "usedsocketsnumber", "usedsockets"],
    workload:   ["workloadtype", "workload", "carga"]
  };

  const findIdx = (aliasArr) => headers.findIndex(h => aliasArr.includes(h));

  const idx = {
    server: findIdx(map.server),
    edition: findIdx(map.edition),
    type: findIdx(map.type),
    status: findIdx(map.status),
    expiration: findIdx(map.expiration),
    licensed: findIdx(map.licensed),
    used: findIdx(map.used),
    workload: findIdx(map.workload)
  };

  if (idx.edition === -1 || idx.licensed === -1 || idx.used === -1) {
    console.warn("⚠️ Faltan columnas críticas en el CSV de Veeam. Columnas encontradas:", rawHeaders);
    return {
      licencias: [],
      errores: [{
        servidor: clienteFallback,
        mensaje: `Faltan columnas críticas en el CSV. Columnas encontradas: ${rawHeaders.join(", ")}`
      }]
    };
  }

  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  const licencias = [];
  const errores = [];

  for (let i = 1; i < parsedData.length; i++) {
    const row = parsedData[i];
    if (!row || row.length < 2) continue;

    const server = idx.server !== -1 ? (row[idx.server] || clienteFallback) : clienteFallback;
    const status = idx.status !== -1 ? (row[idx.status] || "") : "";

    // El extractor marca con Status=ERROR los servidores donde falló, y deja el motivo en
    // WorkloadType. Sin esto, un cliente donde la extracción falló se ve idéntico a uno
    // que directamente no subió nada.
    if (status.toString().trim().toUpperCase() === "ERROR") {
      errores.push({
        servidor: server,
        mensaje: (idx.workload !== -1 ? row[idx.workload] : "") || "Sin detalle"
      });
      continue;
    }

    const edition = (row[idx.edition] || "").toString().trim();
    if (!edition) continue;

    const type = idx.type !== -1 ? (row[idx.type] || "Desconocido") : "Desconocido";
    const workload = idx.workload !== -1 ? (row[idx.workload] || "General") : "General";
    
    let rawUsed = row[idx.used];
    let rawLic = row[idx.licensed];
    let usedNum = typeof normalizarNumero === "function" ? normalizarNumero(rawUsed, rawUsed) : parseInt(rawUsed) || 0;
    let licNum = typeof normalizarNumero === "function" ? normalizarNumero(rawLic, rawLic) : parseInt(rawLic) || 0;
    
    let rawExp = idx.expiration !== -1 ? (row[idx.expiration] || "").toString().trim() : "";
    let diasRestantes = 999999;

    if (rawExp.toLowerCase() !== "" && rawExp.toLowerCase() !== "never") {
      let dStr = rawExp.split(" ")[0];
      let expDate = null;
      if (typeof interpretarFecha === "function") {
        expDate = interpretarFecha(dStr);
      } else {
        let parsed = new Date(dStr);
        if (!isNaN(parsed.getTime())) expDate = { obj: parsed };
      }
      
      if (expDate) {
        expDate.obj.setHours(0,0,0,0);
        diasRestantes = Math.ceil((expDate.obj.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
      } else {
        // Fallback robusto para ISO/YYYY-MM-DD
        let parts = dStr.split(/[\/\-]/);
        if (parts.length >= 3) {
          let y = parseInt(parts[0]), m = parseInt(parts[1]), d = parseInt(parts[2]);
          if (y > 2000) {
            let dt = new Date(y, m-1, d);
            diasRestantes = Math.ceil((dt.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
          }
        }
      }
    }

    if (status.toLowerCase().includes("expired")) diasRestantes = -1;

    licencias.push({
      servidor: server,
      nombre: edition,
      tipo: type,
      vencimiento: rawExp || "Never",
      diasRestantes: diasRestantes,
      usadas: usedNum,
      total: licNum,
      workload: workload
    });
  }

  return { licencias, errores };
}

/**
 * Descarta las filas '0 de 0 (Sockets)' redundantes: si el servidor ya reporta uso real en
 * otra fila, esa no aporta nada. Se aplica ANTES de clasificar porque esas filas heredan la
 * fecha de vencimiento de la licencia y si no dispararían alertas por duplicado.
 */
function filtrarSocketsRedundantes(licencias) {
  const servidoresConUso = new Set(licencias.filter(a => a.usadas > 0).map(a => a.servidor));
  return licencias.filter(a => !(
    a.usadas === 0 && a.total === 0 && a.workload === 'Sockets' && servidoresConUso.has(a.servidor)
  ));
}

function enviarAlertaLicenciasVeeam(cliente, destinatarioRaw, todasLasLicencias) {
  const emailsAEnviar = destinatarioRaw.toString().split(',').map(e => e.trim()).filter(e => e !== "").join(',');

  // Clasifica services/LicenciasEstado.js (AGENTS.md §5). Ahí vive la regla de Veeam: el
  // vencimiento manda esté o no la licencia en uso, porque una licencia paga que vence sin
  // usarse le importa igual al equipo y a quien la vendió.
  const clas = clasificarLicenciasVeeam(todasLasLicencias);
  const licencias = clas.licencias;
  const vencidas = clas.vencidas;
  const proximas = clas.proximas;
  const sanasEnUso = clas.sanasEnUso;
  const sinUso = clas.sinUso;

  const sortServidorDias = (a, b) => {
    if (a.servidor < b.servidor) return -1;
    if (a.servidor > b.servidor) return 1;
    return a.diasRestantes - b.diasRestantes;
  };

  vencidas.sort(sortServidorDias);
  proximas.sort(sortServidorDias);
  sanasEnUso.sort(sortServidorDias);
  sinUso.sort(sortServidorDias);

  const todoOK = (vencidas.length === 0 && proximas.length === 0);

  let colorHeader = "#5cb85c"; // Verde
  let iconoHeader = "✅";
  let statusTxt = "Auditoría Exitosa";
  let situacionTxt = "Todas las licencias de Veeam se encuentran vigentes.";

  if (vencidas.length > 0) {
    colorHeader = "#d9534f";
    iconoHeader = "❌";
    statusTxt = "Licencias Veeam Vencidas";
    situacionTxt = "Se requiere acción inmediata para renovar licencias expiradas.";
  } else if (proximas.length > 0) {
    colorHeader = "#f0ad4e";
    iconoHeader = "⚠️";
    statusTxt = "Atención: Licencias Veeam Próximas a Vencer";
    situacionTxt = "Se han detectado licencias que vencerán en el corto plazo.";
  }

  const fechaHoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy");
  const asunto = `${iconoHeader} Estado de Licencias Veeam - Wetcom / ${cliente} - ${fechaHoy}`;
  
  let cuerpoHtml = `
  <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; max-width: 850px;">
    <div style="border: 1px solid #ddd; border-left: 6px solid ${colorHeader}; padding: 20px; background-color: #f9f9f9; border-radius: 4px;">
      <h2 style="margin-top: 0; color: ${colorHeader}; font-size: 18px;">${statusTxt}</h2>
      <p style="font-size: 14px;">Auditoría Veeam completa para <b>${cliente}</b>.</p>
      <p style="font-size: 14px;"><b>Situación:</b> ${situacionTxt}</p>
  `;

  const formatUso = (u, t, w) => {
    let un = typeof formatearNumero === "function" ? formatearNumero(u) : u;
    // El JSON de "Create Report" trae el consumo pero no el total contratado. Mostrar
    // "7974 de 0" parece un dato roto; sin total mostramos sólo el consumo.
    if (!t) return `${un} (${w})`;
    let tn = typeof formatearNumero === "function" ? formatearNumero(t) : t;
    return `${un} de ${tn} (${w})`;
  };

  const formatTable = (titulo, items, bgHeader, colorHeader, bgSub, colorSub) => {
    if (items.length === 0) return "";
    let html = `
      <div style="margin-top: 20px;">
        <table style="border-collapse: collapse; width: 100%; background-color: white; font-size: 13px; border: 1px solid #ddd;">
          <tr style="background-color: ${bgHeader}; color: ${colorHeader};">
            <th colspan="6" style="padding: 10px; border: 1px solid #ddd; text-align: left; font-size: 14px;">${titulo}</th>
          </tr>
          <tr style="background-color: ${bgSub}; color: ${colorSub};">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Servidor</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Licencia</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Tipo</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Vencimiento</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Días</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Uso</th>
          </tr>`;
    items.forEach(a => {
      let isCrit = (a.diasRestantes < 0);
      let diasDisplay = (a.diasRestantes === 999999) ? "-" : (isCrit ? "VENCIDA" : a.diasRestantes);
      let rowColor = a.usadas === 0 ? "color: #666; background-color: #f2f2f2;" : "background-color: #fff;";
      
      html += `<tr style="${rowColor}">
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">${a.servidor}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.tipo}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; ${isCrit ? 'color:#d9534f; font-weight:bold;' : ''}">${a.vencimiento}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; ${isCrit ? 'color:#d9534f; font-weight:bold;' : ''}">${diasDisplay}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${formatUso(a.usadas, a.total, a.workload)}</td>
      </tr>`;
    });
    html += `</table></div>`;
    return html;
  };

  cuerpoHtml += formatTable("CRÍTICO - LICENCIAS VENCIDAS", vencidas, "#d9534f", "white", "#fdf7f7", "#761c19");
  cuerpoHtml += formatTable("ATENCIÓN - PRÓXIMAS A VENCER", proximas, "#f0ad4e", "white", "#fcf8f2", "#8a6d3b");

  if (sanasEnUso.length > 0 || sinUso.length > 0) {
    let bgH = todoOK ? "#5cb85c" : "#e2e3e5";
    let colH = todoOK ? "white" : "#495057";
    let bgS = todoOK ? "#f9fdf9" : "#f8f9fa";
    let colS = todoOK ? "#2b542c" : "#495057";

    cuerpoHtml += formatTable("SALUDABLE - ESTADO OK / NO UTILIZADAS", sanasEnUso.concat(sinUso), bgH, colH, bgS, colS);
  }

  cuerpoHtml += `<p style="font-size: 14px; margin-top: 20px;">Este reporte es meramente informativo.</p></div><p style="margin-top: 25px; font-size: 12px; color: #666;">Saludos,<br><b>Wetcom Proactive Center</b></p></div>`;
  
  if (emailsAEnviar) {
    EmailService.enviarReporteGuardia(emailsAEnviar, asunto, cuerpoHtml);

  }
}

function enviarAlertaSlackVeeamLic(cliente, alertas) {
  // Mismo guard falso que en vSphere, más un sendSlackMessage que tampoco existe acá.
  const clas = clasificarLicenciasVeeam(alertas);
  const vencidas = clas.vencidas;
  const proximas = clas.proximas;
  if (vencidas.length === 0 && proximas.length === 0) return;

  let msg = `*Reporte de Licencias Veeam - ${cliente}*\n`;
  if (vencidas.length > 0) msg += `🔴 *CRÍTICO:* ${vencidas.length} licencias vencidas.\n`;
  if (proximas.length > 0) msg += `🟡 *WARNING:* ${proximas.length} próximas a vencer.\n`;
  SlackService.enviarLogTexto(msg);
}

function ejecutarClienteSeleccionadoVeeamLic() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(NOMBRE_PESTANA_CONFIG);
  if (!hoja) return ui.alert("❌ Error", "No se encontró la pestaña.", ui.ButtonSet.OK);
  
  const fila = hoja.getActiveCell().getRow();
  if (fila === 1) return ui.alert("⚠️ Advertencia", "Selecciona una fila válida.", ui.ButtonSet.OK);
  
  let cols, datosFila;
  try {
    ({ cols, fila: datosFila } = leerFilaSeleccionadaLicencias(hoja, fila, LIC_TECNOLOGIA_VEEAM));
  } catch (e) {
    return ui.alert("❌ Error", e.message, ui.ButtonSet.OK);
  }
  const { email: emailDestino, pod, cliente, carpeta: folderId, activo } = datosFila;

  if (!cliente || !emailDestino || !folderId) {
    return ui.alert("⚠️ Fila Incompleta", "Faltan datos de Veeam para este cliente.", ui.ButtonSet.OK);
  }
  if (!activo) {
    return ui.alert("⚠️ Cliente Inactivo", `El cliente está marcado como inactivo en "Activo Veeam".`, ui.ButtonSet.OK);
  }
  
  const respuesta = ui.alert(
      "Confirmar Auditoría Veeam",
      `¿Deseas lanzar la auditoría de licencias Veeam para el cliente?\n\n• Cliente: ${cliente}\n• POD: ${pod || 'N/A'}\n• Destinatario: ${emailDestino}`,
      ui.ButtonSet.YES_NO
    );
  if (respuesta !== ui.Button.YES) return;
  
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  ss.toast(`Procesando licencias Veeam de ${cliente}...`, "🚀 Auditoría en Curso", -1);
  
  try {
    const res = procesarInfraestructuraClienteVeeam(cliente, emailDestino, folderId, pod, summaryReport);
      
      let detalleLog = "📁 Ruta: " + res.ruta + "\n📄 Archivos:\n" + res.archivos;

      if (summaryReport.errores.length > 0) {
        escribirLogLicencias(hoja, fila, cols, false, "❌ Errores:\n" + summaryReport.errores[0].detalle);
        ui.alert("❌ Errores", summaryReport.errores[0].detalle, ui.ButtonSet.OK);
      } else {
        escribirLogLicencias(hoja, fila, cols, true, detalleLog);
        ui.alert("✅ Éxito", `Reporte enviado a ${emailDestino}.`, ui.ButtonSet.OK);
      }
    } catch (error) {
      escribirLogLicencias(hoja, fila, cols, false, "❌ Error Crítico: " + error.message);
      ui.alert("❌ Error Crítico", error.message, ui.ButtonSet.OK);
  } finally {
    ss.toast("Proceso finalizado.", "🏁 Wetcom Ops", 3);

  }
}

// --- MENÚ: ENVIAR TODOS LOS ACTIVOS DE UNA TECNOLOGÍA ---
// Audita y manda el mail a todos los clientes activos sin esperar al último día hábil.
// Reenvía aunque el cliente ya haya recibido el reporte este mes.
function enviarTodosActivosVsphere() {
  confirmarYEnviarTodosLicencias(LIC_TECNOLOGIA_VSPHERE);
}

function enviarTodosActivosVeeam() {
  confirmarYEnviarTodosLicencias(LIC_TECNOLOGIA_VEEAM);
}

function confirmarYEnviarTodosLicencias(tecnologia) {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const nombre = LIC_NOMBRE[tecnologia];

  let clientes;
  try {
    const { datos, cols } = leerConfiguracionLicencias(tecnologia);
    clientes = datos.slice(1)
      .map(row => leerFilaLicencias(row, cols))
      .filter(f => filaLicenciasCompleta(f) && f.activo)
      .map(f => f.cliente);
  } catch (e) {
    ui.alert("❌ Error", e.message, ui.ButtonSet.OK);
    return;
  }

  if (clientes.length === 0) {
    ui.alert("Sin clientes", `No hay clientes activos con carpeta de ${nombre} configurada.`, ui.ButtonSet.OK);
    return;
  }

  const enCurso = tecnologiaEnCursoLicencias();
  if (enCurso === tecnologia) {
    ui.alert(`⏳ ${nombre} ya está en curso`,
      `${describirEstadoLicencias(tecnologia)}\n\nNo se lanza otra corrida de ${nombre} hasta que termine esta.` +
      LIC_PIE_PENDIENTES + LIC_PIE_VER_ESTADO, ui.ButtonSet.OK);
    return;
  }

  // No hay vuelta atrás una vez que salen los mails: se muestra a quiénes antes de confirmar.
  let texto = `Se va a auditar y enviar el reporte a ${clientes.length} cliente(s):\n\n${clientes.join(", ")}`;
  if (enCurso) {
    texto += `\n\n🕒 ${LIC_NOMBRE[enCurso]} todavía no terminó: este envío va a quedar en cola y arranca solo cuando termine.`;
  }
  const respuesta = ui.alert(`Enviar licencias ${nombre} a todos los activos`, texto + "\n\n¿Continuar?", ui.ButtonSet.YES_NO);
  if (respuesta !== ui.Button.YES) return;

  ss.toast(`Arrancando ${clientes.length} cliente(s)...`, `🚀 Licencias ${nombre}`, -1);
  const alProgresar = (n, total, cliente) => ss.toast(`${n} de ${total}: ${cliente}`, `⏳ Licencias ${nombre}`, -1);
  const resultado = ejecutarAuditoriaLicencias(tecnologia, { nuevoCiclo: true, forzar: true, alProgresar });
  ss.toast("Terminó la parte visible del proceso.", `🏁 Licencias ${nombre}`, 5);

  const [titulo, mensaje] = resumenCorteLicencias(tecnologia, resultado);
  ui.alert(titulo, mensaje, ui.ButtonSet.OK);
}

const LIC_PIE_PENDIENTES = "\n\nMientras haya pendientes, cualquier otra ejecución de licencias que lances se programa para después de ellos.";
const LIC_PIE_VER_ESTADO = "\n\nPara seguir el avance: menú \"Ejecutar reporte de licencias\" → \"Ver estado de licencias\".";

/**
 * Lo que se le dice al operador cuando termina la parte visible: si quedó todo listo,
 * si sigue en segundo plano o si quedó en cola, y qué pasa si lanza otra cosa.
 * @returns {[string, string]} título y cuerpo del aviso.
 */
function resumenCorteLicencias(tecnologia, resultado) {
  const nombre = LIC_NOMBRE[tecnologia];
  const e = leerEstadoLicencias(tecnologia);
  const cola = leerColaLicencias();
  const errores = e.errores ? ` ${e.errores} con error: quedan en rojo en "Logs ${nombre}".` : "";
  let titulo, cuerpo;
  let hayPendientes = cola.length > 0;

  switch (resultado) {
    case 'finalizado':
      titulo = `✅ ${nombre}: terminado`;
      cuerpo = `Se procesaron los ${e.total || 0} cliente(s).${errores || " Todos sin error."}`;
      if (cola.length > 0) {
        cuerpo += `\n\n▶️ Quedaba en cola: ${cola.map(c => LIC_NOMBRE[c.tecnologia]).join(" → ")}. Arranca solo en 1 minuto.`;
      }
      break;
    case 'continua':
      titulo = `⏳ ${nombre}: sigue en segundo plano`;
      cuerpo = `Se procesaron ${e.hechos || 0} de ${e.total || 0} cliente(s).${errores}\n\n` +
               `Google corta cada ~4,5 minutos: el resto sigue solo en segundo plano y retoma en 1 minuto. ` +
               `No hace falta dejar la planilla abierta.`;
      hayPendientes = true;
      break;
    case 'en-cola': {
      const otra = tecnologiaEnCursoLicencias();
      titulo = `🕒 ${nombre}: en cola`;
      cuerpo = (otra ? `${LIC_NOMBRE[otra]} todavía no terminó (${describirEstadoLicencias(otra)}).\n\n` : "Hay otra corrida de licencias en curso.\n\n") +
               `${nombre} quedó en cola y arranca solo cuando termine.`;
      hayPendientes = true;
      break;
    }
    case 'ya-en-curso':
      titulo = `⏳ ${nombre} ya está en curso`;
      cuerpo = describirEstadoLicencias(tecnologia);
      hayPendientes = true;
      break;
    case 'error-config':
      titulo = `❌ ${nombre}: no se pudo leer la planilla`;
      cuerpo = e.mensaje || `Revisá la solapa "${NOMBRE_PESTANA_CONFIG}".`;
      break;
    default:
      titulo = `${nombre}: ${resultado}`;
      cuerpo = describirEstadoLicencias(tecnologia);
  }

  return [titulo, cuerpo + (hayPendientes ? LIC_PIE_PENDIENTES : "") + LIC_PIE_VER_ESTADO];
}

/** Menú: cómo van vSphere y Veeam, también mientras siguen en segundo plano. */
function verEstadoLicencias() {
  const lineas = [LIC_TECNOLOGIA_VSPHERE, LIC_TECNOLOGIA_VEEAM]
    .map(t => `${LIC_NOMBRE[t]}:\n${describirEstadoLicencias(t)}`);
  const cola = leerColaLicencias();
  lineas.push(cola.length > 0
    ? `En cola: ${cola.map(c => LIC_NOMBRE[c.tecnologia]).join(" → ")}`
    : "Cola: vacía");
  const ui = SpreadsheetApp.getUi();
  ui.alert("📊 Estado de licencias", lineas.join("\n\n"), ui.ButtonSet.OK);
}

// --- BACKOFF PARA DRIVE API ---
function executeDriveWithBackoff(fn, maxRetries) {
  const retries = maxRetries || 3;
  let attempt = 0;
  while (attempt < retries) {
    try {
      return fn();
    } catch (e) {
      attempt++;
      const msg = e.message.toLowerCase();
      if ((msg.includes("rate limit") || msg.includes("limit exceeded") || msg.includes("too many requests") || msg.includes("service error")) && attempt < retries) {
        const sleepTime = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        Logger.log(`[DRIVE BACKOFF] Intento ${attempt} falló por límite de tasa. Reintentando en ${Math.round(sleepTime)}ms... Error: ${e.message}`);
        Utilities.sleep(sleepTime);
      } else {
        throw e;
      }
    }
  }
}

// --- PARSER ROBUSTO ---
function parseCsvRobust(csvText, separator = null) {
  if (!csvText) return [];
  const lines = csvText.split(/\r\n|\n|\r/);
  const sep = separator || detectarSeparadorCsv(lines);

  const result = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const row = [];
    let currentField = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = i < line.length - 1 ? line[i+1] : null;

      if (char === '"' && inQuotes && nextChar === '"') {
        currentField += '"';
        i++; // Skip next quote
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === sep && !inQuotes) {
        row.push(currentField);
        currentField = '';
      } else {
        currentField += char === '|' ? '-' : char;
      }
    }
    row.push(currentField);
    result.push(row);
  }
  return result;
}