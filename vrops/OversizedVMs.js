/**
 * @fileoverview Lógica específica para procesar reportes de "Oversized VMs".
 * Refactorizado utilizando la clase base MailProcessor.
 */

const OVER_VMS_OPERATION_NAME = "Oversized VMs";
const OVER_VMS_EMAIL_SUBJECT = "Oversized VMs";
const OVER_VMS_CSV_FILENAME_MATCH = "Oversized VMs";
const OVER_VMS_SCHEDULED_TASK_NAME_TO_CLOSE = "Oversized VMs";
const OVER_VMS_JIRA_TICKET_SUMMARY = "Se detectaron Oversized VMs";

class OversizedVMsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: OVER_VMS_OPERATION_NAME,
      emailSubject: OVER_VMS_EMAIL_SUBJECT,
      attachmentMatch: OVER_VMS_CSV_FILENAME_MATCH,
      scheduledTaskName: OVER_VMS_SCHEDULED_TASK_NAME_TO_CLOSE,
      ticketSummary: "Se detectaron Oversized VMs"
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
    return findExistingJiraTicket(OVER_VMS_JIRA_TICKET_SUMMARY, clientConfig.jiraProjectKey);
  }
}

function processOversizedVMsEmails() {
  new OversizedVMsProcessor().processEmails();
}
