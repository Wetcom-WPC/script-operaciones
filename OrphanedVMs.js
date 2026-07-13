/**
 * @fileoverview Lógica específica para procesar reportes de "Orphaned VMs".
 * Detecta VMs huérfanas en el reporte Excel (v12) o CSV "Details" (v13).
 * ACTUALIZADO: 
 * 1. COMPATIBILIDAD V13: Procesa automáticamente CSV mapeando "Workload Name" a "VMs".
 * 2. Filtra secciones completas de "Backup to tape".
 * 3. APLICA ESTILO: Usa la función compartida generateStyledReportBlob (Siempre saca Excel).
 * 4. SOLUCIÓN TICKETS: Escribe en el ticket de incidente (Verde) ignorando Tareas Programadas.
 * 5. CORRECCIÓN EXCEPCIONES: Usa isRowExcepted de FuncionesCompartidas.
 * 6. SOPORTE ZIP Y CIERRE TEMPRANO: Descomprime dinámicamente reportes (Appliance Linux) y cierra Tareas en Jira si el ZIP está vacío.
 * * REQUIERE: Servicio "Drive API" activado (v3).
 */

// --- CONFIGURACIÓN ESPECÍFICA DE LA TAREA ---
const ORPHANED_VMS_OPERATION_NAME = "Orphaned VMs"; 

// Variables de búsqueda
const ORPHANED_VMS_EMAIL_SUBJECT = "Orphaned VMs"; 
const ORPHANED_VMS_FILENAME_MATCH = "Orphaned VMs"; 
const ORPHANED_VMS_TASK_NAME = "Orphaned VMs"; 
const ORPHANED_VMS_TICKET_SUMMARY = "Se detectaron Orphaned VMs"; 

// --- FUNCIÓN PRINCIPAL (TRIGGER) ---

function processOrphanedVMsEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  
  const searchQuery = construirBusquedaGmail(ORPHANED_VMS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);

  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleOrphanedVMsMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500') {
             thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: `Error Crítico en Script ${ORPHANED_VMS_OPERATION_NAME}: ${e.message}`, detalle: `Stack: ${e.stack}` });
        }
      }
    });
  }
  
  enviarResumenSlack(ORPHANED_VMS_OPERATION_NAME, summaryReport);
}


// --- LÓGICA DE PROCESAMIENTO ---

function processSingleOrphanedVMsMessage(message, summaryReport) {
  Logger.log(`--- Iniciando procesamiento para [${ORPHANED_VMS_OPERATION_NAME}] del correo: "${message.getSubject()}" ---`);
  
  const subjectLower = message.getSubject().toLowerCase();
  const requiredSubjectPart = ORPHANED_VMS_EMAIL_SUBJECT.toLowerCase();

  if (!subjectLower.includes(requiredSubjectPart)) {
    Logger.log(`El asunto "${message.getSubject()}" no contiene la frase requerida "${ORPHANED_VMS_EMAIL_SUBJECT}". Se omite.`);
    return 'SUCCESS'; 
  }

  const senderEmail = message.getFrom();
  const searchString = ORPHANED_VMS_FILENAME_MATCH.toLowerCase().trim();

  // --- CONFIGURACIÓN ESPECIAL PARA COMAFI ---
  const isComafi = senderEmail.toLowerCase().includes("@comafi.com.ar"); 
  if (isComafi) {
    Logger.log("MODO COMAFI DETECTADO: Ticket interno forzado (Tarea A Demanda).");
  }

  // --- 1. CONFIGURACIÓN DEL CLIENTE (Movido arriba para el cierre temprano) ---
  const clientConfig = getClientConfig(senderEmail, ORPHANED_VMS_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Remitente: ${senderEmail}` });
    return 'FAILURE';
  }
  clientConfig.tecnologia = "Veeam Backup & Replication"; // Siempre Veeam
  if (isComafi) clientConfig.requestParticipants = []; 

  // --- 2. LÓGICA DE DETECCIÓN DUAL Y ZIP ---
  let attachmentToUse = null;
  let isV13 = false;
  let filesToEvaluate = [];

  message.getAttachments().forEach(att => {
    const attNameLower = att.getName().toLowerCase();
    if (attNameLower.endsWith(".zip") || att.getContentType() === "application/zip") {
      try {
        const unzippedBlobs = Utilities.unzip(att.copyBlob());
        filesToEvaluate = filesToEvaluate.concat(unzippedBlobs);
        Logger.log(`Archivo ZIP detectado y descomprimido: ${att.getName()}`);
      } catch(e) {
        Logger.log(`Error al descomprimir ${att.getName()}: ${e.message}`);
      }
    } else {
      filesToEvaluate.push(att.copyBlob());
    }
  });

  const attachmentExcel = filesToEvaluate.find(blob => {
    const name = blob.getName().toLowerCase();
    return name.includes(searchString) && name.endsWith(".xlsx");
  });

  const attachmentCsv = filesToEvaluate.find(blob => {
    const name = blob.getName().toLowerCase();
    return name.includes("details") && name.endsWith(".csv");
  });

  if (attachmentExcel) {
    attachmentToUse = attachmentExcel;
    Logger.log("MODO V12 DETECTADO: Procesando Excel Clásico.");
  } else if (attachmentCsv) {
    attachmentToUse = attachmentCsv;
    isV13 = true;
    Logger.log("MODO V13 DETECTADO: Procesando CSV 'Details'.");
  }

  // --- 3. ESCAPE TEMPRANO CON CIERRE DE TAREA ---
  if (!attachmentToUse) {
    Logger.log(`No se encontró un adjunto válido (Ni Excel V12, ni CSV V13). Cerrando Tarea Programada por reporte vacío.`);
    if (!isComafi) {
      const closeResult = buscarYCerrarTareaProgramada(ORPHANED_VMS_TASK_NAME, clientConfig, false);
      if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return 'SUCCESS'; 
  }

  // --- 4. LECTURA Y FILTRADO DE DATOS ---
  let rawRows = [];
  try {
    if (isV13) {
      const csvString = attachmentToUse.getDataAsString();
      rawRows = Utilities.parseCsv(csvString);
    } else {
      rawRows = convertOrphanedExcelToData(attachmentToUse);
    }
  } catch (e) {
    summaryReport.errores.push({ error: `Fallo al leer el archivo ${isV13 ? 'CSV' : 'Excel'}.`, detalle: e.message });
    return 'FAILURE';
  }
  
  let filteredData;
  if (isV13) {
    filteredData = filterOrphanedVMsDataV13(rawRows, clientConfig.exceptions);
  } else {
    filteredData = filterOrphanedVMsData(rawRows, clientConfig.exceptions);
  }

  const finalAlerts = filteredData.rows; 
  const alertCount = filteredData.vmCount; 

  // --- 5. GESTIÓN DE TICKETS ---
  let existingTicketKey = null;
  if (!isComafi) {
    existingTicketKey = findTargetReportTicket(ORPHANED_VMS_TICKET_SUMMARY, clientConfig.jiraProjectKey);
  }

  if (alertCount === 0) {
    if (existingTicketKey && !isComafi) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Anomalía resuelta.** El reporte actual no muestra Orphaned VMs pendientes.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    
    if (!isComafi) {
      const closeResult = buscarYCerrarTareaProgramada(ORPHANED_VMS_TASK_NAME, clientConfig, false);
      if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    }
    return 'SUCCESS';

  } else {
    const baseName = attachmentToUse.getName().replace(/\.(xlsx|csv)$/i, "");
    const newFileName = `${baseName} - FILTRADO.xlsx`;
    const xlsxBlob = generateStyledReportBlob(finalAlerts, newFileName, [], "VMs");
    
    if (existingTicketKey) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attachmentResult.status === 'SUCCESS') {
        const commentText = `🚨 **Atención:** Se detectaron **${alertCount}** Orphaned VMs en el último reporte. Ver adjunto actualizado.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Ticket existente <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> actualizado con evidencia.` });
        
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, ORPHANED_VMS_OPERATION_NAME); 
        if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
          
        const closeResult = buscarYCerrarTareaProgramada(ORPHANED_VMS_TASK_NAME, clientConfig, false);
        if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
        return 'SUCCESS';
      } else {
        summaryReport.advertencias.push(attachmentResult.detail);
        return attachmentResult.status;
      }
    } else {
      const summary = ORPHANED_VMS_TICKET_SUMMARY;
      const description = `Se han detectado ${alertCount} Orphaned VMs (Máquinas presentes en archivos de backup pero que ya no existen en los jobs de respaldo).\n\nEsto implica consumo innecesario de almacenamiento. Ver adjunto para detalles.`;
      
      let creationResult;
      if (isComafi) {
        creationResult = createInternalTicketLocal(summary, description, xlsxBlob, clientConfig);
      } else {
        creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, ORPHANED_VMS_EMAIL_SUBJECT);
      }
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
        if (!isComafi) {
          const closeResult = buscarYCerrarTareaProgramada(ORPHANED_VMS_TASK_NAME, clientConfig, false);
          if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
        }
      } else if (creationResult.status === 'ERROR') {
        summaryReport.errores.push(creationResult.detail);
      } else {
        summaryReport.advertencias.push(creationResult.detail);
      }
      return creationResult.status;
    }
  }
}

function filterOrphanedVMsDataV13(allRows, exceptions) {
  const resultRows = [];
  let vmCount = 0;
  let COL_WORKLOAD = -1, COL_RESTORE = -1, COL_LOCATION = -1, COL_DATE = -1, COL_DELETED = -1, COL_PROTECTION = -1;
  let headerFound = false;
  let startIndex = 0;

  for (let i = 0; i < allRows.length; i++) {
    const rowString = allRows[i].join(" ").toLowerCase();
    if (rowString.includes("workload name") && rowString.includes("restore points")) {
      const header = allRows[i];
      for (let c = 0; c < header.length; c++) {
        const val = header[c].toString().toLowerCase().trim();
        if (val === "workload name") COL_WORKLOAD = c;
        else if (val === "restore points") COL_RESTORE = c;
        else if (val === "backup location") COL_LOCATION = c;
        else if (val === "last backup date") COL_DATE = c;
        else if (val.includes("deleted at")) COL_DELETED = c;
        else if (val === "type of protection") COL_PROTECTION = c;
      }
      startIndex = i + 1;
      headerFound = true;
      break;
    }
  }

  if (!headerFound || COL_WORKLOAD === -1) return { rows: [], vmCount: 0 };

  const outputHeader = ["VMs", "Restore Points", "Backup Location", "Last Backup Date", "Backup Will Be Deleted at..."];
  resultRows.push(outputHeader);
  let normalizedHeaders = outputHeader.map(h => normalizarEncabezado(h));

  for (let i = startIndex; i < allRows.length; i++) {
    const row = allRows[i];
    const vmName = (row[COL_WORKLOAD] || "").toString().trim();
    if (vmName === "") continue;

    const protectionType = (row[COL_PROTECTION] || "").toString().toLowerCase();
    if (protectionType.includes("backup to tape")) continue;

    const mappedRow = [
      row[COL_WORKLOAD] || "",
      row[COL_RESTORE] || "",
      row[COL_LOCATION] || "",
      row[COL_DATE] || "",
      row[COL_DELETED] || ""
    ];

    if (!isRowExcepted(mappedRow, normalizedHeaders, exceptions)) {
      resultRows.push(mappedRow);
      vmCount++; 
    }
  }
  return { rows: resultRows, vmCount: vmCount };
}

function filterOrphanedVMsData(allRows, exceptions) {
  const resultRows = [];
  let currentHeader = [];
  let normalizedHeaders = []; 
  let vmCount = 0;
  let COL_IDX_VM = -1;
  let COL_IDX_RESTORE_POINTS = -1;
  let headerFound = false;
  let startIndex = 0;

  for (let i = 0; i < allRows.length; i++) {
    const rowString = allRows[i].join(" ").toLowerCase();
    if (rowString.includes("vms") && rowString.includes("restore points")) {
      currentHeader = allRows[i];
      resultRows.push(currentHeader);
      normalizedHeaders = currentHeader.map(h => normalizarEncabezado(h));
      startIndex = i + 1;
      headerFound = true;
      for (let c = 0; c < currentHeader.length; c++) {
        const val = currentHeader[c].toString().toLowerCase().trim();
        if (val === "vms") COL_IDX_VM = c;
        else if (val.includes("restore points")) COL_IDX_RESTORE_POINTS = c;
      }
      break;
    }
  }

  if (!headerFound || COL_IDX_VM === -1) return { rows: [], vmCount: 0 };

  let skipCurrentSection = false; 
  for (let i = startIndex; i < allRows.length; i++) {
    const row = allRows[i];
    const vmName = (row[COL_IDX_VM] || "").toString().trim();
    const vmNameLower = vmName.toLowerCase();
    if (vmName === "") continue;
    
    if (vmNameLower.includes("type of protection")) {
        skipCurrentSection = vmNameLower.includes("backup to tape");
        continue;
    }
    if (skipCurrentSection) continue;

    if (!isRowExcepted(row, normalizedHeaders, exceptions)) {
      resultRows.push(row);
      vmCount++; 
    }
  }
  return { rows: resultRows, vmCount: vmCount };
}

function convertOrphanedExcelToData(blob) {
  let tempFileId;
  try {
    const resource = { name: "[TEMP] " + blob.getName(), mimeType: MimeType.GOOGLE_SHEETS };
    const tempFile = Drive.Files.create(resource, blob);
    tempFileId = tempFile.id;
    Utilities.sleep(2000);
    const spreadsheet = SpreadsheetApp.openById(tempFileId);
    return spreadsheet.getSheets()[0].getDataRange().getDisplayValues(); 
  } catch (e) {
    Logger.log("Error convirtiendo Excel: " + e.message);
    throw e;
  } finally {
    if (tempFileId) {
      try { Drive.Files.update({trashed: true}, tempFileId); } catch (e) {}
    }
  }
}

function findTargetReportTicket(summary, projectKey) {
  const endpoint = `https://wetcom.atlassian.net/rest/api/3/search/jql`;
  let jql = `summary ~ "${summary.replace(/"/g, '\\"')}" AND statusCategory != "Done"`;
  if (projectKey) jql += ` AND project = "${projectKey}"`;
  jql += ` AND issuetype != "Tarea Programada" ORDER BY created DESC`;
  
  const payload = { "jql": jql, "maxResults": 1, "fields": ["key"] };
  const options = {
    "method": "post", "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  };
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      if (data.issues && data.issues.length > 0) return data.issues[0].key;
    }
    return null;
  } catch (e) { return null; }
}

function createInternalTicketLocal(summary, description, attachmentBlob, clientConfig) {
  const ORIGEN_FIELD_ID = "customfield_12305"; 
  const TECNOLOGIA_FIELD_ID = "customfield_12316";
  const DUEDATE_FIELD_ID = "duedate"; 
  
  const today = new Date();
  today.setDate(today.getDate() + 7);
  const dueDateString = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");

  const payload = {
    "fields": {
      "project": { "key": clientConfig.jiraProjectKey },
      "summary": summary,
      "description": description,
      "issuetype": { "name": "Tarea A Demanda" }, 
      [DUEDATE_FIELD_ID]: dueDateString, 
      [TECNOLOGIA_FIELD_ID]: { "value": clientConfig.tecnologia }
    }
  };
  if (clientConfig.origen) payload.fields[ORIGEN_FIELD_ID] = { "value": clientConfig.origen };

  const options = {
    "method": "post", "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch("https://wetcom.atlassian.net/rest/api/2/issue", options);
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      const data = JSON.parse(response.getContentText());
      if (attachmentBlob) addAttachmentToJiraTicket(data.key, attachmentBlob);
      return { status: 'SUCCESS', detail: { mensaje: `Se creó el ticket INTERNO <https://wetcom.atlassian.net/browse/${data.key}|${data.key}>.` } };
    } else {
      return { status: 'ERROR', detail: { error: `Error Jira: ${response.getContentText()}` } };
    }
  } catch (e) { return { status: 'ERROR', detail: { error: e.message } }; }
}