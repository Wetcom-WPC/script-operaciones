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

const AGE_MAX = 7;      // Días (umbral Ops)
const SIZE_MAX = 300;   // GB   (umbral Ops)
const CANTIDAD_MAX = 3; // Unidades (umbral Ops)

// Umbrales globales de Soporte (buenas prácticas): se aplican a VMs que no matchean
// ninguna regla en la planilla SOP pero superan estos límites más graves.
const SOP_AGE_MAX = 14;     // Días
const SOP_SIZE_MAX = 1024;  // GB
const SOP_CANTIDAD_MAX = 7; // Unidades

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
    Logger.log("HEADERS ENCONTRADOS: " + JSON.stringify(headers));
    
    if (clientConfig && !clientConfig.exceptions) clientConfig.exceptions = [];
    Logger.log('[DEBUG EXCEPCIONES] Excepciones globales (Ops): ' + JSON.stringify(clientConfig.exceptions));
    Logger.log('[DEBUG EXCEPCIONES] Excepciones globales cargadas de la planilla: ' + JSON.stringify(clientConfig.exceptions));
    Logger.log('[DEBUG EXCEPCIONES] Excepciones globales cargadas de la planilla: ' + JSON.stringify(clientConfig.exceptions));

    const findCol = (namePart) => headers.findIndex(h => h.toLowerCase().includes(namePart.toLowerCase()));
    
    let idxName = findCol("Name");
    let idxAge = findCol("Number_Days_Old") !== -1 ? findCol("Number_Days_Old") : findCol("Age");  
    let idxSpace = findCol("Snapshot_Space") !== -1 ? findCol("Snapshot_Space") : findCol("Space");
    let idxCount = findCol("Number_Snapshots") !== -1 ? findCol("Number_Snapshots") : findCol("Cantidad");
    let idxSnapshotName = findCol("Snapshot_Name");
    
    let idxTotalCapacity = findCol("Total_Capacity") !== -1 ? findCol("Total_Capacity") : findCol("Total Capacity");
    if (idxTotalCapacity === -1) idxTotalCapacity = findCol("Summary|Datastore(s)");
    if (idxTotalCapacity === -1) idxTotalCapacity = findCol("Capacity");
    if (idxTotalCapacity === -1) idxTotalCapacity = findCol("Total");

    if (idxName === -1 || idxAge === -1 || idxSpace === -1 || idxCount === -1) {
      summaryReport.errores.push({ error: "Faltan columnas clave." });
      return null;
    }
    
    headers[idxName] = "Name";
    if (idxTotalCapacity !== -1 && !headers.includes("Used Space %")) {
      headers.push("Used Space %");
    }
    
    const parseSeguro = (val) => {
      if (!val) return 0;
      let clean = val.toString().trim();
      let lastDot = clean.lastIndexOf('.');
      let lastComma = clean.lastIndexOf(',');
      if (lastDot > lastComma) { clean = clean.replace(/,/g, ''); }
      else if (lastComma > lastDot) { clean = clean.replace(/\./g, '').replace(/,/g, '.'); }
      else { clean = clean.replace(/,/g, '.'); }
      return parseFloat(clean) || 0;
    };

    const parseSpaceToGB = (val) => {
      if (!val) return 0;
      let str = val.toString().trim().toUpperCase();
      let clean = str.replace(/[^\d.,-]/g, '').trim();
      let lastDot = clean.lastIndexOf('.');
      let lastComma = clean.lastIndexOf(',');
      if (lastDot > lastComma) { clean = clean.replace(/,/g, ''); }
      else if (lastComma > lastDot) { clean = clean.replace(/\./g, '').replace(/,/g, '.'); }
      else { clean = clean.replace(/,/g, '.'); }
      let num = parseFloat(clean) || 0;
      if (str.includes('TB')) return num * 1024;
      if (str.includes('MB')) return num / 1024;
      if (str.includes('KB')) return num / (1024 * 1024);
      return num; // defaults to GB if no unit or 'GB'
    };

    const detectedReasonsOps = new Set();
    const detectedReasonsSoporte = new Set();
    const opsAlerts = [];
    const soporteAlerts = [];

    // Las reglas de soporte vienen de la misma planilla de Excepciones (columnas AGE/SIZE/QTY/CRITERIO)
    let sopRules = {};
    if (typeof getClientConfig === "function") {
      const emailParaSoporte = (clientConfig && clientConfig.senderEmail) ? clientConfig.senderEmail : "alarmas@wetcom.com";
      const configSop = getClientConfig(emailParaSoporte, this.operationName + " SOP", true);
      if (configSop && configSop.exceptions) sopRules = configSop.exceptions;
    }

    reportRows.forEach(row => {
      if (row.length < idxAge || row.join('').trim() === '') return;
      
      const vmName = (row[idxName] || "").trim();
      if (vmName.toLowerCase().includes("replica")) return;
      
      const age = parseSeguro(row[idxAge]);
      
      // Ignorar snapshots con age -1 (o negativo) reportados por la plataforma
      if (age < 0) return;
      
      if (idxSnapshotName !== -1) {
         const snapName = (row[idxSnapshotName] || "").toString().toLowerCase();
         if (snapName.includes("restore point") || snapName.includes("restore_point")) return;
      }
      
      const space = parseSpaceToGB(row[idxSpace]);
      const count = parseSeguro(row[idxCount]);
      
      let usedPercent = 0;
      const totalCap = idxTotalCapacity !== -1 ? parseSpaceToGB(row[idxTotalCapacity]) : 0;
      if (totalCap > 0) {
         usedPercent = (space / totalCap) * 100;
      }
      if (idxTotalCapacity !== -1) {
        row.push(usedPercent > 0 ? usedPercent.toFixed(2) + "%" : "0.00%");
      }
      
      // PASO 1: SOP siempre tiene prioridad
      const matchedSopRule = findMatchingSopRule(row, headers, sopRules);
      if (matchedSopRule) {
         Logger.log('[DEBUG SOPORTE] VM MATCH SOP: criterio=' + matchedSopRule.criterio + ' VM=' + vmName);
      }

      if (matchedSopRule && matchedSopRule.criterio === 'considerar') {
         // → Ticket SOPORTE con umbrales personalizados
         let sizeLimit = matchedSopRule.size > 0 ? matchedSopRule.size : Infinity;
         let ageLimit = matchedSopRule.age > 0 ? matchedSopRule.age : Infinity;
         let qtyLimit = matchedSopRule.qty > 0 ? matchedSopRule.qty : Infinity;
         
         let rowBreaksRule = false;
         if (age >= ageLimit) { detectedReasonsSoporte.add(`Antigüedad >= ${ageLimit} días`); rowBreaksRule = true; }
         if (count >= qtyLimit) { detectedReasonsSoporte.add(`Cantidad >= ${qtyLimit}`); rowBreaksRule = true; }
         
         const esRelativo = matchedSopRule.sizeType === 'porcentaje' || matchedSopRule.sizeType === 'relativo';
         if (esRelativo) {
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
         // Si es 'exceptuar' de SOP o si no hay regla SOP
         let fallsToOps = false;
         
         if (matchedSopRule && matchedSopRule.criterio === 'exceptuar') {
            // Está exceptuada de SOP explícitamente -> pasamos directo a evaluar OPS
            fallsToOps = true;
         } else {
            // PASO 2: Evaluar umbrales SOP Hardcodeados (Safety net)
            let sopBreaksRule = false;
            if (age >= SOP_AGE_MAX) { detectedReasonsSoporte.add(`Antigüedad >= ${SOP_AGE_MAX} días`); sopBreaksRule = true; }
            if (space >= SOP_SIZE_MAX) { detectedReasonsSoporte.add(`Tamaño >= ${SOP_SIZE_MAX} GB`); sopBreaksRule = true; }
            if (count >= SOP_CANTIDAD_MAX) { detectedReasonsSoporte.add(`Cantidad >= ${SOP_CANTIDAD_MAX}`); sopBreaksRule = true; }
            
            if (sopBreaksRule) {
               Logger.log('[DEBUG EVAL] -> VM asignada a SOPORTE por umbrales hardcodeados: ' + vmName);
               soporteAlerts.push(row);
            } else {
               fallsToOps = true;
            }
         }

         if (fallsToOps) {
            // PASO 3: Evaluar OPS
            const matchedOpsRule = findMatchingSopRule(row, headers, clientConfig.exceptions);
            if (matchedOpsRule) {
               Logger.log('[DEBUG OPS] VM MATCH OPS: criterio=' + matchedOpsRule.criterio + ' VM=' + vmName);
            }

            if (matchedOpsRule && matchedOpsRule.criterio === 'considerar') {
               // Umbrales OPS personalizados
               let sizeLimit = matchedOpsRule.size > 0 ? matchedOpsRule.size : Infinity;
               let ageLimit  = matchedOpsRule.age  > 0 ? matchedOpsRule.age  : Infinity;
               let qtyLimit  = matchedOpsRule.qty  > 0 ? matchedOpsRule.qty  : Infinity;
               
               let rowBreaksRule = false;
               if (age   >= ageLimit) { detectedReasonsOps.add(`Antigüedad >= ${ageLimit} días`); rowBreaksRule = true; }
               if (count >= qtyLimit) { detectedReasonsOps.add(`Cantidad >= ${qtyLimit}`); rowBreaksRule = true; }
               
               const esRelativo = matchedOpsRule.sizeType === 'porcentaje' || matchedOpsRule.sizeType === 'relativo';
               if (esRelativo) {
                  if (usedPercent >= sizeLimit && sizeLimit !== Infinity) { 
                     detectedReasonsOps.add(`Tamaño Relativo >= ${sizeLimit}%`); 
                     rowBreaksRule = true; 
                  }
               } else {
                  if (space >= sizeLimit && sizeLimit !== Infinity) { 
                     detectedReasonsOps.add(`Tamaño Absoluto >= ${sizeLimit} GB`); 
                     rowBreaksRule = true; 
                  }
               }
               if (rowBreaksRule) {
                  Logger.log('[DEBUG EVAL] -> VM asignada a OPS por regla personalizada: ' + vmName);
                  opsAlerts.push(row);
               }
            } else if (matchedOpsRule) {
               // criterio = 'ignorar' o vacío
               Logger.log('[DEBUG EVAL] -> VM IGNORADA por regla OPS (criterio=' + matchedOpsRule.criterio + '): ' + vmName);
            } else {
               // PASO 4: Evaluar umbrales OPS Hardcodeados
               let rowBreaksRule = false;
               if (age >= AGE_MAX) { detectedReasonsOps.add(`Antigüedad >= ${AGE_MAX} días`); rowBreaksRule = true; }
               if (space >= SIZE_MAX) { detectedReasonsOps.add(`Tamaño >= ${SIZE_MAX} GB`); rowBreaksRule = true; }
               if (count >= CANTIDAD_MAX) { detectedReasonsOps.add(`Cantidad >= ${CANTIDAD_MAX}`); rowBreaksRule = true; }
               
               if (rowBreaksRule) {
                  Logger.log('[DEBUG EVAL] -> VM asignada a OPS (umbrales hardcodeados): ' + vmName);
                  opsAlerts.push(row);
               }
            }
         }
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
        
        const nombreReporteOps = attachmentName.replace(/\.xlsx$|\.csv$/i, "") + "-OPS.xlsx";
        const xlsxBlobOps = convertDataToXlsxBlob([headers, ...rowsExp], nombreReporteOps);
        if (xlsxBlobOps) {
            this.extractedBlobs = this.extractedBlobs || [];
            this.extractedBlobs.push(xlsxBlobOps);
        }

        if (existingTicketKeyOps) {
          if (!haSidoActualizadoHoy(existingTicketKeyOps, "ALERTA-SNAPSHOTS-OPS")) {
            let commentText = `⏳ **El problema persiste.** [HU-ALERTA-SNAPSHOTS-OPS]\n\nSe detectaron ${this.opsAlerts.length} VMs fuera de norma:\n${this.opsReasonsText}\n\n`;
            if (this.opsAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
              if (xlsxBlobOps) {
                addAttachmentToJiraTicket(existingTicketKeyOps, xlsxBlobOps);
                commentText += "Se adjunta reporte detallado.\n";
              }
              addCommentToJiraTicket(existingTicketKeyOps, commentText);
              summaryReport.exitos.push({ mensaje: `Ticket OPS ${existingTicketKeyOps} actualizado con comentario y adjunto.` });
            } else {
              if (xlsxBlobOps) {
                const attStatus = addAttachmentToJiraTicket(existingTicketKeyOps, xlsxBlobOps);
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
          let summary, description;
          description = `Se detectaron ${this.opsAlerts.length} VMs con snapshots fuera del estándar (Ops):\n${this.opsReasonsText}\n\n`;
          if (this.opsAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
            summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE;
            description += `|| ${headers.join(" || ")} ||\n`;
            this.opsAlerts.forEach(row => description += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
            const creationResult = createTicketAndNotify(summary, description, xlsxBlobOps, clientConfigOps, this.operationName);
            if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Ops: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
            else globalStatus = 'FAILURE';
          } else {
            summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT;
            description += `Debido a la cantidad de registros, se adjunta el reporte.`;
            const creationResult = createTicketAndNotify(summary, description, xlsxBlobOps, clientConfigOps, this.operationName);
            if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Ops: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
            else globalStatus = 'FAILURE';
          }
        }
    }

    // PROCESAR SOPORTE
    if (this.soporteAlerts && this.soporteAlerts.length > 0) {
      huboAlertaSop = true;
      // Tratar de obtener el clientConfigSoporte (pasando true como 3er parámetro si getClientConfig lo soporta, o forzando datos manuales)
      let clientConfigSop = null;
      if (typeof getClientConfig === 'function') {
         clientConfigSop = getClientConfig(senderEmail, this.operationName + " SOP", true);
      }
      if (!clientConfigSop || !clientConfigSop.jiraProjectKeySop) {
         // Fallback por si getClientConfig(..., true) no existe, o si estamos en Testing
         clientConfigSop = { ...clientConfig_Ignored, jiraProjectKeySop: "SOP", clientNameSop: "Veeam Backup & Replication" }; 
      }
      
      const existingTicketKeySop = findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE + " (Soporte)", clientConfigSop.jiraProjectKeySop) ||
                                   findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT + " (Soporte)", clientConfigSop.jiraProjectKeySop);
                           const rowsExp = [...this.soporteAlerts];
        
        const nombreReporteSop = attachmentName.replace(/\.xlsx$|\.csv$/i, "") + "-SOP.xlsx";
        const xlsxBlobSop = convertDataToXlsxBlob([headers, ...rowsExp], nombreReporteSop);
        if (xlsxBlobSop) {
            this.extractedBlobs = this.extractedBlobs || [];
            this.extractedBlobs.push(xlsxBlobSop);
        }
        
        if (existingTicketKeySop) {
          if (!haSidoActualizadoHoy(existingTicketKeySop, "ALERTA-SNAPSHOTS-SOP")) {
            let commentText = `⏳ **El problema persiste.** [HU-ALERTA-SNAPSHOTS-SOP]\n\nSe detectaron ${this.soporteAlerts.length} VMs fuera de norma:\n${this.soporteReasonsText}\n\n`;
            if (this.soporteAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
              if (xlsxBlobSop) {
                addAttachmentToJiraTicket(existingTicketKeySop, xlsxBlobSop);
                commentText += "Se adjunta reporte detallado.\n";
              }
              addCommentToJiraTicket(existingTicketKeySop, commentText);
              summaryReport.exitos.push({ mensaje: `Ticket SOPORTE ${existingTicketKeySop} actualizado con comentario y adjunto.` });
            } else {
              if (xlsxBlobSop) {
                const attStatus = addAttachmentToJiraTicket(existingTicketKeySop, xlsxBlobSop);
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
          let summary, description;
          description = `Se detectaron ${this.soporteAlerts.length} VMs con snapshots fuera del estándar (Soporte):\n${this.soporteReasonsText}\n\n`;
          if (this.soporteAlerts.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
            summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE + " (Soporte)";
            description += `|| ${headers.join(" || ")} ||\n`;
            this.soporteAlerts.forEach(row => description += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
            const creationResult = createTicketAndNotifySoporte(summary, description, xlsxBlobSop, clientConfigSop);
            if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Soporte: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
            else globalStatus = 'FAILURE';
          } else {
            summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT + " (Soporte)";
            description += `Debido a la cantidad de registros, se adjunta el reporte.`;
            const creationResult = createTicketAndNotifySoporte(summary, description, xlsxBlobSop, clientConfigSop);
            if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Soporte: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
            else globalStatus = 'FAILURE';
          }
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
// Busca en clientConfig.exceptions el primer grupo cuyas condiciones coincidan
// con la fila del reporte Y que tenga umbrales de soporte definidos (ageLimit/sizeLimit/qtyLimit).
function findMatchingSopRule(reportRow, headers, exceptions) {
  if (!exceptions || typeof exceptions !== 'object') return null;
  const normalizedHeaders = headers.map(h => {
    let n = h.trim().toLowerCase();
    return n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  });
  for (const exceptionId in exceptions) {
    const ruleGroup = exceptions[exceptionId];

    const allConditionsMet = ruleGroup.every(condition => {
      let nCol = condition.column.trim().toLowerCase();
      nCol = nCol.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const colIndex = normalizedHeaders.indexOf(nCol);
      if (colIndex === -1) return false;
      const reportValueStr = (reportRow[colIndex] || '').toString().trim().toLowerCase();
      return condition.values.some(exceptionValue => {
        switch (condition.matchType.toLowerCase()) {
          case 'exacta':      return reportValueStr === exceptionValue;
          case 'contiene':    return reportValueStr.includes(exceptionValue);
          case 'comienza con': return reportValueStr.startsWith(exceptionValue);
          case 'termina con': return reportValueStr.endsWith(exceptionValue);
          default:            return reportValueStr === exceptionValue;
        }
      });
    });

    if (allConditionsMet) {
      const c = ruleGroup[0];
      if (c) return { age: c.ageLimit, size: c.sizeLimit, qty: c.qtyLimit, sizeType: c.sizeType || '', criterio: (c.criterio || '').toLowerCase() };
    }
  }
  return null;
}
