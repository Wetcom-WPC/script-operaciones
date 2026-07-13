/**
 * @fileoverview Lógica específica para procesar reportes de "Espacio en datastores".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE ESPACIO EN DATASTORES ---
const DS_OPERATION_NAME = "Espacio en datastores";
const DS_EMAIL_SUBJECT = "Espacio en datastores";
const DS_CSV_FILENAME_MATCH = "Espacio en datastores";
const DS_SCHEDULED_TASK_NAME_TO_CLOSE = "Espacio en datastores"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const DS_FILTER_COLUMN = "Used Space (%)";
const DS_THRESHOLD = 85;
const DS_COLUMNS_TO_KEEP = ["Name", "Cluster", "Used Space (%)"];
const DS_ROW_LIMIT_FOR_TABLE = 10;
const DS_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron datastores con bajo espacio libre";
const DS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron datastores con bajo espacio libre";


// --- LÓGICA PRINCIPAL DE ESPACIO EN DATASTORES ---

function processDatastoreSpaceEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(DS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleDatastoreMessage(message, summaryReport);
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
  enviarResumenSlack(DS_OPERATION_NAME, summaryReport);
}

function processSingleDatastoreMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(DS_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) return 'SUCCESS';

  const clientConfig = getClientConfig(senderEmail, DS_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
  
  // ----- INICIO DE CAMBIOS -----

  // 1. GUARDAR ENCABEZADOS ORIGINALES Y CREAR VERSIÓN NORMALIZADA
  // Guardamos los encabezados originales para usarlos en el ticket de Jira.
  const originalHeaders = allRows[0]; 
  const reportRows = allRows.slice(1);
  
  // Usamos la función 'normalizarEncabezado' para limpiar los encabezados del CSV.
  // Esto asegura consistencia al buscar columnas.
  const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
  
  // 2. BÚSQUEDA ROBUSTA DE LA COLUMNA DE FILTRADO
  // Normalizamos también la columna que buscamos para asegurar la coincidencia.
  const columnaNormalizadaBuscada = normalizarEncabezado(DS_FILTER_COLUMN);
  const filterColIndex = headers.indexOf(columnaNormalizadaBuscada);
  
  // ----- FIN DE CAMBIOS -----

  if (filterColIndex === -1) {
    // Mensaje de error mejorado, igual que en la primera función.
    summaryReport.errores.push({ error: `Columna "${DS_FILTER_COLUMN}" no encontrada.` });
    Logger.log(`Error: No se encontró la columna normalizada "${columnaNormalizadaBuscada}" en los encabezados: ${JSON.stringify(headers)}`);
    return 'FAILURE';
  }

  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    if (isRowEmpty) return false;
    
    const usedSpaceValue = parseFloat(row[filterColIndex]);
    const isAlert = !isNaN(usedSpaceValue) && usedSpaceValue >= DS_THRESHOLD;
    
    // 3. PASAR ENCABEZADOS NORMALIZADOS A LAS EXCEPCIONES
    // La variable 'headers' ya contiene los encabezados normalizados.
    return isAlert && !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const summary1 = DS_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = DS_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de Espacio en Datastores no muestra alertas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(DS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  // --- LÓGICA DE CONDENSACIÓN DEL REPORTE (AHORA MÁS ROBUSTA) ---
  const condensedHeaders = DS_COLUMNS_TO_KEEP;
  
  // <--- CAMBIO CLAVE: Búsqueda normalizada para las columnas a mantener.
  const columnIndices = DS_COLUMNS_TO_KEEP.map(headerName => headers.indexOf(normalizarEncabezado(headerName)));
  
  if (columnIndices.some(index => index === -1)) {
    const notFound = DS_COLUMNS_TO_KEEP.filter((_, i) => columnIndices[i] === -1);
    summaryReport.errores.push({ 
      cliente: clientConfig.clientName, // <--- ESTANDARIZADO
      error: `Una o más columnas para condensar el reporte no se encontraron: ${notFound.join(', ')}`,
      detalle: `Revisar si el formato del reporte CSV cambió para este vCenter.`
    });
    return 'FAILURE';
  }
  
  const condensedAlerts = finalAlerts.map(row => columnIndices.map(index => row[index]));
  // --- FIN DE LA LÓGICA DE CONDENSACIÓN ---

  if (existingTicketKey) {
    const alertCount = condensedAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= DS_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} datastores con bajo espacio:\n\n`;
      commentText += `|| ${condensedHeaders.join(" || ")} ||\n`;
      condensedAlerts.forEach(rowData => {
        commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
      const xlsxBlob = convertDataToXlsxBlob([condensedHeaders, ...condensedAlerts], newFileName);
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** datastores afectados.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, DS_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(DS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  } else {
    const creationResult = analyzeDatastores_CSV(message.getSubject(), attachment.getName(), condensedHeaders, condensedAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(DS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeDatastores_CSV(emailSubject, attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
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
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, DS_OPERATION_NAME);
}
