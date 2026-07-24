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

class VROpsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: VROPS_OPERATION_NAME,
      emailSubject: VROPS_EMAIL_SUBJECT,
      attachmentMatch: VROPS_CSV_FILENAME_MATCH,
      scheduledTaskName: VROPS_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  parseAttachment(attachment, summaryReport) {
    try {
      let csvContent = attachment.getDataAsString("UTF-8");
      csvContent = csvContent.replace(/^\uFEFF/, ''); 
      csvContent = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      return parseCsvRobust(csvContent);
    } catch (e) {
      summaryReport.errores.push({ error: "Error parseando CSV robusto", detalle: e.message });
      return null;
    }
  }

  isDataEmpty(parsedData) {
    return !parsedData || parsedData.length < 2;
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);
    const headers = originalHeaders.map(h => normalizarEncabezado(h));

    const finalAlerts = reportRows.filter(row =>
      (row.join('').trim() !== '') && !isRowExcepted(row, headers, clientConfig.exceptions)
    );
    
    const groupingColIndex   = headers.indexOf(normalizarEncabezado(VROPS_GROUPING_COLUMN_NAME));
    const objectNameColIndex = headers.indexOf(normalizarEncabezado(VROPS_OBJECT_NAME_COLUMN));
    
    if (groupingColIndex === -1 || objectNameColIndex === -1) {
      const errorMsg = `Columnas clave no encontradas. Se buscó "${VROPS_GROUPING_COLUMN_NAME}" (índice: ${groupingColIndex}) y "${VROPS_OBJECT_NAME_COLUMN}" (índice: ${objectNameColIndex}).`;
      summaryReport.errores.push({ error: errorMsg });
      return null;
    }

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return null; // Handle inside handleAlerts
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    summaryReport.exitos.push({
      mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías nuevas (todas las filas fueron exceptuadas o vacías).`
    });
    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const groupingColIndex   = headers.map(h => normalizarEncabezado(h)).indexOf(normalizarEncabezado(VROPS_GROUPING_COLUMN_NAME));
    const objectNameColIndex = headers.map(h => normalizarEncabezado(h)).indexOf(normalizarEncabezado(VROPS_OBJECT_NAME_COLUMN));

    const groupedAlerts = {};
    finalAlerts.forEach(row => {
      const alertName = (row[groupingColIndex] || "Sin Nombre").trim();
      if (!groupedAlerts[alertName]) groupedAlerts[alertName] = [];
      groupedAlerts[alertName].push(row);
    });

    let overallStatus = 'SUCCESS';

    for (const alertName in groupedAlerts) {
      const alertGroupRows = groupedAlerts[alertName];
      let summary = VROPS_JIRA_GROUPED_SUMMARY_TEMPLATE.replace("{ALERT_NAME}", alertName);
      const ticketKey = findExistingJiraTicket(summary, clientConfig.jiraProjectKey);

      if (ticketKey) {
        if (haSidoActualizadoHoy(ticketKey, alertName)) {
          continue;
        }
        
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
          addCommentToJiraTicket(ticketKey, commentText);
          summaryReport.exitos.push({
            mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${ticketKey}|${ticketKey}> con ${alertCount} alertas.`
          });

          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, summary);
          if (accountIdAsignado) {
            ticketInformativo(ticketKey, accountIdAsignado);
          }

        } else {
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** objetos afectados.`;
          const newFileName = `${alertName.replace(/[^a-zA-Z0-9]/g, '_')}-FILTRADO.xlsx`;
          const xlsxBlob    = convertDataToXlsxBlob([headers, ...alertGroupRows], newFileName);
          const attachmentStatus = addAttachmentToJiraTicket(ticketKey, xlsxBlob);

          if (attachmentStatus.status === 'SUCCESS') {
            addCommentToJiraTicket(ticketKey, commentText);
            summaryReport.exitos.push({
              mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${ticketKey}|${ticketKey}> con el nuevo reporte adjunto.`
            });

            const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, summary);
            if (accountIdAsignado) {
              ticketInformativo(ticketKey, accountIdAsignado);
            }

          } else {
            summaryReport.advertencias.push(attachmentStatus.detail);
            overallStatus = attachmentStatus.status;
          }
        }
      } else {
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
          attachmentBlob = convertDataToXlsxBlob([headers, ...alertGroupRows], newFileName);
        }
      
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

    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    return { status: overallStatus };
  }
}

function processVropsEmails() {
  new VROpsProcessor().processEmails();
}
