/**
 * =================================================================
 * SCRIPT DE REPORTE DE TAREAS PROGRAMADAS CERRADAS
 * =================================================================
 * Este script se ejecuta una vez al día para enviar un resumen a Slack
 * de todas las "Tareas Programadas" que fueron cerradas por la automatización.
 */

/**
 * Función principal que busca las tareas cerradas y envía la notificación.
 */
function generarReporteTareasCerradas() {
  
  const accountId = PropertiesService.getScriptProperties().getProperty("JIRA_DEFAULT_ASSIGNEE_ID"); 
  const ahora = new Date();
  ahora.setHours(0, 0, 0, 0);
  const inicioDelDia = Utilities.formatDate(ahora, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");

  // --- NUEVA CONSULTA JQL ---
  // Busca issues de tipo "Tarea Programada" cuyo estado CAMBIÓ a "Finalizado"
  // por el usuario de automatización, DESDE el inicio del día.
  const jql = `issuetype = "Tarea Programada" AND status changed to "${JIRA_STATUS_TO_CLOSE}" by "${accountId}" after "${inicioDelDia}"`;
  
  Logger.log(`Ejecutando JQL para tareas cerradas: ${jql}`);
  
  const endpoint = `https://wetcom.atlassian.net/rest/api/3/search/jql`;
  const payload = {
    "jql": jql,
    "maxResults": 100,
    "fields": ["summary", "project", "key"]
  };
  const options = {
    "method": "post",
    "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    const data = JSON.parse(response.getContentText());
    
    if (response.getResponseCode() !== 200) {
      Logger.log(`Error de Jira al buscar tareas cerradas. Código: ${response.getResponseCode()}. Mensaje: ${response.getContentText()}`);
      return;
    }

    if (!data.issues || data.issues.length === 0) {
      Logger.log("No se encontraron Tareas Programadas cerradas hoy.");
      return; // No envía mensaje si no hay nada que reportar
    }
    
    // --- CONSTRUCCIÓN DEL MENSAJE PARA SLACK ---
    let titulo = `*Tareas Programadas Cerradas Hoy - ${new Date().toLocaleDateString('es-AR')}*`;
    let mensajeSlack = "";
    
    data.issues.forEach(issue => {
      const nombreProyecto = issue.fields.project.name;
      const link = `https://wetcom.atlassian.net/browse/${issue.key}`;
      
      // Formato: • [Nombre del Proyecto] Resumen del ticket <link|Ticket Key>
      mensajeSlack += `\n• [${nombreProyecto}] ${issue.fields.summary} <${link}|${issue.key}>`;
    });
    
    const fullMessage = `${titulo}${mensajeSlack}`;
    
    // --- ENVÍO A SLACK ---
    const slackPayload = JSON.stringify({ text: fullMessage });
    const slackOptions = { 
      "method": "post", 
      "contentType": "application/json", 
      "payload": slackPayload, 
      "muteHttpExceptions": true 
    };
    
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, slackOptions);
    Logger.log(`Reporte de tareas cerradas enviado a Slack con éxito.`);

  } catch (e) {
    Logger.log(`Error crítico al generar el reporte de tareas cerradas: ${e.message}`);
  }
}


