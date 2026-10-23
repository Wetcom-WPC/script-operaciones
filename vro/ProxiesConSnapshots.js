/**
 * @fileoverview Lógica específica para procesar reportes de "Proxies con snapshots".
 * Refactorizado utilizando la clase base MailProcessor.
 */

// --- CONFIGURACIÓN ESPECÍFICA ---
const PROXIES_OPERATION_NAME = "Proxies con snapshots";
const PROXIES_EMAIL_SUBJECT = "Proxies con snapshots";
const PROXIES_FILENAME_MATCH = "Proxies con snapshots";
const PROXIES_SCHEDULED_TASK_NAME_TO_CLOSE = "Proxies con snapshots";
const PROXIES_ROW_LIMIT_FOR_TABLE = 5;
const PROXIES_COLUMNA_TAMANO = "Tamaño del snapshot";
const PROXIES_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Proxies con Snapshots";
const PROXIES_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron Proxies con Snapshots";

/**
 * Summary del ticket de alerta, respetando el lado AVS del reporte.
 */
function summaryProxiesSegunAVS(base, clientConfig) {
  return nombreTareaSegunAVS(base, clientConfig);
}

class ProxiesConSnapshotsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: PROXIES_OPERATION_NAME,
      emailSubject: PROXIES_EMAIL_SUBJECT,
      attachmentMatch: PROXIES_FILENAME_MATCH,
      scheduledTaskName: PROXIES_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  // Soportar adjuntos que vengan en formato JSON array o CSV
  parseAttachment(attachment, summaryReport) {
    try {
      const rawText = attachment.getDataAsString("UTF-8");
      const trimmed = (rawText || "").replace(/^\uFEFF/, '').trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsedJson = JSON.parse(trimmed);
          const arr = Array.isArray(parsedJson) ? parsedJson : (parsedJson.Report || parsedJson.items || parsedJson.data || []);
          if (Array.isArray(arr)) {
            if (arr.length === 0) return [["Name", "Snapshot_Name", "Number_Days_Old", "Snapshot_Space", "Number_Snapshots", "Total_Capacity", "Custom_Attribute"]];
            const keys = Object.keys(arr[0]);
            const headerMap = {
              name: "Name",
              snapshotname: "Snapshot_Name",
              age: "Number_Days_Old",
              space: "Snapshot_Space",
              cantidad: "Number_Snapshots",
              totalcapacity: "Total_Capacity",
              customattribute: "Custom_Attribute",
              vcenter: "Parent vCenter",
              cluster: "Parent Cluster"
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

  processSingleMessage(message, summaryReport) {
    this._currentSenderEmail = message.getFrom();
    return super.processSingleMessage(message, summaryReport);
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
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

  processData(data, headers, summaryReport) {
    if (!data || data.length === 0) {
      return { status: 'SUCCESS', alerts: [] };
    }

    const clientConfig = this.currentClientConfig;
    if (!clientConfig) {
      summaryReport.advertencias.push("No se pudo obtener la configuración del cliente.");
      return { status: 'FAILURE' };
    }

    const clientName = clientConfig.clientName;
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
    let idxCustomAttr = findCol("Custom_Attribute");
    if (idxCustomAttr === -1) idxCustomAttr = findCol("Custom Attribute");

    if (idxName === -1 || idxSpace === -1) {
      summaryReport.advertencias.push("Faltan columnas requeridas (Name o Space).");
      return { status: 'FAILURE' };
    }

    // Limpieza de fila total si viniera
    const lastRow = data[data.length - 1];
    if (lastRow && (lastRow[idxName] || "").toLowerCase().trim() === "total") {
      data.pop();
    }

    headers.push(PROXIES_COLUMNA_TAMANO);

    const unidadEspacio = detectarUnidadTamano(headers[idxSpace]);
    const formatearTamanoDesdeGB = (spaceGB) => {
      if (spaceGB === null || isNaN(spaceGB)) return "";
      if (spaceGB < 1) {
        const mb = spaceGB * 1024;
        return `${Number(mb.toFixed(2))} MB`;
      }
      return `${Number(spaceGB.toFixed(2))} GB`;
    };

    this.opsAlerts = [];
    const detectedReasonsOps = new Set();

    data.forEach(row => {
      const vmName = (row[idxName] || "").trim();
      if (!vmName) return;

      const rawSpace = row[idxSpace];
      let space = parseSeguro(rawSpace);
      if (unidadEspacio === 'MB' && space !== null) space = space / 1024;
      else if (unidadEspacio === 'TB' && space !== null) space = space * 1024;

      row.push(formatearTamanoDesdeGB(space));

      // Verificar si hay reglas de excepción personalizadas para este proxy
      const matchedRules = typeof findAllMatchingRules === 'function' ? findAllMatchingRules(row, headers, exceptions) : [];
      const isExcepted = matchedRules.some(r => r.criterio === 'exceptuar');

      if (isExcepted) {
        Logger.log(`[DEBUG EVAL] -> Proxy exceptuado por regla personalizada: ${vmName}`);
        return; // Ignorar alerta
      }

      // Regla de Negocio: Todo proxy de backup con snapshot activo es una alerta inmediata para Operaciones
      detectedReasonsOps.add("Snapshot en Proxy de Backup detectado (no tolerado)");
      Logger.log(`[DEBUG EVAL] -> Proxy con snapshot asignado a OPS: ${vmName}`);
      this.opsAlerts.push(row);
    });

    this.opsReasonsText = Array.from(detectedReasonsOps).join("\n");
    return { status: 'SUCCESS', alerts: this.opsAlerts };
  }

  handleAlerts(existingTicketKeyIgnored, clientConfig_Ignored, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    let globalStatus = 'SUCCESS';
    const opsAlertsFinal = [...(this.opsAlerts || [])];
    const opsReasonsFinal = this.opsReasonsText || "Se detectaron proxies de backup con snapshots activos.";

    if (opsAlertsFinal.length > 0) {
      const clientConfigOps = getClientConfigByName(clientConfig_Ignored.clientName, this.operationName) || clientConfig_Ignored;
      if (clientConfig_Ignored.isAVS) clientConfigOps.isAVS = true;

      const existingTicketKeyOps = findExistingJiraTicket(summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_TABLE, clientConfigOps), clientConfigOps.jiraProjectKey) ||
                                   findExistingJiraTicket(summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfigOps), clientConfigOps.jiraProjectKey);
      
      const rowsExp = [...opsAlertsFinal];
      const nombreReporteOps = attachmentName.replace(/\.(xlsx|csv|xls|json)$/i, "") + "-OPS.xlsx";
      const xlsxBlobOps = convertDataToXlsxBlob([headers, ...rowsExp], nombreReporteOps);
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
        description = `Se detectaron ${opsAlertsFinal.length} Proxies con snapshots activos (Ops):\n${opsReasonsFinal}\n\n`;
        if (opsAlertsFinal.length <= PROXIES_ROW_LIMIT_FOR_TABLE) {
          summary = summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_TABLE, clientConfigOps);
          description += `|| ${headers.join(" || ")} ||\n`;
          opsAlertsFinal.forEach(row => description += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
          const creationResult = createTicketAndNotify(summary, description, xlsxBlobOps, clientConfigOps, this.operationName);
          if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Ops: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
          else globalStatus = 'FAILURE';
        } else {
          summary = summaryProxiesSegunAVS(PROXIES_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfigOps);
          description += `Debido a la cantidad de registros, se adjunta el reporte.`;
          const creationResult = createTicketAndNotify(summary, description, xlsxBlobOps, clientConfigOps, this.operationName);
          if (creationResult.status === 'SUCCESS') summaryReport.exitos.push({ mensaje: "Ops: " + (creationResult.detail.mensaje || JSON.stringify(creationResult.detail)) });
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

function processProxiesSnapshotsEmails() {
  new ProxiesConSnapshotsProcessor().processEmails();
}
