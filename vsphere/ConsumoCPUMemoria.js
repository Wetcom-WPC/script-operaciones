/**
 * =================================================================
 * SCRIPT DE REPORTE DE CONSUMO (CPU/MEMORIA) - VERSIÓN OPTIMIZADA + DRP
 * =================================================================
 */

const CONSUMO_OPERATION_NAME = "Reporte de Consumo vSphere";
const CONSUMO_EMAIL_SUBJECTS = 'subject:{"Alertas de vSphere" "Alarmas de vSphere"}';
const CONSUMO_FILENAME_MATCH = ".json";
const CONSUMO_GROUPING_COLUMN = "alarm"; 
const CONSUMO_OBJECT_COLUMN = "object";  

const CONSUMO_ALERTS_TO_FIND = [
  "Virtual machine memory usage",
  "Virtual machine CPU usage",
  "Host CPU usage",
  "Host memory usage"
];

// Mapeo de DRP 
const CONSUMO_DRP_CLIENT_NAME_MAP = {
  "BERSA": "Operaciones Banco de Entre Rios",
  "SANTA FE": "Operaciones Banco Santa Fe",
  "SAN JUAN": "Operaciones Banco de San Juan",
  "SANTA CRUZ": "Operaciones Banco de Santa Cruz"
};

/**
 * Busca los consumos mapeando la Key de Jira con el remitente del Índice Maestro.
 * @param {string} opsKey - La Key del espacio de operaciones (ej: "OBC")
 */
function generarReporteConsumoVsphere(opsKey) {
  Logger.log(`--- Iniciando ${CONSUMO_OPERATION_NAME} para Key: ${opsKey} ---`);
  
  if (!opsKey) {
    Logger.log("⚠️ No se proporcionó opsKey para buscar consumos.");
    return [];
  }

  // 1. Buscar el/los remitente(s) y el nombre del cliente en el Índice Maestro
  let clientSenders = [];
  let clientNameFromIndex = ""; 
  
  try {
    const masterSheet = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0];
    const data = masterSheet.getRange("A2:D").getValues();

    data.forEach(row => {
      const sender = row[0] ? String(row[0]).trim() : "";
      const clientName = row[1] ? String(row[1]).trim() : "";
      const keyOpsSheet = row[3] ? String(row[3]).trim() : ""; // Columna D

      if (keyOpsSheet.toUpperCase() === String(opsKey).trim().toUpperCase() && sender !== "") {
        clientSenders.push(sender);
        if (!clientNameFromIndex) clientNameFromIndex = clientName;
      }
    });
  } catch (e) {
     Logger.log(`Error crítico al leer el Índice Maestro: ${e.message}`);
     return []; 
  }
  
  if (clientSenders.length === 0) {
    Logger.log(`No se encontraron remitentes en el Índice Maestro para la Key: ${opsKey}.`);
    return [];
  }

  // 2. Construir la consulta de Gmail EXCLUSIVA para los remitentes de este cliente
  const fromQuery = `(from:${clientSenders.join(" OR from:")})`;
  const searchQuery = `${fromQuery} ${CONSUMO_EMAIL_SUBJECTS} newer_than:12h`;
  
  const threads = GmailApp.search(searchQuery);
  Logger.log(`[Optimizado] Búsqueda encontró ${threads.length} hilos con la consulta: ${searchQuery}`);
  
  let allAlerts = [];

  // 3. Procesar los correos
  threads.forEach(thread => {
    const message = thread.getMessages()[thread.getMessageCount() - 1];
    const emailSubject = message.getSubject();

    // Por defecto usamos el nombre del Índice Maestro
    let finalClientName = clientNameFromIndex || opsKey;

    // --- LÓGICA DRP RECUPERADA ---
    const subjectLower = emailSubject.toLowerCase();
    if (subjectLower.includes('drp')) {
      const drpMatch = emailSubject.match(/Alarmas de vSphere\s(.*?)\s\(/i);
      if (drpMatch && drpMatch[1]) {
        let drpClientName = drpMatch[1].trim();
        const mappedClientName = CONSUMO_DRP_CLIENT_NAME_MAP[drpClientName.toUpperCase()];
        
        // Pisamos el nombre del cliente con el de DRP
        finalClientName = mappedClientName ? mappedClientName : drpClientName;
        Logger.log(`Alerta DRP detectada. Renombrando cliente a: ${finalClientName}`);
      }
    }
    // --- FIN LÓGICA DRP ---

    const attachment = message.getAttachments().find(att => att.getName().toLowerCase().endsWith(CONSUMO_FILENAME_MATCH));
    if (!attachment) return;

    try {
      const jsonString = attachment.getDataAsString("UTF-8");
      const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
      const reportData = parsedJson.Report || parsedJson.alerts || parsedJson;

      if (!reportData || !Array.isArray(reportData) || reportData.length === 0) {
        return;
      }

      // Filtramos solo las alertas que nos interesan
      const relevantAlerts = reportData.filter(row => 
        row[CONSUMO_GROUPING_COLUMN] && CONSUMO_ALERTS_TO_FIND.includes(row[CONSUMO_GROUPING_COLUMN])
      );

      if (relevantAlerts.length > 0) {
        Logger.log(`Se encontraron ${relevantAlerts.length} alertas de consumo para ${finalClientName}`);
        allAlerts.push({
          clientName: finalClientName,
          alerts: relevantAlerts
        });
      }
    } catch (e) {
      Logger.log(`Error al procesar JSON del correo "${emailSubject}": ${e.message}`);
    }
  }); 

  Logger.log(`--- ${CONSUMO_OPERATION_NAME} Finalizado ---`);
  return allAlerts;
}