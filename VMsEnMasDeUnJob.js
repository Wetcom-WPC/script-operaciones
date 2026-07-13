/**
 * @fileoverview Lógica específica para procesar reportes de "VMs en más de un Job" (Formato Excel y V13 CSV).
 * Traduce la lógica de PowerShell para filtrar bloques de VMs con 2 o más jobs "Daily" o "Weekly".
 * APLICA ESTILO AVANZADO: Usa la función compartida generateStyledReportBlob.
 * SOLUCIÓN DE TICKETS: Excluye explícitamente el tipo "Tarea Programada" al buscar dónde adjuntar.
 * CORRECCIÓN EXCEPCIONES: Filtra individualmente los Jobs hijos antes de validar la condición de duplicidad.
 * MISMO DÍA: Solo alerta si 2+ jobs Daily/Weekly tienen su última ejecución el mismo día calendario.
 * SOPORTE V13/ZIP Y CIERRE TEMPRANO: Descomprime dinámicamente reportes, procesa CSVs planos y cierra tareas en Jira en ZIPs vacíos.
 * REQUIERE: Servicio "Drive API" activado (v3).
 */

// --- CONFIGURACIÓN ESPECÍFICA DE LA TAREA ---
const VMS_EN_MAS_DE_UN_JOB_OPERATION_NAME = "VMs en mas de un Job"; 
const VMS_EN_MAS_DE_UN_JOB_EMAIL_SUBJECT = "VMs en mas de un Job"; 
const VMS_EN_MAS_DE_UN_JOB_FILENAME_MATCH = "VMs en mas de un Job"; 
const VMS_EN_MAS_DE_UN_JOB_TASK_NAME = "VMs en mas de un Job"; 
const VMS_EN_MAS_DE_UN_JOB_TICKET_SUMMARY = "Se detectaron VMs en mas de un Job"; 

// --- FUNCIÓN PRINCIPAL (TRIGGER) ---

function processDuplicateJobEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  
  const searchQuery = construirBusquedaGmail(VMS_EN_MAS_DE_UN_JOB_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);

  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleDuplicateJobMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500') {
             thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: `Error Crítico en Script ${VMS_EN_MAS_DE_UN_JOB_OPERATION_NAME}: ${e.message}`, detalle: `Stack: ${e.stack}` });
        }
      }
    });
  }
  enviarResumenSlack(VMS_EN_MAS_DE_UN_JOB_OPERATION_NAME, summaryReport);
}

// --- LÓGICA DE PROCESAMIENTO Y FILTRADO ---

function processSingleDuplicateJobMessage(message, summaryReport) {
  Logger.log(`--- Iniciando procesamiento para [${VMS_EN_MAS_DE_UN_JOB_OPERATION_NAME}] del correo: "${message.getSubject()}" ---`);
  
  const subjectLower = message.getSubject().toLowerCase();
  const requiredSubjectPart = VMS_EN_MAS_DE_UN_JOB_EMAIL_SUBJECT.toLowerCase();

  if (!subjectLower.includes(requiredSubjectPart)) {
    Logger.log(`El asunto no contiene la frase requerida "${VMS_EN_MAS_DE_UN_JOB_EMAIL_SUBJECT}". Se omite.`);
    return 'SUCCESS'; 
  }

  const senderEmail = message.getFrom();
  const searchString = VMS_EN_MAS_DE_UN_JOB_FILENAME_MATCH.toLowerCase().trim();

  // --- 1. CONFIGURACIÓN DEL CLIENTE (Movido arriba) ---
  const clientConfig = getClientConfig(senderEmail, VMS_EN_MAS_DE_UN_JOB_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Remitente: ${senderEmail}` });
    return 'FAILURE';
  }
  clientConfig.tecnologia = "Veeam Backup & Replication"; 

  // --- 2. SOPORTE ZIP Y DUALIDAD V12/V13 ---
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
    Logger.log(`No se encontró un adjunto válido. Cerrando Tarea Programada por reporte vacío.`);
    const closeResult = buscarYCerrarTareaProgramada(VMS_EN_MAS_DE_UN_JOB_TASK_NAME, clientConfig, false);
    if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS'; 
  }

  // --- 4. LECTURA Y FILTRADO ---
  let rawRows = [];
  try {
    if (isV13) {
      const csvString = attachmentToUse.getDataAsString();
      rawRows = Utilities.parseCsv(csvString);
    } else {
      rawRows = convertExcelBlobToData(attachmentToUse);
    }
  } catch (e) {
    summaryReport.errores.push({ error: `Fallo al leer el archivo.`, detalle: e.message });
    return 'FAILURE';
  }
  
  let filteredData;
  if (isV13) {
    filteredData = filterVMsWithMultipleDailyJobsV13(rawRows, clientConfig.exceptions);
  } else {
    filteredData = filterVMsWithMultipleDailyJobsFlattened(rawRows, clientConfig.exceptions);
  }
  
  const finalAlerts = filteredData.rows; 
  const alertCount = filteredData.vmCount; 

  // --- 5. GESTIÓN DE TICKETS ---
  const existingTicketKey = findTargetReportTicket(VMS_EN_MAS_DE_UN_JOB_TICKET_SUMMARY, clientConfig.jiraProjectKey);

  if (alertCount === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Anomalía resuelta.** El reporte actual no muestra VMs con jobs duplicados corriendo el mismo día.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    
    const closeResult = buscarYCerrarTareaProgramada(VMS_EN_MAS_DE_UN_JOB_TASK_NAME, clientConfig, false);
    if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';

  } else {
    const baseName = attachmentToUse.getName().replace(/\.(xlsx|csv)$/i, "");
    const newFileName = `${baseName} - FILTRADO.xlsx`;
    const columnsToIgnore = ["Average VM Processing Time", "Average VM Transferred Data(GB)"];
    const xlsxBlob = generateStyledReportBlob(finalAlerts, newFileName, columnsToIgnore, "Virtual Machine");
    
    if (existingTicketKey) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attachmentResult.status === 'SUCCESS') {
        const commentText = `🚨 **El problema persiste.** Se detectaron **${alertCount}** VMs con jobs duplicados corriendo el mismo día. Ver adjunto actualizado.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Ticket existente <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> actualizado.` });
        
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, VMS_EN_MAS_DE_UN_JOB_OPERATION_NAME); 
        if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
        
        const closeResult = buscarYCerrarTareaProgramada(VMS_EN_MAS_DE_UN_JOB_TASK_NAME, clientConfig, false);
        if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
        return 'SUCCESS';
      } else {
        summaryReport.advertencias.push(attachmentResult.detail);
        return attachmentResult.status;
      }
    } else {
      const summary = VMS_EN_MAS_DE_UN_JOB_TICKET_SUMMARY;
      const description = `Se han detectado ${alertCount} VMs que están siendo respaldadas por más de un Job en esquema 'Daily' o 'Weekly' corriendo el mismo día, duplicando consumo.\n\nSe adjunta reporte filtrado.`;
      
      const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, VMS_EN_MAS_DE_UN_JOB_OPERATION_NAME);
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
        const closeResult = buscarYCerrarTareaProgramada(VMS_EN_MAS_DE_UN_JOB_TASK_NAME, clientConfig, false);
        if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      } else if (creationResult.status === 'ERROR') {
        summaryReport.errores.push(creationResult.detail);
      } else {
        summaryReport.advertencias.push(creationResult.detail);
      }
      return creationResult.status;
    }
  }
}

function filterVMsWithMultipleDailyJobsV13(allRows, exceptions) {
  const resultRows = [];
  let vmCount = 0;
  let COL_VM = -1, COL_JOB = -1, COL_SCHEDULE = -1, COL_LAST_RUN = -1;
  let headerFound = false;
  let startIndex = 0;

  for (let i = 0; i < allRows.length; i++) {
    const rowString = allRows[i].join(" ").toLowerCase();
    if ((rowString.includes("virtual machine") || rowString.includes("workload name")) &&
        (rowString.includes("backup job") || rowString.includes("job name"))) {
      const header = allRows[i];
      for (let c = 0; c < header.length; c++) {
        const cellVal = header[c].toString().toLowerCase().trim();
        if (cellVal === "virtual machine" || cellVal === "workload name") COL_VM = c;
        else if (cellVal === "backup job" || cellVal === "job name") COL_JOB = c;
        else if (cellVal.includes("schedule")) COL_SCHEDULE = c;
        else if (cellVal.includes("last run") || cellVal.includes("last execution") || cellVal.includes("last backup") || cellVal.includes("latest job run")) COL_LAST_RUN = c;
      }
      startIndex = i + 1;
      headerFound = true;
      break;
    }
  }

  if (!headerFound || COL_VM === -1 || COL_JOB === -1) return { rows: [], vmCount: 0 };

  const outputHeader = ["Virtual Machine", "Backup Job", "Job Schedule", "Last Run"];
  resultRows.push(outputHeader);

  const vmGroups = {};
  for (let i = startIndex; i < allRows.length; i++) {
    const row = allRows[i];
    const vmName = (row[COL_VM] || "").toString().trim();
    const jobName = (row[COL_JOB] || "").toString().trim();
    if (vmName === "" || jobName === "") continue;

    const mappedRow = [
      vmName,
      jobName,
      COL_SCHEDULE !== -1 ? (row[COL_SCHEDULE] || "") : "",
      COL_LAST_RUN !== -1 ? (row[COL_LAST_RUN] || "") : ""
    ];
    if (!vmGroups[vmName]) vmGroups[vmName] = [];
    vmGroups[vmName].push(mappedRow);
  }

  for (const vmName in vmGroups) {
    const groupRows = vmGroups[vmName];
    const validJobRows = groupRows.filter(row => !isRowExcepted(row, outputHeader, exceptions));
    
    const dailyDateCount = {};
    const weeklyDateCount = {};

    validJobRows.forEach(jRow => {
      const schedule = (jRow[2] || "").toString().trim().toLowerCase();
      if (schedule !== "daily" && schedule !== "weekly") return;

      const rawDate = (jRow[3] || "").toString().trim();
      let dateKey = "__sin_fecha__";
      if (rawDate !== "") {
        const d = new Date(rawDate);
        if (!isNaN(d.getTime())) dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      }
      if (schedule === "daily") dailyDateCount[dateKey] = (dailyDateCount[dateKey] || 0) + 1;
      else weeklyDateCount[dateKey] = (weeklyDateCount[dateKey] || 0) + 1;
    });

    const hasDailyDuplicate = Object.values(dailyDateCount).some(count => count >= 2);
    const hasWeeklyDuplicate = Object.values(weeklyDateCount).some(count => count >= 2);
    
    if (hasDailyDuplicate || hasWeeklyDuplicate) {
      validJobRows.forEach(row => resultRows.push(row));
      vmCount++;
    }
  }
  return { rows: resultRows, vmCount: vmCount };
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

function convertExcelBlobToData(blob) {
  let tempFileId;
  try {
    const resource = { name: "[TEMP] " + blob.getName(), mimeType: MimeType.GOOGLE_SHEETS };
    const tempFile = Drive.Files.create(resource, blob);
    tempFileId = tempFile.id;
    Utilities.sleep(2000);

    const spreadsheet = SpreadsheetApp.openById(tempFileId);
    let sheet = spreadsheet.getSheetByName("Sheet2") || spreadsheet.getSheets()[0];
    return sheet.getDataRange().getDisplayValues(); 
  } catch (e) {
    Logger.log("Error convirtiendo Excel: " + e.message);
    throw e;
  } finally {
    if (tempFileId) {
      try { Drive.Files.update({trashed: true}, tempFileId); } catch (e) {}
    }
  }
}

function filterVMsWithMultipleDailyJobsFlattened(allRows, exceptions) {
  const resultRows = [];
  let currentHeader = [];
  let vmCount = 0;
  let headerFound = false;
  let currentBlock = { vmRow: null, jobRows: [], kept: false };
  let COL_IDX_VM = -1, COL_IDX_JOB_NAME = -1, COL_IDX_SCHEDULE = -1, COL_IDX_LAST_RUN = -1;
  let startIndex = 0;
  
  for (let i = 0; i < allRows.length; i++) {
    const rowString = allRows[i].join(" ").toLowerCase();
    if (rowString.includes("virtual machine") && rowString.includes("backup job")) {
      currentHeader = allRows[i];
      startIndex = i + 1;
      headerFound = true;
      for (let c = 0; c < currentHeader.length; c++) {
        const cellVal = currentHeader[c].toString().toLowerCase().trim();
        if (cellVal.includes("virtual machine")) COL_IDX_VM = c;
        else if (cellVal.includes("backup job")) COL_IDX_JOB_NAME = c;
        else if (cellVal.includes("job schedule")) COL_IDX_SCHEDULE = c;
        else if (cellVal.includes("last run") || cellVal.includes("last execution") || cellVal.includes("last backup") || cellVal.includes("latest job run")) COL_IDX_LAST_RUN = c;
      }
      break;
    }
  }
  
  if (!headerFound || COL_IDX_VM === -1 || COL_IDX_JOB_NAME === -1) return { rows: [], vmCount: 0 };

  const headerForExceptions = currentHeader;
  resultRows.push(currentHeader);

  for (let i = startIndex; i < allRows.length; i++) {
    const row = allRows[i];
    const vmName = (row[COL_IDX_VM] || "").toString().trim();
    const jobName = (row[COL_IDX_JOB_NAME] || "").toString().trim();
    if (vmName === "" && jobName === "") continue;

    if (vmName !== "" && jobName === "") { 
      if (currentBlock.vmRow) {
        processBlockFlattened(currentBlock, resultRows, exceptions, COL_IDX_VM, COL_IDX_SCHEDULE, headerForExceptions, COL_IDX_LAST_RUN);
        if (currentBlock.kept) vmCount++;
      }
      currentBlock = { vmRow: row, jobRows: [], kept: false };
    } else if (vmName === "" && jobName !== "") { 
      if (currentBlock.vmRow) currentBlock.jobRows.push(row);
    }
  }
  
  if (currentBlock.vmRow) {
    processBlockFlattened(currentBlock, resultRows, exceptions, COL_IDX_VM, COL_IDX_SCHEDULE, headerForExceptions, COL_IDX_LAST_RUN);
    if (currentBlock.kept) vmCount++;
  }
  return { rows: resultRows, vmCount: vmCount };
}

function processBlockFlattened(block, resultRows, exceptions, colIdxVM, colIdxSchedule, headers, colIdxLastRun) {
  const validJobRows = block.jobRows.filter(childRow => {
    const hybridRow = [...childRow];
    hybridRow[colIdxVM] = block.vmRow[colIdxVM];
    return !isRowExcepted(hybridRow, headers, exceptions);
  });

  let isDuplicate = false;

  if (colIdxLastRun !== -1) {
    const dailyDateCount = {};
    const weeklyDateCount = {};

    validJobRows.forEach(jRow => {
      const schedule = (jRow[colIdxSchedule] || "").toString().trim().toLowerCase();
      if (schedule !== "daily" && schedule !== "weekly") return;

      const rawDate = (jRow[colIdxLastRun] || "").toString().trim();
      let dateKey = "__sin_fecha__"; 

      if (rawDate !== "") {
        const d = new Date(rawDate);
        if (!isNaN(d.getTime())) dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      }

      if (schedule === "daily") dailyDateCount[dateKey] = (dailyDateCount[dateKey] || 0) + 1;
      else weeklyDateCount[dateKey] = (weeklyDateCount[dateKey] || 0) + 1;
    });

    const hasDailyDuplicate = Object.values(dailyDateCount).some(count => count >= 2);
    const hasWeeklyDuplicate = Object.values(weeklyDateCount).some(count => count >= 2);
    isDuplicate = hasDailyDuplicate || hasWeeklyDuplicate;

  } else {
    let dailyCount = 0, weeklyCount = 0;
    validJobRows.forEach(jRow => {
      const schedule = (jRow[colIdxSchedule] || "").toString().trim().toLowerCase();
      if (schedule === "daily") dailyCount++;
      else if (schedule === "weekly") weeklyCount++;
    });
    isDuplicate = dailyCount >= 2 || weeklyCount >= 2;
  }

  if (isDuplicate) {
    const vmName = block.vmRow[colIdxVM];
    validJobRows.forEach(childRow => {
      const flattenedRow = [...childRow]; 
      flattenedRow[colIdxVM] = vmName;    
      resultRows.push(flattenedRow);      
    });
    block.kept = true;
  }
}