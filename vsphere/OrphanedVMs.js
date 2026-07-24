/**
 * @fileoverview Lógica específica para procesar reportes de "Orphaned VMs".
 * Refactorizado utilizando la clase base MailProcessor.
 */

const ORPHANED_VMS_OPERATION_NAME = "Orphaned VMs"; 
const ORPHANED_VMS_EMAIL_SUBJECT = "Orphaned VMs"; 
const ORPHANED_VMS_FILENAME_MATCH = "Orphaned VMs"; 
const ORPHANED_VMS_TASK_NAME = "Orphaned VMs"; 
const ORPHANED_VMS_TICKET_SUMMARY = "Se detectaron Orphaned VMs"; 

class OrphanedVMsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: ORPHANED_VMS_OPERATION_NAME,
      emailSubject: ORPHANED_VMS_EMAIL_SUBJECT,
      attachmentMatch: ORPHANED_VMS_FILENAME_MATCH,
      scheduledTaskName: ORPHANED_VMS_TASK_NAME
    });
  }

  findAttachment(message) {
    const subjectLower = message.getSubject().toLowerCase();
    if (!subjectLower.includes(this.emailSubject.toLowerCase())) return null;

    let filesToEvaluate = [];
    const searchString = this.attachmentMatch.toLowerCase().trim();

    message.getAttachments().forEach(att => {
      const attNameLower = att.getName().toLowerCase();
      if (attNameLower.endsWith(".zip") || att.getContentType() === "application/zip") {
        try {
          const unzippedBlobs = Utilities.unzip(att.copyBlob());
          filesToEvaluate = filesToEvaluate.concat(unzippedBlobs);
        } catch(e) { }
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
      this.isV13 = false;
      return attachmentExcel;
    } else if (attachmentCsv) {
      this.isV13 = true;
      return attachmentCsv;
    }

    // Return dummy object so we can catch it in parseAttachment and close task
    return { isDummy: true, getName: () => "dummy" };
  }

  resolveClientConfig(config, senderEmail, attachment, message, summaryReport) {
    if (config) {
      config.tecnologia = "Veeam Backup & Replication";
      const isComafi = senderEmail.toLowerCase().includes("@comafi.com.ar"); 
      if (isComafi) config.requestParticipants = []; 
      config.isComafi = isComafi;
    }
    this.currentClientConfig = config;
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    if (attachment.isDummy) {
      if (!this.currentClientConfig.isComafi) {
        const closeResult = buscarYCerrarTareaProgramada(this.scheduledTaskName, this.currentClientConfig, false);
        if (closeResult && closeResult.status === 'SUCCESS') {
          summaryReport.tareasCerradas = (summaryReport.tareasCerradas || 0) + 1;
        }
      }
      return []; // Return empty so it triggers isDataEmpty and halts smoothly
    }
    
    try {
      if (this.isV13) {
        const csvString = attachment.getDataAsString();
        return parseCsvRobust(csvString);
      } else {
        return convertOrphanedExcelToData(attachment);
      }
    } catch (e) {
      summaryReport.errores.push({ error: `Fallo al leer el archivo ${this.isV13 ? 'CSV' : 'Excel'}.`, detalle: e.message });
      return null;
    }
  }

  processData(parsedData, clientConfig, summaryReport) {
    let filteredData;
    if (this.isV13) {
      filteredData = filterOrphanedVMsDataV13(parsedData, clientConfig.exceptions);
    } else {
      filteredData = filterOrphanedVMsData(parsedData, clientConfig.exceptions);
    }

    return { 
      headers: [], 
      finalAlerts: filteredData.rows, 
      rowsForExport: filteredData.rows, 
      reasonsText: filteredData.vmCount
    };
  }

  findExistingTicket(clientConfig) {
    if (clientConfig.isComafi) return null;
    return findTargetReportTicket(ORPHANED_VMS_TICKET_SUMMARY, clientConfig.jiraProjectKey);
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    if (existingTicketKey && !clientConfig.isComafi) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Anomalía resuelta.** El reporte actual no muestra Orphaned VMs pendientes.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    
    if (!clientConfig.isComafi) {
      const closeResult = buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      if (closeResult && closeResult.status === 'SUCCESS') {
        summaryReport.tareasCerradas = (summaryReport.tareasCerradas || 0) + 1;
      }
    }
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = reasonsText;
    
    const baseName = attachmentName.replace(/\.(xlsx|csv|zip)$/i, "");
    const newFileName = `${baseName} - FILTRADO.xlsx`;
    const xlsxBlob = generateStyledReportBlob(finalAlerts, newFileName, [], "VMs");
    
    if (existingTicketKey) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attachmentResult.status === 'SUCCESS') {
        const commentText = `🚨 **Atención:** Se detectaron **${alertCount}** Orphaned VMs en el último reporte. Ver adjunto actualizado.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Ticket existente <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> actualizado con evidencia.` });
        
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
        if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
          
        const closeResult = buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
        if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas = (summaryReport.tareasCerradas || 0) + 1;
        return { status: 'SUCCESS' };
      } else {
        summaryReport.advertencias.push(attachmentResult.detail);
        return { status: attachmentResult.status };
      }
    } else {
      const summary = ORPHANED_VMS_TICKET_SUMMARY;
      const description = `Se han detectado ${alertCount} Orphaned VMs (Máquinas presentes en archivos de backup pero que ya no existen en los jobs de respaldo).\n\nEsto implica consumo innecesario de almacenamiento. Ver adjunto para detalles.`;
      
      let creationResult;
      if (clientConfig.isComafi) {
        creationResult = createInternalTicketLocal(summary, description, xlsxBlob, clientConfig);
      } else {
        creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, ORPHANED_VMS_EMAIL_SUBJECT);
      }
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
        if (!clientConfig.isComafi) {
          const closeResult = buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
          if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas = (summaryReport.tareasCerradas || 0) + 1;
        }
      } else if (creationResult.status === 'ERROR') {
        summaryReport.errores.push(creationResult.detail);
      } else {
        summaryReport.advertencias.push(creationResult.detail);
      }
      return { status: creationResult.status };
    }
  }
}

function processOrphanedVMsEmails() {
  new OrphanedVMsProcessor().processEmails();
}

// --- FUNCIONES AUXILIARES (CONSERVADAS) ---
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
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/search/jql`;
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
    const response = fetchWithRetries(endpoint, options);
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
    const response = fetchWithRetries(JIRA_DOMAIN + "/rest/api/2/issue", options);
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      const data = JSON.parse(response.getContentText());
      if (attachmentBlob) addAttachmentToJiraTicket(data.key, attachmentBlob);
      return { status: 'SUCCESS', detail: { mensaje: `Se creó el ticket INTERNO <${JIRA_DOMAIN}/browse/${data.key}|${data.key}>.` } };
    } else {
      return { status: 'ERROR', detail: { error: `Error Jira: ${response.getContentText()}` } };
    }
  } catch (e) { return { status: 'ERROR', detail: { error: e.message } }; }
}
