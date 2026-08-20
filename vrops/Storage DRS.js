/**
 * @fileoverview Lógica específica para procesar reportes de "Storage DRS".
 * Refactorizado utilizando la clase base MailProcessor.
 */

const SDRS_OPERATION_NAME = "Storage DRS";
const SDRS_EMAIL_SUBJECT = "Storage DRS";
const SDRS_CSV_FILENAME_MATCH = "Storage DRS";
const SDRS_SCHEDULED_TASK_NAME_TO_CLOSE = "Storage DRS";
const SDRS_ROW_LIMIT_FOR_TABLE = 10;
const SDRS_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Clusters con Storage DRS no automatizado";
const SDRS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron Clusters con Storage DRS no automatizado";

class StorageDRSProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: SDRS_OPERATION_NAME,
      emailSubject: SDRS_EMAIL_SUBJECT,
      attachmentMatch: SDRS_CSV_FILENAME_MATCH,
      scheduledTaskName: SDRS_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);

    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));

    const sDRSColNorm = normalizarEncabezado("sDRS Configuration");
    const drsEnabledColNorm = normalizarEncabezado("DRS Enabled");
    const sDRSConfigColIndex = headers.indexOf(sDRSColNorm);
    const drsEnabledColIndex = headers.indexOf(drsEnabledColNorm);

    if (sDRSConfigColIndex === -1 || drsEnabledColIndex === -1) {
      const notFound = [];
      if (sDRSConfigColIndex === -1) notFound.push("sDRS Configuration");
      if (drsEnabledColIndex === -1) notFound.push("DRS Enabled");
      const errorMsg = `No se encontraron las siguientes columnas: "${notFound.join('", "')}".`;
      summaryReport.errores.push({ error: errorMsg });
      return null;
    }

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      const sDRSConfigValue = (row[sDRSConfigColIndex] || "").trim().toLowerCase();
      const drsEnabledValue = (row[drsEnabledColIndex] || "").trim().toLowerCase();
      const goodConfigValues = ["automated", "fullyautomated"];
      const isAlert = !goodConfigValues.includes(sDRSConfigValue) || drsEnabledValue === "false";
      return isAlert && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(SDRS_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(SDRS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;

    if (existingTicketKey) {
      if (alertCount <= SDRS_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se han detectado ${alertCount} nuevas alertas:\n\n`;
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
        
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
        return { status: 'SUCCESS' };
      } else {
        const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
        const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
        const attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

        if (attachmentStatus.status === 'SUCCESS') {
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** clusters afectados.`;
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
          if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
          return { status: 'SUCCESS' };
        } else {
          summaryReport.advertencias.push(attachmentStatus.detail);
          return { status: attachmentStatus.status };
        }
      }
    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= SDRS_ROW_LIMIT_FOR_TABLE) {
        summary = SDRS_JIRA_TICKET_SUMMARY_TABLE;
        description = `Se detectaron ${alertCount} clusters con una configuración de Storage DRS no adecuada:\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = SDRS_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Se encontraron ${alertCount} clusters con una configuración de Storage DRS no adecuada. Se adjunta el reporte completo para su revisión.`;
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

function processStorageDRSEmails() {
  new StorageDRSProcessor().processEmails();
}
