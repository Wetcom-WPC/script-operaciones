function verTiposDeIssueValidos() {
  // PONE AQUÍ LA KEY DEL PROYECTO QUE DA ERROR (ej: "COM", "SOP")
  const PROJECT_KEY = "WPC"; 
  
  const endpoint = `${JIRA_DOMAIN}/rest/api/2/issue/createmeta?projectKeys=${PROJECT_KEY}&expand=projects.issuetypes`;
  const options = {
    "method": "get",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "muteHttpExceptions": true
  };

  const response = UrlFetchApp.fetch(endpoint, options);
  Logger.log("--- TIPOS VÁLIDOS PARA " + PROJECT_KEY + " ---");
  
  if (response.getResponseCode() === 200) {
    const data = JSON.parse(response.getContentText());
    if (data.projects && data.projects.length > 0) {
      const types = data.projects[0].issuetypes;
      types.forEach(t => {
        Logger.log(`Nombre: "${t.name}"  (ID: ${t.id})`);
      });
    } else {
      Logger.log("No se encontró información del proyecto.");
    }
  } else {
    Logger.log("Error: " + response.getContentText());
  }
}

/**
 * Envía un mensaje de prueba al webhook de Slack para verificar la integración.
 */
function testearNotificacionSlack() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL");
  if (!webhookUrl) {
    Logger.log("❌ Error: No se encontró la propiedad SLACK_WEBHOOK_GENERAL.");
    return;
  }
  
  const payload = JSON.stringify({
    text: "🚀 *¡Hola!* Esto es una notificación de prueba desde el Apps Script de testing. La integración con Slack está funcionando."
  });
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": payload,
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(webhookUrl, options);
    Logger.log(`Código de respuesta de Slack: ${response.getResponseCode()}`);
    Logger.log(`Respuesta de Slack: ${response.getContentText()}`);
  } catch (e) {
    Logger.log(`❌ Error al enviar mensaje a Slack: ${e.message}`);
  }
}

/**
 * Envía un mensaje de prueba al canal mock-auditoria-pods.
 */
function testearSlackAuditoriaPods() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AUDITOR_POD_1");
  if (!webhookUrl) {
    Logger.log("❌ Error: No se encontró la propiedad SLACK_WEBHOOK_AUDITOR_POD_1.");
    return;
  }
  
  const payload = JSON.stringify({
    text: "🔍 *[Auditoría PODs - Testing]* Mensaje de prueba enviado al canal mock-auditoria-pods."
  });
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": payload,
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(webhookUrl, options);
    Logger.log(`[Auditoría] Código: ${response.getResponseCode()} | Respuesta: ${response.getContentText()}`);
  } catch (e) {
    Logger.log(`❌ Error: ${e.message}`);
  }
}

/**
 * Envía un mensaje de prueba al canal mock-comunicaciones-pods.
 */
function testearSlackAvisosPods() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AVISOS_POD_1");
  if (!webhookUrl) {
    Logger.log("❌ Error: No se encontró la propiedad SLACK_WEBHOOK_AVISOS_POD_1.");
    return;
  }
  
  const payload = JSON.stringify({
    text: "📢 *[Avisos PODs - Testing]* Mensaje de prueba enviado al canal mock-comunicaciones-pods."
  });
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": payload,
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(webhookUrl, options);
    Logger.log(`[Avisos] Código: ${response.getResponseCode()} | Respuesta: ${response.getContentText()}`);
  } catch (e) {
    Logger.log(`❌ Error: ${e.message}`);
  }
}

/**
 * Elimina todos los activadores de tiempo (triggers) programados en el proyecto.
 * Detiene por completo la ejecución recurrente cada 2 minutos.
 */
function detenerTodosLosActivadores() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log(`🛑 Encontrados ${triggers.length} activadores activos. Procediendo a eliminar...`);
  
  for (const trigger of triggers) {
    try {
      ScriptApp.deleteTrigger(trigger);
      Logger.log(`- Activador eliminado: ${trigger.getHandlerFunction()}`);
    } catch (e) {
      Logger.log(`- Error al eliminar activador: ${e.message}`);
    }
  }
  
  // Limpiamos también el índice para reiniciar desde cero el próximo ciclo
  PropertiesService.getScriptProperties().deleteProperty('INDICE_SIGUIENTE_TAREA');
  Logger.log("✅ Ciclo detenido y reseteado con éxito.");
}
