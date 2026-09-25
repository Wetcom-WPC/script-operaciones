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

/**
 * Summary del ticket de alerta, respetando el lado AVS del reporte.
 *
 * Delega en nombreTareaSegunAVS() a propósito: el prefijo "AVS - " ya es el que usan las
 * Tareas Programadas y tiene que vivir en un solo lugar (AGENTS.md §5), no repetido acá.
 *
 * Antes el summary se buscaba y se creaba SIEMPRE sin prefijo, así que el reporte AVS y el
 * común compartían el mismo ticket. El 15/09/2026 Macro mandó los dos reportes con el mismo
 * asunto y el mismo nombre de adjunto ("VMs con snapshots.csv"): el común levantó 12
 * anomalías y creó OBM-18791, y el de AVS —cuyas 20 filas son todas snapshots de templates,
 * que se ignoran por regla de negocio— cayó en handleNoAlerts, encontró ESE mismo ticket y
 * comentó "la anomalía no persiste" sobre anomalías que seguían vigentes. El ticket se cerró
 * con las 12 VMs sin atender.
 *
 * @param {string} base Summary sin prefijo.
 * @param {Object} clientConfig Config que trae `isAVS`.
 * @returns {string}
 */
function summarySnapshotsSegunAVS(base, clientConfig) {
  return nombreTareaSegunAVS(base, clientConfig);
}

class VMsConSnapshotsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: SNAPSHOTS_OPERATION_NAME,
      emailSubject: SNAPSHOTS_EMAIL_SUBJECT,
      attachmentMatch: SNAPSHOTS_FILENAME_MATCH,
      scheduledTaskName: SNAPSHOTS_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processSingleMessage(message, summaryReport) {
    this._currentSenderEmail = message.getFrom();
    return super.processSingleMessage(message, summaryReport);
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (config) {
      config.senderEmail = sender;
    }
    this._currentSenderEmail = sender;
    // Lado AVS del reporte. Sin esto, un reporte AVS cierra la Tarea Programada
    // "VMs con snapshots" en vez de "AVS - VMs con snapshots": los dos tickets existen
    // (OBM-18502 y OBM-18503) y el nombre sin prefijo apunta siempre al no-AVS.
    const esAVS = esReporteAVS(message ? message.getSubject() : '', attachment);

    const fileNameUpper = attachment.getName().toUpperCase();
    const clientNameUpper = (config && config.clientName) ? config.clientName.toUpperCase() : "";
    
    const esBalanz = clientNameUpper.includes("BALANZ") || fileNameUpper.includes("BALANZ");
    const esMacro = clientNameUpper.includes("MACRO") || fileNameUpper.includes("MACRO");
    
    if (esBalanz && (!config || !config.clientName || !config.clientName.toUpperCase().includes("BALANZ"))) {
      config = getClientConfigByName("Operaciones BALANZ", this.operationName) || { clientName: "Operaciones BALANZ", jiraProjectKey: "OBC2", exceptions: [] };
      config.senderEmail = sender;
    } else if (esMacro && (!config || !config.clientName || !config.clientName.toUpperCase().includes("MACRO"))) {
      config = getClientConfigByName("Operaciones Banco Macro", this.operationName) || { clientName: "Operaciones Banco Macro", jiraProjectKey: "OBM", exceptions: [] };
      config.senderEmail = sender;
    } else if (!config || !config.clientName || config.clientName.toUpperCase().includes("DESCONOCIDO")) {
      return null;
    }
    if (config) config.isAVS = esAVS;
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
      const emailParaSoporte = (clientConfig && clientConfig.senderEmail) ? clientConfig.senderEmail : this._currentSenderEmail;
      if (emailParaSoporte) {
        const configSop = getClientConfig(emailParaSoporte, this.operationName + " SOP", true);
        if (configSop && configSop.exceptions) sopRules = configSop.exceptions;
      }
    }

    reportRows.forEach(row => {
      if (row.length < idxAge || row.join('').trim() === '') return;
      
      const vmName = (row[idxName] || "").trim();
      const vmNameLower = vmName.toLowerCase();
      if (vmNameLower.includes("replica")) return;
      
      const age = parseSeguro(row[idxAge]);
      
      // Ignorar snapshots con age -1 (o negativo) reportados por la plataforma
      if (age < 0) return;
      
      if (idxSnapshotName !== -1) {
         const snapName = (row[idxSnapshotName] || "").toString().toLowerCase();
         if (snapName.includes("restore point") || snapName.includes("restore_point")) return;

         // PUNTO 3: Ignorar snapshots de plantillas / templates (ej. vm-template-snapshot)
         if (snapName.includes("vm-template-snapshot") || snapName.includes("template")) return;

         // PUNTO 2: Snapshots temporales de Veeam: se ignoran si tienen menos de 48 horas (age < 2)
         if (snapName.includes("veeam backup temporary snapshot") && age < 2) return;
      }

      if (vmNameLower.includes("template") && idxSnapshotName !== -1) {
         const snapName = (row[idxSnapshotName] || "").toString().toLowerCase();
         if (snapName.includes("snapshot") || snapName.includes("template")) return;
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
      const matchedSopRules = findAllMatchingRules(row, headers, sopRules);
      
      const hasExceptuarSop = matchedSopRules.some(r => r.criterio === 'exceptuar');
      const considerarSopRules = matchedSopRules.filter(r => r.criterio === 'considerar');

      if (matchedSopRules.length > 0) {
         Logger.log('[DEBUG SOPORTE] VM MATCH SOP: ' + matchedSopRules.length + ' regla(s) para VM=' + vmName);
      }

      if (!hasExceptuarSop && considerarSopRules.length > 0) {
         // → Ticket SOPORTE con umbrales personalizados
         let rowBreaksRule = false;
         for (const rule of considerarSopRules) {
            if (_evaluaRegla(rule, age, space, count, usedPercent, detectedReasonsSoporte, true)) {
               rowBreaksRule = true;
               Logger.log('[DEBUG EVAL] -> VM asignada a SOPORTE por regla (' + rule.exceptionId + '): ' + vmName);
               break; // Con que rompa una regla alcanza
            }
         }
         if (rowBreaksRule) soporteAlerts.push(row);

      } else {
         // Si es 'exceptuar' de SOP o si no hay regla SOP
         let fallsToOps = false;
         
         if (hasExceptuarSop) {
            // Está exceptuada de SOP explícitamente -> pasamos directo a evaluar OPS
            fallsToOps = true;
         } else {
            // PASO 2: Evaluar umbrales SOP Hardcodeados (Safety net)
            let sopBreaksRule = false;
            if (age >= SOP_AGE_MAX) { detectedReasonsSoporte.add(`Antigüedad >= ${SOP_AGE_MAX} días`); sopBreaksRule = true; }
            // PUNTO 1: Solo alertar por tamaño en Soporte si tiene al menos 24 horas de vida (age >= 1)
            if (space >= SOP_SIZE_MAX && age >= 1) { detectedReasonsSoporte.add(`Tamaño >= ${SOP_SIZE_MAX} GB (Antigüedad >= 1 día)`); sopBreaksRule = true; }
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
            const matchedOpsRules = findAllMatchingRules(row, headers, clientConfig.exceptions);
            
            const hasIgnorarOps = matchedOpsRules.some(r => r.criterio === 'ignorar' || r.criterio === 'exceptuar');
            const considerarOpsRules = matchedOpsRules.filter(r => r.criterio === 'considerar');

            if (matchedOpsRules.length > 0) {
               Logger.log('[DEBUG OPS] VM MATCH OPS: ' + matchedOpsRules.length + ' regla(s) para VM=' + vmName);
            }

            if (hasIgnorarOps) {
               Logger.log('[DEBUG EVAL] -> VM IGNORADA por regla OPS explícita: ' + vmName);
            } else if (considerarOpsRules.length > 0) {
               // Umbrales OPS personalizados
               let rowBreaksRule = false;
               for (const rule of considerarOpsRules) {
                  if (_evaluaRegla(rule, age, space, count, usedPercent, detectedReasonsOps, false)) {
                     rowBreaksRule = true;
                     Logger.log('[DEBUG EVAL] -> VM asignada a OPS por regla personalizada (' + rule.exceptionId + '): ' + vmName);
                     break; // Con que rompa una regla alcanza
                  }
               }
               
               if (rowBreaksRule) {
                  opsAlerts.push(row);
               }
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
    // El lado AVS busca su propio ticket ("AVS - ..."). Si no existe devuelve null, y
    // handleNoAlerts no comenta nada: es preferible no decir nada a comentar "la anomalía no
    // persiste" sobre el ticket del parque común, que es otro reporte (ver
    // summarySnapshotsSegunAVS).
    return findExistingJiraTicket(summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfig), clientConfig.jiraProjectKey) ||
           findExistingJiraTicket(summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig), clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKeyIgnored, clientConfig_Ignored, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    let globalStatus = 'SUCCESS';
    let huboAlertaOps = false;
    let huboAlertaSop = false;
    const senderEmail = (clientConfig_Ignored && clientConfig_Ignored.senderEmail) ? clientConfig_Ignored.senderEmail : this._currentSenderEmail;

    // 1. Obtener la configuración de Soporte para el remitente real del cliente
    let clientConfigSop = null;
    if (typeof getClientConfig === 'function' && senderEmail) {
       clientConfigSop = getClientConfig(senderEmail, this.operationName + " SOP", true);
    }

    const tieneSoporte = !!(clientConfigSop && clientConfigSop.jiraProjectKeySop);

    // REGLA DE NEGOCIO: Si el cliente NO tiene Soporte en la Columna N (está vacía),
    // cualquier alerta que hubiera calificado para Soporte se reporta en Operaciones (Columna D).
    let opsAlertsFinal = [...(this.opsAlerts || [])];
    let opsReasonsFinal = this.opsReasonsText || "";

    if (!tieneSoporte && this.soporteAlerts && this.soporteAlerts.length > 0) {
      Logger.log(`[VMs con snapshots] El cliente "${clientConfig_Ignored.clientName}" no tiene Columna N (Soporte). Se unifican ${this.soporteAlerts.length} alertas en Operaciones (${clientConfig_Ignored.jiraProjectKey}).`);
      opsAlertsFinal = [...opsAlertsFinal, ...this.soporteAlerts];
      opsReasonsFinal = (opsReasonsFinal ? opsReasonsFinal + '\n' : '') + (this.soporteReasonsText || '');
    }

    // PROCESAR OPS
    if (opsAlertsFinal.length > 0) {
      huboAlertaOps = true;
      const clientConfigOps = getClientConfigByName(clientConfig_Ignored.clientName, this.operationName) || clientConfig_Ignored;
      if (clientConfig_Ignored.isAVS) clientConfigOps.isAVS = true;
      const existingTicketKeyOps = findExistingJiraTicket(summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfigOps), clientConfigOps.jiraProjectKey) ||
                                   findExistingJiraTicket(summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfigOps), clientConfigOps.jiraProjectKey);
      const rowsExp = [...opsAlertsFinal];
        
      const nombreReporteOps = attachmentName.replace(/\.(xlsx|csv|xls|json)$/i, "") + "-OPS.xlsx";
      const xlsxBlobOps = convertDataToXlsxBlob([headers, ...rowsExp], nombreReporteOps);
      if (xlsxBlobOps) {
          this.extractedBlobs = this.extractedBlobs || [];
          this.extractedBlobs.push(xlsxBlobOps);
      }

      if (existingTicketKeyOps) {
        if (!haSidoActualizadoHoy(existingTicketKeyOps, "ALERTA-SNAPSHOTS-OPS")) {
          let commentText = `⏳ **El problema persiste.** [HU-ALERTA-SNAPSHOTS-OPS]\n\nSe detectaron ${opsAlertsFinal.length} VMs fuera de norma:\n${opsReasonsFinal}\n\n`;
          if (opsAlertsFinal.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
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
        description = `Se detectaron ${opsAlertsFinal.length} VMs con snapshots fuera del estándar (Ops):\n${opsReasonsFinal}\n\n`;
        if (opsAlertsFinal.length <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
          summary = summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfigOps);
          description += `|| ${headers.join(" || ")} ||\n`;
          opsAlertsFinal.forEach(row => description += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
          const creationResult = createTicketAndNotify(summary, description, xlsxBlobOps, clientConfigOps, this.operationName);
          if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Ops: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
          else globalStatus = 'FAILURE';
        } else {
          summary = summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfigOps);
          description += `Debido a la cantidad de registros, se adjunta el reporte.`;
          const creationResult = createTicketAndNotify(summary, description, xlsxBlobOps, clientConfigOps, this.operationName);
          if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Ops: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
          else globalStatus = 'FAILURE';
        }
      }
    }

    // PROCESAR SOPORTE (solo si el cliente tiene Columna N configurada)
    if (tieneSoporte && this.soporteAlerts && this.soporteAlerts.length > 0) {
      huboAlertaSop = true;
      // El lado AVS también separa el ticket de Soporte. clientConfigSop viene de la Columna N
      // y no trae `isAVS`, así que el lado se toma del config del reporte (clientConfig_Ignored).
      const existingTicketKeySop = findExistingJiraTicket(summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfig_Ignored) + " (Soporte)", clientConfigSop.jiraProjectKeySop) ||
                                   findExistingJiraTicket(summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig_Ignored) + " (Soporte)", clientConfigSop.jiraProjectKeySop);
      const rowsExp = [...this.soporteAlerts];
      
      const nombreReporteSop = attachmentName.replace(/\.(xlsx|csv|xls|json)$/i, "") + "-SOP.xlsx";
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
          summary = summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfig_Ignored) + " (Soporte)";
          description += `|| ${headers.join(" || ")} ||\n`;
          this.soporteAlerts.forEach(row => description += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
          const creationResult = createTicketAndNotifySoporte(summary, description, xlsxBlobSop, clientConfigSop);
          if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Soporte: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
          else globalStatus = 'FAILURE';
        } else {
          summary = summarySnapshotsSegunAVS(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig_Ignored) + " (Soporte)";
          description += `Debido a la cantidad de registros, se adjunta el reporte.`;
          const creationResult = createTicketAndNotifySoporte(summary, description, xlsxBlobSop, clientConfigSop);
          if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Soporte: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
          else globalStatus = 'FAILURE';
        }
      }
    }

    if (globalStatus === 'SUCCESS' && this.scheduledTaskName) {
       buscarYCerrarTareaProgramada(nombreTareaSegunAVS(this.scheduledTaskName, clientConfig_Ignored), clientConfig_Ignored, false);
    }
    return { status: globalStatus };
  }
}

function processSnapshotsEmails() {
  new VMsConSnapshotsProcessor().processEmails();
}// --- SOP RULES PARSING ---
// Busca en clientConfig.exceptions todos los grupos cuyas condiciones coincidan
// con la fila del reporte Y que tengan umbrales definidos (ageLimit/sizeLimit/qtyLimit).
function findAllMatchingRules(reportRow, headers, exceptions) {
  if (!exceptions || typeof exceptions !== 'object') return [];
  const normalizedHeaders = headers.map(h => {
    let n = h.trim().toLowerCase();
    return n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  });
  
  const matched = [];
  
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
      const rowsWithLimits = ruleGroup.filter(r => 
        (r.ageLimit !== null && r.ageLimit !== undefined && r.ageLimit !== '') ||
        (r.sizeLimit !== null && r.sizeLimit !== undefined && r.sizeLimit !== '') ||
        (r.qtyLimit !== null && r.qtyLimit !== undefined && r.qtyLimit !== '')
      );

      const isCompoundRule = rowsWithLimits.length > 1;
      const c = ruleGroup[0];
      const matchingCriterio = ruleGroup.find(r => r.criterio && r.criterio.trim() !== '');
      const criterioGroup = (matchingCriterio ? matchingCriterio.criterio : (c ? c.criterio : '') || '').toLowerCase();

      matched.push({
        exceptionId: exceptionId,
        isCompoundRule: isCompoundRule,
        limits: rowsWithLimits.map(r => ({
          age: (r.ageLimit !== null && r.ageLimit !== undefined && r.ageLimit !== '') ? Number(r.ageLimit) : null,
          size: (r.sizeLimit !== null && r.sizeLimit !== undefined && r.sizeLimit !== '') ? Number(r.sizeLimit) : null,
          qty: (r.qtyLimit !== null && r.qtyLimit !== undefined && r.qtyLimit !== '') ? Number(r.qtyLimit) : null,
          sizeType: (r.sizeType || '').toLowerCase()
        })),
        age: c ? c.ageLimit : null,
        size: c ? c.sizeLimit : null,
        qty: c ? c.qtyLimit : null,
        sizeType: c ? (c.sizeType || '') : '',
        criterio: criterioGroup
      });
    }
  }
  return matched;
}

// Alias de compatibilidad por si es invocado desde afuera
function findMatchingSopRule(reportRow, headers, exceptions) {
  const matches = findAllMatchingRules(reportRow, headers, exceptions);
  return matches.length > 0 ? matches[0] : null;
}

/**
 * Evalúa si una VM rompe una regla específica (individual o compuesta)
 * Si la rompe, agrega las razones al reasonsSet y retorna true.
 * @param {Object} rule - La regla matcheada
 * @param {Number} age - Antigüedad de la VM
 * @param {Number} space - Espacio ocupado en GB
 * @param {Number} count - Cantidad de snapshots
 * @param {Number} usedPercent - Porcentaje de espacio usado
 * @param {Set} reasonsSet - Set donde se guardarán las razones
 * @param {Boolean} isSoporte - Si es true, el tamaño requiere age >= 1 (regla de soporte)
 * @returns {Boolean} true si rompió la regla, false si no
 */
function _evaluaRegla(rule, age, space, count, usedPercent, reasonsSet, isSoporte = false) {
  if (rule.isCompoundRule) {
    // MODO AND: Todas las filas de límites del mismo ID deben cumplirse simultáneamente
    const reasonsGroup = [];
    const allLimitsBroken = rule.limits.every(limit => {
      let broken = false;
      if (limit.age !== null && limit.age > 0) {
        if (age >= limit.age) {
          reasonsGroup.push(`Antigüedad >= ${limit.age} días`);
          broken = true;
        }
      }
      if (limit.qty !== null && limit.qty > 0) {
        if (count >= limit.qty) {
          reasonsGroup.push(`Cantidad >= ${limit.qty}`);
          broken = true;
        }
      }
      if (limit.size !== null && limit.size > 0) {
        const esRelativo = limit.sizeType === 'porcentaje' || limit.sizeType === 'relativo';
        // En SOPORTE el tamaño requiere age >= 1. En OPS no.
        const cumpleAgeMinimo = isSoporte ? (age >= 1) : true;
        
        if (esRelativo) {
          if (usedPercent >= limit.size && cumpleAgeMinimo) {
            reasonsGroup.push(`Tamaño Relativo >= ${limit.size}%${isSoporte ? ' (Antigüedad >= 1 día)' : ''}`);
            broken = true;
          }
        } else {
          if (space >= limit.size && cumpleAgeMinimo) {
            reasonsGroup.push(`Tamaño Absoluto >= ${limit.size} GB${isSoporte ? ' (Antigüedad >= 1 día)' : ''}`);
            broken = true;
          }
        }
      }
      return broken;
    });
    if (allLimitsBroken) {
      reasonsGroup.forEach(r => reasonsSet.add(r));
      return true;
    }
    return false;
  } else {
    // MODO INDIVIDUAL (1 fila): se evalúa con OR
    let sizeLimit = rule.size > 0 ? rule.size : Infinity;
    let ageLimit = rule.age > 0 ? rule.age : Infinity;
    let qtyLimit = rule.qty > 0 ? rule.qty : Infinity;
    
    let broken = false;
    if (age >= ageLimit) { reasonsSet.add(`Antigüedad >= ${ageLimit} días`); broken = true; }
    if (count >= qtyLimit) { reasonsSet.add(`Cantidad >= ${qtyLimit}`); broken = true; }
    
    const esRelativo = rule.sizeType === 'porcentaje' || rule.sizeType === 'relativo';
    const cumpleAgeMinimo = isSoporte ? (age >= 1) : true;
    
    if (esRelativo) {
      if (usedPercent >= sizeLimit && sizeLimit !== Infinity && cumpleAgeMinimo) {
        reasonsSet.add(`Tamaño Relativo >= ${sizeLimit}%${isSoporte ? ' (Antigüedad >= 1 día)' : ''}`); 
        broken = true;
      }
    } else {
      if (space >= sizeLimit && sizeLimit !== Infinity && cumpleAgeMinimo) {
        reasonsSet.add(`Tamaño Absoluto >= ${sizeLimit} GB${isSoporte ? ' (Antigüedad >= 1 día)' : ''}`); 
        broken = true;
      }
    }
    return broken;
  }
}
