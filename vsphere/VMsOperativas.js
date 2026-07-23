/**
 * @fileoverview Lógica específica para procesar reportes de "VMs operativas".
 * Utiliza el sistema de notificación de resumen consolidado y todas las
 * funcionalidades avanzadas de las funciones compartidas.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE VMS OPERATIVAS ---
const VM_OPERATION_NAME = "VMs operativas";
const VM_EMAIL_SUBJECT = "VMs operativas";
const VM_CSV_FILENAME_MATCH = "VMs operativas";
const VM_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs operativas";
const VM_PARTITION_USAGE_COLUMN = "Partition Usage (%)";
const VM_THRESHOLD_PERCENT = 85;
const VM_ROW_LIMIT_FOR_TABLE = 10;
const VM_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs Operativas con poco espacio en particiones";
const VM_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs Operativas con poco espacio en particiones";

class VMsOperativasProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: VM_OPERATION_NAME,
      emailSubject: VM_EMAIL_SUBJECT,
      attachmentMatch: VM_CSV_FILENAME_MATCH,
      scheduledTaskName: VM_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processData(parsedData, clientConfig, summaryReport) {
    const originalHeaders = parsedData[0];
    const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
    
    const columnaNormalizadaBuscada = normalizarEncabezado(VM_PARTITION_USAGE_COLUMN);
    const partitionUsageColIndex = headers.indexOf(columnaNormalizadaBuscada);
    
    if (partitionUsageColIndex === -1) {
      summaryReport.errores.push({ error: `Columna "${VM_PARTITION_USAGE_COLUMN}" no encontrada.` });
      return null; // processSingleMessage will handle it as FAILURE
    }

    const reportRows = parsedData.slice(1);

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      const usageNum = parseFloat((row[partitionUsageColIndex] || "").trim());
      const superaUmbral = !isNaN(usageNum) && usageNum >= VM_THRESHOLD_PERCENT;
      return superaUmbral && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    return { headers: originalHeaders, finalAlerts, rowsForExport: finalAlerts, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(VM_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) || 
           findExistingJiraTicket(VM_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    let attachmentStatus = { status: 'SUCCESS' };

    if (existingTicketKey) {
      let commentText = `🚨 **El problema persiste.** `;

      if (alertCount <= VM_ROW_LIMIT_FOR_TABLE) {
        commentText += `Se han detectado ${alertCount} nuevas alertas:\n\n`;
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          commentText += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.` });
      } else {
        const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
        const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
        attachmentStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

        if (attachmentStatus.status === 'SUCCESS') {
          commentText += `Se adjunta el reporte actualizado con **${alertCount}** VMs afectadas.`;
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
      if (alertCount <= VM_ROW_LIMIT_FOR_TABLE) {
        summary = VM_JIRA_TICKET_SUMMARY_TABLE;
        description = `Informamos que se detectaron ${alertCount} particiones de VMs Operativas con menos de 15% de espacio disponible. Se adjunta el reporte correspondiente, con las excepciones ya filtradas.\n\n|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = VM_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description = `Informamos que se detectaron ${alertCount} particiones de VMs Operativas con menos de 15% de espacio disponible. Se adjunta el reporte correspondiente, con las excepciones ya filtradas.`;
        const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
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

function processVMsOperativasEmails() {
  new VMsOperativasProcessor().processEmails();
}
