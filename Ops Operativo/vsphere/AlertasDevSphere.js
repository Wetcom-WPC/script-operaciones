/**
 * @fileoverview Lógica específica para "Alertas de vSphere".
 * IMPLEMENTA:
 * - Lógica DRP con MAPEO para redirigir tickets según el asunto.
 * - Estandarizado para usar FuncionesCompartidas.gs.
 * Refactorizado utilizando la clase base MailProcessor.
 */

// --- CONFIGURACIÓN DE LA OPERACIÓN "ALERTAS DE VSPHERE" ---
const VSPHERE_OPERATION_NAME = "Alertas de vSphere";
const VSPHERE_EMAIL_SUBJECT = "Alertas de vSphere";
const VSPHERE_FILENAME_MATCH = ".json";
const VSPHERE_SCHEDULED_TASK_NAME_TO_CLOSE = "Alertas de vSphere";
const VSPHERE_GROUPING_COLUMN_NAME = "alarm";
const VSPHERE_OBJECT_NAME_COLUMN = "object";
const VSPHERE_ALERT_THRESHOLD_FOR_ATTACHMENT = 10;
const VSPHERE_JIRA_GROUPED_SUMMARY_TEMPLATE = "Alertas de vSphere {ALERT_NAME}";

// Alertas que NO deben generar ticket (se manejan solo por mail/reporte de consumo)
const VSPHERE_ALERTAS_SIN_TICKET = [
  "Virtual machine CPU usage",
  "Host CPU usage",
  "Host memory usage",
  "Virtual machine memory usage",
  "Virtual machine CPU usage"
];


class VsphereAlertsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: VSPHERE_OPERATION_NAME,
      emailSubject: VSPHERE_EMAIL_SUBJECT,
      attachmentMatch: VSPHERE_FILENAME_MATCH,
      scheduledTaskName: VSPHERE_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  processSingleMessage(message, summaryReport) {
    const emailSubject = message.getSubject();
    if (emailSubject.toLowerCase().includes("success")) {
      const senderEmail = message.getFrom();
      let clientConfig = getClientConfig(senderEmail, this.operationName);
      // Extraemos el primer attachment (si lo hay) para resolveClientConfig
      const attachments = message.getAttachments();
      const attachment = attachments.length > 0 ? attachments[0] : null;
      clientConfig = this.resolveClientConfig(clientConfig, senderEmail, attachment, message, summaryReport);
      
      if (clientConfig) {
        summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} recibido con [SUCCESS].` });
        if (this.scheduledTaskName) {
          const taskNameToClose = clientConfig.isAVS ? "AVS - " + this.scheduledTaskName : this.scheduledTaskName;
          const closeResult = buscarYCerrarTareaProgramada(taskNameToClose, clientConfig, false);
          if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas = (summaryReport.tareasCerradas || 0) + 1;
        }
      }
      return { status: 'SUCCESS' };
    }
    
    return super.processSingleMessage(message, summaryReport);
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    const emailSubject = message.getSubject();
    const subjectLower = emailSubject.toLowerCase();
    let isDRP = false;
    let isAVS = false;
    
    // Restaurar lógica isAVS perdida en el refactor
    isAVS = (subjectLower.includes('avs') || (attachment && attachment.getName().toLowerCase().includes('avs')));

    const drpClientName = extractDRPClientName(emailSubject, "Alertas de vSphere");
    if (drpClientName) {
      Logger.log(`Modo DRP detectado. Nombre extraído/mapeado: "${drpClientName}"`);
      config = getClientConfigByName(drpClientName, this.operationName);
      isDRP = true;
    } else if (subjectLower.includes('drp')) {
      Logger.log(`ADVERTENCIA: Asunto DRP detectado, pero no se pudo extraer el nombre del cliente. Asunto: "${emailSubject}"`);
    }

    if (!config) {
      if (isDRP) Logger.log(`Búsqueda DRP por nombre falló. Revirtiendo a búsqueda por remitente.`);
      config = getClientConfig(sender, this.operationName);
      isDRP = false;
    }
    
    if (config) {
      config.isDRP = isDRP;
      config.isAVS = isAVS;
    }
    
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    try {
      const jsonString = attachment.getDataAsString("UTF-8");
      const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
      const reportData = parsedJson.Report || parsedJson.alerts || parsedJson;
      
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
    
    const groupingColIndex = headers.indexOf(normalizarEncabezado(VSPHERE_GROUPING_COLUMN_NAME));
    const objectNameColIndex = headers.indexOf(normalizarEncabezado(VSPHERE_OBJECT_NAME_COLUMN));

    if (groupingColIndex === -1 || objectNameColIndex === -1) {
      summaryReport.errores.push({ error: `Columnas clave de agrupación u objeto no encontradas en el JSON.` });
      return null;
    }

    const finalAlerts = reportRows.filter(row => {
      const isRowEmpty = row.join('').trim() === '';
      if (isRowEmpty) return false;
      return !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    // In this specific script, we don't return a single array of alerts.
    // We actually group them and create multiple tickets.
    // MailProcessor expects finalAlerts, but we need custom logic to group them.
    // We will return the grouped alerts as "finalAlerts" and handle them in handleAlerts.
    
    if (finalAlerts.length === 0) {
      return { headers: originalHeaders, finalAlerts: [], rowsForExport: [], reasonsText: "" };
    }

    const groupedAlerts = {};
    finalAlerts.forEach(row => {
      let alertName = (row[groupingColIndex] || "Sin Nombre").trim();
      alertName = alertName.replace(/['"]/g, ""); 
      
      if (!groupedAlerts[alertName]) groupedAlerts[alertName] = [];
      groupedAlerts[alertName].push(row);
    });

    return { 
      headers: originalHeaders, 
      finalAlerts: finalAlerts, // Not empty, so handleAlerts will be called
      rowsForExport: groupedAlerts, // We pass the grouped alerts here
      reasonsText: objectNameColIndex // Pass the col index to use it in handleAlerts
    };
  }

  findExistingTicket(clientConfig) {
    // Return null, because each group might have its own ticket.
    return null;
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado. Todas las anomalías fueron exceptuadas o el archivo estaba vacío.` });
    if (this.scheduledTaskName) {
      const taskNameToClose = clientConfig.isAVS ? "AVS - " + this.scheduledTaskName : this.scheduledTaskName;
      const closeResult = buscarYCerrarTareaProgramada(taskNameToClose, clientConfig, false);
      if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas = (summaryReport.tareasCerradas || 0) + 1;
    }
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const groupedAlerts = rowsForExport;
    const objectNameColIndex = reasonsText;
    let overallStatus = 'SUCCESS';

    for (const alertName in groupedAlerts) {
      Logger.log(`\n--- Procesando grupo: "${alertName}" ---`);

      const esAlertaSinTicket = VSPHERE_ALERTAS_SIN_TICKET.some(a =>
        alertName.toLowerCase().includes(a.toLowerCase())
      );
      if (esAlertaSinTicket) {
        Logger.log(`Alerta "${alertName}" excluida de ticketing. Solo se reporta por mail.`);
        continue;
      }

      const alertGroupRows = groupedAlerts[alertName];
      let summary = VSPHERE_JIRA_GROUPED_SUMMARY_TEMPLATE.replace("{ALERT_NAME}", alertName);

      if (clientConfig.isDRP) {
        summary = summary.replace("Alertas de vSphere", "Alertas de vSphere DRP");
      }
      
      const JIRA_SUMMARY_MAX_LENGTH = 254;
      if (summary.length > JIRA_SUMMARY_MAX_LENGTH) {
        summary = summary.substring(0, JIRA_SUMMARY_MAX_LENGTH - 3) + "...";
      }

      const ticketKey = findExistingJiraTicket(summary, clientConfig.jiraProjectKey);
      
      if (ticketKey) {
        if (haSidoActualizadoHoy(ticketKey, alertName)) {
          continue;
        }
        const todayMarker = `[AUTO-UPDATE:${new Date().toISOString().slice(0, 10)}]`;
        let attachmentStatus = { status: 'SUCCESS' };
        
        if (alertGroupRows.length > VSPHERE_ALERT_THRESHOLD_FOR_ATTACHMENT) {
          const newFileName = `Reporte ${alertName} (Actualizado).xlsx`;
          const xlsxBlob = convertDataToXlsxBlob([headers, ...alertGroupRows], newFileName);
          attachmentStatus = addAttachmentToJiraTicket(ticketKey, xlsxBlob);
          if (attachmentStatus.status === 'SUCCESS') {
            const commentText = `${todayMarker} ${alertName}\n\n🚨 **La anomalía persiste.** Se adjunta reporte con **${alertGroupRows.length}** objetos afectados.`;
            addCommentToJiraTicket(ticketKey, commentText);
            summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${ticketKey}|${ticketKey}> con nuevo reporte.` });

            const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, summary);
            if (accountIdAsignado) ticketInformativo(ticketKey, accountIdAsignado);
          } else {
            summaryReport.advertencias.push(attachmentStatus.detail);
          }
        } else {
          let comment = `${todayMarker} ${alertName}\n\n🚨 **La anomalía persiste.** Se ha vuelto a detectar la alerta *"${alertName}"*.\n\n`;
          comment += `*Objetos Afectados en este reporte (${alertGroupRows.length}):*\n`;
          alertGroupRows.forEach(row => (comment += `• ${row[objectNameColIndex] || "(objeto sin nombre)"}\n`));
          addCommentToJiraTicket(ticketKey, comment);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${ticketKey}|${ticketKey}> con ${alertGroupRows.length} objetos.` });

          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, summary);
          if (accountIdAsignado) ticketInformativo(ticketKey, accountIdAsignado);
        }
        if (attachmentStatus.status !== 'SUCCESS') overallStatus = attachmentStatus.status;

      } else {
        let description = "";
        let xlsxBlob = null;
        if (alertGroupRows.length > VSPHERE_ALERT_THRESHOLD_FOR_ATTACHMENT) {
          description = `Se detectaron ${alertGroupRows.length} objetos afectados por la alerta *"${alertName}"*. Se adjunta un reporte con el detalle.`;
          const newFileName = `Reporte ${alertName}.xlsx`;
          xlsxBlob = convertDataToXlsxBlob([headers, ...alertGroupRows], newFileName);
        } else {
          description = `Se detectó la siguiente alerta:\n\n*Alarma:* ${alertName}\n\n*Objetos Afectados (${alertGroupRows.length}):*\n`;
          alertGroupRows.forEach(rowData => {
            const objectName = rowData[objectNameColIndex] || "(objeto sin nombre)";
            description += `• ${objectName}\n`;
          });
        }

        const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, summary);
        if (creationResult.status !== 'SUCCESS') overallStatus = creationResult.status;
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push(creationResult.detail);
        } else {
          (creationResult.status === 'ERROR' ? summaryReport.errores : summaryReport.advertencias).push(creationResult.detail);
        }
      } 
    }
    
    if (this.scheduledTaskName) {
      const taskNameToClose = clientConfig.isAVS ? "AVS - " + this.scheduledTaskName : this.scheduledTaskName;
      const closeResult = buscarYCerrarTareaProgramada(taskNameToClose, clientConfig, false);
      if (closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas = (summaryReport.tareasCerradas || 0) + 1;
    }
    return { status: overallStatus };
  }
}

function processVsphereEmails() {
  new VsphereAlertsProcessor().processEmails();
}

