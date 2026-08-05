/**
 * @fileoverview Lógica específica para procesar reportes de "VMs con snapshots".
 * Refactorizado utilizando la clase base MailProcessor.
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

class VMsConSnapshotsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: SNAPSHOTS_OPERATION_NAME,
      emailSubject: SNAPSHOTS_EMAIL_SUBJECT,
      attachmentMatch: SNAPSHOTS_FILENAME_MATCH,
      scheduledTaskName: SNAPSHOTS_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    const fileNameUpper = attachment.getName().toUpperCase();
    const clientNameUpper = (config && config.clientName) ? config.clientName.toUpperCase() : "";
    
    const esBalanz = clientNameUpper.includes("BALANZ") || fileNameUpper.includes("BALANZ");
    const esMacro = clientNameUpper.includes("MACRO") || fileNameUpper.includes("MACRO");
    
    if (esBalanz && (!config || !config.clientName || !config.clientName.toUpperCase().includes("BALANZ"))) {
      config = getClientConfigByName("Operaciones BALANZ", this.operationName) || { clientName: "Operaciones BALANZ", jiraProjectKey: "OBC2", exceptions: [] };
    } else if (esMacro && (!config || !config.clientName || !config.clientName.toUpperCase().includes("MACRO"))) {
      config = getClientConfigByName("Operaciones Banco Macro", this.operationName) || { clientName: "Operaciones Banco Macro", jiraProjectKey: "OBM", exceptions: [] };
    } else if (!config || !config.clientName || config.clientName.toUpperCase().includes("DESCONOCIDO")) {
      return null;
    }
    return config;
  }

  processData(parsedData, clientConfig, summaryReport) {
    let summaryRow = [];
    if (parsedData.length > 1) {
      summaryRow = parsedData.pop(); // Sacamos la última fila (Total)
    }

    const headers = parsedData[0].map(h => h.trim());
    const reportRows = parsedData.slice(1);
    
    if (clientConfig && !clientConfig.exceptions) clientConfig.exceptions = [];

    const findCol = (namePart) => headers.findIndex(h => h.toLowerCase().includes(namePart.toLowerCase()));
    
    let idxName = findCol("Name");
    let idxAge = findCol("Number_Days_Old") !== -1 ? findCol("Number_Days_Old") : findCol("Age");  
    let idxSpace = findCol("Snapshot_Space") !== -1 ? findCol("Snapshot_Space") : findCol("Space");
    let idxCount = findCol("Number_Snapshots") !== -1 ? findCol("Number_Snapshots") : findCol("Cantidad");
    
    let idxTotalCapacity = findCol("Total_Capacity") !== -1 ? findCol("Total_Capacity") : findCol("Total Capacity");
    if (idxTotalCapacity === -1) idxTotalCapacity = findCol("Summary|Datastore(s)");
    if (idxTotalCapacity === -1) idxTotalCapacity = findCol("Capacity");
    if (idxTotalCapacity === -1) idxTotalCapacity = findCol("Total");

    if (idxName === -1 || idxAge === -1 || idxSpace === -1 || idxCount === -1) {
      summaryReport.errores.push({ error: "Faltan columnas clave." });
      return null;
    }
    
    headers[idxName] = "Name";
    if (!headers.includes("Used Space %")) {
      headers.push("Used Space %");
    }
    
    const parseSeguro = (val) => {
      if (!val) return 0;
      let clean = val.toString().trim();
      if (clean.includes('.') && clean.includes(',')) clean = clean.replace(/\./g, '');
      clean = clean.replace(',', '.');
      return parseFloat(clean) || 0;
    };

    const detectedReasonsOps = new Set();
    const detectedReasonsSoporte = new Set();
    const opsAlerts = [];
    const soporteAlerts = [];

    const sopRules = getSopRules(clientConfig.exceptionFileId);

    reportRows.forEach(row => {
      if (row.length < idxAge || row.join('').trim() === '') return;
      
      const vmName = (row[idxName] || "").trim();
      if (vmName.toLowerCase().includes("replica")) return;
      
      const age = parseSeguro(row[idxAge]);
      const space = parseSeguro(row[idxSpace]);
      const count = parseSeguro(row[idxCount]);
      
      let usedPercent = 0;
      const totalCap = idxTotalCapacity !== -1 ? parseSeguro(row[idxTotalCapacity]) : 0;
      if (totalCap > 0) {
         usedPercent = (space / totalCap) * 100;
      }
      row.push(usedPercent > 0 ? usedPercent.toFixed(2) + "%" : "N/A");
      
      if (isRowExcepted(row, headers, clientConfig.exceptions)) return;

      const matchedRule = typeof findMatchingSopRule === 'function' ? findMatchingSopRule(row, headers, sopRules) : null;
      
      if (matchedRule) {
         let sizeLimit = matchedRule.size > 0 ? matchedRule.size : Infinity;
         let ageLimit = matchedRule.age > 0 ? matchedRule.age : Infinity;
         let qtyLimit = matchedRule.qty > 0 ? matchedRule.qty : Infinity;
         
         let rowBreaksRule = false;
         if (age >= ageLimit) { detectedReasonsSoporte.add(`Antigüedad >= ${ageLimit} días`); rowBreaksRule = true; }
         if (count >= qtyLimit) { detectedReasonsSoporte.add(`Cantidad >= ${qtyLimit}`); rowBreaksRule = true; }
         
         if (matchedRule.sizeType === 'relativo') {
            if (usedPercent >= sizeLimit && sizeLimit !== Infinity) {
               detectedReasonsSoporte.add(`Tamaño Relativo >= ${sizeLimit}%`); 
               rowBreaksRule = true;
            }
         } else {
            if (space >= sizeLimit && sizeLimit !== Infinity) {
               detectedReasonsSoporte.add(`Tamaño Absoluto >= ${sizeLimit} GB`); 
               rowBreaksRule = true;
            }
         }
         if (rowBreaksRule) soporteAlerts.push(row);
      } else {
         let rowBreaksRule = false;
         if (age >= AGE_MAX) { detectedReasonsOps.add(`Antigüedad >= ${AGE_MAX} días`); rowBreaksRule = true; }
         if (space >= SIZE_MAX) { detectedReasonsOps.add(`Tamaño >= ${SIZE_MAX} GB`); rowBreaksRule = true; }
         if (count >= CANTIDAD_MAX) { detectedReasonsOps.add(`Cantidad >= ${CANTIDAD_MAX}`); rowBreaksRule = true; }
         
         if (rowBreaksRule) opsAlerts.push(row);
      }
    });

    const opsReasonsText = Array.from(detectedReasonsOps).map(r => `* ${r}`).join('\n');
    const soporteReasonsText = Array.from(detectedReasonsSoporte).map(r => `* ${r}`).join('\n');
    
    this.opsAlerts = opsAlerts;
    this.soporteAlerts = soporteAlerts;
    this.opsReasonsText = opsReasonsText;
    this.soporteReasonsText = soporteReasonsText;
    
    // Devolvemos la unión de ambas para que la clase base detecte si hubo alertas en total.
    const finalAlerts = [...opsAlerts, ...soporteAlerts];
    const reasonsText = opsReasonsText + '\n' + soporteReasonsText;
    
    const rowsForExport = [...finalAlerts];
    if (summaryRow.length > 0) rowsForExport.push(summaryRow);

    return { headers, finalAlerts, rowsForExport, reasonsText };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) ||
           findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKeyIgnored, clientConfig_Ignored, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    let globalStatus = 'SUCCESS';
    let huboAlertaOps = false;
    let huboAlertaSop = false;
    let senderEmail = clientConfig_Ignored.senderEmail || "alarmas@wetcom.com"; // workaround para conseguir el email

    // PROCESAR OPS
    if (this.opsAlerts && this.opsAlerts.length > 0) {
      huboAlertaOps = true;
      const clientConfigOps = getClientConfigByName(clientConfig_Ignored.clientName, this.operationName) || clientConfig_Ignored;
      const existingTicketKeyOps = findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfigOps.jiraProjectKey) ||
                                   findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfigOps.jiraProjectKey);
                                   
      const rowsExp = [...this.opsAlerts];
      // Note: we'd append summaryRow if we had it, but we can just omit it for the split.
      
      if (existingTicketKeyOps) {
        if (!haSidoActualizadoHoy(existingTicketKeyOps, "ALERTA-SNAPSHOTS-OPS")) {
          let commentText = `🚨 **El problema persiste.** [HU-ALERTA-SNAPSHOTS-OPS]\n\nSe detectaron ${this.opsAlerts.length} VMs fuera de norma:\n${this.opsReasonsText}\n\n`;
          if (this.opsAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
            commentText += `|| ${headers.join(" || ")} ||\n`;
            this.opsAlerts.forEach(row => commentText += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
            addCommentToJiraTicket(existingTicketKeyOps, commentText);
            summaryReport.exitos.push({ mensaje: `Ticket OPS ${existingTicketKeyOps} actualizado con tabla.` });
          } else {
            const nombreReporte = attachmentName.replace(/\.csv$/i, "-Ops-FILTRADO.xlsx");
            const xlsxBlob = convertDataToXlsxBlob([headers, ...rowsExp], nombreReporte);
            if (xlsxBlob) {
              const attStatus = addAttachmentToJiraTicket(existingTicketKeyOps, xlsxBlob);
              if (attStatus.status === 'SUCCESS') {
                commentText += "Se adjunta reporte detallado.";
                addCommentToJiraTicket(existingTicketKeyOps, commentText);
                summaryReport.exitos.push({ mensaje: `Ticket OPS ${existingTicketKeyOps} actualizado con adjunto.` });
                const accountIdAsignado = chequearSiEsInformativa(clientConfigOps.clientName, this.operationName);
                if (accountIdAsignado) ticketInformativo(existingTicketKeyOps, accountIdAsignado);
              } else {
                summaryReport.advertencias.push("Fallo al adjuntar en Ops.");
                globalStatus = 'FAILURE';
              }
            } else {
              globalStatus = 'FAILURE';
            }
          }
        }
      } else {
        let summary, description, xlsxBlob = null;
        description = `Se detectaron ${this.opsAlerts.length} VMs con snapshots fuera del estándar (Ops):\n${this.opsReasonsText}\n\n`;
        if (this.opsAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
          summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE;
          description += `|| ${headers.join(" || ")} ||\n`;
          this.opsAlerts.forEach(row => description += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
        } else {
          summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT;
          description += `Debido a la cantidad de registros, se adjunta el reporte.`;
          const newFileName = attachmentName.replace(/\.xlsx$|\.csv$/i, "") + "-Ops-FILTRADO.xlsx";
          xlsxBlob = convertDataToXlsxBlob([headers, ...rowsExp], newFileName);
        }
        const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfigOps, this.operationName);
        if (creationResult.status === 'SUCCESS') summaryReport.exitos.push("Ops: " + creationResult.detail);
        else globalStatus = 'FAILURE';
      }
    }

    // PROCESAR SOPORTE
    if (this.soporteAlerts && this.soporteAlerts.length > 0) {
      huboAlertaSop = true;
      // Tratar de obtener el clientConfigSoporte (pasando true como 3er parámetro si getClientConfig lo soporta, o forzando datos manuales)
      let clientConfigSop = null;
      if (typeof getClientConfig === 'function') {
         clientConfigSop = getClientConfig("alarmas@wetcom.com", this.operationName, true);
      }
      if (!clientConfigSop) {
         // Fallback por si getClientConfig(..., true) no existe
         clientConfigSop = { ...clientConfig_Ignored, jiraProjectKey: "SOP", clientName: "Veeam Backup & Replication" }; 
      }
      
      const existingTicketKeySop = findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfigSop.jiraProjectKeySop) ||
                                   findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfigSop.jiraProjectKeySop);
                                   
      const rowsExp = [...this.soporteAlerts];
      
      if (existingTicketKeySop) {
        if (!haSidoActualizadoHoy(existingTicketKeySop, "ALERTA-SNAPSHOTS-SOP")) {
          let commentText = `🚨 **El problema persiste.** [HU-ALERTA-SNAPSHOTS-SOP]\n\nSe detectaron ${this.soporteAlerts.length} VMs fuera de norma:\n${this.soporteReasonsText}\n\n`;
          if (this.soporteAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
            commentText += `|| ${headers.join(" || ")} ||\n`;
            this.soporteAlerts.forEach(row => commentText += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
            addCommentToJiraTicket(existingTicketKeySop, commentText);
            summaryReport.exitos.push({ mensaje: `Ticket SOPORTE ${existingTicketKeySop} actualizado con tabla.` });
          } else {
            const nombreReporte = attachmentName.replace(/\.csv$/i, "-Soporte-FILTRADO.xlsx");
            const xlsxBlob = convertDataToXlsxBlob([headers, ...rowsExp], nombreReporte);
            if (xlsxBlob) {
              const attStatus = addAttachmentToJiraTicket(existingTicketKeySop, xlsxBlob);
              if (attStatus.status === 'SUCCESS') {
                commentText += "Se adjunta reporte detallado.";
                addCommentToJiraTicket(existingTicketKeySop, commentText);
                summaryReport.exitos.push({ mensaje: `Ticket SOPORTE ${existingTicketKeySop} actualizado con adjunto.` });
              } else {
                summaryReport.advertencias.push("Fallo al adjuntar en Soporte.");
                globalStatus = 'FAILURE';
              }
            } else {
              globalStatus = 'FAILURE';
            }
          }
        }
      } else {
        let summary, description, xlsxBlob = null;
        description = `Se detectaron ${this.soporteAlerts.length} VMs con snapshots fuera del estándar (Soporte):\n${this.soporteReasonsText}\n\n`;
        if (this.soporteAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
          summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE;
          description += `|| ${headers.join(" || ")} ||\n`;
          this.soporteAlerts.forEach(row => description += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
        } else {
          summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT;
          description += `Debido a la cantidad de registros, se adjunta el reporte.`;
          const newFileName = attachmentName.replace(/\.xlsx$|\.csv$/i, "") + "-Soporte-FILTRADO.xlsx";
          xlsxBlob = convertDataToXlsxBlob([headers, ...rowsExp], newFileName);
        }
        const creationResult = createTicketAndNotifySoporte(summary, description, xlsxBlob, clientConfigSop);
        if (creationResult.status === 'SUCCESS') summaryReport.exitos.push("Soporte: " + creationResult.detail);
        else globalStatus = 'FAILURE';
      }
    }

    if (globalStatus === 'SUCCESS' && this.scheduledTaskName) {
       buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig_Ignored, false);
    }
    return { status: globalStatus };
  }
}

function processSnapshotsEmails() {
  new VMsConSnapshotsProcessor().processEmails();
}// --- SOP RULES PARSING ---
function getSopRules(exceptionFileId) {
    if (!exceptionFileId) return [];
    try {
        const sopSheet = SpreadsheetApp.openById(exceptionFileId).getSheetByName("VMs con Snapshots SOP");
        if (!sopSheet) return [];
        const sopData = sopSheet.getDataRange().getValues();
        sopData.shift(); // remove headers
        
        const rules = [];
        sopData.forEach(row => {
            if (!row[0]) return; // Skip empty rows
            rules.push({
                idUmbral: (row[0] || "").toString().trim(),
                column: (row[1] || "").toString().trim(),
                matchType: (row[2] || "").toString().trim(),
                matchValue: (row[3] || "").toString().trim(),
                age: parseFloat(row[4]) || 0,
                size: parseFloat(row[5]) || 0,
                qty: parseFloat(row[6]) || 0,
                sizeType: (row[7] || "").toString().trim().toLowerCase() // absoluto o relativo
            });
        });
        return rules;
    } catch (e) {
        Logger.log("Error leyendo hoja SOP: " + e.message);
        return [];
    }
}

function findMatchingSopRule(row, headers, rules) {
    const normalizedHeaders = headers.map(h => {
        let n = h.trim().toLowerCase();
        n = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return n;
    });

    for (const rule of rules) {
        if (rule.matchType === '-') {
            // Regla fallback (UMBRAL_GLOBAL)
            return rule;
        }

        let nCol = rule.column.trim().toLowerCase();
        nCol = nCol.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const colIndex = normalizedHeaders.indexOf(nCol);
        
        if (colIndex !== -1) {
            const reportValueStr = (row[colIndex] || "").toString().trim().toLowerCase();
            const exceptionValue = rule.matchValue.toLowerCase();
            
            let matched = false;
            switch (rule.matchType.toLowerCase()) {
                case "exacta": matched = (reportValueStr === exceptionValue); break;
                case "contiene": matched = reportValueStr.includes(exceptionValue); break;
                case "empieza con": matched = reportValueStr.startsWith(exceptionValue); break;
                case "termina con": matched = reportValueStr.endsWith(exceptionValue); break;
            }
            if (matched) return rule;
        }
    }
    return null;
}


