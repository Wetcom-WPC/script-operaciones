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


// --- LÓGICA PRINCIPAL DE COMPONENTES DE VIEW ---

function processViewEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(VIEW_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleViewMessage(message, summaryReport);
          if (processingStatus === 'SUCCESS') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
    // Al final de todas las operaciones, se envía un único resumen a Slack
    enviarResumenSlack(VIEW_OPERATION_NAME, summaryReport);
  }
}

function processSingleViewMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(VIEW_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) return 'SUCCESS';

  const clientConfig = getClientConfig(senderEmail, VIEW_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  // --- CAMBIO CLAVE: SOBRESCRIBIR LA TECNOLOGÍA ---
  clientConfig.tecnologia = "Horizon View";
  // ---------------------------------------------

  const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
  
  // --- INICIO DE CAMBIOS ---

  // 1. Se separan los encabezados originales de los normalizados.
  const originalHeaders = allRows[0];
  const reportRows = allRows.slice(1);
  const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
  
  // 2. Búsqueda robusta de la columna de filtrado.
  const columnaNormalizadaBuscada = normalizarEncabezado(VIEW_FILTER_COLUMN);
  const filterColIndex = headers.indexOf(columnaNormalizadaBuscada);
  
  // --- FIN DE CAMBIOS ---

  if (filterColIndex === -1) {
    summaryReport.errores.push({ error: `Columna "${VIEW_FILTER_COLUMN}" no encontrada.` });
    // Log mejorado para depuración
    Logger.log(`Error: No se encontró la columna normalizada "${columnaNormalizadaBuscada}" en los encabezados: ${JSON.stringify(headers)}`);
    return 'FAILURE';
  }

  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    if (isRowEmpty) return false;
    const usageNum = parseFloat((row[filterColIndex] || "").trim());
    const superaUmbral = !isNaN(usageNum) && usageNum >= VIEW_THRESHOLD_PERCENT;
    // 3. Se pasan los encabezados normalizados a la función de excepciones.
    return superaUmbral && !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const summary1 = VIEW_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = VIEW_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de Componentes de View no muestra alertas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(VIEW_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= VIEW_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas alertas:\n\n`;
      // CAMBIO: Se usan los encabezados originales para la tabla de Jira.
      commentText += `|| ${originalHeaders.join(" || ")} ||\n`;
      finalAlerts.forEach(rowData => {
        commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
      // CAMBIO: Se usan los encabezados originales para el archivo Excel.
      const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName);
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** componentes afectados.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, VIEW_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(VIEW_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  } else {
    // CAMBIO: Se usan los encabezados originales para crear el ticket.
    const creationResult = analyzeViews_CSV(message.getSubject(), attachment.getName(), originalHeaders, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(VIEW_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeViews_CSV(emailSubject, attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
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
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, VIEW_OPERATION_NAME);
}
