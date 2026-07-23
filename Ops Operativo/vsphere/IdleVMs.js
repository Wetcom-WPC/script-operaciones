/**
 * @fileoverview Lógica específica para procesar reportes de "Idle VMs".
 * Refactorizado utilizando la clase base MailProcessor.
 */

const IDLE_VMS_OPERATION_NAME = "Idle VMs";
const IDLE_VMS_EMAIL_SUBJECT = "Idle VMs";
const IDLE_VMS_CSV_FILENAME_MATCH = "Idle VMs";
const IDLE_VMS_SCHEDULED_TASK_NAME_TO_CLOSE = "Idle VMs";
const IDLE_VMS_JIRA_TICKET_SUMMARY = "Se detectaron Idle VMs";

class IdleVMsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: IDLE_VMS_OPERATION_NAME,
      emailSubject: IDLE_VMS_EMAIL_SUBJECT,
      attachmentMatch: IDLE_VMS_CSV_FILENAME_MATCH,
      scheduledTaskName: IDLE_VMS_SCHEDULED_TASK_NAME_TO_CLOSE,
      ticketSummary: "Se detectaron Idle VMs"
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
    return findExistingJiraTicket(IDLE_VMS_JIRA_TICKET_SUMMARY, clientConfig.jiraProjectKey);
  }
    } else {
      const description = `Se encontraron ${alertCount} Idle VMs. Se adjunta el reporte completo para su revisión.`;
      const creationResult = createTicketAndNotify(IDLE_VMS_JIRA_TICKET_SUMMARY, description, xlsxBlob, clientConfig, this.operationName);
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else {
        summaryReport.errores.push(creationResult.detail);
      }
    }
    
    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    return { status: 'SUCCESS' };
  }
}

function processIdleVMsEmails() {
  new IdleVMsProcessor().processEmails();
}
