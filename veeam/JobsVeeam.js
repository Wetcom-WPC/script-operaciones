// ==============================================================================
// --- CONFIGURACIÓN ESPECÍFICA DE VEEAM JOB WARNINGS ---
// ==============================================================================

const VEEAM_OPERATION_NAME = "Jobs de Veeam";
const VEEAM_EMAIL_SUBJECT = "Jobs de Veeam";
const VEEAM_FILENAME_MATCH = ".csv";
const VEEAM_SCHEDULED_TASK_NAME = "Jobs de Veeam";
const VEEAM_JIRA_SUMMARY_TEXT = "TEST DESESTIMAR - Se detectaron jobs finalizados con el mismo error";
const VEEAM_IGNORE_PHRASE = "processing finished with warnings"; // Frase a ignorar



// Nombres exactos de las columnas esperadas en el CSV

const VEEAM_COLS = {
  JOB_NAME: 'JobName',
  JOB_TYPE: 'JobType',
  SESSION_START: 'SessionStart',
  SESSION_END: 'SessionEnd',
  RESULT: 'Result',
  OBJECT_NAME: 'ObjectName',
  OBJECT_STATUS: 'ObjectStatus',
  ERROR_MESSAGE: 'ErrorMessage'
};



// ==============================================================================
// --- LÓGICA PRINCIPAL DE VEEAM JOB WARNINGS ---
// ==============================================================================



function processVeeamJobWarnings() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  
  // 1. Buscamos correos no leídos con el asunto configurado
  const searchQuery = construirBusquedaGmail(VEEAM_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);

  if (threads.length > 0) {
    threads.forEach(thread => {
      // Tomamos el último mensaje del hilo
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleVeeamJobMessage(message, summaryReport);
          // Si fue exitoso (o no hubo nada que reportar), marcamos como leído

          if (processingStatus === 'SUCCESS') {
            thread.markRead();
          }

        } catch (e) {
          summaryReport.errores.push({
            error: e.message,
            detalle: `Procesando Veeam Jobs en correo: "${message.getSubject()}"`
          });
        }
      }
    });
    // Enviamos resumen a Slack
    enviarResumenSlack(VEEAM_OPERATION_NAME, summaryReport);
  }
}


function processSingleVeeamJobMessage(message, summaryReport) {
  const senderEmail = message.getFrom();
  const emailSubject = message.getSubject();

  // 1. Configuración Ops
  const clientConfig = getClientConfig(senderEmail, VEEAM_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "No config found", detalle: senderEmail });
    return 'FAILURE';
  }
  
  // Forzamos tecnología
  clientConfig.tecnologia = "Veeam Backup & Replication"; 
  // Configuración Soporte (para tickets Failed)
  const clientConfigSop = getClientConfig(senderEmail, VEEAM_OPERATION_NAME, true);

  // 2. Auto-cierre Success
  if (emailSubject.toLowerCase().includes("success")) {
    summaryReport.exitos.push({ mensaje: `Reporte Veeam (SUCCESS) de ${clientConfig.clientName}.` });
    const closeResult = buscarYCerrarTareaProgramada(VEEAM_SCHEDULED_TASK_NAME, clientConfig, false);
    if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    return 'SUCCESS';
  }

  // 3. Adjunto
  const attachment = message.getAttachments().find(att => att.getName().toLowerCase().endsWith(VEEAM_FILENAME_MATCH));
  if (!attachment) return 'SUCCESS';

  // 4. Leer CSV
  let allRows = [];
  try {
    allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
  } catch (e) {
    summaryReport.errores.push({ error: "Error CSV", detalle: emailSubject });
    return 'FAILURE';
  }

  if (!allRows || allRows.length === 0) return 'FAILURE';

  // Headers
  const rawHeaders = allRows[0];
  const headers = rawHeaders.map(h => h.toString().replace(/^\uFEFF|"/g, '').trim());

  const idxResult = headers.indexOf(VEEAM_COLS.RESULT);
  const idxError = headers.indexOf(VEEAM_COLS.ERROR_MESSAGE);
  const idxJobName = headers.indexOf(VEEAM_COLS.JOB_NAME);
  const idxObjectName = headers.indexOf(VEEAM_COLS.OBJECT_NAME); 

  if (idxResult === -1 || idxError === -1 || idxJobName === -1) {
    summaryReport.errores.push({ error: "Columnas faltantes", detalle: clientConfig.clientName });
    return 'FAILURE';
  }

  // ===========================================================================
  // 5. LÓGICA DE RECOLECCIÓN (Por Job)
  // ===========================================================================
  
  const normalizedHeaders = headers.map(h => normalizarEncabezado(h));
  const ignoredPhrases = ["processing finished with warnings", "job finished with warnings", "finished with warnings"];

  // Estructura: { 'JobName': { primaryError: string, isFailed: boolean, items:Array } }
  const jobsData = {}; 

  allRows.forEach(row => {
      const res = row[idxResult];
      const status = res ? res.toString().trim().toLowerCase() : "";
      
      // Filtros básicos
      if (!['warning', 'error', 'failed'].includes(status)) return;
      
      // --- VALIDACIÓN DE EXCEPCIONES ---
      if (isRowExcepted(row, normalizedHeaders, clientConfig.exceptions)) return; 

      const cleanError = (row[idxError] || "").trim();
      if (!cleanError) return;
      if (ignoredPhrases.some(ph => cleanError.toLowerCase().includes(ph))) return;

      const jobName = (row[idxJobName] || "Job Desconocido").trim();
      const vmName = (idxObjectName !== -1 && row[idxObjectName]) ? row[idxObjectName].trim() : "Objeto General";

      // Inicializamos el Job
      if (!jobsData[jobName]) {
          jobsData[jobName] = { 
              primaryError: cleanError, // Usamos el primer error válido como clave de agrupación
              isFailed: false, 
              items: [] 
          };
      }
      
      // Si hay un failed, el job entero es crítico
      if (status === 'failed' || status === 'error') {
          jobsData[jobName].isFailed = true;
      }

      jobsData[jobName].items.push({
          vm: vmName,
          error: cleanError
      });
  });

  if (Object.keys(jobsData).length === 0) return 'SUCCESS';

  // ===========================================================================
  // 6. AGRUPACIÓN POR ERROR (Multiples jobs -> 1 Ticket)
  // ===========================================================================
  
  const ticketsMap = {}; 

  for (const [jobName, data] of Object.entries(jobsData)) {
      const errorKey = data.primaryError; 

      if (!ticketsMap[errorKey]) {
          ticketsMap[errorKey] = [];
      }

      ticketsMap[errorKey].push({
          name: jobName,
          items: data.items,
          isFailed: data.isFailed
      });
  }

  // ===========================================================================
  // 7. GENERACIÓN DE TICKETS
  // ===========================================================================
  let finalStatus = 'SUCCESS';

  for (const [mainError, affectedJobs] of Object.entries(ticketsMap)) {
      
      const jobsCount = affectedJobs.length;
      const isTicketCritical = affectedJobs.some(j => j.isFailed);
      const globalStatus = isTicketCritical ? 'Failed' : 'Warning';

      // --- TÍTULO ---
      let targetSummary = "";
      if (jobsCount === 1) {
          targetSummary = `Se detectó el job ${affectedJobs[0].name} finalizado en ${globalStatus}`;
      } else {
          targetSummary = `Se detectaron multiples jobs finalizados en ${globalStatus} (mismo error)`;
      }

      // --- DESCRIPCIÓN ---
      let description = `Se han detectado anomalías (${globalStatus}) en los backups.\n\n`;
      
      if (jobsCount > 1) {
          description += `*Error Común:* {quote}${mainError}{quote}\n\n`;
      }

// --- FORMATO ESCALONADO ---
      affectedJobs.forEach(job => {
          description += `* Job: ${job.name}\n`; // Nivel 1
          
          // Agrupamos errores por VM
          const vmsMap = {};
          job.items.forEach(item => {
              if (!vmsMap[item.vm]) vmsMap[item.vm] = new Set();
              vmsMap[item.vm].add(item.error);
          });

          // Imprimimos con indentación de Jira
          for (const [vmName, errorsSet] of Object.entries(vmsMap)) {
              description += `** Objeto: ${vmName}\n`; // Nivel 2 (Con Tab visual)
              errorsSet.forEach(err => {
                  description += `*** Error: ${err}\n`; // Nivel 3 (Más adentro)
              });
          }
          description += `\n`;
      });

      description += `Se deberá analizar la anomalía y coordinar solución.`;

      // --- CREAR / ACTUALIZAR TICKET ---
      const activeConfig = isTicketCritical ? clientConfigSop : clientConfig;
      const projectKey = activeConfig.jiraProjectKey;

      const existingTicketKey = findExistingJiraTicket(targetSummary, projectKey);

      if (existingTicketKey) {
          let commentText = `El problema persiste en:\n`;
          affectedJobs.forEach(j => commentText += `* ${j.name}\n`);
          addCommentToJiraTicket(existingTicketKey, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}>.` });
      } else {
          let result;
          if (isTicketCritical) {
              result = createTicketAndNotifySoporte(targetSummary, description, null, clientConfigSop, VEEAM_OPERATION_NAME);
          } else {
              result = createTicketAndNotify(targetSummary, description, null, clientConfig, VEEAM_OPERATION_NAME);
          }

          if (result.status === 'SUCCESS') {
              summaryReport.exitos.push(result.detail);
          } else {
              summaryReport.errores.push(result.detail);
              finalStatus = 'FAILURE';
          }
      }
  }

  return finalStatus;
}

// Asegúrate de tener esta función auxiliar también
function normalizarEncabezado(header) {
    if (!header) return "";
    // Elimina comillas, espacios al inicio/final y caracteres invisibles (BOM)
    return header.toString().replace(/^"|"$/g, '').replace(/^\uFEFF/, '').trim();
}
