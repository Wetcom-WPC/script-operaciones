/**
 * @fileoverview Lógica específica para procesar reportes de "Horizon Dashboard".
 */

// --- CONFIGURACIÓN ESPECÍFICA ---
const HZ_DASH_OPERATION_NAME = "Dashboard View";
const HZ_DASH_EMAIL_SUBJECT = "Horizon Dashboard View Problems"; // Asunto que envía vRO
const HZ_DASH_JSON_FILENAME_MATCH = ".json"; // Busca cualquier adjunto JSON
const HZ_DASH_SCHEDULED_TASK_NAME_TO_CLOSE = "Dashboard View"; // Nombre de la tarea en Jira
const HZ_DASH_ROW_LIMIT_FOR_TABLE = 15;
const HZ_DASH_JIRA_TICKET_SUMMARY_TABLE = "Alertas detectadas en el Dashboard de Horizon";
const HZ_DASH_JIRA_TICKET_SUMMARY_ATTACHMENT = "Alertas detectadas en el Dashboard de Horizon";


function processHorizonDashboardEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(HZ_DASH_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleHorizonDashboardMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  enviarResumenSlack(HZ_DASH_OPERATION_NAME, summaryReport);
}

function processSingleHorizonDashboardMessage(message, summaryReport) {
  Logger.log("--- Dentro de processSingleHorizonDashboardMessage ---");
  const senderEmail = message.getFrom();
  Logger.log(`Procesando mensaje de: ${senderEmail}, Asunto: "${message.getSubject()}"`);

  const attachments = message.getAttachments();
  const attachment = attachments.find(att => att.getName().toLowerCase().endsWith(HZ_DASH_JSON_FILENAME_MATCH));

  if (!attachment) {
    Logger.log("❌ FALLO: No se encontró adjunto JSON.");
    return 'SUCCESS'; 
  }
  
  Logger.log(`✅ ÉXITO: Se encontró el adjunto JSON "${attachment.getName()}".`);

  const clientConfig = getClientConfig(senderEmail, HZ_DASH_OPERATION_NAME);
  if (!clientConfig) {
    Logger.log(`❌ ERROR CRÍTICO: No se encontró configuración de cliente para ${senderEmail}.`);
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  // Parseo del JSON de vRO
  let jsonData;
  try {
    const jsonString = attachment.getDataAsString("UTF-8");
    Logger.log(`[DEBUG] String JSON obtenido. Longitud: ${jsonString.length} caracteres.`);
    jsonData = JSON.parse(jsonString);
  } catch (e) {
    Logger.log(`❌ ERROR CRÍTICO: No se pudo parsear el JSON. ${e.message}`);
    summaryReport.errores.push({ error: "Fallo al leer JSON.", detalle: e.message });
    return 'FAILURE';
  }

  // --- LOGICA DE EXCEPCIONES Y DEBBUGING ---
  // Mantenemos los nombres EXACTOS de las columnas que espera tu automatizador
  const headers = ["object", "alarm", "severity", "time", "vcenter"];
  const rawAlerts = jsonData.Report || [];
  
  Logger.log(`[DEBUG] JSON parseado. Cantidad de alertas crudas en 'Report': ${rawAlerts.length}`);
  if (rawAlerts.length > 0) {
     Logger.log(`[DEBUG] Muestra de la primera alerta cruda: ${JSON.stringify(rawAlerts[0])}`);
  }

  // Filtramos usando tu función isRowExcepted
  const finalAlerts = rawAlerts.filter((alert, index) => {
    const rowData = [
      (alert.object || "").toString().trim(),
      (alert.alarm || "").toString().trim(),
      (alert.severity || "").toString().trim(),
      (alert.time || "").toString().trim(),
      (alert.vcenter || "").toString().trim()
    ];
    
    Logger.log(`[DEBUG] Evaluando fila ${index + 1} para excepciones: ${JSON.stringify(rowData)}`);
    
    try {
      const isExcepted = isRowExcepted(rowData, headers, clientConfig.exceptions);
      if (isExcepted) {
        Logger.log(`[DEBUG] -> Fila ${index + 1} DESCARTADA por excepción.`);
      }
      return !isExcepted;
    } catch (err) {
      Logger.log(`[ERROR DEBUG] Falló la función isRowExcepted en la fila ${index + 1}. Error exacto: ${err.message}`);
      return true; // Si falla el filtro, dejamos pasar la alerta para no perderla
    }
  });
  
  Logger.log(`[DEBUG] Alertas totales recibidas: ${rawAlerts.length}. Alertas finales tras aplicar excepciones: ${finalAlerts.length}`);

  const existingTicketKey = findExistingJiraTicket(HZ_DASH_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
                            findExistingJiraTicket(HZ_DASH_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);

  // Escenario: TODO OK (Sin errores o todas fueron exceptuadas)
  if (finalAlerts.length === 0 || jsonData.Result === "OK") {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Sistema Normalizado.** El último reporte de Horizon confirma que todos los componentes están saludables (o las alertas actuales son excepciones validadas).");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías (OK).` });
    }
    const closeResult = buscarYCerrarTareaProgramada(HZ_DASH_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);    
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  // Escenario: HAY ERRORES y YA EXISTE TICKET
  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= HZ_DASH_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se mantienen ${alertCount} alertas en el Dashboard (con excepciones ya filtradas):\n\n`;
      commentText += `|| ${headers.join(" || ")} ||\n`;
      finalAlerts.forEach(row => {
        commentText += `| ${row.object || "-"} | ${row.alarm || "-"} | ${row.severity || "-"} | ${row.time || "-"} | ${row.vcenter || "-"} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.json$/i, "-FILTRADO.xlsx");
      const matrixData = [headers].concat(finalAlerts.map(r => [r.object, r.alarm, r.severity, r.time, r.vcenter]));
      const xlsxBlob = convertDataToXlsxBlob(matrixData, newFileName);
      
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** alertas de Horizon (excepciones filtradas).`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(HZ_DASH_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, HZ_DASH_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  // Escenario: HAY ERRORES y NO HAY TICKET (Crear nuevo)
  } else {
    // También actualizamos la llamada para pasarle los headers correctos
    const creationResult = analyzeHorizonDashboard_JSON(attachment.getName(), headers, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(HZ_DASH_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeHorizonDashboard_JSON(attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  
  if (alertCount <= HZ_DASH_ROW_LIMIT_FOR_TABLE) {
    summary = HZ_DASH_JIRA_TICKET_SUMMARY_TABLE;
    description = `Informamos que se detectaron ${alertCount} alertas en la infraestructura de Horizon. Se detalla el estado actual a continuación (excepciones ya filtradas):\n\n|| ${headers.join(" || ")} ||\n`;
    finalAlerts.forEach(row => {
      description += `| ${row.object || "-"} | ${row.alarm || "-"} | ${row.severity || "-"} | ${row.time || "-"} | ${row.vcenter || "-"} |\n`;
    });
  } else {
    summary = HZ_DASH_JIRA_TICKET_SUMMARY_ATTACHMENT;
    description = `Informamos que se detectaron ${alertCount} alertas en la infraestructura de Horizon. Por la cantidad de registros, se adjunta el reporte detallado en formato Excel (excepciones ya filtradas).`;
    const newFileName = attachmentName.replace(/\.json$/i, ".xlsx");
    const matrixData = [headers].concat(finalAlerts.map(r => [r.object, r.alarm, r.severity, r.time, r.vcenter]));
    xlsxBlob = convertDataToXlsxBlob(matrixData, newFileName);
  }
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig,HZ_DASH_OPERATION_NAME);
}