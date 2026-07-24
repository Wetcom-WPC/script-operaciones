/**
 * @fileoverview Lógica específica para procesar reportes de "Discos montados en proxy".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE Discos montados en proxy ---
const DISCOSMONTADOS_OPERATION_NAME = "Discos montados en proxy";
const DISCOSMONTADOS_EMAIL_SUBJECT = "Discos montados en proxy";
const DISCOSMONTADOS_FILENAME_MATCH = ".json";
const DISCOSMONTADOS_SCHEDULED_TASK_NAME_TO_CLOSE = "Discos Montados en Proxy"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const DISCOSMONTADOS_ROW_LIMIT_FOR_TABLE = 10;
const DISCOSMONTADOS_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Discos montados en proxy";
const DISCOSMONTADOS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron Discos montados en proxy";

class DiscosMontadosProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: DISCOSMONTADOS_OPERATION_NAME,
      emailSubject: DISCOSMONTADOS_EMAIL_SUBJECT,
      attachmentMatch: DISCOSMONTADOS_FILENAME_MATCH,
      scheduledTaskName: DISCOSMONTADOS_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processSingleMessage(message, summaryReport) {
    const emailSubject = message.getSubject();
    if (emailSubject.toLowerCase().includes("success")) {
      const senderEmail = message.getFrom();
      const clientConfig = getClientConfig(senderEmail, this.operationName);
      if (clientConfig) {
        summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} recibido con (SUCCESS).` });
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      }
      return { status: 'SUCCESS' };
    }
    return super.processSingleMessage(message, summaryReport);
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (config) config.tecnologia = "Veeam Backup & Replication"; // Siempre Veeam
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    const jsonString = attachment.getDataAsString("UTF-8");
    try {
      const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
      const reportData = parsedJson.Report || parsedJson; 
      if (!reportData || !Array.isArray(reportData) || reportData.length === 0) return null;
      
      const headers = Object.keys(reportData[0]);
      const reportRows = reportData.map(obj => headers.map(header => obj[header]));
      return [headers, ...reportRows];
    } catch (e) {
      summaryReport.errores.push({ error: "El archivo JSON es inválido.", detalle: `Asunto: ${attachment.getName()}`});
      return null;
    }
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const reportRows = parsedData.slice(1);
    
    const statusColIndex = originalHeaders.findIndex(h => h.toLowerCase().trim() === 'status');

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;

      if (statusColIndex !== -1) {
        const statusValue = (row[statusColIndex] || "").trim().toLowerCase();
        if (statusValue === 'success') {
          return false;
        }
      }

      return !isRowExcepted(row, originalHeaders, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(DISCOSMONTADOS_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(DISCOSMONTADOS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de Discos montados en proxy no contiene alertas válidas.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let attachmentStatus = { status: 'SUCCESS' };
    
    if (alertCount <= DISCOSMONTADOS_ROW_LIMIT_FOR_TABLE) {
      if (existingTicketKey) {
        let commentText = `🚨 **El problema persiste.** Se han detectado ${alertCount} nuevas alertas de Discos montados en proxy:\n\n`;
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
      } else {
        const summary = DISCOSMONTADOS_JIRA_TICKET_SUMMARY_TABLE;
        let description = `Se detectaron ${alertCount} VMs sin Discos montados en proxy configuradas:\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
        const creationResult = createTicketAndNotify(summary, description, null, clientConfig, this.operationName);
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push(creationResult.detail);
        } else if (creationResult.status === 'ERROR') {
          summaryReport.errores.push(creationResult.detail);
        } else {
          summaryReport.advertencias.push(creationResult.detail);
        }
      }
    } else {
      const newFileName = attachmentName.replace(/\.json$/i, "-FILTRADO.xlsx");
      const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
      
      if (existingTicketKey) {
        attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
        if (attachmentStatus.status === 'SUCCESS') {
          const commentText = `🚨 **El problema persiste.** Se adjunta el reporte actualizado con **${alertCount}** VMs sin Discos montados en proxy.`;
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
          if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
        } else {
          summaryReport.advertencias.push(attachmentStatus.detail);
          return { status: attachmentStatus.status };
        }
      } else {
        const summary = DISCOSMONTADOS_JIRA_TICKET_SUMMARY_ATTACHMENT;
        const description = `Se encontraron ${alertCount} VMs sin Discos montados en proxy configuradas. Se adjunta el reporte filtrado.`;
        const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, this.operationName);
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push(creationResult.detail);
        } else if (creationResult.status === 'ERROR') {
          summaryReport.errores.push(creationResult.detail);
        } else {
          summaryReport.advertencias.push(creationResult.detail);
        }
      }
    }
    
    if (this.scheduledTaskName && attachmentStatus.status === 'SUCCESS') {
      buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    }
    return { status: attachmentStatus.status };
  }
}

function processDISCOSMONTADOSRulesEmails() {
  new DiscosMontadosProcessor().processEmails();
}
