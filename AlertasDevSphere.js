/**
 * @fileoverview Lógica específica para "Alertas de vSphere".
 * IMPLEMENTA:
 * - Lógica DRP con MAPEO para redirigir tickets según el asunto.
 * - Estandarizado para usar FuncionesCompartidas.gs.
 */

// --- CONFIGURACIÓN DE LA OPERACIÓN "ALERTAS DE VSPHERE" ---
const VSPHERE_OPERATION_NAME = "Alertas de vSphere";
const VSPHERE_EMAIL_SUBJECT = "Alertas de vSphere";
const VSPHERE_FILENAME_MATCH = ".json";
const VSPHERE_SCHEDULED_TASK_NAME_TO_CLOSE = "Alertas de vSphere";
const VSPHERE_GROUPING_COLUMN_NAME = "alarm";
const VSPHERE_OBJECT_NAME_COLUMN = "object";
const VSPHERE_ALERT_THRESHOLD_FOR_ATTACHMENT = 10;
const VSPHERE_JIRA_GROUPED_SUMMARY_TEMPLATE = "Alertas de vSphere {ALERT_NAME}";

// Alertas que NO deben generar ticket (se manejan solo por mail/reporte de consumo)
const VSPHERE_ALERTAS_SIN_TICKET = [
  "Virtual machine CPU usage",
  "Host CPU usage",
  "Host memory usage",
  "Virtual machine memory usage",
  "Virtual machine CPU usage"
];

// --- MAPEO DE CLIENTES DRP ---
// Mapea el nombre que aparece en el ASUNTO DEL CORREO (ej. "BERSA")
// con el nombre EXACTO que está en la Columna B de tu Índice Maestro.
const DRP_CLIENT_NAME_MAP = {
  "BERSA": "Operaciones Banco de Entre Rios",
  "SANTA FE": "Operaciones Banco Santa Fe",
  "SAN JUAN": "Operaciones Banco de San Juan",
  "SANTA CRUZ": "Operaciones Banco de Santa Cruz"
  // Añade más mapeos aquí si es necesario.
};

// --- LÓGICA PRINCIPAL (ESTANDARIZADA) ---

function processVsphereEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(VSPHERE_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleVsphereMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  enviarResumenSlack(VSPHERE_OPERATION_NAME, summaryReport);
}

/**
 * Procesa un solo correo. Detecta reportes DRP usando una nueva lógica de extracción (RegEx)
 * basada en los asuntos de ejemplo
 */
function processSingleVsphereMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const emailSubject = message.getSubject();
  let overallStatus = 'SUCCESS';

  // --- INICIO DE LA LÓGICA "DRP OVERRIDE" ---
  let clientConfig = null;
  let isDRP = false;
  const subjectLower = emailSubject.toLowerCase();

  // 1. Verificamos si es un reporte DRP
  if (subjectLower.includes('drp')) {
    // 2. Usamos RegEx para extraer el nombre del cliente
    const drpMatch = emailSubject.match(/Alertas de vSphere\s(.*?)\s\(/i);

    if (drpMatch && drpMatch[1]) {
      let drpClientName = drpMatch[1].trim(); 
      Logger.log(`Modo DRP detectado. Nombre extraído: "${drpClientName}"`);
      
      // 3. Usamos el mapa para traducir el nombre
      const mappedClientName = DRP_CLIENT_NAME_MAP[drpClientName.toUpperCase()];
      
      if (mappedClientName) {
        Logger.log(`Nombre mapeado a: "${mappedClientName}"`);
        drpClientName = mappedClientName; 
      } else {
        Logger.log(`Nombre "${drpClientName}" no encontrado en el mapa DRP. Se usará el nombre tal cual.`);
      }
      
      // 4. Buscamos la configuración por el nombre mapeado
      clientConfig = getClientConfigByName(drpClientName, VSPHERE_OPERATION_NAME);
      isDRP = true;
      
    } else {
      Logger.log(`ADVERTENCIA: Asunto DRP detectado, pero no se pudo extraer el nombre del cliente. Asunto: "${emailSubject}"`);
    }
  }

  // 5. Si no es DRP, usamos el método normal
  if (!clientConfig) {
    if (isDRP) Logger.log(`Búsqueda DRP por nombre falló. Revirtiendo a búsqueda por remitente.`);
    clientConfig = getClientConfig(senderEmail, VSPHERE_OPERATION_NAME);
    isDRP = false;
  }
  // --- FIN DE LA LÓGICA "DRP OVERRIDE" ---

  if (!clientConfig) {
      summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
      return 'FAILURE';
  }
  
  Logger.log(`Procesando reporte para el cliente: ${clientConfig.clientName} (Proyecto Jira: ${clientConfig.jiraProjectKey})`);
  
  if (emailSubject.toLowerCase().includes("success")) {
    summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} recibido con [SUCCESS].` });
    const closeResult = buscarYCerrarTareaProgramada(VSPHERE_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  const attachment = message.getAttachments().find(att => att.getName().toLowerCase().endsWith(VSPHERE_FILENAME_MATCH));
  if (!attachment) {
      Logger.log("No se encontró un adjunto JSON válido para procesar.");
      return 'SUCCESS';
  }

  const jsonString = attachment.getDataAsString("UTF-8");
  let reportData;
  try {
    const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
    reportData = parsedJson.Report || parsedJson.alerts || parsedJson;
  } catch (e) {
    summaryReport.errores.push({ error: "El archivo JSON es inválido.", detalle: `Asunto: ${emailSubject}` });
    return 'FAILURE';
  }

  if (!reportData || !Array.isArray(reportData) || reportData.length === 0) {
    summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías (archivo vacío).` });
    const closeResult = buscarYCerrarTareaProgramada(VSPHERE_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  const originalHeaders = Object.keys(reportData[0]);
  const headers = originalHeaders.map(h => normalizarEncabezado(h));
  const reportRows = reportData.map(obj => originalHeaders.map(header => obj[header]));
  const finalAlerts = reportRows.filter(row => (row.join('').trim() !== '') && !isRowExcepted(row, headers, clientConfig.exceptions));

  const groupingColIndex = headers.indexOf(normalizarEncabezado(VSPHERE_GROUPING_COLUMN_NAME));
  const objectNameColIndex = headers.indexOf(normalizarEncabezado(VSPHERE_OBJECT_NAME_COLUMN));

  if (groupingColIndex === -1 || objectNameColIndex === -1) {
    summaryReport.errores.push({ error: `Columnas clave de agrupación u objeto no encontradas en el JSON.` });
    return 'FAILURE';
  }

  if (finalAlerts.length > 0) {
    const groupedAlerts = {};
    finalAlerts.forEach(row => {
      // --- FIX: Limpiamos comillas simples y dobles para no romper la búsqueda JQL de Jira ---
      let alertName = (row[groupingColIndex] || "Sin Nombre").trim();
      alertName = alertName.replace(/['"]/g, ""); 
      
      if (!groupedAlerts[alertName]) groupedAlerts[alertName] = [];
      groupedAlerts[alertName].push(row);
    });

    for (const alertName in groupedAlerts) {
      Logger.log(`\n--- Procesando grupo: "${alertName}" ---`);

      // Alertas excluidas de ticketing — solo se reportan por mail
      const esAlertaSinTicket = VSPHERE_ALERTAS_SIN_TICKET.some(a =>
        alertName.toLowerCase().includes(a.toLowerCase())
      );
      if (esAlertaSinTicket) {
        Logger.log(`Alerta "${alertName}" excluida de ticketing. Solo se reporta por mail.`);
        continue;
      }

      const alertGroupRows = groupedAlerts[alertName];
      
      let summary = VSPHERE_JIRA_GROUPED_SUMMARY_TEMPLATE.replace("{ALERT_NAME}", alertName);

      if (isDRP) {
        summary = summary.replace("Alertas de vSphere", "Alertas de vSphere DRP");
      }
      
      const JIRA_SUMMARY_MAX_LENGTH = 254;
      if (summary.length > JIRA_SUMMARY_MAX_LENGTH) {
        summary = summary.substring(0, JIRA_SUMMARY_MAX_LENGTH - 3) + "...";
      }

      const existingTicketKey = findExistingJiraTicket(summary, clientConfig.jiraProjectKey);
      
      if (existingTicketKey) { // Actualizar Ticket Existente
        if (haSidoActualizadoHoy(existingTicketKey, alertName)) {
          continue;
        }
        const todayMarker = `[AUTO-UPDATE:${new Date().toISOString().slice(0, 10)}]`;
        let attachmentStatus = { status: 'SUCCESS' };
        
        if (alertGroupRows.length > VSPHERE_ALERT_THRESHOLD_FOR_ATTACHMENT) {
          const newFileName = `Reporte ${alertName} (Actualizado).xlsx`;
          const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...alertGroupRows], newFileName);
          attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
          if (attachmentStatus.status === 'SUCCESS') {
            const commentText = `${todayMarker} ${alertName}\n\n🚨 **La anomalía persiste.** Se adjunta reporte con **${alertGroupRows.length}** objetos afectados.`;
            addCommentToJiraTicket(existingTicketKey, commentText);
            summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con nuevo reporte.` });

            // --- BLOQUE INFORMATIVO: ticket existente con adjunto ---
            const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, summary);
            if (accountIdAsignado) {
              ticketInformativo(existingTicketKey, accountIdAsignado);
            }

          } else {
            summaryReport.advertencias.push(attachmentStatus.detail);
          }
        } else {
          let comment = `${todayMarker} ${alertName}\n\n🚨 **La anomalía persiste.** Se ha vuelto a detectar la alerta *"${alertName}"*.\n\n`;
          comment += `*Objetos Afectados en este reporte (${alertGroupRows.length}):*\n`;
          alertGroupRows.forEach(row => (comment += `• ${row[objectNameColIndex] || "(objeto sin nombre)"}\n`));
          addCommentToJiraTicket(existingTicketKey, comment);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertGroupRows.length} objetos.` });

          // --- BLOQUE INFORMATIVO: ticket existente sin adjunto ---
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, summary);
          if (accountIdAsignado) {
            ticketInformativo(existingTicketKey, accountIdAsignado);
          }
        }
        if (attachmentStatus.status !== 'SUCCESS') overallStatus = attachmentStatus.status;

      } else { // Crear Ticket Nuevo
        let description = "";
        let xlsxBlob = null;
        if (alertGroupRows.length > VSPHERE_ALERT_THRESHOLD_FOR_ATTACHMENT) {
          description = `Se detectaron ${alertGroupRows.length} objetos afectados por la alerta *"${alertName}"*. Se adjunta un reporte con el detalle.`;
          const newFileName = `Reporte ${alertName}.xlsx`;
          xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...alertGroupRows], newFileName);
        } else {
          description = buildVsphereDescription(alertName, originalHeaders, alertGroupRows, objectNameColIndex);
        }

        // --- CAMBIO: se pasa `summary` en lugar de VSPHERE_OPERATION_NAME
        //     para que chequearSiEsInformativa (dentro de createTicketAndNotify)
        //     matchee contra los nombres específicos de la hoja Informativas. ---
        const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, summary);
        
        if (creationResult.status !== 'SUCCESS') overallStatus = creationResult.status;
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push(creationResult.detail);
        } else {
          (creationResult.status === 'ERROR' ? summaryReport.errores : summaryReport.advertencias).push(creationResult.detail);
        }
      } 
    }
  } else {
    summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado. Todas las anomalías fueron exceptuadas.` });
  }
  
  const closeResult = buscarYCerrarTareaProgramada(VSPHERE_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
  if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
  
  Logger.log(`--- Finalizado el procesamiento para [Alertas de vSphere]. ---`);
  return overallStatus;
}

// --- FUNCIONES AUXILIARES ---

function buildVsphereDescription(alertName, originalHeaders, rows, objectNameColIndex) {
  let description = `Se detectó la siguiente alerta:\n\n*Alarma:* ${alertName}\n\n`;
  description += `*Objetos Afectados (${rows.length}):*\n`;
  
  if (objectNameColIndex === -1) {
    description += "Error: No se pudo encontrar la columna de objetos para listar.\n\n";
  } else {
    rows.forEach(rowData => {
      const objectName = rowData[objectNameColIndex] || "(objeto sin nombre)";
      description += `• ${objectName}\n`;
    });
  }
  return description;
}