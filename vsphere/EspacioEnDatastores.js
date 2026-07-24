/**
 * @fileoverview Lógica específica para procesar reportes de "Espacio en datastores".
 * Refactorizado utilizando la clase base MailProcessor.
 */

const DS_OPERATION_NAME = "Espacio en datastores";
const DS_EMAIL_SUBJECT = "Espacio en datastores";
const DS_CSV_FILENAME_MATCH = "Espacio en datastores";
const DS_SCHEDULED_TASK_NAME_TO_CLOSE = "Espacio en datastores";
const DS_FILTER_COLUMN = "Used Space (%)";
const DS_THRESHOLD = 85;
const DS_COLUMNS_TO_KEEP = ["Name", "Cluster", "Used Space (%)"];
const DS_ROW_LIMIT_FOR_TABLE = 10;
const DS_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron datastores con bajo espacio libre";
const DS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron datastores con bajo espacio libre";

class EspacioEnDatastoresProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: DS_OPERATION_NAME,
      emailSubject: DS_EMAIL_SUBJECT,
      attachmentMatch: DS_CSV_FILENAME_MATCH,
      scheduledTaskName: DS_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0]; 
    const reportRows = parsedData.slice(1);
    
    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
    
    const columnaNormalizadaBuscada = normalizarEncabezado(DS_FILTER_COLUMN);
    const filterColIndex = headers.indexOf(columnaNormalizadaBuscada);
    
    if (filterColIndex === -1) {
      summaryReport.errores.push({ error: `Columna "${DS_FILTER_COLUMN}" no encontrada.` });
      return null;
    }

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      
      const usedSpaceValue = parseFloat(row[filterColIndex]);
      const isAlert = !isNaN(usedSpaceValue) && usedSpaceValue >= DS_THRESHOLD;
      
      return isAlert && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    if (finalAlerts.length === 0) {
       return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
    }

    const condensedHeaders = DS_COLUMNS_TO_KEEP;
    const columnIndices = DS_COLUMNS_TO_KEEP.map(headerName => headers.indexOf(normalizarEncabezado(headerName)));
    
    if (columnIndices.some(index => index === -1)) {
      const notFound = DS_COLUMNS_TO_KEEP.filter((_, i) => columnIndices[i] === -1);
      summaryReport.errores.push({ 
        cliente: clientConfig.clientName,
        error: `Una o más columnas para condensar el reporte no se encontraron: ${notFound.join(', ')}`,
        detalle: `Revisar si el formato del reporte CSV cambió para este vCenter.`
      });
      return null;
    }
    
    const condensedAlerts = finalAlerts.map(row => columnIndices.map(index => row[index]));

    return { headers: condensedHeaders, finalAlerts: condensedAlerts, rowsForExport: condensedAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(DS_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(DS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    
    if (existingTicketKey) {
      if (alertCount <= DS_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se han detectado ${alertCount} datastores con bajo espacio:\n\n`;
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
        const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

        if (attachmentResult.status === 'SUCCESS') {
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** datastores afectados.`;
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
          if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
          return { status: 'SUCCESS' };
        } else {
          summaryReport.advertencias.push(attachmentResult.detail);
          return { status: attachmentResult.status };
        }
      }
    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= DS_ROW_LIMIT_FOR_TABLE) {
        summary = DS_JIRA_TICKET_SUMMARY_TABLE;
        description = `Se detectaron ${alertCount} datastores con un espacio utilizado >= ${DS_THRESHOLD}%:\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = DS_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Se encontraron ${alertCount} datastores con un espacio utilizado >= ${DS_THRESHOLD}%. Se adjunta el reporte condensado.`;
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

function processDatastoreSpaceEmails() {
  new EspacioEnDatastoresProcessor().processEmails();
}
