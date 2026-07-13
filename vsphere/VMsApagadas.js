/**
 * @fileoverview Lógica específica para procesar reportes de "Apagadas VMs".
 * Utiliza el sistema de resumen de notificaciones de FuncionesGenerales.gs.
 */

// --- CONFIGURACIÓN ESPECÍFICA DE Apagadas VMS ---
const APAGADAS_VMS_OPERATION_NAME = "VMs apagadas por periodo de tiempo significativo";
const APAGADAS_VMS_EMAIL_SUBJECT = "VMs apagadas por periodo de tiempo significativo"; // CONFIRMAR: Ajusta el asunto del email si es diferente
const APAGADAS_VMS_CSV_FILENAME_MATCH = "VMs apagadas por periodo de tiempo significativo";    // CONFIRMAR: Ajusta el nombre del archivo si es diferente
const APAGADAS_VMS_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs apagadas por periodo de tiempo significativo";
const APAGADAS_VMS_JIRA_TICKET_SUMMARY = "Se detectaron VMs apagadas por un periodo de tiempo significativo";


// --- LÓGICA PRINCIPAL DE Apagadas VMS ---

function processApagadasVMsEmails() {
  const summaryReport = {
    exitos: [],
    advertencias: [],
    errores: [],
    tareasCerradas: 0
  };
  const searchQuery = construirBusquedaGmail(APAGADAS_VMS_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);

  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const result = processSingleApagadasMessage(message);

          switch (result.status) {
            case 'SUCCESS':
              if (result.detail && result.detail.mensaje) summaryReport.exitos.push(result.detail);
              if (result.taskClosed) summaryReport.tareasCerradas++;
              break;
            case 'WARNING':
            case 'HTTP_500':
              if (result.detail) summaryReport.advertencias.push(result.detail);
              break;
            case 'ERROR':
              if (result.detail) summaryReport.errores.push(result.detail);
              break;
            // 'NO_OP' (No Operation) no hace nada.
          }
          
          // --- CAMBIO CLAVE ---
          // Marcar como leído si el status no es HTTP_500.
          // Esto incluye el caso 'ERROR' por remitente no encontrado.
          if (result.status !== 'HTTP_500') {
              thread.markRead();
          }

        } catch (e) {
          summaryReport.errores.push({ error: `Error Crítico en Script: ${e.message}`, detalle: `Stack: ${e.stack}` });
          // No se marca como leído en caso de un error inesperado del script.
        }
      }
    });
  }
  
  enviarResumenSlack(APAGADAS_VMS_OPERATION_NAME, summaryReport);
}


function processSingleApagadasMessage(message) {
  const senderEmail = message.getFrom();
  const attachment = message.getAttachments().find(att =>
    att.getName().includes(APAGADAS_VMS_CSV_FILENAME_MATCH) && att.getContentType().includes("text/csv")
  );
  if (!attachment) return { status: 'NO_OP' };

  const clientConfig = getClientConfig(senderEmail, APAGADAS_VMS_OPERATION_NAME);
  if (!clientConfig) {
    return { status: 'ERROR', detail: { error: 'Error de Configuración', detalle: `No se encontró configuración para el remitente: ${senderEmail}` } };
  }

  const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
  
  // --- INICIO DE CAMBIOS ---

  // 1. Se separan los encabezados originales de los normalizados.
  const originalHeaders = allRows[0];
  const reportRows = allRows.slice(1);
  const headers = originalHeaders.map(h => normalizarEncabezado(h.replace(/\uFEFF/g, '').replace(/^"|"$/g, '')));
  
  // --- FIN DE CAMBIOS ---

  // Lógica de filtrado ahora usa los encabezados normalizados para las excepciones.
  const finalAlerts = reportRows.filter(row => {
    const isRowEmpty = row.join('').trim() === '';
    if (isRowEmpty) return false;
    // 2. Se pasan los encabezados normalizados a la función de excepciones.
    return !isRowExcepted(row, headers, clientConfig.exceptions);
  });
  
  const existingTicketKey = findExistingJiraTicket(APAGADAS_VMS_JIRA_TICKET_SUMMARY, clientConfig.jiraProjectKey);
  let taskClosed = false;

  if (finalAlerts.length === 0) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El último reporte de VMs subdimensionadas no muestra alertas.");
      const closeResult = buscarYCerrarTareaProgramada(APAGADAS_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      return { status: 'SUCCESS', detail: { mensaje: `Anomalía Resuelta. Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}>.` }, taskClosed: taskClosed };
    } else {
      const closeResult = buscarYCerrarTareaProgramada(APAGADAS_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      return { status: 'SUCCESS', detail: { mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.`}, taskClosed: taskClosed };
    }
  }

  const alertCount = finalAlerts.length;
  const newFileName = attachment.getName().replace(/\.csv$/i, "-FILTRADO.xlsx");
  
  // CAMBIO: Se usan los encabezados originales para el archivo Excel.
  const xlsxBlob = convertDataToXlsxBlob([originalHeaders, ...finalAlerts], newFileName);

  if (existingTicketKey) {
    const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
    
    if (attachmentResult.status === 'SUCCESS') {
      const commentText = `🚨 **El problema persiste.** Se adjunta el reporte actualizado con **${alertCount}** VMs afectadas.`;
      addCommentToJiraTicket(existingTicketKey, commentText);
      const closeResult = buscarYCerrarTareaProgramada(APAGADAS_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
      const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, APAGADAS_VMS_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
      return { status: 'SUCCESS', detail: { mensaje: `Anomalía Persiste. Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` }, taskClosed: taskClosed };
    } else {
      return attachmentResult;
    }
  } else {
    // CAMBIO: Se usan los encabezados originales para crear el ticket.
    const creationResult = analyzeApagadasVMs_CSV(attachment.getName(), originalHeaders, finalAlerts, clientConfig);
    if (creationResult.status === 'SUCCESS') {
       const closeResult = buscarYCerrarTareaProgramada(APAGADAS_VMS_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
       creationResult.taskClosed = taskClosed;
    }
    return creationResult;
  }
}

function analyzeApagadasVMs_CSV(attachmentName, headers, finalAlerts, clientConfig) {
  const alertCount = finalAlerts.length;
  const summary = APAGADAS_VMS_JIRA_TICKET_SUMMARY;
  const description = `Se encontraron ${alertCount} VMs apagadas por un tiempo significativo. Se adjunta el reporte completo para la revisión del POD.`;
  
  const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
  const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);
  
  return createTicketAndNotify(summary, description, xlsxBlob, clientConfig,APAGADAS_VMS_OPERATION_NAME);
}
