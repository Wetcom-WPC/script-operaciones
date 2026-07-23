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

    if (idxName === -1 || idxAge === -1 || idxSpace === -1 || idxCount === -1) {
      summaryReport.errores.push({ error: "Faltan columnas clave." });
      return null;
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
      
      return rowBreaksRule && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    const reasonsText = Array.from(detectedReasons).map(r => `* ${r}`).join('\n');
    
    const rowsForExport = [...finalAlerts];
    if (summaryRow.length > 0) rowsForExport.push(summaryRow);

    return { headers, finalAlerts, rowsForExport, reasonsText };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) ||
           findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;

    if (existingTicketKey) {
      if (haSidoActualizadoHoy(existingTicketKey, "ALERTA-SNAPSHOTS")) return { status: 'SUCCESS' };
      
      let commentText = `🚨 **El problema persiste.** [HU-ALERTA-SNAPSHOTS]\n\nSe detectaron ${alertCount} VMs fuera de norma:\n${reasonsText}\n\n`;
      
      if (alertCount <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(row => commentText += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} actualizado con tabla.` });
      } else {
        const xlsxBlob = convertDataToXlsxBlob([headers, ...rowsForExport], "Reporte-Filtrado.xlsx");
        const attStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
        
        if (attStatus.status === 'SUCCESS') {
            commentText += "Se adjunta reporte detallado.";
            addCommentToJiraTicket(existingTicketKey, commentText);
            summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} actualizado con adjunto.` });
            
            const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName);
            if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
        } else {
            summaryReport.advertencias.push("Fallo al adjuntar.");
        }
      }
      
      if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      return { status: 'SUCCESS' };
      
    } else {
      let summary, description, xlsxBlob = null;
      description = `Se detectaron ${alertCount} VMs con snapshots fuera del estándar permitido:\n${reasonsText}\n\n`;
      
      if (alertCount <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
        summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE;
        description += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description += `Debido a la cantidad de registros (${alertCount}), se adjunta el reporte detallado.`;
        const newFileName = attachmentName.replace(/\.xlsx$|\.csv$/i, "") + "-FILTRADO.xlsx";
        xlsxBlob = convertDataToXlsxBlob([headers, ...rowsForExport], newFileName);
      }
     
      const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, this.operationName);
      if (creationResult.status === 'SUCCESS') summaryReport.exitos.push(creationResult.detail);
      else if (creationResult.status === 'ERROR') summaryReport.errores.push(creationResult.detail);
      
      if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      return { status: creationResult.status };
    }
  }
}

function processSnapshotsEmails() {
  new VMsConSnapshotsProcessor().processEmails();
}