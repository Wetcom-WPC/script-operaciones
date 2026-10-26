/**
 * @fileoverview Lógica específica para procesar reportes de "Proxies con snapshots".
 * Consume la configuración del cliente desde el Índice Maestro.
 * Reporta todo proxy de backup con snapshot directamente como alerta de Operaciones (Ops).
 */

// --- CONFIGURACIÓN ESPECÍFICA ---
const PROXIES_OPERATION_NAME = "Proxies con snapshots";
const PROXIES_EMAIL_SUBJECT = "Proxies con snapshots";
const PROXIES_FILENAME_MATCH = "Proxies con snapshots";
const PROXIES_SCHEDULED_TASK_NAME_TO_CLOSE = "Proxies con snapshots";
const PROXIES_ROW_LIMIT_FOR_TABLE = 10;
const PROXIES_COLUMNA_TAMANO = "Tamaño del snapshot";
const PROXIES_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Proxies con Snapshots";
const PROXIES_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron Proxies con Snapshots";

/**
 * Summary del ticket de alerta, respetando el lado AVS del reporte si aplica.
 */
function summaryProxiesSegunAVS(base, clientConfig) {
  return typeof nombreTareaSegunAVS === 'function' ? nombreTareaSegunAVS(base, clientConfig) : base;
}

class ProxiesConSnapshotsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: PROXIES_OPERATION_NAME,
      emailSubject: PROXIES_EMAIL_SUBJECT,
      attachmentMatch: PROXIES_FILENAME_MATCH,
      scheduledTaskName: PROXIES_SCHEDULED_TASK_NAME_TO_CLOSE,
      ticketSummary: PROXIES_JIRA_TICKET_SUMMARY_TABLE
    });
  }

  processSingleMessage(message, summaryReport) {
    this._currentSenderEmail = message.getFrom();
    const emailSubject = message.getSubject();

    // Caso de éxito sin anomalías (asunto incluye SUCCESS)
    if (emailSubject.toLowerCase().includes("success")) {
      const senderEmail = message.getFrom();
      const clientConfig = this.resolveClientConfig(null, senderEmail, null, message, summaryReport);
      if (clientConfig) {
        summaryReport.exitos.push({
          cliente: clientConfig.clientName,
          mensaje: `Reporte de ${clientConfig.clientName} recibido con (SUCCESS). No se detectaron proxies con snapshots fuera de norma.`
        });
        if (this.scheduledTaskName) {
          buscarYCerrarTareaProgramada(summaryProxiesSegunAVS(this.scheduledTaskName, clientConfig), clientConfig, false);
        }
        const nombreArchivo = this.operationName + " - OK.txt";
        this.extractedBlobs = [Utilities.newBlob("Reporte procesado exitosamente sin alertas.", "text/plain", nombreArchivo)];
        this.ejecutarPasoDrive(message, clientConfig.clientName, summaryReport, { status: 'SUCCESS' });
      }
      return { status: 'SUCCESS' };
    }

    return super.processSingleMessage(message, summaryReport);
  }

  // Soportar adjuntos que vengan en formato JSON array, CSV o XLSX
  parseAttachment(attachment, summaryReport) {
    try {
      const rawText = attachment.getDataAsString("UTF-8");
      const trimmed = (rawText || "").replace(/^\uFEFF/, '').trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsedJson = JSON.parse(trimmed);
          const arr = Array.isArray(parsedJson) ? parsedJson : (parsedJson.Report || parsedJson.items || parsedJson.data || []);
          if (Array.isArray(arr)) {
            if (arr.length === 0) return [["Name", "Snapshot_Name", "Number_Days_Old", "Snapshot_Space", "Number_Snapshots", "Total_Capacity"]];
            const keys = Object.keys(arr[0]);
            const headerMap = {
              name: "Name",
              snapshotname: "Snapshot_Name",
              age: "Number_Days_Old",
              space: "Snapshot_Space",
              cantidad: "Number_Snapshots",
              totalcapacity: "Total_Capacity"
            };
            const headers = keys.map(k => headerMap[k.toLowerCase()] || k);
            const rows = arr.map(obj => keys.map(k => obj[k] != null ? String(obj[k]) : ""));
            return [headers, ...rows];
          }
        } catch (jsonErr) {
          // Si no es JSON válido, continúa al parseo CSV estándar
        }
      }
      return parseCsvDeReporte(rawText);
    } catch (e) {
      summaryReport.errores.push({ error: "Error parseando adjunto", detalle: e.message });
      return null;
    }
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (!config) {
      config = getClientConfig(sender, this.operationName);
    }
    if (config) {
      config.senderEmail = sender;
    }
    this._currentSenderEmail = sender;
    const esAVS = esReporteAVS(message ? message.getSubject() : '', attachment);

    if (config) {
      config.isAVS = esAVS;
      if (esAVS && !config.jiraProjectKeyAVS) {
        summaryReport.advertencias.push(`El cliente "${config.clientName}" tiene reporte AVS de Proxies con snapshots pero no tiene configurado Proyecto Jira AVS.`);
      }
    }
    return config;
  }

  processData(parsedData, clientConfig, summaryReport) {
    if (!parsedData || parsedData.length <= 1) {
      return { headers: (parsedData && parsedData[0]) || [], finalAlerts: [], rowsForExport: [], reasonsText: "" };
    }

    const headers = parsedData[0].map(h => (h != null ? String(h).trim() : ""));
    const reportRows = parsedData.slice(1);

    const clientName = clientConfig ? clientConfig.clientName : "_Desconocido_";
    const exceptions = ClientConfigService.getExceptions(clientName, this.operationName);

    const normHeaders = headers.map(h => normalizarEncabezado(h));
    const findCol = (name) => {
      const idx = headers.indexOf(name);
      return idx !== -1 ? idx : normHeaders.indexOf(normalizarEncabezado(name));
    };

    let idxName = findCol("Name") !== -1 ? findCol("Name") : findCol("VM");
    let idxSpace = findCol("Snapshot_Space") !== -1 ? findCol("Snapshot_Space") : findCol("Space");
    let idxAge = findCol("Number_Days_Old") !== -1 ? findCol("Number_Days_Old") : findCol("Age");
    let idxCount = findCol("Number_Snapshots") !== -1 ? findCol("Number_Snapshots") : findCol("Cantidad");
    let idxSnapshotName = findCol("Snapshot_Name");

    if (idxName === -1) {
      summaryReport.errores.push({ error: "Falta columna Name en reporte de Proxies con snapshots." });
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

    if (!headers.includes(PROXIES_COLUMNA_TAMANO)) {
      headers.push(PROXIES_COLUMNA_TAMANO);
    }

    const unidadEspacio = idxSpace !== -1 ? detectarUnidadTamano(headers[idxSpace]) : 'GB';
    const formatearTamanoDesdeGB = (spaceGB) => {
      if (spaceGB === null || isNaN(spaceGB) || spaceGB === undefined) return "";
      if (spaceGB < 1 && spaceGB > 0) {
        const mb = spaceGB * 1024;
        return `${Number(mb.toFixed(2))} MB`;
      }
      return `${Number(spaceGB.toFixed(2))} GB`;
    };

    const opsAlerts = [];
    const detectedReasonsOps = new Set();

    reportRows.forEach(row => {
      if (!row || row.length === 0 || row.join('').trim() === '') return;

      const vmName = (row[idxName] || "").toString().trim();
      if (!vmName) return;

      let spaceGB = 0;
      if (idxSpace !== -1) {
        let rawSpace = parseSeguro(row[idxSpace]);
        if (unidadEspacio === 'MB') rawSpace = rawSpace / 1024;
        else if (unidadEspacio === 'TB') rawSpace = rawSpace * 1024;
        spaceGB = rawSpace;
      }

      row.push(formatearTamanoDesdeGB(spaceGB));

      // Verificar si hay reglas de excepción personalizadas para este proxy en la planilla de excepciones
      const matchedRules = typeof findAllMatchingRules === 'function' ? findAllMatchingRules(row, headers, exceptions) : [];
      const isExcepted = matchedRules.some(r => r.criterio === 'exceptuar');

      if (isExcepted) {
        Logger.log(`[Proxies con snapshots] -> Proxy exceptuado por regla personalizada: ${vmName}`);
        return;
      }

      // Regla de Negocio: Todo proxy de backup con snapshot activo es una anomalía para Operaciones (Ops)
      detectedReasonsOps.add("Snapshot activo en Proxy de Backup (no tolerado)");
      Logger.log(`[Proxies con snapshots] -> Proxy con snapshot asignado a OPS: ${vmName}`);
      opsAlerts.push(row);
    });

    const reasonsText = Array.from(detectedReasonsOps).join("\n") || "Se detectaron proxies de backup con snapshots activos.";
    this.opsAlerts = opsAlerts;
    this.opsReasonsText = reasonsText;

    return {
      headers: headers,
      finalAlerts: opsAlerts,
      rowsForExport: opsAlerts,
      reasonsText: reasonsText
    };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    let globalStatus = 'SUCCESS';
    const opsAlertsFinal = [...(this.opsAlerts || finalAlerts || [])];
    const opsReasonsFinal = this.opsReasonsText || reasonsText || "Se detectaron proxies de backup con snapshots activos.";

    if (opsAlertsFinal.length === 0) {
      return this.handleNoAlerts(existingTicketKey, clientConfig, summaryReport);
    }

    const clientConfigOps = (typeof getClientConfigByName === 'function' ? getClientConfigByName(clientConfig.clientName, this.operationName) : null) || clientConfig;
    if (clientConfig.isAVS) clientConfigOps.isAVS = true;

    const existingTicketKeyOps = existingTicketKey ||
                                 findExistingJiraTicket(summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_TABLE, clientConfigOps), clientConfigOps.jiraProjectKey) ||
                                 findExistingJiraTicket(summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfigOps), clientConfigOps.jiraProjectKey);

    const nombreReporteOps = attachmentName.replace(/\.(xlsx|csv|xls|json)$/i, "") + "-OPS.xlsx";
    const xlsxBlobOps = convertDataToXlsxBlob([headers, ...opsAlertsFinal], nombreReporteOps);
    if (xlsxBlobOps) {
      this.extractedBlobs = this.extractedBlobs || [];
      this.extractedBlobs.push(xlsxBlobOps);
    }

    if (existingTicketKeyOps) {
      if (!haSidoActualizadoHoy(existingTicketKeyOps, "ALERTA-PROXIES-OPS")) {
        let commentText = `⏳ **El problema persiste.** [HU-ALERTA-PROXIES-OPS]\n\nSe detectaron ${opsAlertsFinal.length} Proxies fuera de norma:\n${opsReasonsFinal}\n\n`;
        if (opsAlertsFinal.length <= PROXIES_ROW_LIMIT_FOR_TABLE) {
          if (xlsxBlobOps) {
            addAttachmentToJiraTicket(existingTicketKeyOps, xlsxBlobOps);
            commentText += "Se adjunta reporte detallado.\n";
          }
          addCommentToJiraTicket(existingTicketKeyOps, commentText);
          summaryReport.exitos.push({ mensaje: `Ticket OPS ${existingTicketKeyOps} actualizado con comentario y adjunto.`, cliente: clientConfigOps.clientName });
        } else {
          if (xlsxBlobOps) {
            const attStatus = addAttachmentToJiraTicket(existingTicketKeyOps, xlsxBlobOps);
            if (attStatus.status === 'SUCCESS') {
              commentText += "Se adjunta reporte detallado.";
              addCommentToJiraTicket(existingTicketKeyOps, commentText);
              summaryReport.exitos.push({ mensaje: `Ticket OPS ${existingTicketKeyOps} actualizado con adjunto.`, cliente: clientConfigOps.clientName });
              const accountIdAsignado = chequearSiEsInformativa(clientConfigOps.clientName, this.operationName);
              if (accountIdAsignado) ticketInformativo(existingTicketKeyOps, accountIdAsignado, summaryReport.timeGuard);
            } else {
              summaryReport.advertencias.push({ problema: "Fallo al adjuntar reporte en ticket Ops.", accion: "Verificar permisos de Jira." });
              globalStatus = 'FAILURE';
            }
          } else {
            globalStatus = 'FAILURE';
          }
        }
      }
    } else {
      let summary, description;
      description = `Se detectaron ${opsAlertsFinal.length} Proxies con snapshots activos (Ops):\n${opsReasonsFinal}\n\n`;
      if (opsAlertsFinal.length <= PROXIES_ROW_LIMIT_FOR_TABLE) {
        summary = summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_TABLE, clientConfigOps);
        description += `|| ${headers.join(" || ")} ||\n`;
        opsAlertsFinal.forEach(row => {
          description += `| ${row.map(c => (c != null ? String(c).trim() : "")).join(" | ")} |\n`;
        });
        const creationResult = createTicketAndNotify(summary, description, xlsxBlobOps, clientConfigOps, this.operationName);
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push({ mensaje: "Ops: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)), cliente: clientConfigOps.clientName });
        } else {
          globalStatus = 'FAILURE';
        }
      } else {
        summary = summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfigOps);
        description += `Debido a la cantidad de registros, se adjunta el reporte detallado.`;
        const creationResult = createTicketAndNotify(summary, description, xlsxBlobOps, clientConfigOps, this.operationName);
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push({ mensaje: "Ops: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)), cliente: clientConfigOps.clientName });
        } else {
          globalStatus = 'FAILURE';
        }
      }
    }

    if (globalStatus === 'SUCCESS' && this.scheduledTaskName) {
      buscarYCerrarTareaProgramada(summaryProxiesSegunAVS(this.scheduledTaskName, clientConfig), clientConfig, false);
    }
    return { status: globalStatus };
  }
}

function processProxiesSnapshotsEmails() {
  new ProxiesConSnapshotsProcessor().processEmails();
}
