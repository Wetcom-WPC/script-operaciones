/**
 * @fileoverview Lógica específica para procesar reportes de "VMs con preguntas".
 * Lee reportes en formato JSON y utiliza el sistema de notificación de resumen
 * y todas las funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE VMS CON PREGUNTAS ---
const Q_VM_OPERATION_NAME = "VMs con preguntas";
const Q_VM_EMAIL_SUBJECT = "VMs con preguntas";
const Q_VM_FILENAME_MATCH = ".json"; // Buscará un archivo adjunto que sea JSON
const Q_VM_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs con Preguntas"; // <-- REVISA Y AJUSTA ESTE NOMBRE
const Q_VM_ROW_LIMIT_FOR_TABLE = 10;
const Q_VM_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs con preguntas pendientes";
const Q_VM_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs con preguntas pendientes";

class VMsConPreguntasProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: Q_VM_OPERATION_NAME,
      emailSubject: Q_VM_EMAIL_SUBJECT,
      attachmentMatch: Q_VM_FILENAME_MATCH,
      scheduledTaskName: Q_VM_SCHEDULED_TASK_NAME_TO_CLOSE
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

  parseAttachment(attachment, summaryReport) {
    try {
      const jsonString = attachment.getDataAsString("UTF-8");
      const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
      const reportData = parsedJson.Report || parsedJson;
      if (!Array.isArray(reportData) || reportData.length === 0) {
        return [];
      }
      return reportData; // Array of objects
    } catch (e) {
      summaryReport.errores.push({ error: "El archivo JSON es inválido.", detalle: `Nombre de archivo: ${attachment.getName()}` });
      return null;
    }
  }

  isDataEmpty(parsedData) {
    return !parsedData || parsedData.length === 0;
  }

  processData(parsedData, clientConfig, summaryReport) {
    const headers = Object.keys(parsedData[0]);
    const reportRows = parsedData.map(obj => headers.map(header => obj[header]));

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      return !isRowEmpty && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(Q_VM_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(Q_VM_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let attachmentStatus = { status: 'SUCCESS' };

    if (existingTicketKey) {
      let commentText = `🚨 **El problema persiste.** `;
      if (alertCount <= Q_VM_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se han detectado ${alertCount} nuevas VMs con preguntas pendientes:\n\n`;
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
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs con preguntas.`;
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
          if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
        } else {
          summaryReport.advertencias.push(attachmentStatus.detail || { error: "Fallo al adjuntar." });
        }
      }
      
      if (attachmentStatus.status === 'SUCCESS') {
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      }
      return { status: attachmentStatus.status };
    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= Q_VM_ROW_LIMIT_FOR_TABLE) {
        summary = Q_VM_JIRA_TICKET_SUMMARY_TABLE;
        description = `Se detectaron ${alertCount} VMs con preguntas pendientes:\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = Q_VM_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Se encontraron ${alertCount} VMs con preguntas pendientes. Se adjunta el reporte filtrado.`;
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

function processVmsWithQuestionsEmails() {
  new VMsConPreguntasProcessor().processEmails();
}
