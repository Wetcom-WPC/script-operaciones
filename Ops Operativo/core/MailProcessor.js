/**
 * @fileoverview MailProcessor base class.
 * Centraliza la lógica repetitiva de procesamiento de correos, parsing, chequeo de excepciones y comunicación con Jira.
 * Aplica el patrón Template Method.
 */

class MailProcessor {
  /**
   * @param {Object} config - Configuración base del procesador.
   * @param {String} config.operationName - Nombre de la operación para logs y Slack (ej. "VMs con snapshots").
   * @param {String} config.emailSubject - Asunto a buscar en Gmail.
   * @param {String} config.attachmentMatch - Substring para identificar el adjunto (opcional).
   * @param {String} config.scheduledTaskName - Nombre de la tarea programada a cerrar (opcional).
   */
  constructor(config) {
    this.operationName = config.operationName;
    this.emailSubject = config.emailSubject;
    this.attachmentMatch = config.attachmentMatch;
    this.scheduledTaskName = config.scheduledTaskName;
    this.ticketSummary = config.ticketSummary; // NEW: For generic handleAlerts
  }

  /**
   * Punto de entrada principal. Orquesta la búsqueda y el procesamiento.
   */
  processEmails() {
    const timeGuard = new TimeGuard({ operationName: this.operationName });
    const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0, timeGuard: timeGuard };
    const threads = fetchAndFilterGlobalThreads(this.emailSubject);
    
    if (threads.length > 0) {
      for (const thread of threads) {
        // --- TIME GUARD ---
        if (!timeGuard.check(`Thread ${thread.getId()}`)) {
          summaryReport.advertencias.push({
            ticketKey: "N/A",
            problema: "Límite de tiempo de ejecución alcanzado o margen <30s (TimeGuard).",
            accion: "Se pausó la ejecución por seguridad y se notificó la traza a Slack. El resto de los correos en la bandeja se procesarán en la próxima ejecución."
          });
          break; // Sale del loop limpiamente
        }

        const message = thread.getMessages()[thread.getMessageCount() - 1];
        try {
          const result = this.processSingleMessage(message, summaryReport);
          const status = result ? result.status : 'ERROR';
          etiquetarYMarcarProcesado(thread, status);
        } catch (e) {
          summaryReport.errores.push({ 
            error: `Error Crítico en Script: ${e.message}`, 
            detalle: `Correo: "${message.getSubject()}" | Stack: ${e.stack}` 
          });
          etiquetarYMarcarProcesado(thread, 'ERROR');
        }
      }
    }
    
    enviarResumenSlack(this.operationName, summaryReport);
    
    // --- BATCHED WRITES (FLUSH) ---
    if (typeof flushLogs === "function") {
      flushLogs();
    }
  }

  /**
   * Procesa un único mensaje de correo. Aplica el Template Method.
   */
  processSingleMessage(message, summaryReport) {
    const errorCountBefore = summaryReport.errores.length;
    let clientName = "_Desconocido_";
    try {
      Logger.log(`--- Procesando: "${message.getSubject()}" ---`);
      const senderEmail = message.getFrom();
      
      const attachments = message.getAttachments();
      Logger.log(`[DEBUG MAIL] Encontrados ${attachments.length} adjuntos en el correo.`);
      attachments.forEach(att => {
        Logger.log(`  - Adjunto: "${att.getName()}" | Tipo: "${att.getContentType()}"`);
      });
      
      const attachment = this.findAttachment(message);
      if (!attachment) {
        Logger.log(`[DEBUG MAIL] NO_OP: No se encontró ningún adjunto válido que coincida con la palabra clave "${this.attachmentMatch}".`);
        return { status: 'NO_OP' };
      }

      let clientConfig = getClientConfig(senderEmail, this.operationName);
      clientConfig = this.resolveClientConfig(clientConfig, senderEmail, attachment, message, summaryReport);
      
      if (!clientConfig) {
        summaryReport.errores.push({ error: 'Error de Configuración', detalle: `No se encontró config para: ${senderEmail}` });
        enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
        return { status: 'ERROR' };
      }

      clientName = clientConfig.clientName;

      const parsedData = this.parseAttachment(attachment, summaryReport);
      if (!parsedData || this.isDataEmpty(parsedData)) {
        enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
        return { status: 'SUCCESS' };
      }

      const processed = this.processData(parsedData, clientConfig, summaryReport);
      if (!processed) {
        enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
        return { status: 'FAILURE' };
      }

      const { headers, finalAlerts, rowsForExport, reasonsText } = processed;
      const existingTicketKey = this.findExistingTicket(clientConfig);

      let result;
      if (finalAlerts.length === 0) {
        result = this.handleNoAlerts(existingTicketKey, clientConfig, summaryReport);
      } else {
        result = this.handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachment.getName(), attachment);
      }
      
      enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
      return result;

    } catch (e) {
      summaryReport.errores.push({ 
        cliente: clientName,
        error: `Error Crítico: ${e.message}`, 
        detalle: `Fallo durante el procesamiento del correo. Stack: ${e.stack}`
      });
      enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
      return { status: 'FAILURE' };
    }
  }

  // ==========================================
  // HOOKS (Métodos a sobrescribir por subclases)
  // ==========================================

  findAttachment(message) {
    return message.getAttachments().find(att => {
      const nameLower = att.getName().toLowerCase().replace(/-/g, ' ');
      const matchLower = this.attachmentMatch ? this.attachmentMatch.toLowerCase().replace(/-/g, ' ') : '';
      const nameMatch = this.attachmentMatch ? nameLower.includes(matchLower) : true;
      
      // Robustez para tipos de archivo CSV, Excel (.xlsx, .xls), JSON y TXT
      const contentType = att.getContentType().toLowerCase();
      const typeMatch = contentType.includes("csv") || 
                        contentType.includes("excel") || 
                        contentType.includes("spreadsheet") || 
                        contentType.includes("json") || 
                        contentType.includes("plain") || 
                        nameLower.endsWith(".csv") || 
                        nameLower.endsWith("xlsx") || 
                        nameLower.endsWith("xls") ||
                        nameLower.endsWith("json") ||
                        nameLower.endsWith(".txt");
                        
      return nameMatch && typeMatch;
    });
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    try {
      let csvData = attachment.getDataAsString("UTF-8");
      
      // Limpieza automática de filas totalmente envueltas en comillas (bug de exportación)
      const lines = csvData.split(/\r\n|\n|\r/);
      const cleanedLines = lines.map(line => {
        let clean = line.trim();
        if (clean.startsWith('"') && clean.endsWith('"')) {
          clean = clean.substring(1, clean.length - 1).replace(/""/g, '"');
        }
        return clean;
      });
      csvData = cleanedLines.join("\n");

      const firstLine = csvData.split(/\n/)[0];
      const separator = firstLine.includes(";") ? ";" : ",";
      return parseCsvRobust(csvData, separator);
    } catch (e) {
      summaryReport.errores.push({ error: "Error parseando CSV", detalle: e.message });
      return null;
    }
  }

  isDataEmpty(parsedData) {
    return !parsedData || parsedData.length <= 1; // Solo headers o vacío
  }

  /**
   * @returns {Object} { headers, finalAlerts, rowsForExport, reasonsText }
   */
  processData(parsedData, clientConfig, summaryReport) {
    throw new Error("processData() debe ser implementado por la subclase.");
  }

  findExistingTicket(clientConfig) {
    throw new Error("findExistingTicket() debe ser implementado por la subclase.");
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El reporte está limpio.");
      summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName, attachmentBlob = null) {
    if (!this.ticketSummary) {
      throw new Error("handleAlerts() debe ser implementado por la subclase, o bien proveer 'ticketSummary' en la configuración base.");
    }
    
    const alertCount = finalAlerts.length;
    const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
    const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);

    if (existingTicketKey) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attachmentResult.status === 'SUCCESS') {
        const commentText = `🚨 **El problema persiste.** Se adjunta el reporte actualizado con **${alertCount}** objetos afectados.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
        if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado, summaryReport.timeGuard);
        
        summaryReport.exitos.push({ mensaje: `Anomalía Persiste. Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
      } else {
        summaryReport.errores.push(attachmentResult.detail || { error: "Fallo al adjuntar." });
      }
    } else {
      const description = `Se encontraron ${alertCount} alertas. Se adjunta el reporte completo para su revisión.`;
      const creationResult = createTicketAndNotify(this.ticketSummary, description, xlsxBlob, clientConfig, this.operationName);
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else {
        summaryReport.errores.push(creationResult.detail);
      }
    }
    
    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    return { status: 'SUCCESS' };
  }
}

/**
 * Enriquece la lista de errores agregando el nombre de cliente a aquellos
 * que no lo tienen registrado aún en un rango de índices.
 */
function enrichErrorsWithClient(errores, startIndex, clientName) {
  for (let i = startIndex; i < errores.length; i++) {
    if (!errores[i].cliente) {
      errores[i].cliente = clientName;
    }
  }
}
