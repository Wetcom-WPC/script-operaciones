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

class JobsVeeamProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: VEEAM_OPERATION_NAME,
      emailSubject: VEEAM_EMAIL_SUBJECT,
      attachmentMatch: VEEAM_FILENAME_MATCH,
      scheduledTaskName: VEEAM_SCHEDULED_TASK_NAME
    });
  }

  processSingleMessage(message, summaryReport) {
    this._currentSenderEmail = message.getFrom();
    const emailSubject = message.getSubject();
    
    if (emailSubject.toLowerCase().includes("success")) {
      const clientConfig = getClientConfig(this._currentSenderEmail, this.operationName);
      if (clientConfig) {
        summaryReport.exitos.push({ mensaje: `Reporte Veeam (SUCCESS) de ${clientConfig.clientName}.` });
        const closeResult = buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
        if(closeResult && closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      }
      return { status: 'SUCCESS' };
    }
    return super.processSingleMessage(message, summaryReport);
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (config) config.tecnologia = "Veeam Backup & Replication"; 
    return config;
  }

  processData(parsedData, clientConfig, summaryReport) {
    const rawHeaders = parsedData[0];
    const headers = rawHeaders.map(h => h.toString().replace(/^\uFEFF|"/g, '').trim());

    const idxResult = headers.indexOf(VEEAM_COLS.RESULT);
    const idxError = headers.indexOf(VEEAM_COLS.ERROR_MESSAGE);
    const idxJobName = headers.indexOf(VEEAM_COLS.JOB_NAME);
    const idxObjectName = headers.indexOf(VEEAM_COLS.OBJECT_NAME); 

    if (idxResult === -1 || idxError === -1 || idxJobName === -1) {
      summaryReport.errores.push({ error: "Columnas faltantes", detalle: clientConfig.clientName });
      return null;
    }

    const normalizedHeaders = headers.map(h => normalizarEncabezado(h));
    const ignoredPhrases = ["processing finished with warnings", "job finished with warnings", "finished with warnings"];

    const jobsData = {}; 

    for (let i = 1; i < parsedData.length; i++) {
      const row = parsedData[i];
      const res = row[idxResult];
      const status = res ? res.toString().trim().toLowerCase() : "";
      
      if (!['warning', 'error', 'failed'].includes(status)) continue;
      if (isRowExcepted(row, normalizedHeaders, clientConfig.exceptions)) continue; 

      const cleanError = (row[idxError] || "").trim();
      if (!cleanError) continue;
      if (ignoredPhrases.some(ph => cleanError.toLowerCase().includes(ph))) continue;

      const jobName = (row[idxJobName] || "Job Desconocido").trim();
      const vmName = (idxObjectName !== -1 && row[idxObjectName]) ? row[idxObjectName].trim() : "Objeto General";

      if (!jobsData[jobName]) {
          jobsData[jobName] = { primaryError: cleanError, isFailed: false, items: [] };
      }
      if (status === 'failed' || status === 'error') {
          jobsData[jobName].isFailed = true;
      }
      jobsData[jobName].items.push({ vm: vmName, error: cleanError });
    }

    const ticketsMap = {}; 
    for (const [jobName, data] of Object.entries(jobsData)) {
        const errorKey = data.primaryError; 
        if (!ticketsMap[errorKey]) ticketsMap[errorKey] = [];
        ticketsMap[errorKey].push({ name: jobName, items: data.items, isFailed: data.isFailed });
    }

    const finalAlerts = [];
    for (const [errorKey, affectedJobs] of Object.entries(ticketsMap)) {
      finalAlerts.push({ errorKey, affectedJobs });
    }

    return { headers, finalAlerts, rowsForExport: [], reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return null;
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    let finalStatus = 'SUCCESS';
    const clientConfigSop = getClientConfig(this._currentSenderEmail, this.operationName, true);

    for (const alertGroup of finalAlerts) {
      const { errorKey: mainError, affectedJobs } = alertGroup;
      const jobsCount = affectedJobs.length;
      const isTicketCritical = affectedJobs.some(j => j.isFailed);
      const globalStatus = isTicketCritical ? 'Failed' : 'Warning';

      let targetSummary = "";
      if (jobsCount === 1) {
          targetSummary = `Se detectó el job ${affectedJobs[0].name} finalizado en ${globalStatus}`;
      } else {
          targetSummary = `Se detectaron multiples jobs finalizados en ${globalStatus} (mismo error)`;
      }

      let description = `Se han detectado anomalías (${globalStatus}) en los backups.\n\n`;
      if (jobsCount > 1) {
          description += `*Error Común:* {quote}${mainError}{quote}\n\n`;
      }

      affectedJobs.forEach(job => {
          description += `* Job: ${job.name}\n`; 
          const vmsMap = {};
          job.items.forEach(item => {
              if (!vmsMap[item.vm]) vmsMap[item.vm] = new Set();
              vmsMap[item.vm].add(item.error);
          });
          for (const [vmName, errorsSet] of Object.entries(vmsMap)) {
              description += `** Objeto: ${vmName}\n`; 
              errorsSet.forEach(err => {
                  description += `*** Error: ${err}\n`; 
              });
          }
          description += `\n`;
      });
      description += `Se deberá analizar la anomalía y coordinar solución.`;

      const activeConfig = isTicketCritical ? clientConfigSop : clientConfig;
      const projectKey = activeConfig.jiraProjectKey;

      const existingTicket = findExistingJiraTicket(targetSummary, projectKey);

      if (existingTicket) {
          let commentText = `El problema persiste en:\n`;
          affectedJobs.forEach(j => commentText += `* ${j.name}\n`);
          addCommentToJiraTicket(existingTicket, commentText);
          summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicket}|${existingTicket}>.` });
      } else {
          let result;
          if (isTicketCritical) {
              result = createTicketAndNotifySoporte(targetSummary, description, null, clientConfigSop, this.operationName);
          } else {
              result = createTicketAndNotify(targetSummary, description, null, clientConfig, this.operationName);
          }

          if (result.status === 'SUCCESS') {
              summaryReport.exitos.push(result.detail);
          } else {
              summaryReport.errores.push(result.detail);
              finalStatus = 'FAILURE';
          }
      }
    }
    return { status: finalStatus };
  }
}

function processVeeamJobWarnings() {
  new JobsVeeamProcessor().processEmails();
}


