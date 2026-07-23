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
 * Se ejecuta manualmente desde el editor de Apps Script.
 */
function diagnosticarEncabezadosDeReporte() {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    'Diagnóstico de Encabezados',
    'Ingresa el nombre EXACTO de la operación (ej. "VMs operativas", "Cluster DRS"):',
    ui.ButtonSet.OK_CANCEL);

  if (result.getSelectedButton() !== ui.Button.OK || !result.getResponseText()) {
    return;
  }
  
  const operationName = result.getResponseText().trim();
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
    SpreadsheetApp.getUi().alert("Diagnóstico completo. Revisa los logs para ver los encabezados.");
  } else {
    Logger.log("No se pudieron extraer encabezados del reporte.");
  }
}
function forzarReautorizacion() {
  // Esta función no hace nada.
  MailApp.sendEmail("test@test.com", "test", "test");
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

