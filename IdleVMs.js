/**
 * @fileoverview Lógica específica para procesar reportes de "Idle VMs".
 * Adaptado para usar el sistema de resumen de notificaciones y el patrón de código robusto.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE IDLE VMS ---
const IDLE_VMS_OPERATION_NAME = "Idle VMs";
const IDLE_VMS_EMAIL_SUBJECT = "Idle VMs";
const IDLE_VMS_CSV_FILENAME_MATCH = "Idle VMs";
const IDLE_VMS_SCHEDULED_TASK_NAME_TO_CLOSE = "Idle VMs";
const IDLE_VMS_JIRA_TICKET_SUMMARY = "Se detectaron Idle VMs";


// --- LÓGICA PRINCIPAL DE IDLE VMS (SIMPLIFICADA) ---

function processIdleVMsEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(IDLE_VMS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);

  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          // La función de procesamiento ahora modifica summaryReport directamente.
          const processingStatus = processSingleIdleVMsMessage(message, summaryReport);
          
          if (processingStatus !== 'HTTP_500') {
             thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: `Error Crítico en Script: ${e.message}`, detalle: `Stack: ${e.stack}` });
        }
      }
    });
  }
  
  enviarResumenSlack(IDLE_VMS_OPERATION_NAME, summaryReport);
}

// --- FUNCIÓN DE PROCESAMIENTO (ROBUSTA Y CON LOGS) ---

// REEMPLAZA ESTA FUNCIÓN COMPLETA EN TU SCRIPT

function processSingleIdleVMsMessage(message, summaryReport) {
  Logger.log(`--- Iniciando procesamiento para [Idle VMs] del correo: "${message.getSubject()}" ---`);
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(IDLE_VMS_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) {
    Logger.log("No se encontró un adjunto CSV válido para procesar.");
    return 'SUCCESS';
  }

  const clientConfig = getClientConfig(senderEmail, IDLE_VMS_OPERATION_NAME);
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
    return !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const existingTicketKey = findExistingJiraTicket(IDLE_VMS_JIRA_TICKET_SUMMARY, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de Idle VMs no muestra alertas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(IDLE_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
    if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    Logger.log(`--- Finalizado el procesamiento para [Idle VMs]. No se encontraron alertas. ---`);
    return 'SUCCESS';
  }

  const alertCount = finalAlerts.length;
  if (existingTicketKey) {
    
    // --- LÍNEA CORREGIDA ---
    // Se agrega la definición de 'newFileName' que faltaba.
    const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
    const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName);
    // --- FIN DE LA CORRECCIÓN ---

    const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
    
    if (attachmentResult.status === 'SUCCESS') {
      const commentText = `🚨 **El problema persiste.** Se adjunta el reporte actualizado con **${alertCount}** VMs afectadas.`;
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
      const closeResult = buscarYCerrarTareaProgramada(IDLE_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);      if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      Logger.log(`--- Finalizado el procesamiento para [Idle VMs]. Ticket existente actualizado. ---`);
      const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, IDLE_VMS_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      return 'SUCCESS';
      
    } else {
      summaryReport.advertencias.push(attachmentResult.detail);
      Logger.log(`--- Finalizado el procesamiento para [Idle VMs] con error al adjuntar archivo. ---`);
      return attachmentResult.status;
    }
  } else {
    const creationResult = analyzeIdleVMs_CSV(attachment.getName(), originalHeaders, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
      const closeResult = buscarYCerrarTareaProgramada(IDLE_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);      if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    Logger.log(`--- Finalizado el procesamiento para [Idle VMs]. Se intentó crear un ticket. ---`);
    return creationResult.status;
  }
}

// --- FUNCIONES AUXILIARES (CORREGIDAS) ---

function analyzeIdleVMs_CSV(attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  const summary = IDLE_VMS_JIRA_TICKET_SUMMARY;
  const description = `Se encontraron ${alertCount} Idle VMs. Se adjunta el reporte completo para su revisión.`;
  
  const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
  const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig,IDLE_VMS_OPERATION_NAME);
}
