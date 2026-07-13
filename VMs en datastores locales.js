/**
 * @fileoverview Lógica específica para procesar reportes de "VMs en datastores locales".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE VMs en datastores locales ---
const DATASTORESLOCALES_OPERATION_NAME = "VMs en datastores locales";
const DATASTORESLOCALES_EMAIL_SUBJECT = "VMs en datastores locales";
const DATASTORESLOCALES_CSV_FILENAME_MATCH = "VMs en datastores locales";
const DATASTORESLOCALES_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs en datastores locales"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const DATASTORESLOCALES_ROW_LIMIT_FOR_TABLE = 10;
const DATASTORESLOCALES_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs en datastores locales";
const DATASTORESLOCALES_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs en datastores locales";


// --- LÓGICA PRINCIPAL DE VMs en datastores locales ---

function processDATASTORESLOCALESVMsEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(DATASTORESLOCALES_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleDATASTORESLOCALESVMMessage(message, summaryReport);
          // --- CORRECCIÓN ---
          // Solo marcamos como leído si el estado es SUCCESS.
          // Si falla (ej. no encuentra al cliente), el estado será 'FAILURE' y el correo quedará no leído.
          if (processingStatus === 'SUCCESS') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  // Al final de todas las operaciones, se envía un único resumen a Slack
  enviarResumenSlack(DATASTORESLOCALES_OPERATION_NAME, summaryReport);
}

/**
 * REEMPLAZA ESTA FUNCIÓN COMPLETA en "VMs en datastores locales.gs"
 */
function processSingleDATASTORESLOCALESVMMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(DATASTORESLOCALES_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  if (!attachment) return 'SUCCESS';

  const clientConfig = getClientConfig(senderEmail, DATASTORESLOCALES_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
  // Guardamos los encabezados originales (sin normalizar) para usarlos al crear tablas en Jira.
  const originalHeaders = allRows[0].map(h => h.replace(/\uFEFF/g, '').trim().replace(/^"|"$/g, ''));
  const reportRows = allRows.slice(1);

  // --- INICIO DE LA CORRECCIÓN ---
  // Creamos una versión NORMALIZADA de los encabezados para la lógica de excepciones.
  // Usamos la misma función 'normalizarEncabezado' de FuncionesCompartidas.
  const normalizedHeaders = originalHeaders.map(h => normalizarEncabezado(h));
  // --- FIN DE LA CORRECCIÓN ---

  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    // Pasamos los encabezados NORMALIZADOS a la función de excepciones.
    return !isRowEmpty && !isRowExcepted(row, normalizedHeaders, clientConfig.exceptions);
  });
  
  const summary1 = DATASTORESLOCALES_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = DATASTORESLOCALES_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de VMs en datastores locales no contiene alertas válidas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    // ARREGLO DEL BUG DE COPIA Y PEGA:
    const closeResult = buscarYCerrarTareaProgramada(DATASTORESLOCALES_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= DATASTORESLOCALES_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas alertas de VMs en datastores locales:\n\n`;
      // Usamos los encabezados ORIGINALES para que se vean bien en Jira
      commentText += `|| ${originalHeaders.join(" || ")} ||\n`;
      finalAlerts.forEach(rowData => {
        commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
      // Usamos los encabezados ORIGINALES para el archivo Excel
      const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName);
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs en datastores locales.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, DATASTORESLOCALES_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(DATASTORESLOCALES_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  } else {
    // Usamos los encabezados ORIGINALES para crear el ticket
    const creationResult = analyzeDATASTORESLOCALESVMs_CSV(message.getSubject(), attachment.getName(), originalHeaders, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(DATASTORESLOCALES_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeDATASTORESLOCALESVMs_CSV(emailSubject, attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  if (alertCount <= DATASTORESLOCALES_ROW_LIMIT_FOR_TABLE) {
    summary = DATASTORESLOCALES_JIRA_TICKET_SUMMARY_TABLE;
    description = `Se detectaron ${alertCount} VMs en datastores locales en "${emailSubject}":\n\n|| ${headers.join(" || ")} ||\n`;
    finalAlerts.forEach(rowData => {
      description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
    });
  } else {
    summary = DATASTORESLOCALES_JIRA_TICKET_SUMMARY_ATTACHMENT;
    description = `Se encontraron ${alertCount} VMs en datastores locales. Se adjunta el reporte filtrado.`;
    const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
    xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  }
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, DATASTORESLOCALES_OPERATION_NAME);
}