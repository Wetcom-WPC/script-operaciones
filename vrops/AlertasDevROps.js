/**
 * @fileoverview Lógica específica para procesar reportes de "Alertas de vROps".
 * Utiliza el sistema de notificación de resumen consolidado y el patrón de código robusto.
 * Incluye lógica para crear tickets con adjuntos si el número de alertas supera un umbral.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE ALERTAS DE VROPS ---
const VROPS_OPERATION_NAME = "Alertas de vROps";
const VROPS_EMAIL_SUBJECT = "Alertas de vROps";
const VROPS_CSV_FILENAME_MATCH = "Alertas de vROps";
const VROPS_SCHEDULED_TASK_NAME_TO_CLOSE = "Alertas de vROps";
const VROPS_GROUPING_COLUMN_NAME = "Name"; // Columna para agrupar (nombre de la alerta)
const VROPS_OBJECT_NAME_COLUMN = "Object Name"; // Columna con el nombre del objeto afectado
const VROPS_ALERT_THRESHOLD_FOR_ATTACHMENT = 10; // A partir de este número de alertas, se adjunta un reporte
const VROPS_JIRA_GROUPED_SUMMARY_TEMPLATE = "Alertas de vROps: {ALERT_NAME}";


// --- LÓGICA PRINCIPAL (ESTANDARIZADA) ---

function processVropsEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(VROPS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleVropsMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500' && processingStatus !== 'FAILURE') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  enviarResumenSlack(VROPS_OPERATION_NAME, summaryReport);
}


function processSingleVropsMessage(message, summaryReport) {
  Logger.log(`--- Iniciando procesamiento para [Alertas de vROps] del correo: "${message.getSubject()}" ---`);
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(VROPS_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );

  // 1) Si no hay adjunto CSV: no hay nada que hacer, pero no es error.
  if (!attachment) {
    Logger.log("No se encontró un adjunto CSV. Terminando el procesamiento para este correo.");
    return 'SUCCESS';
  }

  const clientConfig = getClientConfig(senderEmail, VROPS_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  // 2) Normalizar CSV y parsear
  let csvContent = attachment.getDataAsString("UTF-8");
  csvContent = csvContent.replace(/^\uFEFF/, ''); 
  csvContent = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  const allRows = parseCsvRobust(csvContent);
  
  // 3) Caso: archivo sin datos (solo encabezado o incluso sin encabezado)
  if (!allRows || allRows.length < 2) {
    summaryReport.exitos.push({
      mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías (archivo sin datos).`
    });

    const closeResult = buscarYCerrarTareaProgramada(VROPS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    Logger.log(`Resultado de buscarYCerrarTareaProgramada (archivo sin datos): ${JSON.stringify(closeResult)}`);

    if (closeResult && closeResult.status === 'SUCCESS') {
      summaryReport.tareasCerradas++;
    } else if (closeResult && closeResult.status !== 'SKIPPED') {
      summaryReport.advertencias.push({
        mensaje: `No se pudo cerrar la tarea programada para ${clientConfig.clientName}. Status: ${closeResult.status}`
      });
    }

    return 'SUCCESS';
  }
  
  // 4) Hay datos: aplicar excepciones y agrupar
  const originalHeaders = allRows[0];
  const reportRows = allRows.slice(1);
  const headers = originalHeaders.map(h => normalizarEncabezado(h));

  const finalAlerts = reportRows.filter(row =>
    (row.join('').trim() !== '') && !isRowExcepted(row, headers, clientConfig.exceptions)
  );
  
  Logger.log(`Paso 1: Número de alertas encontradas después del filtro inicial: ${finalAlerts.length}`);
  
  const groupingColIndex   = headers.indexOf(normalizarEncabezado(VROPS_GROUPING_COLUMN_NAME));
  const objectNameColIndex = headers.indexOf(normalizarEncabezado(VROPS_OBJECT_NAME_COLUMN));
  
  if (groupingColIndex === -1 || objectNameColIndex === -1) {
    const errorMsg = `Columnas clave no encontradas. Se buscó "${VROPS_GROUPING_COLUMN_NAME}" (índice: ${groupingColIndex}) y "${VROPS_OBJECT_NAME_COLUMN}" (índice: ${objectNameColIndex}).`;
    summaryReport.errores.push({ error: errorMsg });
    Logger.log(`ERROR: ${errorMsg}`);
    return 'FAILURE';
  }
  
  let overallStatus = 'SUCCESS';

  // 5) Caso: el CSV tiene filas, pero después de aplicar excepciones NO queda ninguna alerta.
  if (finalAlerts.length === 0) {
    summaryReport.exitos.push({
      mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías nuevas (todas las filas fueron exceptuadas o vacías).`
    });

    const closeResult = buscarYCerrarTareaProgramada(VROPS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    Logger.log(`Resultado de buscarYCerrarTareaProgramada (sin alertas finales): ${JSON.stringify(closeResult)}`);

    if (closeResult && closeResult.status === 'SUCCESS') {
      summaryReport.tareasCerradas++;
    } else if (closeResult && closeResult.status !== 'SKIPPED') {
      summaryReport.advertencias.push({
        mensaje: `No se pudo cerrar la tarea programada para ${clientConfig.clientName}. Status: ${closeResult.status}`
      });
    }

    return 'SUCCESS';
  }

  // 6) Caso: HAY alertas (finalAlerts.length > 0): tu lógica original de tickets
  const groupedAlerts = {};
  finalAlerts.forEach(row => {
    const alertName = (row[groupingColIndex] || "Sin Nombre").trim();
    if (!groupedAlerts[alertName]) groupedAlerts[alertName] = [];
    groupedAlerts[alertName].push(row);
  });
  
  Logger.log(`Paso 2: Alertas agrupadas en ${Object.keys(groupedAlerts).length} grupos distintos.`);

  for (const alertName in groupedAlerts) {
    Logger.log(`--- Procesando Grupo de Alerta: "${alertName}" (${groupedAlerts[alertName].length} alertas) ---`);
    
    const alertGroupRows = groupedAlerts[alertName];
    let summary = VROPS_JIRA_GROUPED_SUMMARY_TEMPLATE.replace("{ALERT_NAME}", alertName);
    
    Logger.log(`Buscando ticket existente con el resumen: "${summary}"`);
    const existingTicketKey = findExistingJiraTicket(summary, clientConfig.jiraProjectKey);

    if (existingTicketKey) {
      Logger.log(`Ticket encontrado: ${existingTicketKey}. Verificando si ya fue actualizado hoy...`);
      if (haSidoActualizadoHoy(existingTicketKey, alertName)) {
        Logger.log(`El ticket ${existingTicketKey} ya fue actualizado hoy para esta alerta. Omitiendo.`);
        continue;
      }
      
      Logger.log(`Actualizando ticket ${existingTicketKey} con ${alertGroupRows.length} nuevas ocurrencias.`);
      
      const alertCount   = alertGroupRows.length;
      const todayMarker  = `[AUTO-UPDATE:${new Date().toISOString().slice(0, 10)}]`;
      const fingerprint  = `${todayMarker} ${alertName}`;
      let commentText    = `🚨 **El problema persiste.** ${fingerprint}\nSe han detectado ${alertCount} nuevas ocurrencias de la alerta "${alertName}".\n\n`;

      if (alertCount <= VROPS_ALERT_THRESHOLD_FOR_ATTACHMENT) {
        commentText += `*Objetos Afectados:*\n`;
        alertGroupRows.forEach(rowData => {
          const objectName = rowData[objectNameColIndex] || "(objeto sin nombre)";
          commentText += `• ${objectName}\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({
          mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.`
        });

        // --- BLOQUE INFORMATIVO: ticket existente sin adjunto ---
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, summary);
        if (accountIdAsignado) {
          ticketInformativo(existingTicketKey, accountIdAsignado);
        }

      } else {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** objetos afectados.`;
        const newFileName = `${alertName.replace(/[^a-zA-Z0-9]/g, '_')}-FILTRADO.xlsx`;
        const xlsxBlob    = convertDataToXlsxBlob([originalHeaders, ...alertGroupRows], newFileName);
        const attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

        if (attachmentStatus.status === 'SUCCESS') {
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({
            mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte adjunto.`
          });

          // --- BLOQUE INFORMATIVO: ticket existente con adjunto ---
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, summary);
          if (accountIdAsignado) {
            ticketInformativo(existingTicketKey, accountIdAsignado);
          }

        } else {
          summaryReport.advertencias.push(attachmentStatus.detail);
          overallStatus = attachmentStatus.status;
        }
      }
    } else {
      Logger.log(`No se encontró ticket. Creando uno nuevo para la alerta "${alertName}".`);
        
      const alertCount = alertGroupRows.length;
      let description;
      let attachmentBlob = null;
    
      if (alertCount <= VROPS_ALERT_THRESHOLD_FOR_ATTACHMENT) {
        description = `Se detectó la siguiente alerta:\n\n*Alarma:* ${alertName}\n\n*Objetos Afectados (${alertCount}):*\n`;
        alertGroupRows.forEach(rowData => {
          const objectName = rowData[objectNameColIndex] || "(objeto sin nombre)";
          description += `• ${objectName}\n`;
        });
      } else {
        description = `Se detectaron ${alertCount} anomalías de la alerta "${alertName}". Se adjunta el detalle, filtrando las excepciones correspondientes.`;
        const newFileName = `${alertName.replace(/[^a-zA-Z0-9]/g, '_')}-FILTRADO.xlsx`;
        attachmentBlob = convertDataToXlsxBlob([originalHeaders, ...alertGroupRows], newFileName);
      }
    
      // --- CAMBIO: se pasa `summary` en lugar de VROPS_OPERATION_NAME
      //     para que chequearSiEsInformativa (dentro de createTicketAndNotify)
      //     matchee contra los nombres específicos de la hoja Informativas. ---
      const creationResult = createTicketAndNotify(summary, description, attachmentBlob, clientConfig, summary);
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else if (creationResult.status === 'ERROR') {
        summaryReport.errores.push(creationResult.detail);
      } else {
        summaryReport.advertencias.push(creationResult.detail);
      }
      
      if (creationResult.status === 'HTTP_500' || creationResult.status === 'FAILURE') {
        overallStatus = creationResult.status;
      }
    }
  }

  // 7) Cerrar la tarea programada TAMBIÉN cuando hubo alertas
  const closeResult = buscarYCerrarTareaProgramada(VROPS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
  Logger.log(`Resultado de buscarYCerrarTareaProgramada (con alertas): ${JSON.stringify(closeResult)}`);

  if (closeResult && closeResult.status === 'SUCCESS') {
    summaryReport.tareasCerradas++;
  } else if (closeResult && closeResult.status !== 'SKIPPED') {
    summaryReport.advertencias.push({
      mensaje: `No se pudo cerrar la tarea programada para ${clientConfig.clientName}. Status: ${closeResult.status}`
    });
  }

  return overallStatus;
}