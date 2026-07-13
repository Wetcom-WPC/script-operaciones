/**
 * @fileoverview Lógica específica para procesar reportes de "Cluster DRS".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
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


// --- LÓGICA PRINCIPAL DE CLUSTER DRS ---

function processClusterDRSEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(DRS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleDRSMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  // Al final de todas las operaciones, se envía un único resumen a Slack
  enviarResumenSlack(DRS_OPERATION_NAME, summaryReport);
}

// REEMPLAZA ESTA FUNCIÓN COMPLETA EN TU SCRIPT DE "Cluster DRS"

function processSingleDRSMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(DRS_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) return 'SUCCESS';

  // --- SIN CAMBIOS AQUÍ ---
  // La llamada a getClientConfig ya se beneficia de las mejoras que hicimos.
  const clientConfig = getClientConfig(senderEmail, DRS_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
  const originalHeaders = allRows[0]; // Guardamos los originales por si los necesitamos para los tickets
  const reportRows = allRows.slice(1);

  // ----- INICIO DE CAMBIOS -----

  // 1. NORMALIZACIÓN DE ENCABEZADOS
  // Usamos la función 'normalizarEncabezado' para limpiar los encabezados del CSV.
  const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
  
  // 2. BÚSQUEDA ROBUSTA DE LA COLUMNA
  // Normalizamos también la columna que buscamos para asegurar la coincidencia.
  const columnaNormalizadaBuscada = normalizarEncabezado(DRS_FILTER_COLUMN);
  const drsConfigColIndex = headers.indexOf(columnaNormalizadaBuscada);
  
  // ----- FIN DE CAMBIOS -----

  if (drsConfigColIndex === -1) {
    summaryReport.errores.push({ error: `Columna "${DRS_FILTER_COLUMN}" no encontrada.` });
    Logger.log(`Error: No se encontró la columna normalizada "${columnaNormalizadaBuscada}" en los encabezados: ${JSON.stringify(headers)}`);
    return 'FAILURE';
  }

  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    if (isRowEmpty) return false;
    const drsConfigValue = (row[drsConfigColIndex] || "").trim();
    
    // 3. PASAR ENCABEZADOS NORMALIZADOS A LAS EXCEPCIONES
    // La variable 'headers' ya contiene los encabezados normalizados, por lo que la
    // llamada a isRowExcepted ahora funcionará correctamente.
    return drsConfigValue && drsConfigValue.toLowerCase() !== DRS_VALUE_TO_EXCLUDE.toLowerCase() && !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const summary1 = DRS_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = DRS_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de Cluster DRS no muestra alertas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(DRS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= DRS_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas alertas:\n\n`;
      // Usamos los encabezados originales para que se vean bien en el ticket
      commentText += `|| ${originalHeaders.join(" || ")} ||\n`;
      finalAlerts.forEach(rowData => {
        commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
      // Usamos los encabezados originales para el archivo adjunto
      const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName);
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** clusters afectados.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, DRS_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(DRS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  } else {
    // Pasamos los encabezados originales para la creación del ticket
    const creationResult = analyzeDRS_CSV(message.getSubject(), attachment.getName(), originalHeaders, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(DRS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeDRS_CSV(emailSubject, attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
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
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, DRS_OPERATION_NAME);
}
