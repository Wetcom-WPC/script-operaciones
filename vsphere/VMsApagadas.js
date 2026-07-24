/**
 * @fileoverview Lógica específica para procesar reportes de "Apagadas VMs".
 * Refactorizado utilizando la clase base MailProcessor.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE Apagadas VMS ---
const APAGADAS_VMS_OPERATION_NAME = "VMs apagadas por periodo de tiempo significativo";
const APAGADAS_VMS_EMAIL_SUBJECT = "VMs apagadas por periodo de tiempo significativo"; 
const APAGADAS_VMS_CSV_FILENAME_MATCH = "VMs apagadas por periodo de tiempo significativo";    
const APAGADAS_VMS_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs apagadas por periodo de tiempo significativo";
const APAGADAS_VMS_JIRA_TICKET_SUMMARY = "Se detectaron VMs apagadas por un periodo de tiempo significativo";

class VMsApagadasProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: APAGADAS_VMS_OPERATION_NAME,
      emailSubject: APAGADAS_VMS_EMAIL_SUBJECT,
      attachmentMatch: APAGADAS_VMS_CSV_FILENAME_MATCH,
      scheduledTaskName: APAGADAS_VMS_SCHEDULED_TASK_NAME_TO_CLOSE,
      ticketSummary: "Se detectaron VMs apagadas por un periodo de tiempo significativo"
    });
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);
    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      return !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(APAGADAS_VMS_JIRA_TICKET_SUMMARY, clientConfig.jiraProjectKey);
  }
}

function processApagadasVMsEmails() {
  new VMsApagadasProcessor().processEmails();
}
