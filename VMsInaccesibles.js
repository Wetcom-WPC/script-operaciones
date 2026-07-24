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


// --- LÓGICA PRINCIPAL (ESTANDARIZADA) ---

function processInaccessibleVMsEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(INACCESSIBLE_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleInaccessibleVMMessage(message, summaryReport);
          // Se marca como leído a menos que sea un error de servidor que requiera reintento.
          if (processingStatus !== 'HTTP_500') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  enviarResumenSlack(INACCESSIBLE_OPERATION_NAME, summaryReport);
}


// --- FUNCIÓN DE PROCESAMIENTO (ROBUSTA Y CON LOGS) ---

function processSingleInaccessibleVMMessage(message, summaryReport) {
  Logger.log(`--- Iniciando procesamiento para [VMs inaccesibles] del correo: "${message.getSubject()}" ---`);
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(INACCESSIBLE_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) {
    Logger.log("No se encontró un adjunto CSV válido para procesar.");
    return 'SUCCESS';
  }

  const clientConfig = getClientConfig(senderEmail, INACCESSIBLE_OPERATION_NAME);
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
    // Se pasan los headers normalizados para un chequeo de excepción robusto.
    return !isRowEmpty && !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const summary1 = INACCESSIBLE_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = INACCESSIBLE_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de VMs inaccesibles no contiene alertas válidas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(INACCESSIBLE_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    Logger.log(`--- Finalizado el procesamiento para [VMs inaccesibles]. No se encontraron alertas. ---`);
    return 'SUCCESS';
  }

  const alertCount = finalAlerts.length;
  if (existingTicketKey) {
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= INACCESSIBLE_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas alertas de VMs inaccesibles:\n\n`;
      commentText += `|| ${originalHeaders.join(" || ")} ||\n`;
      finalAlerts.forEach(rowData => {
        commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
      const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName);
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs inaccesibles.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, INACCESSIBLE_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(INACCESSIBLE_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      Logger.log(`--- Finalizado el procesamiento para [VMs inaccesibles]. Ticket existente actualizado. ---`);
      return 'SUCCESS';
    } else {
      Logger.log(`--- Finalizado el procesamiento para [VMs inaccesibles] con error al adjuntar archivo. ---`);
      return attachmentStatus.status;
    }

  } else {
    const creationResult = analyzeInaccessibleVMs_CSV(message.getSubject(), attachment.getName(), originalHeaders, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(INACCESSIBLE_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    Logger.log(`--- Finalizado el procesamiento para [VMs inaccesibles]. Se intentó crear un ticket. ---`);
    return creationResult.status;
  }
}


// --- FUNCIONES AUXILIARES (CORREGIDAS) ---

function analyzeInaccessibleVMs_CSV(emailSubject, attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  if (alertCount <= INACCESSIBLE_ROW_LIMIT_FOR_TABLE) {
    summary = INACCESSIBLE_JIRA_TICKET_SUMMARY_TABLE;
    description = `Se detectaron ${alertCount} VMs inaccesibles en "${emailSubject}":\n\n|| ${headers.join(" || ")} ||\n`;
    finalAlerts.forEach(rowData => {
      description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
    });
  } else {
    summary = INACCESSIBLE_JIRA_TICKET_SUMMARY_ATTACHMENT;
    description = `Se encontraron ${alertCount} VMs inaccesibles. Se adjunta el reporte filtrado.`;
    const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
    xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  }
  // CORRECCIÓN: Se elimina el parámetro extra e innecesario 'operationName'.
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig,INACCESSIBLE_OPERATION_NAME);
}