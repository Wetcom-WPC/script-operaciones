/**
 * @fileoverview Lógica específica para procesar reportes de "Undersized VMs".
 * Adaptado para usar el sistema de resumen de notificaciones y el patrón de código robusto.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE UNDERSIZED VMS ---
const UNDERSIZED_VMS_OPERATION_NAME = "Undersized VMs";
const UNDERSIZED_VMS_EMAIL_SUBJECT = "Undersized VMs";
const UNDERSIZED_VMS_CSV_FILENAME_MATCH = "Undersized VMs";
const UNDERSIZED_VMS_SCHEDULED_TASK_NAME_TO_CLOSE = "Undersized VMs";
const UNDERSIZED_VMS_JIRA_TICKET_SUMMARY = "Se detectaron Undersized VMs";


// --- LÓGICA PRINCIPAL (SIMPLIFICADA) ---

function processUndersizedVMsEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(UNDERSIZED_VMS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);

  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleUndersizedVMsMessage(message, summaryReport);
          
          if (processingStatus !== 'HTTP_500') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: `Error Crítico en Script: ${e.message}`, detalle: `Stack: ${e.stack}` });
        }
      }
    });
  }
  
  enviarResumenSlack(UNDERSIZED_VMS_OPERATION_NAME, summaryReport);
}


// --- FUNCIÓN DE PROCESAMIENTO (ROBUSTA Y CON LOGS) ---

function processSingleUndersizedVMsMessage(message, summaryReport) {
  Logger.log(`--- Iniciando procesamiento para [Undersized VMs] del correo: "${message.getSubject()}" ---`);
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(UNDERSIZED_VMS_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) {
    Logger.log("No se encontró un adjunto CSV válido para procesar.");
    return 'SUCCESS';
  }

  const clientConfig = getClientConfig(senderEmail, UNDERSIZED_VMS_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
  const originalHeaders = allRows[0];
  const reportRows = allRows.slice(1);

  Logger.log(`Encabezados Originales: ${JSON.stringify(originalHeaders)}`);
  const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
  Logger.log(`Encabezados Normalizados: ${JSON.stringify(headers)}`);

  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    if (isRowEmpty) return false;
    // La lógica de alerta es simplemente cualquier fila que no esté exceptuada.
    return !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const existingTicketKey = findExistingJiraTicket(UNDERSIZED_VMS_JIRA_TICKET_SUMMARY, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de VMs subdimensionadas no muestra alertas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(UNDERSIZED_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);    if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    Logger.log(`--- Finalizado el procesamiento para [Undersized VMs]. No se encontraron alertas. ---`);
    return 'SUCCESS';
  }

  const alertCount = finalAlerts.length;
  if (existingTicketKey) {
    const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
    const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName);
    const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
    
    if (attachmentResult.status === 'SUCCESS') {
      const commentText = `🚨 **El problema persiste.** Se adjunta el reporte actualizado con **${alertCount}** VMs afectadas.`;
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
      const closeResult = buscarYCerrarTareaProgramada(UNDERSIZED_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      Logger.log(`--- Finalizado el procesamiento para [Undersized VMs]. Ticket existente actualizado. ---`);
      const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, UNDERSIZED_VMS_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      return 'SUCCESS';
    } else {
      summaryReport.advertencias.push(attachmentResult.detail);
      Logger.log(`--- Finalizado el procesamiento para [Undersized VMs] con error al adjuntar archivo. ---`);
      return attachmentResult.status;
    }
  } else {
    const creationResult = analyzeUndersizedVMs_CSV(attachment.getName(), originalHeaders, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
      const closeResult = buscarYCerrarTareaProgramada(UNDERSIZED_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    Logger.log(`--- Finalizado el procesamiento para [Undersized VMs]. Se intentó crear un ticket. ---`);
    return creationResult.status;
  }
}


// --- FUNCIONES AUXILIARES ---

function analyzeUndersizedVMs_CSV(attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  const summary = UNDERSIZED_VMS_JIRA_TICKET_SUMMARY;
  const description = `Se encontraron ${alertCount} VMs subdimensionadas (Undersized). Se adjunta el reporte completo para su revisión.`;
  
  const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
  const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig,UNDERSIZED_VMS_OPERATION_NAME);
}