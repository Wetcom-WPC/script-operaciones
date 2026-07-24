/**
 * @fileoverview Lógica específica para procesar reportes de "Componentes de View".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas, estableciendo la tecnología como "Horizon View".
 */

// --- CONFIGURACIÓN ESPECÍFICA DE COMPONENTES DE VIEW ---
const VIEW_OPERATION_NAME = "Componentes de View";
const VIEW_EMAIL_SUBJECT = "Componentes de View";
const VIEW_CSV_FILENAME_MATCH = "Componentes de View";
const VIEW_SCHEDULED_TASK_NAME_TO_CLOSE = "Componentes de View"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const VIEW_FILTER_COLUMN = "Porcentaje de uso (%)";
const VIEW_THRESHOLD_PERCENT = 85;
const VIEW_ROW_LIMIT_FOR_TABLE = 10;
const VIEW_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Componentes de View con poco espacio en particiones";
const VIEW_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron Componentes de View con poco espacio en particiones";

class ComponentesDeViewProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: VIEW_OPERATION_NAME,
      emailSubject: VIEW_EMAIL_SUBJECT,
      attachmentMatch: VIEW_CSV_FILENAME_MATCH,
      scheduledTaskName: VIEW_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (config) {
      config.tecnologia = "Horizon View";
    }
    return config;
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);
    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
    
    const columnaNormalizadaBuscada = normalizarEncabezado(VIEW_FILTER_COLUMN);
    const filterColIndex = headers.indexOf(columnaNormalizadaBuscada);
    
    if (filterColIndex === -1) {
      summaryReport.errores.push({ error: `Columna "${VIEW_FILTER_COLUMN}" no encontrada.` });
      Logger.log(`Error: No se encontró la columna normalizada "${columnaNormalizadaBuscada}" en los encabezados: ${JSON.stringify(headers)}`);
      return null;
    }

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      const usageNum = parseFloat((row[filterColIndex] || "").trim());
      const superaUmbral = !isNaN(usageNum) && usageNum >= VIEW_THRESHOLD_PERCENT;
      return superaUmbral && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(VIEW_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || findExistingJiraTicket(VIEW_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (existingTicketKey) {
      if (alertCount <= VIEW_ROW_LIMIT_FOR_TABLE) {
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
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** componentes afectados.`;
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
        return { status: 'SUCCESS' };
      } else {
        return { status: attachmentStatus.status };
      }

    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= VIEW_ROW_LIMIT_FOR_TABLE) {
        summary = VIEW_JIRA_TICKET_SUMMARY_TABLE;
        description = `Se detectaron ${alertCount} componentes de View con alto uso de disco:\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = VIEW_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Se encontraron ${alertCount} componentes de View con alto uso de disco. Se adjunta el reporte.`;
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

function processViewEmails() {
  new ComponentesDeViewProcessor().processEmails();
}
