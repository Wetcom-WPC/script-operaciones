/**
 * @fileoverview Lógica específica para procesar reportes de "VMs en datastores locales".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE VMs en datastores locales ---
const DATASTORESLOCALES_OPERATION_NAME = "VMs en datastores locales";
const DATASTORESLOCALES_EMAIL_SUBJECT = "VMs en datastores locales";
const DATASTORESLOCALES_CSV_FILENAME_MATCH = "VMs en datastores locales";
const DATASTORESLOCALES_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs en datastores locales"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const DATASTORESLOCALES_ROW_LIMIT_FOR_TABLE = 10;
const DATASTORESLOCALES_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs en datastores locales";
const DATASTORESLOCALES_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs en datastores locales";

class VMsDatastoresLocalesProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: DATASTORESLOCALES_OPERATION_NAME,
      emailSubject: DATASTORESLOCALES_EMAIL_SUBJECT,
      attachmentMatch: DATASTORESLOCALES_CSV_FILENAME_MATCH,
      scheduledTaskName: DATASTORESLOCALES_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0].map(h => h.replace(/\uFEFF/g, '').trim().replace(/^"|"$/g, ''));
    const reportRows = parsedData.slice(1);
    const normalizedHeaders = originalHeaders.map(h => normalizarEncabezado(h));

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      return !isRowEmpty && !isRowExcepted(row, normalizedHeaders, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(DATASTORESLOCALES_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(DATASTORESLOCALES_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let attachmentStatus = { status: 'SUCCESS' };

    if (existingTicketKey) {
      let commentText = `🚨 **El problema persiste.** `;

      if (alertCount <= DATASTORESLOCALES_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se han detectado ${alertCount} nuevas alertas de VMs en datastores locales:\n\n`;
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
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs en datastores locales.`;
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
      if (alertCount <= DATASTORESLOCALES_ROW_LIMIT_FOR_TABLE) {
        summary = DATASTORESLOCALES_JIRA_TICKET_SUMMARY_TABLE;
        description = `Se detectaron ${alertCount} VMs en datastores locales en "${this.emailSubject}":\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = DATASTORESLOCALES_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Se encontraron ${alertCount} VMs en datastores locales. Se adjunta el reporte filtrado.`;
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

function processDATASTORESLOCALESVMsEmails() {
  new VMsDatastoresLocalesProcessor().processEmails();
}
