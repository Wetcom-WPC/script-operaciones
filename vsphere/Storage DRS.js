/**
 * @fileoverview Lógica específica para procesar reportes de "Storage DRS".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE STORAGE DRS ---
const SDRS_OPERATION_NAME = "Storage DRS";
const SDRS_EMAIL_SUBJECT = "Storage DRS";
const SDRS_CSV_FILENAME_MATCH = "Storage DRS";
const SDRS_SCHEDULED_TASK_NAME_TO_CLOSE = "Storage DRS"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const SDRS_ROW_LIMIT_FOR_TABLE = 10;
const SDRS_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Clusters con Storage DRS no automatizado";
const SDRS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron Clusters con Storage DRS no automatizado";


// --- LÓGICA PRINCIPAL DE STORAGE DRS ---

function processStorageDRSEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(SDRS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleSDRSMessage(message, summaryReport);
          // --- CORRECCIÓN ---
          if (processingStatus === 'SUCCESS') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  enviarResumenSlack(SDRS_OPERATION_NAME, summaryReport);
}

// REEMPLAZA ESTA FUNCIÓN
function processSingleSDRSMessage(message, summaryReport) {
  Logger.log(`--- Iniciando procesamiento para [Storage DRS] del correo: "${message.getSubject()}" ---`);
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(SDRS_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) {
    Logger.log("No se encontró un adjunto CSV válido para procesar.");
    return 'SUCCESS';
  }

  const clientConfig = getClientConfig(senderEmail, SDRS_OPERATION_NAME);
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
    Logger.log(`❌ ${errorMsg}`);
    return 'FAILURE';
  }

  // ... (el resto de la función sigue exactamente igual)
  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    if (isRowEmpty) return false;
    const sDRSConfigValue = (row[sDRSConfigColIndex] || "").trim().toLowerCase();
    const drsEnabledValue = (row[drsEnabledColIndex] || "").trim().toLowerCase();
    const goodConfigValues = ["automated", "fullyautomated"];
    const isAlert = !goodConfigValues.includes(sDRSConfigValue) || drsEnabledValue === "false";
    return isAlert && !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const summary1 = SDRS_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = SDRS_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de Storage DRS no muestra alertas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(SDRS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    Logger.log(`--- Finalizado el procesamiento para [Storage DRS]. No se encontraron alertas. ---`);
    return 'SUCCESS';
  }

  if (existingTicketKey) {
    // ... (lógica para actualizar ticket existente)
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= SDRS_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas alertas:\n\n`;
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
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** clusters afectados.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, SDRS_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(SDRS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      Logger.log(`--- Finalizado el procesamiento para [Storage DRS]. Ticket existente actualizado. ---`);
      return 'SUCCESS';
    } else {
      Logger.log(`--- Finalizado el procesamiento para [Storage DRS] con error al adjuntar archivo. ---`);
      return attachmentStatus.status;
    }
  } else {
    // ... (lógica para crear ticket nuevo)
    const creationResult = analyzeSDRS_CSV(message.getSubject(), attachment.getName(), originalHeaders, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(SDRS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    Logger.log(`--- Finalizado el procesamiento para [Storage DRS]. Se creó un nuevo ticket. ---`);
    return creationResult.status;
  }
}

function analyzeSDRS_CSV(emailSubject, attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
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
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, SDRS_OPERATION_NAME);
}