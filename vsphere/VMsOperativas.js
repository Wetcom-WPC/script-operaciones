/**
 * @fileoverview Lógica específica para procesar reportes de "VMs operativas".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE VMS OPERATIVAS ---
const VM_OPERATION_NAME = "VMs operativas";
const VM_EMAIL_SUBJECT = "VMs operativas";
const VM_CSV_FILENAME_MATCH = "VMs operativas";
const VM_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs operativas";
const VM_PARTITION_USAGE_COLUMN = "Partition Usage (%)";
const VM_THRESHOLD_PERCENT = 85;
const VM_ROW_LIMIT_FOR_TABLE = 10;
const VM_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs Operativas con poco espacio en particiones";
const VM_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs Operativas con poco espacio en particiones";


// --- LÓGICA PRINCIPAL DE VMS OPERATIVAS ---

function processVMsOperativasEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(VM_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleVMMessage(message, summaryReport);
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
  enviarResumenSlack(VM_OPERATION_NAME, summaryReport);
}

/**
 * FUNCIÓN MODIFICADA
 * Procesa un único correo de "VMs operativas", aplicando la lógica de normalización
 * de encabezados para evitar errores por espacios o mayúsculas/minúsculas.
 * @param {GoogleAppsScript.Gmail.GmailMessage} message - El objeto del mensaje de correo.
 * @param {Object} summaryReport - El objeto para recolectar los resultados de la ejecución.
 * @returns {string} - El estado del procesamiento ('SUCCESS', 'FAILURE', etc.).
 */
function processSingleVMMessage(message, summaryReport) {
  // LOG 1: Confirmamos que se entró a la función.
  Logger.log("--- Dentro de processSingleVMMessage ---");
  const senderEmail = message.getFrom();
  Logger.log(`Procesando mensaje de: ${senderEmail}, Asunto: "${message.getSubject()}"`);

  const attachments = message.getAttachments();
  
  // LOG 2: Mostramos TODOS los adjuntos que tiene el correo.
  if (attachments.length > 0) {
    Logger.log(`El correo tiene ${attachments.length} adjunto(s):`);
    attachments.forEach((att, index) => {
      Logger.log(`  Adjunto #${index + 1}: Nombre: "${att.getName()}", Tipo: "${att.getContentType()}"`);
    });
  } else {
    Logger.log("⚠️ ADVERTENCIA: El correo no tiene ningún archivo adjunto.");
    return 'SUCCESS'; // Salimos si no hay adjuntos
  }

  // LOG 3: Recordamos los criterios de búsqueda.
  Logger.log(`Buscando un adjunto que en el nombre contenga "${VM_CSV_FILENAME_MATCH}" Y en el tipo contenga "text/csv".`);

  const attachment = attachments.find(att =>
    att.getName().includes(VM_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) {
    // LOG 4: Este es el log clave si no encuentra el adjunto.
    Logger.log("❌ FALLO: No se encontró ningún adjunto que cumpla AMBOS criterios. La función terminará aquí para este correo.");
    return 'SUCCESS'; // Salimos de la función silenciosamente como antes.
  }
  
  // Si llegamos hasta aquí, es porque el adjunto fue encontrado con éxito.
  Logger.log(`✅ ÉXITO: Se encontró el adjunto "${attachment.getName()}" y cumple los criterios.`);

  const clientConfig = getClientConfig(senderEmail, VM_OPERATION_NAME);
  if (!clientConfig) {
    Logger.log(`❌ ERROR CRÍTICO: No se encontró configuración de cliente para el remitente ${senderEmail}.`);
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }
  Logger.log(`Configuración de cliente encontrada para: ${clientConfig.clientName}`);

  // --- A partir de aquí sigue la lógica de procesamiento de encabezados ---
  Logger.log("Iniciando lectura y procesamiento del archivo CSV...");
  const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
  
  const headers = allRows[0].map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
  Logger.log(`Encabezados del reporte (normalizados): ${JSON.stringify(headers)}`);
  
  const reportRows = allRows.slice(1);
  const columnaNormalizadaBuscada = normalizarEncabezado(VM_PARTITION_USAGE_COLUMN);
  const partitionUsageColIndex = headers.indexOf(columnaNormalizadaBuscada);
  
  if (partitionUsageColIndex === -1) {
    summaryReport.errores.push({ error: `Columna "${VM_PARTITION_USAGE_COLUMN}" no encontrada.` });
    Logger.log(`Error: No se encontró la columna normalizada "${columnaNormalizadaBuscada}" en los encabezados del reporte.`);
    return 'FAILURE';
  }

  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    if (isRowEmpty) return false;
    const usageNum = parseFloat((row[partitionUsageColIndex] || "").trim());
    const superaUmbral = !isNaN(usageNum) && usageNum >= VM_THRESHOLD_PERCENT;
    return superaUmbral && !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const summary1 = VM_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = VM_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte recibido no muestra alertas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(VM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= VM_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas alertas:\n\n`;
      commentText += `|| ${allRows[0].join(" || ")} ||\n`;
      finalAlerts.forEach(rowData => {
        commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
      const xlsxBlob = convertDataToXlsxBlob([allRows[0], ...finalAlerts], newFileName);
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs afectadas.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, VM_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(VM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  } else {
    const creationResult = analyzeVMsOperativas_CSV(message.getSubject(), attachment.getName(), allRows[0], finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(VM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeVMsOperativas_CSV(emailSubject, attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  if (alertCount <= VM_ROW_LIMIT_FOR_TABLE) {
    summary = VM_JIRA_TICKET_SUMMARY_TABLE;
    description = `Informamos que se detectaron ${alertCount} particiones de VMs Operativas con menos de 15% de espacio disponible. Se adjunta el reporte correspondiente, con las excepciones ya filtradas.\n\n|| ${headers.join(" || ")} ||\n`;
    finalAlerts.forEach(rowData => {
      description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
    });
  } else {
    summary = VM_JIRA_TICKET_SUMMARY_ATTACHMENT;
    description = `Informamos que se detectaron ${alertCount} particiones de VMs Operativas con menos de 15% de espacio disponible. Se adjunta el reporte correspondiente, con las excepciones ya filtradas.`;
    const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
    xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  }
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig,VM_OPERATION_NAME);
}

