/**
 * =================================================================
 * SCRIPT DE REPORTE DE CONSUMO (CPU/MEMORIA) - VERSIÓN OPTIMIZADA + DRP
 * =================================================================
 * Refactorizado utilizando la clase base MailProcessor.
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

class ConsumoCPUMemoriaProcessor extends MailProcessor {
  constructor(opsKey) {
    super({
      operationName: CONSUMO_OPERATION_NAME,
      emailSubject: CONSUMO_EMAIL_SUBJECTS,
      attachmentMatch: CONSUMO_FILENAME_MATCH,
      scheduledTaskName: null
    });
    this.opsKey = opsKey;
    this.allAlerts = [];
    this.clientNameFromIndex = "";
    this.finalClientName = "";
  }

  processEmails() {
    Logger.log(`--- Iniciando ${this.operationName} para Key: ${this.opsKey} ---`);
    if (!this.opsKey) {
      Logger.log("⚠️ No se proporcionó opsKey para buscar consumos.");
      return [];
    }

    let clientSenders = [];
    try {
      const masterSheet = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0];
      const data = masterSheet.getRange("A2:D").getValues();

      data.forEach(row => {
        const sender = row[0] ? String(row[0]).trim() : "";
        const clientName = row[1] ? String(row[1]).trim() : "";
        const keyOpsSheet = row[3] ? String(row[3]).trim() : ""; 

        if (keyOpsSheet.toUpperCase() === String(this.opsKey).trim().toUpperCase() && sender !== "") {
          clientSenders.push(sender);
          if (!this.clientNameFromIndex) this.clientNameFromIndex = clientName;
        }
      });
    } catch (e) {
       Logger.log(`Error crítico al leer el Índice Maestro: ${e.message}`);
       return []; 
    }
    
    if (clientSenders.length === 0) {
      Logger.log(`No se encontraron remitentes en el Índice Maestro para la Key: ${this.opsKey}.`);
      return [];
    }

    const fromQuery = `(from:${clientSenders.join(" OR from:")})`;
    const searchQuery = `${fromQuery} ${this.emailSubject} newer_than:12h`;
    
    const threads = GmailApp.search(searchQuery);
    Logger.log(`[Optimizado] Búsqueda encontró ${threads.length} hilos con la consulta: ${searchQuery}`);
    
    const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      this.processSingleMessage(message, summaryReport);
    }); 

    Logger.log(`--- ${this.operationName} Finalizado ---`);
    return this.allAlerts;
  }

  processSingleMessage(message, summaryReport) {
    const emailSubject = message.getSubject();
    this.finalClientName = this.clientNameFromIndex || this.opsKey;

    const subjectLower = emailSubject.toLowerCase();
    if (subjectLower.includes('drp')) {
      const drpMatch = emailSubject.match(/Alarmas de vSphere\s(.*?)\s\(/i);
      if (drpMatch && drpMatch[1]) {
        let drpClientName = drpMatch[1].trim();
        const mappedClientName = CONSUMO_DRP_CLIENT_NAME_MAP[drpClientName.toUpperCase()];
        this.finalClientName = mappedClientName ? mappedClientName : drpClientName;
        Logger.log(`Alerta DRP detectada. Renombrando cliente a: ${this.finalClientName}`);
      }
    }

    const attachment = this.findAttachment(message);
    if (!attachment) return { status: 'NO_OP' };

    const parsedData = this.parseAttachment(attachment, summaryReport);
    if (!parsedData || this.isDataEmpty(parsedData)) return { status: 'SUCCESS' };

    this.processData(parsedData, null, summaryReport);
    return { status: 'SUCCESS' };
  }

  parseAttachment(attachment, summaryReport) {
    try {
      const jsonString = attachment.getDataAsString("UTF-8");
      const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
      return parsedJson.Report || parsedJson.alerts || parsedJson;
    } catch (e) {
      Logger.log(`Error al procesar JSON: ${e.message}`);
      return null;
    }
  }

  isDataEmpty(parsedData) {
    return !parsedData || !Array.isArray(parsedData) || parsedData.length === 0;
  }

  processData(parsedData, clientConfig, summaryReport) {
    const relevantAlerts = parsedData.filter(row => 
      row[CONSUMO_GROUPING_COLUMN] && CONSUMO_ALERTS_TO_FIND.includes(row[CONSUMO_GROUPING_COLUMN])
    );

    if (relevantAlerts.length > 0) {
      Logger.log(`Se encontraron ${relevantAlerts.length} alertas de consumo para ${this.finalClientName}`);
      this.allAlerts.push({
        clientName: this.finalClientName,
        alerts: relevantAlerts
      });
    }
    return { finalAlerts: relevantAlerts };
  }

  findExistingTicket(clientConfig) { return null; }
  handleNoAlerts() { return { status: 'SUCCESS' }; }
  handleAlerts() { return { status: 'SUCCESS' }; }
}

function processConsumoCPUMemoriaEmails(opsKey) {
  return new ConsumoCPUMemoriaProcessor(opsKey).processEmails();
}