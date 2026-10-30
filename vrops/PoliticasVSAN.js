/**
 * @fileoverview Lógica específica para procesar reportes de "Políticas de vSAN" (Auditoría de VM Storage Policies).
 * Consume la configuración del cliente (ej. Banco Macro SDDC) mediante resolución por remitente SMTP desde el Índice General/Maestro.
 * Reporta VMs con compliance fuera de norma (Out of Date, Non-Compliant) a Operaciones.
 */

// --- CONFIGURACIÓN ESPECÍFICA ---
const POLITICAS_VSAN_OPERATION_NAME = "Políticas de vSAN";
const POLITICAS_VSAN_EMAIL_SUBJECT = "Auditoria de VM Storage Policies";
const POLITICAS_VSAN_FILENAME_MATCH = "Auditoria de VM Storage Policies";
const POLITICAS_VSAN_SCHEDULED_TASK_NAME = "Políticas de vSAN";
const POLITICAS_VSAN_ROW_LIMIT_FOR_TABLE = 10;
const POLITICAS_VSAN_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron anomalías en Políticas de vSAN";
const POLITICAS_VSAN_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron anomalías en Políticas de vSAN";

class PoliticasVSANProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: POLITICAS_VSAN_OPERATION_NAME,
      emailSubject: POLITICAS_VSAN_EMAIL_SUBJECT,
      attachmentMatch: POLITICAS_VSAN_FILENAME_MATCH,
      scheduledTaskName: POLITICAS_VSAN_SCHEDULED_TASK_NAME,
      ticketSummary: POLITICAS_VSAN_JIRA_TICKET_SUMMARY_TABLE
    });
  }

  processSingleMessage(message, summaryReport) {
    this._currentSenderEmail = message.getFrom();
    const emailSubject = message.getSubject();

    // Caso de éxito sin anomalías explícito en el asunto
    if (emailSubject.toLowerCase().includes("success")) {
      const senderEmail = message.getFrom();
      const clientConfig = this.resolveClientConfig(null, senderEmail, null, message, summaryReport);
      if (clientConfig) {
        summaryReport.exitos.push({
          cliente: clientConfig.clientName,
          mensaje: `Reporte de ${clientConfig.clientName} recibido con (SUCCESS). No se detectaron anomalías en políticas de vSAN.`
        });
        if (this.scheduledTaskName) {
          buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
        }
        const nombreArchivo = this.operationName + " - OK.txt";
        this.extractedBlobs = [Utilities.newBlob("Reporte procesado exitosamente sin alertas.", "text/plain", nombreArchivo)];
        this.ejecutarPasoDrive(message, clientConfig.clientName, summaryReport, { status: 'SUCCESS' });
      }
      return { status: 'SUCCESS' };
    }

    return super.processSingleMessage(message, summaryReport);
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (!config) {
      config = getClientConfig(sender, this.operationName);
    }
    // Fallback por si en el Índice Maestro la pestaña de excepciones está registrada como "Auditoria de VM Storage Policies"
    if (!config) {
      config = getClientConfig(sender, "Auditoria de VM Storage Policies") || getClientConfig(sender, "Politicas de vSAN");
    }
    if (config) {
      config.senderEmail = sender;
    }
    this._currentSenderEmail = sender;
    return config;
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(POLITICAS_VSAN_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) ||
           findExistingJiraTicket(POLITICAS_VSAN_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  parseAttachment(attachment, summaryReport) {
    try {
      const rawText = attachment.getDataAsString("UTF-8");
      return parseCsvDeReporte(rawText);
    } catch (e) {
      summaryReport.errores.push({ error: "Error parseando CSV de Políticas de vSAN", detalle: e.message });
      return null;
    }
  }

  processData(parsedData, clientConfig, summaryReport) {
    if (!parsedData || parsedData.length <= 1) {
      return { headers: (parsedData && parsedData[0]) || [], finalAlerts: [], rowsForExport: [], reasonsText: "" };
    }

    const headers = parsedData[0].map(h => (h != null ? String(h).trim() : ""));
    const reportRows = parsedData.slice(1);
    const clientName = clientConfig ? clientConfig.clientName : "_Desconocido_";
    const exceptions = (clientConfig && clientConfig.exceptions) || {};

    const stripAccents = (s) => String(s || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const normHeaders = headers.map(h => normalizarEncabezado(h));

    const findCol = (namePart) => {
      const target = stripAccents(namePart);
      let idx = headers.findIndex(h => stripAccents(h).includes(target));
      if (idx !== -1) return idx;
      return normHeaders.findIndex(h => stripAccents(h).includes(target));
    };

    let idxName = findCol("name") !== -1 ? findCol("name") : findCol("vm");
    let idxPolicy = findCol("pol") !== -1 ? findCol("pol") : findCol("policy");
    let idxCompliance = findCol("compliance") !== -1 ? findCol("compliance") : findCol("estado");
    let idxCluster = findCol("cluster");

    if (idxName === -1 || idxCompliance === -1) {
      summaryReport.errores.push({
        cliente: clientName,
        error: "Faltan columnas clave (Name o Compliance) en reporte de Políticas de vSAN.",
        detalle: "Encabezados recibidos: " + JSON.stringify(headers)
      });
      return null;
    }

    // Limpieza de fila total si viniera
    if (reportRows.length > 0) {
      const lastRow = reportRows[reportRows.length - 1];
      const firstCell = (lastRow && lastRow[0] != null) ? String(lastRow[0]).trim().toLowerCase() : "";
      if (firstCell === "total") {
        reportRows.pop();
      }
    }

    const finalAlerts = [];
    const detectedReasons = new Set();

    reportRows.forEach(row => {
      if (!row || row.length === 0 || row.join('').trim() === '') return;

      const vmName = (row[idxName] || "").toString().trim();
      if (!vmName) return;

      // Verificar excepciones del cliente desde el Índice Maestro
      let isExcepted = false;
      if (typeof isRowExcepted === 'function' && isRowExcepted(row, headers, exceptions)) {
        isExcepted = true;
      } else if (typeof findAllMatchingRules === 'function') {
        const matchedRules = findAllMatchingRules(row, headers, exceptions);
        isExcepted = matchedRules.some(r => !r.criterio || r.criterio === 'exceptuar' || r.criterio === 'ignorar');
      }

      if (isExcepted) {
        Logger.log(`[Políticas de vSAN] -> VM exceptuada por regla: ${vmName}`);
        return;
      }

      // Las VMs sin política ("-" o vacía) no residen en datastores vSAN y quedan fuera del alcance de esta operación.
      const policyVal = (idxPolicy !== -1 ? (row[idxPolicy] || "") : "").toString().trim();
      if (!policyVal || policyVal === "-") {
        return;
      }

      const complianceVal = (idxCompliance !== -1 ? (row[idxCompliance] || "") : "").toString().trim();
      const cLower = complianceVal.toLowerCase();

      let isAlert = false;

      // Compliance fuera de estado Compliant
      if (cLower === "out of date") {
        detectedReasons.add("Política de Storage desactualizada (Out of Date)");
        isAlert = true;
      } else if (cLower.includes("non-compliant") || cLower.includes("non compliant")) {
        detectedReasons.add("Política de Storage en incumplimiento (Non-Compliant)");
        isAlert = true;
      }

      if (isAlert) {
        const clusText = idxCluster !== -1 ? row[idxCluster] : "";
        Logger.log(`[Políticas de vSAN] -> Anomalía detectada en VM: ${vmName} (Compliance: ${complianceVal}, Política: ${policyVal}, Cluster: ${clusText})`);
        finalAlerts.push(row);
      }
    });

    const reasonsText = Array.from(detectedReasons).map(r => `* ${r}`).join('\n') || "Se detectaron VMs con políticas de almacenamiento fuera de norma.";
    this.finalAlerts = finalAlerts;
    this.reasonsText = reasonsText;

    return {
      headers: headers,
      finalAlerts: finalAlerts,
      rowsForExport: finalAlerts,
      reasonsText: reasonsText
    };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    let globalStatus = 'SUCCESS';
    const alertsToReport = [...(this.finalAlerts || finalAlerts || [])];
    const alertCount = alertsToReport.length;
    const reasonsFinal = this.reasonsText || reasonsText || "Se detectaron anomalías en políticas de vSAN.";

    if (alertCount === 0) {
      return this.handleNoAlerts(existingTicketKey, clientConfig, summaryReport);
    }

    const ticketKey = existingTicketKey || this.findExistingTicket(clientConfig);
    const newFileName = (attachmentName || "Auditoria de VM Storage Policies.csv").replace(/\.(xlsx|csv|xls|json)$/i, "") + ".xlsx";
    const xlsxBlob = convertDataToXlsxBlob([headers, ...alertsToReport], newFileName);

    if (ticketKey) {
      if (!haSidoActualizadoHoy(ticketKey, "ALERTA-POLITICAS-VSAN")) {
        let commentText = `**El problema persiste.** [ALERTA-POLITICAS-VSAN]\n\nSe detectaron ${alertCount} VMs con anomalías en políticas de vSAN:\n${reasonsFinal}\n\n`;
        if (alertCount <= POLITICAS_VSAN_ROW_LIMIT_FOR_TABLE) {
          if (xlsxBlob) {
            addAttachmentToJiraTicket(ticketKey, xlsxBlob);
            commentText += "Se adjunta reporte detallado.\n";
          }
          addCommentToJiraTicket(ticketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Ticket ${ticketKey} actualizado con comentario y adjunto.`, cliente: clientConfig.clientName });
        } else {
          if (xlsxBlob) {
            const attStatus = addAttachmentToJiraTicket(ticketKey, xlsxBlob);
            if (attStatus.status === 'SUCCESS') {
              commentText += "Se adjunta reporte detallado.";
              addCommentToJiraTicket(ticketKey, commentText);
              summaryReport.exitos.push({ mensaje: `Ticket ${ticketKey} actualizado con adjunto.`, cliente: clientConfig.clientName });
              const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName);
              if (accountIdAsignado) ticketInformativo(ticketKey, accountIdAsignado, summaryReport.timeGuard);
            } else {
              summaryReport.advertencias.push({ problema: "Fallo al adjuntar reporte en ticket.", accion: "Verificar permisos de Jira." });
              globalStatus = 'FAILURE';
            }
          } else {
            globalStatus = 'FAILURE';
          }
        }
      }
    } else {
      let summary, description;
      description = `Se detectaron ${alertCount} VMs con anomalías en políticas de almacenamiento vSAN:\n${reasonsFinal}\n\n`;
      if (alertCount <= POLITICAS_VSAN_ROW_LIMIT_FOR_TABLE) {
        summary = POLITICAS_VSAN_JIRA_TICKET_SUMMARY_TABLE;
        description += `|| ${headers.join(" || ")} ||\n`;
        alertsToReport.forEach(row => {
          description += `| ${row.map(c => (c != null ? String(c).trim() : "")).join(" | ")} |\n`;
        });
        const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, this.operationName);
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push({ mensaje: creationResult.detail.mensaje || JSON.stringify(creationResult.detail), cliente: clientConfig.clientName });
        } else {
          summaryReport.errores.push({ error: "Fallo al crear ticket en Jira", detalle: JSON.stringify(creationResult.detail), cliente: clientConfig.clientName });
          globalStatus = 'FAILURE';
        }
      } else {
        summary = POLITICAS_VSAN_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description += `Debido a la cantidad de registros (${alertCount} VMs), se adjunta el reporte detallado con las anomalías detectadas.`;
        const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, this.operationName);
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push({ mensaje: creationResult.detail.mensaje || JSON.stringify(creationResult.detail), cliente: clientConfig.clientName });
        } else {
          summaryReport.errores.push({ error: "Fallo al crear ticket en Jira", detalle: JSON.stringify(creationResult.detail), cliente: clientConfig.clientName });
          globalStatus = 'FAILURE';
        }
      }
    }

    if (globalStatus === 'SUCCESS' && this.scheduledTaskName) {
      buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    }
    return { status: globalStatus };
  }
}

function processPoliticasVSANEmails() {
  new PoliticasVSANProcessor().processEmails();
}
