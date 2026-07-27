/**
 * @fileoverview Funciones y constantes de utilidad para búsqueda y etiquetado de correos en Gmail.
 * Implementa el flujo de etiquetas [OPS-PENDIENTE] -> [OPS-PROCESADO] para no depender de isUnread().
 */

const OPS_LABEL_PENDIENTE = "[OPS-PENDIENTE]";
const OPS_LABEL_PROCESADO = "[OPS-PROCESADO]";

/**
 * Obtiene o crea una etiqueta en Gmail de forma segura.
 * @param {string} labelName Nombre de la etiqueta.
 * @returns {GoogleAppsScript.Gmail.GmailLabel} Etiqueta de Gmail.
 */
function getOrCreateOpsLabel(labelName) {
  try {
    let label = GmailApp.getUserLabelByName(labelName);
    if (!label) {
      label = GmailApp.createLabel(labelName);
      Logger.log(`[MailUtils] Etiqueta creada en Gmail: ${labelName}`);
    }
    return label;
  } catch (e) {
    Logger.log(`[MailUtils] Error al obtener/crear etiqueta "${labelName}": ${e.message}`);
    return null;
  }
}

/**
 * Aplica las transiciones de etiquetas en un thread de Gmail y gestiona su estado de lectura.
 * @param {GoogleAppsScript.Gmail.GmailThread} thread Hilo procesado.
 * @param {string} status Estado final del procesamiento ('SUCCESS', 'NO_OP', 'ERROR', 'FAILURE', 'HTTP_500').
 */
function etiquetarYMarcarProcesado(thread, status) {
  try {
    const labelPendiente = getOrCreateOpsLabel(OPS_LABEL_PENDIENTE);
    const labelProcesado = getOrCreateOpsLabel(OPS_LABEL_PROCESADO);

    if (status === 'SUCCESS' || status === 'NO_OP') {
      if (labelPendiente) thread.removeLabel(labelPendiente);
      if (labelProcesado) thread.addLabel(labelProcesado);
      thread.markRead();
      Logger.log(`[MailUtils] Thread marcado como PROCESADO (${status}) -> ${OPS_LABEL_PROCESADO}`);
    } else {
      // Si falló (ERROR, FAILURE, HTTP_500), aseguramos la etiqueta [OPS-PENDIENTE] y no agregamos PROCESADO
      if (labelPendiente) thread.addLabel(labelPendiente);
      Logger.log(`[MailUtils] Thread marcado para reintento -> ${OPS_LABEL_PENDIENTE} (${status})`);
    }
  } catch (e) {
    Logger.log(`[MailUtils] Error al gestionar etiquetas del thread: ${e.message}`);
  }
}

// Tope de hilos que trae la búsqueda global de pendientes. GmailApp.search admite hasta 500.
// Estaba en 200 y las corridas del 27/07/2026 devolvían exactamente 200 todas las veces,
// señal de que se estaba truncando el resultado. Ver la advertencia en fetchAndFilterGlobalThreads.
const LIMITE_HILOS_PENDIENTES = 450;

let _globalPendingThreads = null;
let _validSendersCache = null;

/**
 * Obtiene todos los correos pendientes de una sola vez y los filtra en memoria.
 * Evita la saturación de la cuota de la API de Gmail.
 * @param {string} emailSubject El asunto base de la operación.
 * @returns {Array<GoogleAppsScript.Gmail.GmailThread>} Lista de hilos filtrados.
 */
function fetchAndFilterGlobalThreads(emailSubject) {
  if (!_globalPendingThreads) {
    Logger.log("[MailUtils] Obteniendo todos los hilos [OPS-PENDIENTE] globales (caché de ejecución)...");
    _globalPendingThreads = GmailApp.search(`has:attachment (label:${OPS_LABEL_PENDIENTE} OR is:unread) -label:${OPS_LABEL_PROCESADO}`, 0, LIMITE_HILOS_PENDIENTES);
    Logger.log(`[MailUtils] Se obtuvieron ${_globalPendingThreads.length} hilos en total.`);

    // Si la búsqueda vuelve justo con el tope, Gmail truncó el resultado y hay reportes
    // que este ciclo NUNCA va a ver: quedan sin procesar sin que nada lo reporte.
    // El riesgo es real porque la consulta incluye `is:unread`, así que cualquier correo
    // no leído con adjunto (aunque no sea un reporte) compite por el cupo.
    if (_globalPendingThreads.length >= LIMITE_HILOS_PENDIENTES) {
      Logger.log(`[MailUtils] ⚠️ ADVERTENCIA: la búsqueda alcanzó el tope de ${LIMITE_HILOS_PENDIENTES} hilos. Es MUY probable que haya reportes pendientes fuera de ese corte, que este ciclo no va a procesar. Revisar la bandeja: correos no leídos con adjunto que no sean reportes ocupan lugar.`);
    }
  }

  if (!_validSendersCache) {
    const masterSheet = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0];
    const senderData = masterSheet.getRange("A2:A").getValues();
    const senders = [];
    senderData.flat().forEach(val => {
      if (val && val.toString().trim() !== "") {
        val.toString().split(',').forEach(s => {
          const trimmed = s.trim().toLowerCase();
          if (trimmed) senders.push(trimmed);
        });
      }
    });
    _validSendersCache = senders;
  }

  if (_validSendersCache.length === 0) {
    Logger.log("ADVERTENCIA: No se encontraron remitentes en el Índice Maestro.");
    return [];
  }

  const subjectLower = emailSubject.toLowerCase();
  
  return _globalPendingThreads.filter(thread => {
    if (thread.getMessageCount() === 0) return false;
    const msg = thread.getMessages()[thread.getMessageCount() - 1];
    
    const msgSubjectLower = msg.getSubject().toLowerCase();
    // Replicar el comportamiento de subject:"" de Gmail, que verifica que contenga las palabras
    if (!msgSubjectLower.includes(subjectLower)) return false;

    const fromLower = msg.getFrom().toLowerCase();
    return _validSendersCache.some(sender => fromLower.includes(sender));
  });
}


