/**
 * @fileoverview Lógica específica para procesar reportes de "Horizon Dashboard".
 */

// --- CONFIGURACIÓN ESPECÍFICA ---
const HZ_DASH_OPERATION_NAME = "Dashboard View";
const HZ_DASH_EMAIL_SUBJECT = "Horizon Dashboard View Problems"; // Asunto que envía vRO
const HZ_DASH_JSON_FILENAME_MATCH = ".json"; // Busca cualquier adjunto JSON
const HZ_DASH_SCHEDULED_TASK_NAME_TO_CLOSE = "Dashboard View"; // Nombre de la tarea en Jira
const HZ_DASH_ROW_LIMIT_FOR_TABLE = 15;
const HZ_DASH_JIRA_TICKET_SUMMARY_TABLE = "Alertas detectadas en el Dashboard de Horizon";
const HZ_DASH_JIRA_TICKET_SUMMARY_ATTACHMENT = "Alertas detectadas en el Dashboard de Horizon";

class HorizonDashboardProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: HZ_DASH_OPERATION_NAME,
      emailSubject: HZ_DASH_EMAIL_SUBJECT,
      attachmentMatch: HZ_DASH_JSON_FILENAME_MATCH,
      scheduledTaskName: HZ_DASH_SCHEDULED_TASK_NAME_TO_CLOSE
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
    const headers = ["object", "alarm", "severity", "time", "vcenter"];
    const rawAlerts = jsonData.Report || [];
    
    const finalAlerts = rawAlerts.filter((alert, index) => {
      const rowData = [
        (alert.object || "").toString().trim(),
        (alert.alarm || "").toString().trim(),
        (alert.severity || "").toString().trim(),
        (alert.time || "").toString().trim(),
        (alert.vcenter || "").toString().trim()
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
    return findExistingJiraTicket(HZ_DASH_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(HZ_DASH_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Sistema Normalizado.** El último reporte de Horizon confirma que todos los componentes están saludables (o las alertas actuales son excepciones validadas).");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías (OK).` });
    }
    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);    
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let commentText = `🚨 **El problema persiste.** `;
    let attachmentStatus = { status: 'SUCCESS' };

    if (existingTicketKey) {
      if (alertCount <= HZ_DASH_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se mantienen ${alertCount} alertas en el Dashboard (con excepciones ya filtradas):\n\n`;
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(row => {
          commentText += `| ${row.object || "-"} | ${row.alarm || "-"} | ${row.severity || "-"} | ${row.time || "-"} | ${row.vcenter || "-"} |\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
      } else {
        const newFileName = attachmentName.replace(/\.json$/i, "-FILTRADO.xlsx");
        const matrixData = [headers].concat(finalAlerts.map(r => [r.object, r.alarm, r.severity, r.time, r.vcenter]));
        const xlsxBlob = convertDataToXlsxBlob(matrixData, newFileName);
        
        attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

        if (attachmentStatus.status === 'SUCCESS') {
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** alertas de Horizon (excepciones filtradas).`;
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
      if (alertCount <= HZ_DASH_ROW_LIMIT_FOR_TABLE) {
        summary = HZ_DASH_JIRA_TICKET_SUMMARY_TABLE;
        description = `Informamos que se detectaron ${alertCount} alertas en la infraestructura de Horizon. Se detalla el estado actual a continuación (excepciones ya filtradas):\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(row => {
          description += `| ${row.object || "-"} | ${row.alarm || "-"} | ${row.severity || "-"} | ${row.time || "-"} | ${row.vcenter || "-"} |\n`;
        });
      } else {
        summary = HZ_DASH_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Informamos que se detectaron ${alertCount} alertas en la infraestructura de Horizon. Por la cantidad de registros, se adjunta el reporte detallado en formato Excel (excepciones ya filtradas).`;
        const newFileName = attachmentName.replace(/\.json$/i, ".xlsx");
        const matrixData = [headers].concat(finalAlerts.map(r => [r.object, r.alarm, r.severity, r.time, r.vcenter]));
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

function processHorizonDashboardEmails() {
  new HorizonDashboardProcessor().processEmails();
}
