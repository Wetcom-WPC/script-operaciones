/**
 * @fileoverview Lógica específica para procesar reportes de "VMs con preguntas".
 * Lee reportes en formato JSON y utiliza el sistema de notificación de resumen
 * y todas las funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE VMS CON PREGUNTAS ---
const Q_VM_OPERATION_NAME = "VMs con preguntas";
const Q_VM_EMAIL_SUBJECT = "VMs con preguntas";
const Q_VM_FILENAME_MATCH = ".json"; // Buscará un archivo adjunto que sea JSON
const Q_VM_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs con Preguntas"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const Q_VM_ROW_LIMIT_FOR_TABLE = 10;
const Q_VM_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs con preguntas pendientes";
const Q_VM_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs con preguntas pendientes";


// --- LÓGICA PRINCIPAL DE VMS CON PREGUNTAS ---

function processVmsWithQuestionsEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(Q_VM_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleVmWithQuestionMessage(message, summaryReport);
          // Solo marcamos como leído si el estado es SUCCESS.
          if (processingStatus === 'SUCCESS') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
    // Al final de todas las operaciones, se envía un único resumen a Slack
    enviarResumenSlack(Q_VM_OPERATION_NAME, summaryReport);
  }
}

function processSingleVmWithQuestionMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const emailSubject = message.getSubject();

  const clientConfig = getClientConfig(senderEmail, Q_VM_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  // Pre-filtro por asunto del correo
  if (emailSubject.toLowerCase().includes("success")) {
    summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} recibido con (SUCCESS).` });
    const closeResult = buscarYCerrarTareaProgramada(Q_VM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  const attachment = message.getAttachments().find(att => att.getName().toLowerCase().endsWith(Q_VM_FILENAME_MATCH));
  if (!attachment) return 'SUCCESS';

  const jsonString = attachment.getDataAsString("UTF-8");
  let reportData;
  try {
    const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
    // Asumimos que la lista de alertas está en la propiedad "Report" o es el objeto raíz. Si es diferente, ajústalo aquí.
    reportData = parsedJson.Report || parsedJson; 
  } catch (e) {
    summaryReport.errores.push({ error: "El archivo JSON es inválido.", detalle: `Asunto: ${emailSubject}`});
    return 'FAILURE';
  }
  
  if (!reportData || !Array.isArray(reportData) || reportData.length === 0) {
    const closeResult = buscarYCerrarTareaProgramada(Q_VM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }
  
  const headers = Object.keys(reportData[0]);
  const reportRows = reportData.map(obj => headers.map(header => obj[header]));

  // Una fila es una alerta si no está vacía y no está en las excepciones.
  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    return !isRowEmpty && !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const summary1 = Q_VM_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = Q_VM_JIRA_TICKET_SUMMARY_ATTACHMENT;
  const existingTicketKey = findExistingJiraTicket(summary1, clientConfig.jiraProjectKey) || findExistingJiraTicket(summary2, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de VMs con preguntas no contiene alertas válidas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(Q_VM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= Q_VM_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas VMs con preguntas pendientes:\n\n`;
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
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs con preguntas.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, Q_VM_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(Q_VM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  } else {
    const creationResult = analyzeVmsWithQuestions_JSON(attachment.getName(), headers, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(Q_VM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeVmsWithQuestions_JSON(attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  if (alertCount <= Q_VM_ROW_LIMIT_FOR_TABLE) {
    summary = Q_VM_JIRA_TICKET_SUMMARY_TABLE;
    description = `Se detectaron ${alertCount} VMs con preguntas pendientes:\n\n|| ${headers.join(" || ")} ||\n`;
    finalAlerts.forEach(rowData => {
      description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
    });
  } else {
    summary = Q_VM_JIRA_TICKET_SUMMARY_ATTACHMENT;
    description = `Se encontraron ${alertCount} VMs con preguntas pendientes. Se adjunta el reporte filtrado.`;
    const newFileName = attachmentName.replace(/\.json$/i, "-FILTRADO.xlsx");
    xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  }
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, Q_VM_OPERATION_NAME);
}
