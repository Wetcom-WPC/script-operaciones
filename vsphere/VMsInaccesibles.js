/**
 * @fileoverview Lógica específica para procesar reportes de "VMs inaccesibles".
 * Utiliza el sistema de notificación de resumen consolidado y el patrón de código robusto.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE VMS INACCESIBLES ---
const INACCESSIBLE_OPERATION_NAME = "VMs inaccesibles";
const INACCESSIBLE_EMAIL_SUBJECT = "VMs inaccesibles";
const INACCESSIBLE_CSV_FILENAME_MATCH = "VMs inaccesibles";
const INACCESSIBLE_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs inaccesibles";
const INACCESSIBLE_ROW_LIMIT_FOR_TABLE = 10;
const INACCESSIBLE_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs Inaccesibles";
const INACCESSIBLE_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs Inaccesibles";

class VMsInaccesiblesProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: INACCESSIBLE_OPERATION_NAME,
      emailSubject: INACCESSIBLE_EMAIL_SUBJECT,
      attachmentMatch: INACCESSIBLE_CSV_FILENAME_MATCH,
      scheduledTaskName: INACCESSIBLE_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);
    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      return !isRowEmpty && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(INACCESSIBLE_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(INACCESSIBLE_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let attachmentStatus = { status: 'SUCCESS' };

    if (existingTicketKey) {
      let commentText = `🚨 **El problema persiste.** `;

      if (alertCount <= INACCESSIBLE_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se han detectado ${alertCount} nuevas alertas de VMs inaccesibles:\n\n`;
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
      } else {
        const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
        const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
        attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

        if (attachmentStatus.status === 'SUCCESS') {
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs inaccesibles.`;
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
          if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
        } else {
          summaryReport.advertencias.push(attachmentStatus.detail || { error: "Fallo al adjuntar." });
        }
      }
      
      if (attachmentStatus.status === 'SUCCESS') {
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      }
      return { status: attachmentStatus.status };

    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= INACCESSIBLE_ROW_LIMIT_FOR_TABLE) {
        summary = INACCESSIBLE_JIRA_TICKET_SUMMARY_TABLE;
        description = `Se detectaron ${alertCount} VMs inaccesibles en "${this.emailSubject}":\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = INACCESSIBLE_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Se encontraron ${alertCount} VMs inaccesibles. Se adjunta el reporte filtrado.`;
        const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
        xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
      }
      const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, this.operationName);
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else if (creationResult.status === 'ERROR') {
        summaryReport.errores.push(creationResult.detail);
      } else {
        summaryReport.advertencias.push(creationResult.detail);
      }
      
      if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      }
      return { status: creationResult.status };
    }
  }
}

function processInaccessibleVMsEmails() {
  new VMsInaccesiblesProcessor().processEmails();
}
