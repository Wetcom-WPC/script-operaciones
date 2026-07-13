/**
 * @fileoverview Lógica específica para procesar reportes de "Horizon Problem Machines".
 */

// --- CONFIGURACIÓN ESPECÍFICA ---
const HZ_PM_OPERATION_NAME = "Estado de Agentes View";
const HZ_PM_EMAIL_SUBJECT = "Horizon Problem Machines"; // Asunto que envía vRO
const HZ_PM_JSON_FILENAME_MATCH = ".json"; 
const HZ_PM_SCHEDULED_TASK_NAME_TO_CLOSE = "Estado de Agentes View"; // Nombre de la tarea en Jira
const HZ_PM_ROW_LIMIT_FOR_TABLE = 15;
const HZ_PM_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Máquinas con Problemas en Horizon";
const HZ_PM_JIRA_TICKET_SUMMARY_ATTACHMENT = "Múltiples Máquinas con Problemas en Horizon";


function processHorizonProblemMachinesEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(HZ_PM_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleHorizonPMMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  enviarResumenSlack(HZ_PM_OPERATION_NAME, summaryReport);
}

function processSingleHorizonPMMessage(message, summaryReport) {
  Logger.log("--- Dentro de processSingleHorizonPMMessage ---");
  const senderEmail = message.getFrom();
  Logger.log(`Procesando mensaje de: ${senderEmail}, Asunto: "${message.getSubject()}"`);

  const attachments = message.getAttachments();
  const attachment = attachments.find(att => att.getName().toLowerCase().endsWith(HZ_PM_JSON_FILENAME_MATCH));

  if (!attachment) {
    Logger.log("❌ FALLO: No se encontró adjunto JSON. La función terminará aquí.");
    return 'SUCCESS'; 
  }
  
  Logger.log(`✅ ÉXITO: Se encontró el adjunto JSON "${attachment.getName()}".`);

  const clientConfig = getClientConfig(senderEmail, HZ_PM_OPERATION_NAME);
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
  // AHORA SÍ: Usamos solo las 3 columnas originales
  const headers = ["NombreMaquina", "DesktopPool", "Estado"];
  const rawAlerts = jsonData.Report || [];
  
  Logger.log(`[DEBUG] JSON parseado. Cantidad de alertas crudas en 'Report': ${rawAlerts.length}`);

  // Filtramos usando tu función isRowExcepted
  const finalAlerts = rawAlerts.filter((alert, index) => {
    // Extraemos explícitamente las llaves correctas
    const rowData = [
      (alert.NombreMaquina || "").toString().trim(),
      (alert.DesktopPool || "").toString().trim(),
      (alert.Estado || "").toString().trim()
    ];
    
    try {
      const isExcepted = isRowExcepted(rowData, headers, clientConfig.exceptions);
      if (isExcepted) {
        Logger.log(`[DEBUG] -> Máquina problemática en fila ${index + 1} (${alert.NombreMaquina}) DESCARTADA por excepción.`);
      }
      return !isExcepted;
    } catch (err) {
      Logger.log(`[ERROR DEBUG] Falló la función isRowExcepted en la fila ${index + 1}. Error exacto: ${err.message}`);
      return true; // Ante la duda, dejamos pasar la alerta
    }
  });
  
  Logger.log(`[DEBUG] Máquinas con problemas totales: ${rawAlerts.length}. Finales tras aplicar excepciones: ${finalAlerts.length}`);

  const existingTicketKey = findExistingJiraTicket(HZ_PM_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
                            findExistingJiraTicket(HZ_PM_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);

  // Escenario: TODO OK (Sin errores o todos fueron exceptuados)
  if (finalAlerts.length === 0 || jsonData.Result === "OK") {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Anomalía Resuelta.** El último reporte indica que ya no hay máquinas con estados problemáticos (o las detectadas son excepciones validadas).");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin máquinas problemáticas (OK).` });
    }
    const closeResult = buscarYCerrarTareaProgramada(HZ_PM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);    
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  // Escenario: HAY ERRORES y YA EXISTE TICKET
  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= HZ_PM_ROW_LIMIT_FOR_TABLE) {
      commentText += `Actualmente hay ${alertCount} máquinas afectadas (excepciones filtradas):\n\n`;
      commentText += `|| ${headers.join(" || ")} ||\n`;
      finalAlerts.forEach(row => {
        // Solo las 3 columnas
        commentText += `| ${row.NombreMaquina || "-"} | ${row.DesktopPool || "-"} | ${row.Estado || "-"} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.json$/i, "-FILTRADO.xlsx");
      // Matriz de 3 columnas para el Excel
      const matrixData = [headers].concat(finalAlerts.map(r => [r.NombreMaquina, r.DesktopPool, r.Estado]));
      const xlsxBlob = convertDataToXlsxBlob(matrixData, newFileName);
      
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** máquinas en estado de error (excepciones filtradas).`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(HZ_PM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, HZ_PM_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  // Escenario: HAY ERRORES y NO HAY TICKET (Crear nuevo)
  } else {
    const creationResult = analyzeHorizonPM_JSON(attachment.getName(), headers, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(HZ_PM_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

function analyzeHorizonPM_JSON(attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  
  if (alertCount <= HZ_PM_ROW_LIMIT_FOR_TABLE) {
    summary = HZ_PM_JIRA_TICKET_SUMMARY_TABLE;
    description = `Informamos que se detectaron ${alertCount} escritorios virtuales (VMs) en estado problemático en Horizon. Se detalla el estado a continuación (excepciones ya filtradas):\n\n|| ${headers.join(" || ")} ||\n`;
    finalAlerts.forEach(row => {
      // Solo las 3 columnas
      description += `| ${row.NombreMaquina || "-"} | ${row.DesktopPool || "-"} | ${row.Estado || "-"} |\n`;
    });
  } else {
    summary = HZ_PM_JIRA_TICKET_SUMMARY_ATTACHMENT;
    description = `Informamos que se detectaron ${alertCount} escritorios virtuales (VMs) en estado problemático en Horizon. Por la cantidad de registros, se adjunta el reporte detallado en formato Excel (excepciones ya filtradas).`;
    const newFileName = attachmentName.replace(/\.json$/i, ".xlsx");
    // Matriz de 3 columnas para el Excel
    const matrixData = [headers].concat(finalAlerts.map(r => [r.NombreMaquina, r.DesktopPool, r.Estado]));
    xlsxBlob = convertDataToXlsxBlob(matrixData, newFileName);
  }
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig,HZ_PM_OPERATION_NAME);
}