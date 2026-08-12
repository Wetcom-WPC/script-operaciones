/**
 * @fileoverview Processor para las 4 validaciones operativas diarias de Nutanix.
 *
 * PROCEDIMIENTOS CUBIERTOS:
 *   OPS-NTX-001 — Estado del Cluster (servicios de Prism Central/Element)
 *   OPS-NTX-002 — Alertas activas (Critical/Warning, no resueltas)
 *   OPS-NTX-003 — Estado de Data Resiliency
 *   OPS-NTX-004 — Salud de los discos
 *
 * INTEGRACIÓN:
 *   - El script nutanix_ops_check.ps1 (on-premise) envía un correo con asunto
 *     "Operaciones Nutanix" y un adjunto JSON con los resultados de las 4 validaciones.
 *   - Este processor recibe ese correo, evalúa el JSON y gestiona el ticket en Jira:
 *       · Todas "Chequeado"  → sin alertas → cierra la tarea programada.
 *       · Al menos 1 "Derivado" → crea/actualiza ticket en el proyecto del cliente.
 *   - El FromEmail del correo debe estar en el Índice Maestro para resolver el cliente.
 *
 * DIFERENCIAS CON OTROS PROCESSORS:
 *   - parseAttachment()  sobrescrito: parsea JSON en vez de CSV.
 *   - isDataEmpty()      sobrescrito: verifica estructura JSON, no longitud de filas.
 *   - handleAlerts()     sobrescrito: descripción textual (sin XLSX, sin tabla CSV).
 *   - pasos: ['tickets'] — no archiva en Drive (el JSON de diagnóstico no aporta
 *                          valor de auditoría en Drive; el ticket lo documenta todo).
 */

// --- CONFIGURACIÓN ---
const NTX_OPERATION_NAME        = "Operaciones Nutanix";
const NTX_EMAIL_SUBJECT         = "Operaciones Nutanix"; // Debe coincidir con el asunto del PS
const NTX_ATTACHMENT_MATCH      = "nutanix_ops";         // Prefijo del archivo adjunto
const NTX_SCHEDULED_TASK_NAME   = "Operaciones Nutanix";
const NTX_JIRA_TICKET_SUMMARY   = "Operaciones Nutanix — validaciones pendientes de revisión";
const NTX_IDEMPOTENCY_TAG       = "ALERTA-NUTANIX";      // Para haSidoActualizadoHoy()

class NutanixOpsProcessor extends MailProcessor {

  constructor() {
    super({
      operationName:    NTX_OPERATION_NAME,
      emailSubject:     NTX_EMAIL_SUBJECT,
      attachmentMatch:  NTX_ATTACHMENT_MATCH,
      scheduledTaskName: NTX_SCHEDULED_TASK_NAME,
      pasos:            ['tickets'] // Sin paso Drive por ahora
    });
    // Se inicializa en processData() y se consume en handleAlerts()
    this._origen = "";
  }

  // ============================================================================
  // resolveClientConfig — Agrega la tecnología al config (mismo patrón que Veeam)
  // ============================================================================
  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (config) config.tecnologia = "Nutanix";
    return config;
  }

  // ============================================================================
  // parseAttachment — OVERRIDE: parsea JSON en vez de CSV
  // ============================================================================
  parseAttachment(attachment, summaryReport) {
    try {
      const rawText = attachment.getDataAsString("UTF-8");
      const data = JSON.parse(rawText);

      // Validación mínima de estructura
      if (!data || !Array.isArray(data.validaciones)) {
        summaryReport.errores.push({
          error:  "Formato JSON inválido",
          detalle: `El adjunto "${attachment.getName()}" no contiene el campo "validaciones" esperado. ` +
                   `Verificar que el script nutanix_ops_check.ps1 generó el archivo correctamente.`
        });
        return null;
      }

      if (data.validaciones.length === 0) {
        summaryReport.errores.push({
          error:   "JSON sin validaciones",
          detalle: `El adjunto "${attachment.getName()}" tiene el campo "validaciones" vacío.`
        });
        return null;
      }

      return data;
    } catch (e) {
      summaryReport.errores.push({
        error:   "Error al parsear JSON de Nutanix",
        detalle: `Adjunto: "${attachment.getName()}". Error: ${e.message}`
      });
      return null;
    }
  }

  // ============================================================================
  // isDataEmpty — OVERRIDE: verifica que el JSON tenga validaciones
  // ============================================================================
  isDataEmpty(parsedData) {
    return !parsedData ||
           !Array.isArray(parsedData.validaciones) ||
           parsedData.validaciones.length === 0;
  }

  // ============================================================================
  // processData — Evalúa las validaciones y separa las "Derivado"
  //
  // RETORNO ESPERADO por MailProcessor:
  //   { headers, finalAlerts, rowsForExport, reasonsText }
  //
  //   · finalAlerts: array de validaciones con estado "Derivado".
  //                  Si está vacío → MailProcessor llama a handleNoAlerts().
  //                  Si no está vacío → llama a handleAlerts().
  //   · rowsForExport: [] (no generamos XLSX, la descripción va en el ticket).
  //   · reasonsText: texto formateado con el detalle de las alertas derivadas.
  // ============================================================================
  processData(parsedData, clientConfig, summaryReport) {
    const validaciones = parsedData.validaciones;

    // Guardar el origen para usarlo en la descripción del ticket
    this._origen = parsedData.origen || parsedData.prismCentralIp || "N/A";

    // Separar las validaciones que fallaron
    const derivadas = validaciones.filter(v => v.estado === "Derivado");

    const reasonsText = derivadas
      .map(v => `* *${v.id} — ${v.nombre}:* ${v.detalle}`)
      .join('\n');

    Logger.log(
      `[${this.operationName}] Resultado: ` +
      `${derivadas.length}/${validaciones.length} validaciones derivadas. ` +
      `Origen: ${this._origen}`
    );

    return {
      headers:       ["ID", "Nombre", "Estado", "Detalle"],
      finalAlerts:   derivadas,
      rowsForExport: [],
      reasonsText
    };
  }

  // ============================================================================
  // findExistingTicket — Busca un ticket abierto con el mismo resumen fijo
  // ============================================================================
  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(NTX_JIRA_TICKET_SUMMARY, clientConfig.jiraProjectKey);
  }

  // ============================================================================
  // handleAlerts — OVERRIDE: crea/actualiza ticket con descripción textual
  //
  // Se sobrescribe porque el handleAlerts() base genera un XLSX a partir de
  // finalAlerts[], lo cual no aplica aquí (las alertas son objetos estructurados,
  // no filas de CSV). El texto va directamente en la descripción/comentario.
  // ============================================================================
  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    const origen     = this._origen;

    if (existingTicketKey) {
      // Guarda de idempotencia: no actualizar si ya se hizo hoy
      if (haSidoActualizadoHoy(existingTicketKey, NTX_IDEMPOTENCY_TAG)) {
        Logger.log(`[${this.operationName}] Ticket ${existingTicketKey} ya actualizado hoy. No se duplica.`);
        return this.cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport);
      }

      const commentText =
        `🚨 *El problema persiste.* [HU-${NTX_IDEMPOTENCY_TAG}]\n\n` +
        `Se detectaron *${alertCount}* validación(es) en estado *Derivado* (Origen: ${origen}):\n\n` +
        `${reasonsText}`;

      addCommentToJiraTicket(existingTicketKey, commentText);
      summaryReport.exitos.push({
        mensaje: `Ticket ${existingTicketKey} actualizado — ${alertCount} validación(es) derivada(s) en ${origen}.`
      });

    } else {
      // Construcción de la descripción para el ticket nuevo
      const description =
        `Se detectaron anomalías en las validaciones operativas diarias de Nutanix.\n\n` +
        `*Origen:* ${origen}\n\n` +
        `*Validaciones con estado Derivado (${alertCount}):*\n` +
        `${reasonsText}\n\n` +
        `Se deberá analizar la(s) anomalía(s) y coordinar la solución correspondiente.`;

      const creationResult = createTicketAndNotify(
        NTX_JIRA_TICKET_SUMMARY,
        description,
        null, // Sin adjunto XLSX
        clientConfig,
        this.operationName
      );

      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else {
        summaryReport.errores.push(creationResult.detail);
        Logger.log(
          `[${this.operationName}] No se pudo crear el ticket para ${clientConfig.clientName} ` +
          `(estado ${creationResult.status}). El correo queda pendiente para reintentar.`
        );
        return { status: creationResult.status === 'HTTP_500' ? 'HTTP_500' : 'FAILURE' };
      }
    }

    return this.cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport);
  }

}

/**
 * Punto de entrada para el pipeline automático (Main.js) y para ejecución manual.
 * Nombre de función declarado aquí para compatibilidad con el registro de Main.js.
 */
function processNutanixOpsEmails() {
  new NutanixOpsProcessor().processEmails();
}
