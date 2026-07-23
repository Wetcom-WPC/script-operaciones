/**
 * @fileoverview Lógica específica para procesar reportes de "Cluster DRS".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 * Refactorizado utilizando la clase base MailProcessor.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE CLUSTER DRS ---
const DRS_OPERATION_NAME = "Cluster DRS";
const DRS_EMAIL_SUBJECT = "Cluster DRS";
const DRS_CSV_FILENAME_MATCH = "Cluster DRS";
const DRS_SCHEDULED_TASK_NAME_TO_CLOSE = "Cluster DRS";
const DRS_FILTER_COLUMN = "DRS Configuration";
const DRS_VALUE_TO_EXCLUDE = "fullyAutomated";
const DRS_ROW_LIMIT_FOR_TABLE = 10;
const DRS_JIRA_TICKET_SUMMARY_TABLE = "Se encontraron Clusters con DRS no automatizado";
const DRS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se encontraron Clusters con DRS no automatizado";

class ClusterDRSProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: DRS_OPERATION_NAME,
      emailSubject: DRS_EMAIL_SUBJECT,
      attachmentMatch: DRS_CSV_FILENAME_MATCH,
      scheduledTaskName: DRS_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);
    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
    
    const columnaNormalizadaBuscada = normalizarEncabezado(DRS_FILTER_COLUMN);
    const drsConfigColIndex = headers.indexOf(columnaNormalizadaBuscada);
    
    if (drsConfigColIndex === -1) {
      summaryReport.errores.push({ error: `Columna "${DRS_FILTER_COLUMN}" no encontrada.` });
      Logger.log(`Error: No se encontró la columna normalizada "${columnaNormalizadaBuscada}" en los encabezados: ${JSON.stringify(headers)}`);
      return null;
    }

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      const drsConfigValue = (row[drsConfigColIndex] || "").trim();
      
      return drsConfigValue && drsConfigValue.toLowerCase() !== DRS_VALUE_TO_EXCLUDE.toLowerCase() && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(DRS_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(DRS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;

    if (existingTicketKey) {
      let commentText = `🚨 **El problema persiste.** `;
      let attachmentStatus = { status: 'SUCCESS' };

      if (alertCount <= DRS_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se han detectado ${alertCount} nuevas alertas:\n\n`;
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
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** clusters afectados.`;
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
          
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
        } else {
          summaryReport.advertencias.push(attachmentStatus.detail);
        }
      }
      
      if (attachmentStatus.status === 'SUCCESS') {
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      }
      return { status: attachmentStatus.status };

    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= DRS_ROW_LIMIT_FOR_TABLE) {
        summary = DRS_JIRA_TICKET_SUMMARY_TABLE;
        description = `Se detectaron ${alertCount} clusters con una configuración de DRS no automatizada:\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = DRS_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Se encontraron ${alertCount} clusters con una configuración de DRS no automatizada. Se adjunta el reporte completo para su revisión.`;
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

function processClusterDRSEmails() {
  new ClusterDRSProcessor().processEmails();
}
