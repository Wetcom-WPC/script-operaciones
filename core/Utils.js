/**
 * @class TimeGuard
 * Supervisa el tiempo restante de ejecución de Google Apps Script (límite de 6 minutos = 360,000 ms).
 * Proporciona chequeo pre-mensaje granular en bucles para pausar de forma segura si quedan menos de 30s
 * y notifica a Slack con stack trace de depuración.
 */
class TimeGuard {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxExecutionMs=330000] Tiempo máximo permitido antes de pausar (ej. 330,000 ms = 5.5 mins).
   * @param {number} [options.safetyMarginMs=30000] Margen de seguridad antes de los 6 mins en ms (30 segundos).
   * @param {string} [options.operationName="Operación general"] Nombre de la operación para alertas y logs.
   */
  constructor({ maxExecutionMs = 330000, safetyMarginMs = 30000, operationName = "Operación general" } = {}) {
    this.startTime = Date.now();
    this.maxExecutionMs = maxExecutionMs;
    this.safetyMarginMs = safetyMarginMs;
    this.operationName = operationName;
    this.paused = false;
  }

  getElapsedMs() {
    return Date.now() - this.startTime;
  }

  getRemainingMs() {
    return Math.max(0, 360000 - this.getElapsedMs());
  }

  /**
   * Verifica si queda suficiente tiempo para ejecutar la siguiente iteración.
   * Si transcurrió el tiempo máximo o el margen restante es menor a safetyMarginMs (30s),
   * pausa, envía una alerta crítica con stack trace a Slack, y retorna false.
   * @param {string} [contextInfo=""] Detalle del ítem que iba a procesarse.
   * @returns {boolean} `true` si se puede continuar, `false` si se debe pausar.
   */
  check(contextInfo = "") {
    if (this.paused) return false;

    const elapsed = this.getElapsedMs();
    const remaining = this.getRemainingMs();

    if (elapsed >= this.maxExecutionMs || remaining <= this.safetyMarginMs) {
      this.paused = true;
      const stackTrace = new Error().stack || "Sin traza disponible.";
      const msgDetalle = `Se pausó la ejecución de "${this.operationName}" por seguridad (TimeGuard: quedan ${Math.round(remaining/1000)}s de los 6 min permitidos). ${contextInfo ? `[Siguiente ítem: ${contextInfo}]` : ""}`;
      
      Logger.log(`[TimeGuard] ${msgDetalle}`);
      
      if (typeof enviarAlertaCriticaSlack === "function") {
        enviarAlertaCriticaSlack(
          `⏱️ TimeGuard Activado (${this.operationName})`,
          msgDetalle,
          stackTrace
        );
      }
      return false;
    }
    return true;
  }
}

/**
 * Función de diagnóstico para ver los encabezados de un reporte tal como los ve el script.
 *
 * SpreadsheetApp.getUi() solo funciona si la ejecución viene de un contexto de UI real
 * (un menú personalizado clickeado dentro de la hoja abierta, onOpen, onEdit, etc.).
 * Ejecutar con el botón "Run" del editor de Apps Script NUNCA tiene esa sesión de UI,
 * así que getUi() tira "Cannot call SpreadsheetApp.getUi() from this context." sin importar
 * qué función la llame. Por eso ahora acepta `operationName` como parámetro opcional:
 * pasándolo (ej. desde manual_diagnosticarEncabezados en custom/HerramientasManuales.js)
 * se puede correr headless desde el editor sin depender de la UI. Si se omite, intenta el
 * prompt de UI como antes (solo funciona si se invoca desde un menú de la hoja).
 * @param {string} [operationName] Nombre EXACTO de la operación (ej. "VMs operativas", "Cluster DRS").
 */
function diagnosticarEncabezadosDeReporte(operationName) {
  if (!operationName) {
    let ui;
    try {
      ui = SpreadsheetApp.getUi();
    } catch (e) {
      Logger.log('[diagnosticarEncabezadosDeReporte] No hay contexto de UI disponible (se ejecutó fuera de un menú de hoja). Pasa el nombre de la operación como parámetro, ej: diagnosticarEncabezadosDeReporte("VMs operativas").');
      return;
    }
    const result = ui.prompt(
      'Diagnóstico de Encabezados',
      'Ingresa el nombre EXACTO de la operación (ej. "VMs operativas", "Cluster DRS"):',
      ui.ButtonSet.OK_CANCEL);

    if (result.getSelectedButton() !== ui.Button.OK || !result.getResponseText()) {
      return;
    }
    operationName = result.getResponseText().trim();
  } else {
    operationName = operationName.trim();
  }

  Logger.log(`--- Iniciando diagnóstico para la operación: "${operationName}" ---`);

  const searchQuery = `subject:"${operationName}" has:attachment`;
  const threads = GmailApp.search(searchQuery, 0, 1);

  if (threads.length === 0) {
    Logger.log(`No se encontró ningún correo con el asunto que contenga "${operationName}".`);
    return;
  }

  const message = threads[0].getMessages()[threads[0].getMessageCount() - 1];
  const attachment = message.getAttachments()[0];
  if (!attachment) {
    Logger.log("El correo más reciente no tiene adjuntos.");
    return;
  }
  
  Logger.log(`Correo encontrado. Asunto: "${message.getSubject()}"`);
  Logger.log(`Adjunto: "${attachment.getName()}"`);

  let headers = [];
  const fileName = attachment.getName().toLowerCase();

  try {
    if (fileName.endsWith(".csv")) {
      const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
      if (allRows.length > 0) {
        headers = allRows[0].map(h => h.replace(/\uFEFF/g, '').trim().replace(/^"|"$/g, ''));
      }
    } else if (fileName.endsWith(".json")) {
      const jsonString = attachment.getDataAsString("UTF-8");
      const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
      const reportData = parsedJson.Report || parsedJson.alerts || parsedJson;
      if (Array.isArray(reportData) && reportData.length > 0) {
        headers = Object.keys(reportData[0]);
      }
    } else {
      Logger.log("El adjunto no es un archivo .csv o .json reconocido.");
      return;
    }
  } catch (e) {
    Logger.log(`Error al procesar el archivo: ${e.message}`);
    return;
  }

  if (headers.length > 0) {
    Logger.log("--- Encabezados Detectados ---");
    headers.forEach((header, index) => {
      Logger.log(`[${index}] "${header}"`);
    });
    Logger.log("--------------------------------");
    try { SpreadsheetApp.getUi().alert("Diagnóstico completo. Revisa los logs para ver los encabezados."); } catch (e) { /* sin contexto de UI (ejecución headless): el resultado ya quedó en el log */ }
  } else {
    Logger.log("No se pudieron extraer encabezados del reporte.");
  }
}
function forzarReautorizacion() {
  // Esta función no hace nada.
  MailApp.sendEmail("test@test.com", "test", "test");
}

// --- VENTANA HORARIA OPERATIVA (BUG-03) -----------------------------------
// El día operativo de la Mesa es de 05:00 a 15:00 (hora Argentina). Los triggers
// que corren 24/7 (ej. organizarReportesEnDrive cada 10 min, processProxyAlarms
// cada 15 min) consumían cuota de Gmail las 24 horas. Estos límites permiten
// omitir la ejecución fuera de la ventana operativa.
const HORARIO_OPERATIVO_INICIO = 5;   // inclusive (05:00)
const HORARIO_OPERATIVO_FIN = 15;     // exclusive (hasta las 14:59)
const HORARIO_OPERATIVO_TZ = "America/Argentina/Buenos_Aires";

/**
 * ¿Hoy es feriado según la API pública de feriados argentinos?
 *
 * Consulta https://api.argentinadatos.com/v1/feriados/{año} con UN reintento
 * ante falla de red o HTTP ≠ 200. Si ambos intentos fallan, se asume día hábil
 * (fail-safe: para no interrumpir el procesamiento normal) y se avisa por Slack.
 *
 * Ante cualquier problema siempre loguea el motivo (§7 de AGENTS.md).
 *
 * @param {Date} [fecha] Fecha a evaluar. Por defecto, hoy.
 * @returns {boolean}
 */
function esFeriadoHoy(fecha) {
  const hoy = fecha instanceof Date ? fecha : new Date();
  const feriados = _consultarFeriados(hoy.getFullYear());

  if (feriados === null) {
    const aviso =
      `No se pudo consultar la API de feriados (se reintentó una vez). ` +
      `Se asume día hábil para no interrumpir el procesamiento de reportes.`;
    Logger.log(`⚠️ ${aviso}`);
    if (typeof sendSlackMessage === "function") {
      const webhook = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_GENERAL');
      if (webhook) sendSlackMessage(webhook, `⚠️ ${aviso}`);
    }
    return false;
  }

  const mes    = String(hoy.getMonth() + 1).padStart(2, '0');
  const dia    = String(hoy.getDate()).padStart(2, '0');
  const fechaBuscada = `${hoy.getFullYear()}-${mes}-${dia}`;

  const esFeriado = feriados.some(f => f.fecha === fechaBuscada);
  if (esFeriado) Logger.log(`Hoy (${fechaBuscada}) es feriado en Argentina.`);
  return esFeriado;
}

let _feriadosCacheado = null;
let _feriadosAñoCacheado = null;

/**
 * Consulta el listado de feriados del año dado a la API pública.
 * Reintenta una vez ante error de red o HTTP ≠ 200.
 * Usa una variable global como caché de memoria para no llamar repetidamente
 * a la API si varios triggers corren durante la misma ejecución.
 * Devuelve null si los dos intentos fallan.
 *
 * @param {number} año
 * @returns {Array|null}
 */
function _consultarFeriados(año) {
  if (_feriadosCacheado !== null && _feriadosAñoCacheado === año) {
    return _feriadosCacheado;
  }

  const url = `https://api.argentinadatos.com/v1/feriados/${año}`;
  let ultimoError;

  for (let intento = 1; intento <= 2; intento++) {
    try {
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) {
        throw new Error(`HTTP ${response.getResponseCode()}`);
      }
      Logger.log(`API de feriados consultada para el año ${año}.`);
      _feriadosCacheado = JSON.parse(response.getContentText());
      _feriadosAñoCacheado = año;
      return _feriadosCacheado;
    } catch (e) {
      ultimoError = e;
      Logger.log(`Error consultando feriados (intento ${intento}/2): ${e.message}`);
    }
  }

  Logger.log(`Falló la consulta de feriados para ${año} tras 2 intentos: ${ultimoError.message}`);
  return null;
}

/**
 * Indica si el momento actual está dentro de la ventana operativa (05:00–15:00 hora Argentina).
 * @returns {boolean} `true` si se debe ejecutar, `false` si está fuera de horario.
 */
function estaEnHorarioOperativo() {
  const hora = parseInt(Utilities.formatDate(new Date(), HORARIO_OPERATIVO_TZ, "H"), 10);
  return hora >= HORARIO_OPERATIVO_INICIO && hora < HORARIO_OPERATIVO_FIN;
}

/**
 * Guarda de ejecución para triggers 24/7. Registra en log y devuelve `false`
 * si estamos fuera del horario operativo, para que la función que llama pueda
 * cortar temprano: `if (!dentroDeVentanaOperativa("miTrigger")) return;`
 * @param {string} [nombreTrigger=""] Nombre del trigger, solo para el log.
 * @returns {boolean} `true` si se puede continuar, `false` si se debe omitir.
 */
function dentroDeVentanaOperativa(nombreTrigger = "") {
  if (estaEnHorarioOperativo()) return true;
  Logger.log(`[HorarioOperativo] Fuera de la ventana operativa (${HORARIO_OPERATIVO_INICIO}-${HORARIO_OPERATIVO_FIN}hs AR). Ejecución omitida${nombreTrigger ? `: ${nombreTrigger}` : ""}.`);
  return false;
}

/**
 * Wrapper para ejecutar llamadas a la API de Drive con backoff exponencial
 * para evitar el error 'User rate limit exceeded'.
 */
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


/**
 * ==========================================================
 * REGISTRO DE FALLOS DEL MENSAJE EN CURSO
 * ==========================================================
 *
 * Un correo solo se marca [OPS-PROCESADO] si TODOS sus pasos salieron bien. El problema
 * es que 21 processors sobrescriben handleAlerts() y varios devuelven { status: 'SUCCESS' }
 * aunque una llamada a Jira haya fallado: el 27/07/2026 se vio un adjunto con HTTP 500 que
 * igual terminó marcado como procesado, quedando el reporte sin subir y sin reintento.
 *
 * En vez de parchear los 21 archivos (y confiar en que el próximo processor se acuerde),
 * el fallo se registra en el mismo lugar donde ocurre: las funciones de JiraService anotan
 * acá cuando una operación de escritura no se concretó. MailProcessor limpia el registro al
 * empezar cada correo y lo consulta al terminar. Es la única fuente de verdad sobre si un
 * correo quedó completo (ver AGENTS.md §5 y §7).
 *
 * Solo se registran ESCRITURAS que no se concretaron (adjuntar, crear, comentar, transicionar).
 * Las lecturas de verificación (buscarAdjuntoEnTicket, haSidoActualizadoHoy) no cuentan:
 * que una verificación falle no significa que el trabajo no se haya hecho.
 */

let _fallosDelMensajeActual = [];

/** Limpia el registro. Lo llama MailProcessor al empezar cada correo. */
function iniciarSeguimientoDeFallos() {
  _fallosDelMensajeActual = [];
}

/**
 * Registra que un paso no se completó, para que el correo no se dé por procesado.
 *
 * @param {string} origen Función o paso donde ocurrió (ej. "addAttachmentToJiraTicket").
 * @param {string} detalle Motivo concreto, con ticket/cliente si se conocen.
 * @param {boolean} [esTerminal=false] true si reintentar NO lo va a arreglar (problema de
 *        configuración, ej. la tarea programada no existe). Esos correos se apartan con la
 *        etiqueta [OPS-ERROR] en vez de reintentarse en cada ciclo para siempre.
 */
function registrarFalloDePaso(origen, detalle, esTerminal) {
  _fallosDelMensajeActual.push({ origen: origen, detalle: detalle, terminal: esTerminal === true });
  Logger.log(`[Fallos]${esTerminal === true ? ' [TERMINAL]' : ''} ${origen}: ${detalle}`);
}

/** @returns {Array<{origen: string, detalle: string, terminal: boolean}>} Fallos del correo en curso. */
function obtenerFallosDelMensaje() {
  return _fallosDelMensajeActual.slice();
}

/** @returns {boolean} true si algún fallo requiere intervención humana (no sirve reintentar). */
function hayFalloTerminal() {
  return _fallosDelMensajeActual.some(function (f) { return f.terminal === true; });
}
