/**
 * @fileoverview Lógica específica para procesar reportes de "Affinity Rules".
 * IMPLEMENTA:
 * - Lógica DRP con MAPEO para redirigir tickets según el asunto.
 * - Estandarizado para usar FuncionesCompartidas.gs.
 * Refactorizado utilizando la clase base MailProcessor.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE AFFINITY RULES ---
const AFFINITY_OPERATION_NAME = "Affinity Rules";
const AFFINITY_EMAIL_SUBJECT = "Affinity Rules";
const AFFINITY_FILENAME_MATCH = ".json";
const AFFINITY_SCHEDULED_TASK_NAME_TO_CLOSE = "Affinity Rules";
const AFFINITY_ROW_LIMIT_FOR_TABLE = 10;
const AFFINITY_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs sin Affinity Rules configuradas";
const AFFINITY_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs sin Affinity Rules configuradas";


class AffinityRulesProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: AFFINITY_OPERATION_NAME,
      emailSubject: AFFINITY_EMAIL_SUBJECT,
      attachmentMatch: AFFINITY_FILENAME_MATCH,
      scheduledTaskName: AFFINITY_SCHEDULED_TASK_NAME_TO_CLOSE
    });
    this.isDRP = false;
    this.jiraSummaryTable = AFFINITY_JIRA_TICKET_SUMMARY_TABLE;
    this.jiraSummaryAttachment = AFFINITY_JIRA_TICKET_SUMMARY_ATTACHMENT;
  }

  processSingleMessage(message, summaryReport) {
    const emailSubject = message.getSubject();
    
    // Pre-filtro por asunto del correo
    if (emailSubject.toLowerCase().includes("success")) {
      const senderEmail = message.getFrom();
      let clientConfig = getClientConfig(senderEmail, this.operationName);
      clientConfig = this.resolveClientConfig(clientConfig, senderEmail, null, message, summaryReport);
      
      if (clientConfig) {
        summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} recibido con (SUCCESS).` });
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      }
      return { status: 'SUCCESS' };
    }
    
    return super.processSingleMessage(message, summaryReport);
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    const emailSubject = message.getSubject();
    const subjectLower = emailSubject.toLowerCase();
    this.isDRP = false;

    const drpClientName = extractDRPClientName(emailSubject, "Affinity Rules");
    if (drpClientName) {
      Logger.log(`Modo DRP detectado. Nombre extraído/mapeado: "${drpClientName}"`);
      config = getClientConfigByName(drpClientName, this.operationName);
      this.isDRP = true;
    } else if (subjectLower.includes('drp')) {
      Logger.log(`ADVERTENCIA: Asunto DRP detectado, pero no se pudo extraer el nombre del cliente. Asunto: "${emailSubject}"`);
    }

    if (!config) {
      if (this.isDRP) Logger.log(`Búsqueda DRP por nombre falló. Revirtiendo a búsqueda por remitente.`);
      config = getClientConfig(sender, this.operationName);
      this.isDRP = false;
    }
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    try {
      const jsonString = attachment.getDataAsString("UTF-8");
      const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
      const reportData = parsedJson.Report || parsedJson; 
      
      if (!reportData || !Array.isArray(reportData) || reportData.length === 0) {
        return [];
      }
      
      const originalHeaders = Object.keys(reportData[0]);
      const reportRows = reportData.map(obj => originalHeaders.map(header => obj[header]));
      return [originalHeaders, ...reportRows];
    } catch (e) {
      summaryReport.errores.push({ error: "El archivo JSON es inválido.", detalle: e.message });
      return null;
    }
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);
    const headers = originalHeaders.map(h => normalizarEncabezado(h));

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      return !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    let summaryTable = AFFINITY_JIRA_TICKET_SUMMARY_TABLE;
    let summaryAttachment = AFFINITY_JIRA_TICKET_SUMMARY_ATTACHMENT;
    
    if (this.isDRP) {
        summaryTable = summaryTable.replace("Se detectaron", "DRP - Se detectaron");
        summaryAttachment = summaryAttachment.replace("Se detectaron", "DRP - Se detectaron");
    }
    
    this.jiraSummaryTable = summaryTable;
    this.jiraSummaryAttachment = summaryAttachment;

    return findExistingJiraTicket(summaryTable, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(summaryAttachment, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;

    if (existingTicketKey) {
      let commentText = `🚨 **El problema persiste.** `;
      let attachmentStatus = { status: 'SUCCESS' };

      if (alertCount <= AFFINITY_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se han detectado ${alertCount} nuevas alertas de Affinity Rules:\n\n`;
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
      } else {
        const newFileName = attachmentName.replace(/\.json$/i, "-FILTRADO.xlsx");
        const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
        attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

        if (attachmentStatus.status === 'SUCCESS') {
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs sin Affinity Rules.`;
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        } else {
          summaryReport.advertencias.push(attachmentStatus.detail);
        }
      }
      
      if (attachmentStatus.status === 'SUCCESS') {
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      }
      return { status: attachmentStatus.status };

    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= AFFINITY_ROW_LIMIT_FOR_TABLE) {
        summary = this.jiraSummaryTable;
        description = `Se detectaron ${alertCount} VMs sin Affinity Rules configuradas:\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = this.jiraSummaryAttachment;
        description = `Se encontraron ${alertCount} VMs sin Affinity Rules configuradas. Se adjunta el reporte filtrado.`;
        const newFileName = attachmentName.replace(/\.json$/i, "-FILTRADO.xlsx");
        xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
      }
      
      const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, this.operationName);
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else if (creationResult.status === 'ERROR') {
        summaryReport.errores.push(creationResult.detail);
      } else {
        summaryReport.advertencias.push(creationResult.detail);
      }
      
      if (creationResult.status !== 'FAILURE' && creationResult.status !== 'HTTP_500') {
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      }
      return { status: creationResult.status };
    }
  }
}

function processAffinityRulesEmails() {
  new AffinityRulesProcessor().processEmails();
}
