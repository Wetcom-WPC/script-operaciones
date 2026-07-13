/**
 * @fileoverview Lógica específica para procesar reportes de "Discos montados en proxy".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE Discos montados en proxy ---
const DISCOSMONTADOS_OPERATION_NAME = "Discos montados en proxy";
const DISCOSMONTADOS_EMAIL_SUBJECT = "Discos montados en proxy";
const DISCOSMONTADOS_FILENAME_MATCH = ".json";
const DISCOSMONTADOS_SCHEDULED_TASK_NAME_TO_CLOSE = "Discos Montados en Proxy"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const DISCOSMONTADOS_ROW_LIMIT_FOR_TABLE = 10;
const DISCOSMONTADOS_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Discos montados en proxy";
const DISCOSMONTADOS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron Discos montados en proxy";


// --- LÓGICA PRINCIPAL DE Discos montados en proxy ---

function processDISCOSMONTADOSRulesEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(DISCOSMONTADOS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleDISCOSMONTADOSRuleMessage(message, summaryReport);
          // Solo marcamos como leído si el estado es SUCCESS.
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
  enviarResumenSlack(DISCOSMONTADOS_OPERATION_NAME, summaryReport);
}

function processSingleDISCOSMONTADOSRuleMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const emailSubject = message.getSubject();

  const clientConfig = getClientConfig(senderEmail, DISCOSMONTADOS_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE'; // Devolvemos FAILURE para que el correo NO se marque como leído
  }

  // --- FORZADO DE PARÁMETROS ---
  clientConfig.tecnologia = "Veeam Backup & Replication"; // Siempre Veeam
  
  // Pre-filtro por asunto del correo
  if (emailSubject.toLowerCase().includes("success")) {
    summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} recibido con (SUCCESS).` });
    const closeResult = buscarYCerrarTareaProgramada(DISCOSMONTADOS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  const attachment = message.getAttachments().find(att => att.getName().toLowerCase().endsWith(DISCOSMONTADOS_FILENAME_MATCH));
  if (!attachment) return 'SUCCESS';

  const jsonString = attachment.getDataAsString("UTF-8");
  let reportData;
  try {
    const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
    reportData = parsedJson.Report || parsedJson; 
  } catch (e) {
    summaryReport.errores.push({ error: "El archivo JSON es inválido.", detalle: `Asunto: ${emailSubject}`});
    return 'FAILURE';
  }
  
  if (!reportData || !Array.isArray(reportData) || reportData.length === 0) {
    const closeResult = buscarYCerrarTareaProgramada(DISCOSMONTADOS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }
  
  const headers = Object.keys(reportData[0]);
  const reportRows = reportData.map(obj => headers.map(header => obj[header]));

  // --- INICIO DE LA MODIFICACIÓN ---
  // 1. Encontrar el índice de la columna "status" para poder filtrarla (de forma insensible a mayúsculas).
  const statusColIndex = headers.findIndex(h => h.toLowerCase().trim() === 'status');

  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    if (isRowEmpty) {
      return false; // Descartar filas vacías
    }

    // 2. Si la columna "status" existe, obtener su valor y verificar si es "success".
    if (statusColIndex !== -1) {
      const statusValue = (row[statusColIndex] || "").trim().toLowerCase();
      if (statusValue === 'success') {
        return false; // Descartar esta fila porque su estado es "success"
      }
    }

    // 3. Aplicar el filtro de excepciones que ya tenías.
    return !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  // --- FIN DE LA MODIFICACIÓN ---

  const summary1 = DISCOSMONTADOS_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = DISCOSMONTADOS_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de Discos montados en proxy no contiene alertas válidas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(DISCOSMONTADOS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= DISCOSMONTADOS_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas alertas de Discos montados en proxy:\n\n`;
      commentText += `|| ${headers.join(" || ")} ||\n`;
      finalAlerts.forEach(rowData => {
        commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.json$/i, "-FILTRADO.xlsx");
      const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs sin Discos montados en proxy.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, DISCOSMONTADOS_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(DISCOSMONTADOS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  } else {
    const creationResult = analyzeDISCOSMONTADOSRules_JSON(attachment.getName(), headers, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(DISCOSMONTADOS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeDISCOSMONTADOSRules_JSON(attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  if (alertCount <= DISCOSMONTADOS_ROW_LIMIT_FOR_TABLE) {
    summary = DISCOSMONTADOS_JIRA_TICKET_SUMMARY_TABLE;
    description = `Se detectaron ${alertCount} VMs sin Discos montados en proxy configuradas:\n\n|| ${headers.join(" || ")} ||\n`;
    finalAlerts.forEach(rowData => {
      description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
    });
  } else {
    summary = DISCOSMONTADOS_JIRA_TICKET_SUMMARY_ATTACHMENT;
    description = `Se encontraron ${alertCount} VMs sin Discos montados en proxy configuradas. Se adjunta el reporte filtrado.`;
    const newFileName = attachmentName.replace(/\.json$/i, "-FILTRADO.xlsx");
    xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  }
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, DISCOSMONTADOS_OPERATION_NAME);
}
