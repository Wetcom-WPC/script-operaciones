function testSlackConnection() {
  const url = typeof SLACK_WEBHOOK_URL !== "undefined" ? SLACK_WEBHOOK_URL : "No definida";
  Logger.log("Probando conexión a Slack. URL configurada: " + url);
  
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL.trim() === "") {
    Logger.log("❌ ERROR: La constante SLACK_WEBHOOK_URL está vacía o no definida en ConfiguracionGlobal.js");
    return;
  }
  
  const mensajePrueba = "*🤖 Prueba de Conexión a Slack*\nSi estás leyendo esto, significa que la conexión desde Google Apps Script a Slack funciona correctamente en el entorno de Testing.";
  
  const payload = { "text": mensajePrueba };
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, options);
    const statusCode = response.getResponseCode();
    Logger.log(`Respuesta de Slack: Código ${statusCode}. Mensaje: "${response.getContentText()}"`);
    if (statusCode === 200) {
      Logger.log("✅ Conexión exitosa a Slack.");
    } else {
      Logger.log("❌ Slack rechazó el mensaje. Revisa el código de respuesta.");
    }
  } catch (e) {
    Logger.log("❌ Error de red al intentar conectar a Slack: " + e.message);
  }
}
