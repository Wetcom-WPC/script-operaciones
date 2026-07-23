/**
 * @fileoverview Lógica específica para procesar reportes de "Capacidad de particiones".
 * SOPORTE MULTI-ADJUNTO: Procesa múltiples reportes (vSphere, VCF, etc.) en un solo ticket.
 * Refactorizado utilizando la clase base MailProcessor.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE Capacidad de particiones ---
const Partition_OPERATION_NAME = "Capacidad de particiones";
const Partition_EMAIL_SUBJECT = "Capacidad de particiones";
const Partition_CSV_FILENAME_MATCH = "Capacidad de particiones";
const Partition_SCHEDULED_TASK_NAME_TO_CLOSE = "Capacidad de particiones";
const Partition_PARTITION_USAGE_COLUMN = "Porcentaje de uso (%)";
const Partition_THRESHOLD_PERCENT = 85;
const Partition_ROW_LIMIT_FOR_TABLE = 10;
const Partition_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron particiones con poco espacio disponible";
const Partition_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron particiones con poco espacio disponible";

class PartitionProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: Partition_OPERATION_NAME,
      emailSubject: Partition_EMAIL_SUBJECT,
      attachmentMatch: Partition_CSV_FILENAME_MATCH,
      scheduledTaskName: Partition_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  // Sobrescribimos processSingleMessage para manejar múltiples adjuntos por mensaje
  processSingleMessage(message, summaryReport) {
    const senderEmail = message.getFrom();
    
    const attachments = message.getAttachments().filter(att =>
      att.getName().includes(this.attachmentMatch) && att.getContentType().includes("text/csv")
    );

    if (attachments.length === 0) return { status: 'NO_OP' };

    let clientConfig = getClientConfig(senderEmail, this.operationName);
    clientConfig = this.resolveClientConfig(clientConfig, senderEmail, attachments[0], message, summaryReport);
    
    if (!clientConfig) {
      summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
      return { status: 'ERROR' };
    }

    let finalStatus = 'SUCCESS';

    attachments.forEach((attachment) => {
      const parsedData = this.parseAttachment(attachment, summaryReport);
      if (!parsedData || this.isDataEmpty(parsedData)) return; // skip this attachment
      
      const processed = this.processData(parsedData, clientConfig, summaryReport, attachment.getName());
      if (!processed) {
        finalStatus = 'FAILURE';
        return;
      }
      
      const { headers, finalAlerts, rowsForExport, reasonsText } = processed;
      const existingTicketKey = this.findExistingTicket(clientConfig);

      if (finalAlerts.length === 0) {
        if (existingTicketKey) {
          addCommentToJiraTicket(existingTicketKey, `✅ **El reporte "${attachment.getName()}" no presenta anomalías.**`);
        } else {
          summaryReport.exitos.push({ mensaje: `Reporte ${attachment.getName()} de ${clientConfig.clientName} procesado sin anomalías.` });
        }
      } else {
        const result = this.handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachment.getName());
        if (result.status !== 'SUCCESS') finalStatus = result.status;
      }
    });

    if (finalStatus !== 'FAILURE' && finalStatus !== 'HTTP_500') {
      if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    }

    return { status: finalStatus };
  }

  processData(parsedData, clientConfig, summaryReport, fileName) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);
    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
    
    const columnaNormalizadaBuscada = normalizarEncabezado(Partition_PARTITION_USAGE_COLUMN);
    const partitionUsageColIndex = headers.indexOf(columnaNormalizadaBuscada);
    
    if (partitionUsageColIndex === -1) {
      summaryReport.errores.push({ error: `Columna "${Partition_PARTITION_USAGE_COLUMN}" no encontrada en ${fileName}.` });
      return null;
    }

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      const usageNum = parseFloat((row[partitionUsageColIndex] || "").trim());
      const superaUmbral = !isNaN(usageNum) && usageNum >= Partition_THRESHOLD_PERCENT;
      return superaUmbral && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(Partition_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(Partition_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;

    if (existingTicketKey) {
      let commentText = `🚨 **Nuevas alertas detectadas en reporte: ${attachmentName}**\n`;
      let attStatus = { status: 'SUCCESS' };
      
      if (alertCount <= Partition_ROW_LIMIT_FOR_TABLE) {
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
      } else {
        const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
        const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
        attStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
        
        if (attStatus.status === 'SUCCESS') {
          commentText += `Se adjunta el reporte filtrado con **${alertCount}** particiones afectadas.`;
          addCommentToJiraTicket(existingTicketKey, commentText);
        }
      }
      summaryReport.exitos.push({ mensaje: `Se actualizó ticket ${existingTicketKey} con alertas de ${attachmentName}.` });
      return { status: attStatus.status };
    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= Partition_ROW_LIMIT_FOR_TABLE) {
        summary = Partition_JIRA_TICKET_SUMMARY_TABLE;
        description = `Informamos que se detectaron ${alertCount} particiones críticas en el reporte **${attachmentName}**.\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = Partition_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Se detectaron ${alertCount} particiones críticas en el reporte **${attachmentName}**. Se adjunta el archivo filtrado.\n\n`;
        const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
        xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
      }
      
      const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, this.operationName);
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else {
        summaryReport.errores.push(creationResult.detail);
      }
      return { status: creationResult.status };
    }
  }
}

function processPartitionEmails() {
  new PartitionProcessor().processEmails();
}