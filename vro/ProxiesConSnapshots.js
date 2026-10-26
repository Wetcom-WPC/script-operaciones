/**
 * @fileoverview Lógica específica para procesar reportes de "Proxies con snapshots".
 * Consume la configuración del cliente desde el Índice Maestro.
 * Reporta todo proxy de backup con snapshot directamente como alerta en Operaciones.
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
        summaryReport.advertencias.push({
          cliente: config.clientName,
          problema: `El cliente "${config.clientName}" tiene reporte AVS de Proxies con snapshots pero no tiene configurado Proyecto Jira AVS.`,
          accion: "Configurar la columna AVS en el Índice Maestro si corresponde."
        });
      }
    }
    return config;
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_TABLE, clientConfig), clientConfig.jiraProjectKey) ||
           findExistingJiraTicket(summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig), clientConfig.jiraProjectKey);
  }

  processData(parsedData, clientConfig, summaryReport) {
    if (!parsedData || parsedData.length <= 1) {
      return { headers: (parsedData && parsedData[0]) || [], finalAlerts: [], rowsForExport: [], reasonsText: "" };
    }

    const headers = parsedData[0].map(h => (h != null ? String(h).trim() : ""));
    const reportRows = parsedData.slice(1);

    const clientName = clientConfig ? clientConfig.clientName : "_Desconocido_";
    const exceptions = (clientConfig && clientConfig.exceptions) || {};

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
      summaryReport.errores.push({
        cliente: clientName,
        error: "Falta columna Name en reporte de Proxies con snapshots.",
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

    if (!headers.includes(PROXIES_COLUMNA_TAMANO)) {
      headers.push(PROXIES_COLUMNA_TAMANO);
    }

    const unidadEspacio = idxSpace !== -1 ? unidadDelEncabezado(headers[idxSpace]) : '';

    const finalAlerts = [];
    const detectedReasons = new Set();

    reportRows.forEach(row => {
      if (!row || row.length === 0 || row.join('').trim() === '') return;

      const vmName = (row[idxName] || "").toString().trim();
      if (!vmName) return;

      const spaceGB = idxSpace !== -1 ? parseTamanoAGB(row[idxSpace], unidadEspacio) : 0;
      row.push(formatearTamanoDesdeGB(spaceGB));

      // Verificar si hay reglas de excepción para este proxy en la planilla de excepciones
      let isExcepted = false;
      if (typeof isRowExcepted === 'function' && isRowExcepted(row, headers, exceptions)) {
        isExcepted = true;
      } else if (typeof findAllMatchingRules === 'function') {
        const matchedRules = findAllMatchingRules(row, headers, exceptions);
        isExcepted = matchedRules.some(r => !r.criterio || r.criterio === 'exceptuar' || r.criterio === 'ignorar');
      }

      if (isExcepted) {
        Logger.log(`[Proxies con snapshots] -> Proxy exceptuado por regla personalizada: ${vmName}`);
        return;
      }

      // Regla de Negocio: Todo proxy de backup con snapshot activo es una anomalía
      detectedReasons.add("Snapshot activo en Proxy de Backup (no tolerado)");
      Logger.log(`[Proxies con snapshots] -> Proxy con snapshot detectado: ${vmName}`);
      finalAlerts.push(row);
    });

    const reasonsText = Array.from(detectedReasons).join("\n") || "Se detectaron proxies de backup con snapshots activos.";
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
    const reasonsFinal = this.reasonsText || reasonsText || "Se detectaron proxies de backup con snapshots activos.";

    if (alertCount === 0) {
      return this.handleNoAlerts(existingTicketKey, clientConfig, summaryReport);
    }

    const ticketKey = existingTicketKey || this.findExistingTicket(clientConfig);

    const newFileName = (attachmentName || "Proxies con snapshots.csv").replace(/\.(xlsx|csv|xls|json)$/i, "") + ".xlsx";
    const xlsxBlob = convertDataToXlsxBlob([headers, ...alertsToReport], newFileName);

    if (ticketKey) {
      if (!haSidoActualizadoHoy(ticketKey, "ALERTA-PROXIES")) {
        let commentText = `⏳ **El problema persiste.** [ALERTA-PROXIES]\n\nSe detectaron ${alertCount} proxies con snapshots activos:\n${reasonsFinal}\n\n`;
        if (alertCount <= PROXIES_ROW_LIMIT_FOR_TABLE) {
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
      description = `Se detectaron ${alertCount} Proxies con snapshots activos:\n${reasonsFinal}\n\n`;
      if (alertCount <= PROXIES_ROW_LIMIT_FOR_TABLE) {
        summary = summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_TABLE, clientConfig);
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
        summary = summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig);
        description += `Debido a la cantidad de registros, se adjunta el reporte detallado.`;
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
      buscarYCerrarTareaProgramada(summaryProxiesSegunAVS(this.scheduledTaskName, clientConfig), clientConfig, false);
    }
    return { status: globalStatus };
  }
}

function processProxiesSnapshotsEmails() {
  new ProxiesConSnapshotsProcessor().processEmails();
}
