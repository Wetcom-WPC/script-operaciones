/**
 * @fileoverview Lógica específica para procesar reportes de "Horizon Problem Machines".
 */

// --- CONFIGURACIÓN ESPECÍFICA ---
const HZ_PM_OPERATION_NAME = "Estado de Agentes View";
const HZ_PM_EMAIL_SUBJECT = "Horizon Problem Machines"; // Asunto que envía vRO
const HZ_PM_JSON_FILENAME_MATCH = ".json"; 
const HZ_PM_SCHEDULED_TASK_NAME_TO_CLOSE = "Estado de Agentes View"; // Nombre de la tarea en Jira
const HZ_PM_ROW_LIMIT_FOR_TABLE = 15;
const HZ_PM_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron Máquinas con Problemas en Horizon";
const HZ_PM_JIRA_TICKET_SUMMARY_ATTACHMENT = "Múltiples Máquinas con Problemas en Horizon";

class HorizonProblemMachinesProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: HZ_PM_OPERATION_NAME,
      emailSubject: HZ_PM_EMAIL_SUBJECT,
      attachmentMatch: HZ_PM_JSON_FILENAME_MATCH,
      scheduledTaskName: HZ_PM_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  findAttachment(message) {
    return message.getAttachments().find(att => att.getName().toLowerCase().endsWith(this.attachmentMatch));
  }

  parseAttachment(attachment, summaryReport) {
    try {
      const jsonString = attachment.getDataAsString("UTF-8");
      return JSON.parse(jsonString);
    } catch (e) {
      summaryReport.errores.push({ error: "Fallo al leer JSON.", detalle: e.message });
      return null;
    }
  }

  isDataEmpty(parsedData) {
    return !parsedData || (!parsedData.Report && parsedData.Result !== "OK");
  }

  processData(jsonData, clientConfig, summaryReport) {
    const headers = ["NombreMaquina", "DesktopPool", "Estado"];
    const rawAlerts = jsonData.Report || [];
    
    const finalAlerts = rawAlerts.filter((alert, index) => {
      const rowData = [
        (alert.NombreMaquina || "").toString().trim(),
        (alert.DesktopPool || "").toString().trim(),
        (alert.Estado || "").toString().trim()
      ];
      try {
        return !isRowExcepted(rowData, headers, clientConfig.exceptions);
      } catch (err) {
        return true; 
      }
    });

    if (jsonData.Result === "OK") {
        return { headers, finalAlerts: [], rowsForExport: [], reasonsText: "" };
    }
    
    return { headers, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }
  
  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(HZ_PM_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(HZ_PM_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Anomalía Resuelta.** El último reporte indica que ya no hay máquinas con estados problemáticos (o las detectadas son excepciones validadas).");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin máquinas problemáticas (OK).` });
    }
    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);    
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (existingTicketKey) {
      if (alertCount <= HZ_PM_ROW_LIMIT_FOR_TABLE) {
        commentText += `Actualmente hay ${alertCount} máquinas afectadas (excepciones filtradas):\n\n`;
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(row => {
          commentText += `| ${row.NombreMaquina || "-"} | ${row.DesktopPool || "-"} | ${row.Estado || "-"} |\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
      } else {
        const newFileName = attachmentName.replace(/\.json$/i, "-FILTRADO.xlsx");
        const matrixData = [headers].concat(finalAlerts.map(r => [r.NombreMaquina, r.DesktopPool, r.Estado]));
        const xlsxBlob = convertDataToXlsxBlob(matrixData, newFileName);
        
        attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

        if (attachmentStatus.status === 'SUCCESS') {
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** máquinas en estado de error (excepciones filtradas).`;
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
        } else {
          summaryReport.advertencias.push(attachmentStatus.detail);
        }
      }
      
      if (attachmentStatus.status === 'SUCCESS') {
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
        if (accountIdAsignado) {
           ticketInformativo(existingTicketKey, accountIdAsignado);
        }
        return { status: 'SUCCESS' };
      } else {
        return { status: attachmentStatus.status };
      }
    } else {
      let summary, description, xlsxBlob = null;
      if (alertCount <= HZ_PM_ROW_LIMIT_FOR_TABLE) {
        summary = HZ_PM_JIRA_TICKET_SUMMARY_TABLE;
        description = `Informamos que se detectaron ${alertCount} escritorios virtuales (VMs) en estado problemático en Horizon. Se detalla el estado a continuación (excepciones ya filtradas):\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(row => {
          description += `| ${row.NombreMaquina || "-"} | ${row.DesktopPool || "-"} | ${row.Estado || "-"} |\n`;
        });
      } else {
        summary = HZ_PM_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Informamos que se detectaron ${alertCount} escritorios virtuales (VMs) en estado problemático en Horizon. Por la cantidad de registros, se adjunta el reporte detallado en formato Excel (excepciones ya filtradas).`;
        const newFileName = attachmentName.replace(/\.json$/i, ".xlsx");
        const matrixData = [headers].concat(finalAlerts.map(r => [r.NombreMaquina, r.DesktopPool, r.Estado]));
        xlsxBlob = convertDataToXlsxBlob(matrixData, newFileName);
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

function processHorizonProblemMachinesEmails() {
  new HorizonProblemMachinesProcessor().processEmails();
}
