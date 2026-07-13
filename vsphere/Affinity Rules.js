/**
 * @fileoverview Lógica específica para procesar reportes de "Affinity Rules".
 * IMPLEMENTA:
 * - Lógica DRP con MAPEO para redirigir tickets según el asunto.
 * - Estandarizado para usar FuncionesCompartidas.gs.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE AFFINITY RULES ---
const AFFINITY_OPERATION_NAME = "Affinity Rules";
const AFFINITY_EMAIL_SUBJECT = "Affinity Rules";
const AFFINITY_FILENAME_MATCH = ".json";
const AFFINITY_SCHEDULED_TASK_NAME_TO_CLOSE = "Affinity Rules";
const AFFINITY_ROW_LIMIT_FOR_TABLE = 10;
const AFFINITY_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs sin Affinity Rules configuradas";
const AFFINITY_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs sin Affinity Rules configuradas";

// --- MAPEO DE CLIENTES DRP ---
// Mapea el nombre que aparece en el ASUNTO DEL CORREO (ej. "BERSA")
// con el nombre EXACTO que está en la Columna B de tu Índice Maestro.
// (Este mapa debe ser igual al del script Alertas de vSphere)
const DRP_CLIENT_NAME_MAP1 = {
  "BERSA": "Operaciones Banco de Entre Rios",
  "SANTA FE": "Operaciones Banco Santa Fe",
  "SAN JUAN": "Operaciones Banco de San Juan",
  "SANTA CRUZ": "Operaciones Banco de Santa Cruz"
  // Añade más mapeos aquí si es necesario.
};


// --- LÓGICA PRINCIPAL DE AFFINITY RULES ---

function processAffinityRulesEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  
  // --- BÚSQUEDA FLEXIBLE ---
  const searchQuery = construirBusquedaGmail(AFFINITY_EMAIL_SUBJECT);
  // --- FIN BÚSQUEDA ---

  const threads = GmailApp.search(searchQuery);
  Logger.log(`Búsqueda inicial encontró ${threads.length} hilos.`);
  
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleAffinityRuleMessage(message, summaryReport);
          if (processingStatus === 'SUCCESS') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo con asunto: "${message.getSubject()}"` });
        }
      }
    });
  }
  enviarResumenSlack(AFFINITY_OPERATION_NAME, summaryReport);
}

/**
 * REEMPLAZA ESTA FUNCIÓN COMPLETA
 * Procesa un solo correo. Detecta reportes DRP, usa el MAPEO,
 * y redirige el ticket al cliente correspondiente.
 */
function processSingleAffinityRuleMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const emailSubject = message.getSubject();
  let overallStatus = 'SUCCESS'; // Asumimos éxito hasta que algo falle

  // --- INICIO DE LA LÓGICA "DRP OVERRIDE" ---
  let clientConfig = null;
  let isDRP = false;
  const subjectLower = emailSubject.toLowerCase();

  if (subjectLower.includes('drp')) {
    // Usamos RegEx para extraer el nombre del cliente desde el formato:
    // "DRP - [Reporte] [Cliente] (Estado)"
    // Asumimos que el reporte DRP de Affinity Rules sigue el mismo patrón de asunto.
    const drpMatch = emailSubject.match(/Affinity Rules\s(.*?)\s\(/i); // Busca el cliente después de "Affinity Rules "

    if (drpMatch && drpMatch[1]) {
      let drpClientName = drpMatch[1].trim();
      Logger.log(`Modo DRP detectado. Nombre extraído: "${drpClientName}"`);
      
      const mappedClientName = DRP_CLIENT_NAME_MAP1[drpClientName.toUpperCase()];
      
      if (mappedClientName) {
        Logger.log(`Nombre mapeado a: "${mappedClientName}"`);
        drpClientName = mappedClientName;
      } else {
        Logger.log(`Nombre "${drpClientName}" no encontrado en el mapa DRP. Se usará el nombre tal cual.`);
      }
      
      clientConfig = getClientConfigByName(drpClientName, AFFINITY_OPERATION_NAME);
      isDRP = true;
      
    } else {
      Logger.log(`ADVERTENCIA: Asunto DRP detectado, pero no se pudo extraer el nombre del cliente (formato esperado no coincidió). Asunto: "${emailSubject}"`);
    }
  }

  if (!clientConfig) {
    if (isDRP) Logger.log(`Búsqueda DRP por nombre falló. Revirtiendo a búsqueda por remitente.`);
    clientConfig = getClientConfig(senderEmail, AFFINITY_OPERATION_NAME);
    isDRP = false;
  }
  // --- FIN DE LA LÓGICA "DRP OVERRIDE" ---

  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Para remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  Logger.log(`Procesando reporte para el cliente: ${clientConfig.clientName} (Proyecto Jira: ${clientConfig.jiraProjectKey})`);

  // Pre-filtro por asunto del correo
  if (emailSubject.toLowerCase().includes("success")) {
    summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} recibido con (SUCCESS).` });
    const closeResult = buscarYCerrarTareaProgramada(AFFINITY_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  const attachment = message.getAttachments().find(att => att.getName().toLowerCase().endsWith(AFFINITY_FILENAME_MATCH));
  if (!attachment) {
    Logger.log("No se encontró un adjunto JSON válido.");
    return 'SUCCESS';
  }

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
    summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías (archivo vacío).` });
    const closeResult = buscarYCerrarTareaProgramada(AFFINITY_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }
  
  const originalHeaders = Object.keys(reportData[0]);
  const headers = originalHeaders.map(h => normalizarEncabezado(h)); // Normalizamos
  const reportRows = reportData.map(obj => originalHeaders.map(header => obj[header]));
  
  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    return !isRowEmpty && !isRowExcepted(row, headers, clientConfig.exceptions); // Usamos headers normalizados
  });
  
  const summary1 = AFFINITY_JIRA_TICKET_SUMMARY_TABLE;
  const summary2 = AFFINITY_JIRA_TICKET_SUMMARY_ATTACHMENT;

  // --- MODIFICACIÓN DEL TÍTULO DEL TICKET ---
  // Modificamos los resúmenes ANTES de buscar el ticket.
  let jiraSummaryTable = summary1;
  let jiraSummaryAttachment = summary2;
  
  if (isDRP) {
      jiraSummaryTable = jiraSummaryTable.replace("Se detectaron", "DRP - Se detectaron");
      jiraSummaryAttachment = jiraSummaryAttachment.replace("Se detectaron", "DRP - Se detectaron");
  }
  // --- FIN MODIFICACIÓN DEL TÍTULO ---

  const existingTicketKey = findExistingJiraTicket(jiraSummaryTable, clientConfig.jiraProjectKey) || findExistingJiraTicket(jiraSummaryAttachment, clientConfig.jiraProjectKey);

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de Affinity Rules no contiene alertas válidas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    const closeResult = buscarYCerrarTareaProgramada(AFFINITY_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  if (existingTicketKey) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (alertCount <= AFFINITY_ROW_LIMIT_FOR_TABLE) {
      commentText += `Se han detectado ${alertCount} nuevas alertas de Affinity Rules:\n\n`;
      commentText += `|| ${originalHeaders.join(" || ")} ||\n`; // Usamos headers originales
      finalAlerts.forEach(rowData => {
        commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
      });
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
    } else {
      const newFileName = attachment.getName().replace(/\.json$/i, "-FILTRADO.xlsx");
      const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName); // Usamos headers originales
      attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentStatus.status === 'SUCCESS') {
        commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs sin Affinity Rules.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
      } else {
        summaryReport.advertencias.push(attachmentStatus.detail);
      }
    }
    
    if (attachmentStatus.status === 'SUCCESS') {
      const closeResult = buscarYCerrarTareaProgramada(AFFINITY_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      return 'SUCCESS';
    } else {
      return attachmentStatus.status;
    }

  } else {
    // Pasamos los resúmenes (potencialmente modificados por DRP) a la función de creación.
    const creationResult = analyzeAffinityRules_JSON(attachment.getName(), originalHeaders, finalAlerts, clientConfig, jiraSummaryTable, jiraSummaryAttachment);
    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
    } else if (creationResult.status === 'ERROR') {
      summaryReport.errores.push(creationResult.detail);
    } else {
      summaryReport.advertencias.push(creationResult.detail);
    }
    
    if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        const closeResult = buscarYCerrarTareaProgramada(AFFINITY_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return creationResult.status;
  }
}

/**
 * REEMPLAZA ESTA FUNCIÓN COMPLETA
 * Ahora acepta los títulos de Jira como parámetros para manejar los casos DRP.
 */
function analyzeAffinityRules_JSON(attachmentName, headers, finalAlerts, clientConfig, summaryTable, summaryAttachment) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  if (alertCount <= AFFINITY_ROW_LIMIT_FOR_TABLE) {
    summary = summaryTable; // Usa el título DRP o normal que le pasamos
    description = `Se detectaron ${alertCount} VMs sin Affinity Rules configuradas:\n\n|| ${headers.join(" || ")} ||\n`;
    finalAlerts.forEach(rowData => {
      description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
    });
  } else {
    summary = summaryAttachment; // Usa el título DRP o normal que le pasamos
    description = `Se encontraron ${alertCount} VMs sin Affinity Rules configuradas. Se adjunta el reporte filtrado.`;
    const newFileName = attachmentName.replace(/\.json$/i, "-FILTRADO.xlsx");
    xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  }
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, AFFINITY_OPERATION_NAME);
}
