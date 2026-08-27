/**
 * @fileoverview Processor para las validaciones operativas diarias de Nutanix.
 */

const NTX_OPERATION_NAME = "Operaciones Nutanix";
const NTX_EMAIL_SUBJECT  = "Operaciones Nutanix";
const NTX_ATTACHMENT_MATCH = "nutanix_ops";

// Nombres exactos de las tareas programadas en Jira
const NTX_TASKS = [
  "Estado del cluster",
  "Alertas activas en el cluster",
  "Estado de Data Resiliency",
  "Estado de salud de los discos del cluster"
];

class NutanixOpsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: NTX_OPERATION_NAME,
      emailSubject: NTX_EMAIL_SUBJECT,
      attachmentMatch: NTX_ATTACHMENT_MATCH,
      pasos: ['tickets']
    });
    this._clusterName = "";
    this._clusterFqdn = "";
    this._origen = "";
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (attachment) {
      try {
        const rawText = attachment.getDataAsString("UTF-8");
        const data = JSON.parse(rawText);
        if (data && data.clientName) {
           // Buscamos el cliente real por nombre exacto segun el JSON
           const newConfig = getClientConfigByName(data.clientName, this.operationName);
           if (newConfig) {
             config = newConfig;
             
             // BORRAR requestTypeId: Si no tiene request type, Jira lo crea como
             // ticket interno y el cliente (portal) no se entera ni recibe mails.
             // (Solo temporal para testing en produccion sin molestar)
             delete config.requestTypeId;
             
           } else {
             summaryReport.errores.push({
               error: "Cliente Nutanix no encontrado",
               detalle: `El JSON indica cliente "${data.clientName}" pero no existe exactamente así en la Columna B del Índice Maestro.`
             });
           }
        }
      } catch (e) {
        // Si falla el parseo aca, el metodo parseAttachment lo va a loggear despues
      }
    }
    if (config) config.tecnologia = "Nutanix";
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    try {
      const rawText = attachment.getDataAsString("UTF-8");
      const data = JSON.parse(rawText);

      if (!data || !Array.isArray(data.validaciones) || data.validaciones.length === 0) {
        summaryReport.errores.push({
          error: "Formato JSON inválido o vacío",
          detalle: `El adjunto no contiene validaciones válidas.`
        });
        return null;
      }
      return data;
    } catch (e) {
      summaryReport.errores.push({
        error: "Error al parsear JSON",
        detalle: `Error: ${e.message}`
      });
      return null;
    }
  }

  isDataEmpty(parsedData) {
    return !parsedData || !Array.isArray(parsedData.validaciones) || parsedData.validaciones.length === 0;
  }

  processData(parsedData, clientConfig, summaryReport) {
    const validaciones = parsedData.validaciones;

    this._clusterName = parsedData.clusterName || "Desconocido";
    this._clusterFqdn = parsedData.clusterFqdn || "Desconocido";
    this._origen = parsedData.origen || "N/A";

    // Solo las validaciones con estado diferente a Chequeado generan alertas
    const derivadas = validaciones.filter(v => v.estado !== "Chequeado");

    const reasonsText = derivadas
      .map(v => `* *${v.id} — ${v.nombre}* (${v.estado}):\n  ${v.detalle}`)
      .join('\n\n');

    return {
      headers: ["ID", "Nombre", "Estado", "Detalle"],
      finalAlerts: derivadas,
      rowsForExport: [],
      reasonsText
    };
  }

  // Un ticket por cluster
  getTicketSummary() {
    return `[OPS-NTX] ${this._clusterName} — Validaciones operativas`;
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(this.getTicketSummary(), clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName, attachmentBlob = null) {
    const alertCount = finalAlerts.length;
    const origenDetalle = `${this._clusterName} (${this._clusterFqdn} / ${this._origen})`;

    if (existingTicketKey) {
      const commentText = 
        `🔄 *Reporte Nutanix Recibido*\n\n` +
        `*Cluster:* ${origenDetalle}\n\n` +
        `*Validaciones evaluadas (${alertCount}):*\n\n` +
        `${reasonsText}`;
        
      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({
        mensaje: `Ticket ${existingTicketKey} actualizado para ${this._clusterName}.`
      });
    } else {
      const description = 
        `Se recibieron los resultados de las validaciones operativas diarias de Nutanix.\n\n` +
        `*Cluster:* ${origenDetalle}\n\n` +
        `*Validaciones evaluadas (${alertCount}):*\n\n` +
        `${reasonsText}`;

      const creationResult = createTicketAndNotify(
        this.getTicketSummary(),
        description,
        null,
        clientConfig,
        this.operationName
      );

      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else {
        summaryReport.errores.push(creationResult.detail);
        return { status: creationResult.status === 'HTTP_500' ? 'HTTP_500' : 'FAILURE' };
      }
    }

    return this.cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport);
  }

  // Sobrescribir para iterar y cerrar las 4 tareas
  cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport) {
    let allSuccess = true;
    let anyTerminal = false;

    for (const taskName of NTX_TASKS) {
      const resultado = buscarYCerrarTareaProgramada(taskName, clientConfig, false);
      const estado = resultado && resultado.status ? resultado.status : 'SIN_RESPUESTA';

      if (estado === 'SUCCESS') {
        summaryReport.tareasCerradas++;
        Logger.log(`[${this.operationName}] Tarea programada "${taskName}" cerrada para ${clientConfig.clientName}.`);
      } else if (estado === 'DUPLICADO') {
        Logger.log(`[${this.operationName}] Reporte duplicado: la tarea "${taskName}" ya estaba cerrada.`);
      } else if (estado === 'DEFERRED') {
        allSuccess = false;
      } else if (estado === 'NOT_FOUND') {
        summaryReport.advertencias.push({
          cliente: clientConfig.clientName,
          problema: `No existe tarea programada "${taskName}" creada hoy.`,
          accion: `Revisar si el nombre coincide exactamente.`
        });
        anyTerminal = true;
        allSuccess = false;
      } else {
        summaryReport.errores.push({
          cliente: clientConfig.clientName,
          error: `No se pudo cerrar la tarea "${taskName}"`,
          detalle: `Estado: ${estado}.`
        });
        allSuccess = false;
      }
    }

    if (anyTerminal) return { status: 'ERROR_TERMINAL' };
    return { status: allSuccess ? 'SUCCESS' : 'FAILURE' };
  }
}

function processNutanixOpsEmails() {
  new NutanixOpsProcessor().processEmails();
}
