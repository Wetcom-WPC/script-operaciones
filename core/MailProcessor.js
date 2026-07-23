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
  }

  /**
   * Punto de entrada principal. Orquesta la búsqueda y el procesamiento.
   */
  processEmails() {
    const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
    const searchQuery = construirBusquedaGmail(this.emailSubject);
    const threads = GmailApp.search(searchQuery);

    if (threads.length > 0) {
      threads.forEach(thread => {
        const message = thread.getMessages()[thread.getMessageCount() - 1];
        if (message.isUnread()) {
          try {
            const result = this.processSingleMessage(message, summaryReport);
            
            // Unificamos el manejo de respuesta de las subclases
            if (result && result.status !== 'HTTP_500' && result.status !== 'NO_OP' && result.status !== 'FAILURE') {
              thread.markRead();
            }
          } catch (e) {
            summaryReport.errores.push({ 
              error: `Error Crítico en Script: ${e.message}`, 
              detalle: `Correo: "${message.getSubject()}" | Stack: ${e.stack}` 
            });
          }
        }
      });
    }
    
    enviarResumenSlack(this.operationName, summaryReport);
  }

  /**
   * Procesa un único mensaje de correo. Aplica el Template Method.
   */
  processSingleMessage(message, summaryReport) {
    Logger.log(`--- Procesando: "${message.getSubject()}" ---`);
    const senderEmail = message.getFrom();
    
    const attachment = this.findAttachment(message);
    if (!attachment) return { status: 'NO_OP' };

    let clientConfig = getClientConfig(senderEmail, this.operationName);
    clientConfig = this.resolveClientConfig(clientConfig, senderEmail, attachment, message, summaryReport);
    
    if (!clientConfig) {
      summaryReport.errores.push({ error: 'Error de Configuración', detalle: `No se encontró config para: ${senderEmail}` });
      return { status: 'ERROR' };
    }

    const parsedData = this.parseAttachment(attachment, summaryReport);
    if (!parsedData || this.isDataEmpty(parsedData)) return { status: 'SUCCESS' };

    const processed = this.processData(parsedData, clientConfig, summaryReport);
    if (!processed) return { status: 'FAILURE' };

    const { headers, finalAlerts, rowsForExport, reasonsText } = processed;
    const existingTicketKey = this.findExistingTicket(clientConfig);

    if (finalAlerts.length === 0) {
      return this.handleNoAlerts(existingTicketKey, clientConfig, summaryReport);
    } else {
      return this.handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachment.getName());
    }
  }

  // ==========================================
  // HOOKS (Métodos a sobrescribir por subclases)
  // ==========================================

  findAttachment(message) {
    return message.getAttachments().find(att => {
      const nameMatch = this.attachmentMatch ? att.getName().includes(this.attachmentMatch) : true;
      const typeMatch = att.getContentType().includes("csv") || att.getContentType().includes("excel") || att.getName().endsWith(".csv");
      return nameMatch && typeMatch;
    });
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    try {
      const csvData = attachment.getDataAsString("UTF-8");
      const firstLine = csvData.split(/\r\n|\n|\r/)[0];
      const separator = firstLine.includes(";") ? ";" : ",";
      return Utilities.parseCsv(csvData, separator);
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

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    throw new Error("handleAlerts() debe ser implementado por la subclase.");
  }
}
