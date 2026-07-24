/**
 * @fileoverview Lógica específica para procesar reportes de "Capacidad de particiones".
 * SOPORTE MULTI-ADJUNTO: Procesa múltiples reportes (vSphere, VCF, etc.) en un solo ticket.
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


// --- LÓGICA PRINCIPAL DE Capacidad de particiones ---

function processPartitionEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(Partition_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const messages = thread.getMessages();
      // Iteramos todos los mensajes del hilo para no perder reportes si llegan varios correos seguidos
      messages.forEach(message => {
        if (message.isUnread()) {
          try {
            const processingStatus = processSinglePartitionMessage(message, summaryReport);
            if (processingStatus !== 'HTTP_500') {
              message.markRead(); // Marcamos como leído el mensaje individual procesado
            }
          } catch (e) {
            summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
          }
        }
      });
    });
  }
  // Al final de todas las operaciones, se envía un único resumen a Slack
  enviarResumenSlack(Partition_OPERATION_NAME, summaryReport);
}

function processSinglePartitionMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  
  // CAMBIO: Filtramos todos los archivos CSV que coincidan, no solo el primero.
  const attachments = message.getAttachments().filter(att =>
    att.getName().includes(Partition_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (attachments.length === 0) return 'SUCCESS';

  const clientConfig = getClientConfig(senderEmail, Partition_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  let finalStatus = 'SUCCESS';

  // PROCESAMOS CADA ADJUNTO ENCONTRADO
  attachments.forEach((attachment) => {
    const fileName = attachment.getName();
    const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
    
    const originalHeaders = allRows[0];
    const reportRows = allRows.slice(1);
    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
    
    const columnaNormalizadaBuscada = normalizarEncabezado(Partition_PARTITION_USAGE_COLUMN);
    const partitionUsageColIndex = headers.indexOf(columnaNormalizadaBuscada);
    
    if (partitionUsageColIndex === -1) {
      summaryReport.errores.push({ error: `Columna "${Partition_PARTITION_USAGE_COLUMN}" no encontrada en ${fileName}.` });
      finalStatus = 'FAILURE';
      return; // Salta al siguiente adjunto
    }

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      const usageNum = parseFloat((row[partitionUsageColIndex] || "").trim());
      const superaUmbral = !isNaN(usageNum) && usageNum >= Partition_THRESHOLD_PERCENT;
      return superaUmbral && !isRowExcepted(row, headers, clientConfig.exceptions);
    });
    
    const summary1 = Partition_JIRA_TICKET_SUMMARY_TABLE;
    const summary2 = Partition_JIRA_TICKET_SUMMARY_ATTACHMENT;
    // Buscamos si ya existe un ticket (quizás creado por un adjunto anterior del mismo correo)
    const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

    if (finalAlerts.length === 0) {
      if (existingTicketKey) {
        addCommentToJiraTicket(existingTicketKey, `✅ **El reporte "${fileName}" no presenta anomalías.**`);
      } else {
        summaryReport.exitos.push({ mensaje: `Reporte ${fileName} de ${clientConfig.clientName} procesado sin anomalías.` });
      }
    } else {
      // SI HAY ALERTAS
      if (existingTicketKey) {
        const alertCount = finalAlerts.length;
        let commentText = `🚨 **Nuevas alertas detectadas en reporte: ${fileName}**\n`;
        
        if (alertCount <= Partition_ROW_LIMIT_FOR_TABLE) {
          commentText += `|| ${originalHeaders.join(" || ")} ||\n`;
          finalAlerts.forEach(rowData => {
            commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
          });
          addCommentToJiraTicket(existingTicketKey, commentText);
        } else {
          const newFileName = fileName.replace(/\.csv$/i, "-FILTRADO.xlsx");
          const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName);
          const attStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
          
          if (attStatus.status === 'SUCCESS') {
            commentText += `Se adjunta el reporte filtrado con **${alertCount}** particiones afectadas.`;
            addCommentToJiraTicket(existingTicketKey, commentText);
          }
        }
        summaryReport.exitos.push({ mensaje: `Se actualizó ticket ${existingTicketKey} con alertas de ${fileName}.` });
      } else {
        // No existe ticket previo, creamos uno nuevo con este primer reporte con alertas
        const creationResult = analyzePartitions_CSV(message.getSubject(), fileName, originalHeaders, finalAlerts, clientConfig);
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push(creationResult.detail);
        } else {
          summaryReport.errores.push(creationResult.detail);
          finalStatus = creationResult.status;
        }
      }
    }
  });

  // Una vez procesados todos los adjuntos, intentamos cerrar la tarea programada
  const closeResult = buscarYCerrarTareaProgramada(Partition_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
  if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;

  return finalStatus;
}

function analyzePartitions_CSV(emailSubject, attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
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
  
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, Partition_OPERATION_NAME);
}