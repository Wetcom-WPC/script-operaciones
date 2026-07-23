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
      scheduledTaskName: OVER_VMS_SCHEDULED_TASK_NAME_TO_CLOSE
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

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
    const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);

    if (existingTicketKey) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attachmentResult.status === 'SUCCESS') {
        const commentText = `🚨 **El problema persiste.** Se adjunta el reporte actualizado con **${alertCount}** VMs afectadas.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
        if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
        
        summaryReport.exitos.push({ mensaje: `Anomalía Persiste. Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
      } else {
        summaryReport.errores.push(attachmentResult.detail || { error: "Fallo al adjuntar." });
      }
    } else {
      const description = `Se encontraron ${alertCount} VMs subdimensionadas (Oversized). Se adjunta el reporte completo para su revisión.`;
      const creationResult = createTicketAndNotify(OVER_VMS_JIRA_TICKET_SUMMARY, description, xlsxBlob, clientConfig, this.operationName);
      
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

function processOversizedVMsEmails() {
  new OversizedVMsProcessor().processEmails();
}
