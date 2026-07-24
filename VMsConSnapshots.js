/**
 * @fileoverview Lógica específica para procesar reportes de "VMs con snapshots".
 * CORRECCIÓN: La fila "Total" solo va al Excel adjunto, NUNCA a la tabla de texto del ticket.
 */
// --- CONFIGURACIÓN ESPECÍFICA ---
const SNAPSHOTS_OPERATION_NAME = "VMs con snapshots";
const SNAPSHOTS_EMAIL_SUBJECT = "VMs con snapshots";
const SNAPSHOTS_FILENAME_MATCH = "VMs con snapshots";
const SNAPSHOTS_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs con snapshots";
const SNAPSHOTS_ROW_LIMIT_FOR_TABLE = 5;
const SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs con Snapshots";
const SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs con Snapshots";
const AGE_MAX = 7;      // Días
const SIZE_MAX = 300;   // GB
const CANTIDAD_MAX = 3; // Unidades
// --- LÓGICA PRINCIPAL ---
function processSnapshotsEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  const searchQuery = construirBusquedaGmail(SNAPSHOTS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);
 
  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleSnapshotsMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500' && processingStatus !== 'NO_OP') {
            thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: e.message, detalle: `Procesando correo: "${message.getSubject()}"` });
        }
      }
    });
  }
  enviarResumenSlack(SNAPSHOTS_OPERATION_NAME, summaryReport);
}
function processSingleSnapshotsMessage(message, summaryReport) {
  Logger.log(`--- Procesando: "${message.getSubject()}" ---`);
  const senderEmail = message.getFrom();
 
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(SNAPSHOTS_FILENAME_MATCH)
  );
  if (!attachment) return 'NO_OP';
  let clientConfig = getClientConfig(senderEmail, SNAPSHOTS_OPERATION_NAME);
  const fileNameUpper = attachment.getName().toUpperCase();
  const clientNameUpper = (clientConfig && clientConfig.clientName) ? clientConfig.clientName.toUpperCase() : "";
  const esBalanz = clientNameUpper.includes("BALANZ") || fileNameUpper.includes("BALANZ");
  const esMacro = clientNameUpper.includes("MACRO") || fileNameUpper.includes("MACRO");
  if (esBalanz && (!clientConfig || !clientConfig.clientName || !clientConfig.clientName.toUpperCase().includes("BALANZ"))) {
    clientConfig = getClientConfigByName("Operaciones BALANZ", SNAPSHOTS_OPERATION_NAME);
    if (!clientConfig) {
      clientConfig = {
        clientName: "Operaciones BALANZ",
        jiraProjectKey: "OBC2",
        exceptions: []
      };
    }
  } else if (esMacro && (!clientConfig || !clientConfig.clientName || !clientConfig.clientName.toUpperCase().includes("MACRO"))) {
    clientConfig = getClientConfigByName("Operaciones Banco Macro", SNAPSHOTS_OPERATION_NAME);
    if (!clientConfig) {
      clientConfig = {
        clientName: "Operaciones Banco Macro",
        jiraProjectKey: "OBM",
        exceptions: []
      };
    }
  } else if (!clientConfig || !clientConfig.clientName || clientConfig.clientName.toUpperCase().includes("DESCONOCIDO")) {
    summaryReport.errores.push({ error: "No hay configuración para este cliente.", detalle: senderEmail });
    return 'FAILURE';
  }
  let allRows;
  try {
     const csvData = attachment.getDataAsString("UTF-8");
     const firstLine = csvData.split(/\r\n|\n|\r/)[0];
     const separator = firstLine.includes(";") ? ";" : ",";
     allRows = Utilities.parseCsv(csvData, separator);
     Logger.log(`[DEBUG_CSV] FirstLine: "${firstLine}" | Detected Separator: "${separator}" | Total Rows parsed: ${allRows.length}`);
     if (allRows.length > 0) {
       Logger.log(`[DEBUG_CSV] Headers: ${JSON.stringify(allRows[0])}`);
     }
  } catch (e) {
     summaryReport.errores.push({ error: "Error leyendo CSV.", detalle: e.message });
     return 'FAILURE';
  }
  if (!allRows || allRows.length === 0) return 'SUCCESS';
  // --- SEPARACIÓN DE TOTAL ---
  let summaryRow = [];
  if (allRows.length > 1) {
    summaryRow = allRows.pop(); // Sacamos la última fila (Total)
  }
  const headers = allRows[0].map(h => h.trim());
  const reportRows = allRows.slice(1);
  if (clientConfig && !clientConfig.exceptions) {
    clientConfig.exceptions = [];
  }
  const findCol = (namePart) => headers.findIndex(h => h.toLowerCase().includes(namePart.toLowerCase()));
  
  let idxName, idxAge, idxSpace, idxCount;
  const tieneV2 = fileNameUpper.includes("V2");
  
  if (esBalanz || esMacro || tieneV2) {
    idxName = findCol("Name");
    idxAge = findCol("Number_Days_Old");  
    idxSpace = findCol("Snapshot_Space");
    idxCount = findCol("Number_Snapshots");
  } else {
    idxName = findCol("Name");
    idxAge = findCol("Age");  
    idxSpace = findCol("Space");
    idxCount = findCol("Cantidad");
  }
  Logger.log(`[DEBUG_CSV] Column Indices - Name: ${idxName} | Age: ${idxAge} | Space: ${idxSpace} | Count: ${idxCount}`);
  if (idxName === -1 || idxAge === -1 || idxSpace === -1 || idxCount === -1) {
    summaryReport.errores.push({ error: "Faltan columnas clave." });
    return 'FAILURE';
  }
  headers[idxName] = "Name";
  const parseSeguro = (val) => {
    if (!val) return 0;
    let clean = val.toString().trim();
    if (clean.includes('.') && clean.includes(',')) clean = clean.replace(/\./g, '');
    clean = clean.replace(',', '.');
    return parseFloat(clean) || 0;
  };
  const detectedReasons = new Set();
  const finalAlerts = reportRows.filter(row => {
    if (row.length < idxAge || row.join('').trim() === '') return false;
    const vmName = (row[idxName] || "").trim();
    if (vmName.toLowerCase().includes("replica")) return false;
    const age = parseSeguro(row[idxAge]);
    const space = parseSeguro(row[idxSpace]);
    const count = parseSeguro(row[idxCount]);
    let rowBreaksRule = false;
    if (age >= AGE_MAX) { detectedReasons.add(`Antigüedad >= ${AGE_MAX} días`); rowBreaksRule = true; }
    if (space >= SIZE_MAX) { detectedReasons.add(`Tamaño >= ${SIZE_MAX} GB`); rowBreaksRule = true; }
    if (count >= CANTIDAD_MAX) { detectedReasons.add(`Cantidad >= ${CANTIDAD_MAX}`); rowBreaksRule = true; }
    
    const isExcepted = isRowExcepted(row, headers, clientConfig.exceptions);
    Logger.log(`[DEBUG] VM: ${vmName} | Age: ${age} | Space: ${space} | Count: ${count} | BreaksRule: ${rowBreaksRule} | Excepted: ${isExcepted}`);
    
    return rowBreaksRule && !isExcepted;
  });
 
  const reasonsText = Array.from(detectedReasons).map(r => `* ${r}`).join('\n');
  const existingTicketKey = findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) ||
                            findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  // CASO 1: SIN ALERTAS
  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Anomalía resuelta.** Reporte limpio.");
      summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} limpio.` });
    }
    buscarYCerrarTareaProgramada(SNAPSHOTS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
    return 'SUCCESS';
  }
  // --- PREPARAR DATOS PARA ADJUNTOS (Alertas + Total) ---
  const rowsForExport = [...finalAlerts];
  if (summaryRow.length > 0) rowsForExport.push(summaryRow);
  // CASO 2: TICKET EXISTENTE
  if (existingTicketKey) {
    if (haSidoActualizadoHoy(existingTicketKey, "ALERTA-SNAPSHOTS")) return 'SUCCESS';
    let commentText = `🚨 **El problema persiste.** [HU-ALERTA-SNAPSHOTS]\n\nSe detectaron ${finalAlerts.length} VMs fuera de norma:\n${reasonsText}\n\n`;
   
    if (finalAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
      commentText += `|| ${headers.join(" || ")} ||\n`;
      // CORRECCIÓN: Usamos finalAlerts para la tabla (sin totales)
      finalAlerts.forEach(row => commentText += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} actualizado con tabla.` });
    } else {
      // Para el adjunto usamos rowsForExport (con totales)
      const xlsxBlob = convertDataToXlsxBlob([headers, ...rowsForExport], "Reporte-Filtrado.xlsx");
      const attStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attStatus.status === 'SUCCESS') {
          commentText += "Se adjunta reporte detallado.";
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} actualizado con adjunto.` });
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, SNAPSHOTS_OPERATION_NAME);
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      } else {
          summaryReport.advertencias.push("Fallo al adjuntar.");
      }
    }
    buscarYCerrarTareaProgramada(SNAPSHOTS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
    return 'SUCCESS';
  // CASO 3: NUEVO TICKET
  } else {
    // Pasamos ambas listas: finalAlerts (para el texto) y rowsForExport (para el excel)
    const creationResult = analyzeSnapshotsVMs_CSV(message.getSubject(), attachment.getName(), headers, finalAlerts, rowsForExport, clientConfig, reasonsText);
   
    if (creationResult.status === 'SUCCESS') summaryReport.exitos.push(creationResult.detail);
    else if (creationResult.status === 'ERROR') summaryReport.errores.push(creationResult.detail);
   
    buscarYCerrarTareaProgramada(SNAPSHOTS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false, (typeof message !== 'undefined' && message) ? (message.getSubject().toLowerCase().includes('avs') || (message.getAttachments && message.getAttachments().some(a => a.getName().toLowerCase().includes('avs')))) : false);
    return creationResult.status;
  }
}
function analyzeSnapshotsVMs_CSV(emailSubject, attachmentName, headers, finalAlerts, rowsForExport, clientConfig, reasonsText) {
  const alertCount = finalAlerts.length;
  let summary, description, xlsxBlob = null;
  description = `Se detectaron ${alertCount} VMs con snapshots fuera del estándar permitido:\n${reasonsText}\n\n`;
  if (alertCount <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
    summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE;
    description += `|| ${headers.join(" || ")} ||\n`;
    // CORRECCIÓN: Aquí iteramos finalAlerts (solo las VMs con problemas)
    finalAlerts.forEach(rowData => {
      description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
    });
  } else {
    summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT;
    description += `Debido a la cantidad de registros (${alertCount}), se adjunta el reporte detallado.`;
    const newFileName = attachmentName.replace(/\.xlsx$|\.csv$/i, "") + "-FILTRADO.xlsx";
    // Aquí usamos rowsForExport (con el total) para el archivo adjunto
    xlsxBlob = convertDataToXlsxBlob([headers, ...rowsForExport], newFileName);
  }
 
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig, SNAPSHOTS_OPERATION_NAME);
}