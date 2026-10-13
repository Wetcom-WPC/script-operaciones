/**
 * Servicio para el envío de notificaciones a Slack
 */
const SlackService = {
  
  enviarNotificacion: function(message) {
    const webhookUrl = Config.obtenerWebhookSlack();
    
    if (!webhookUrl || webhookUrl.trim() === "") {
      Logger.log("Webhook de Slack no configurado, saltando envío.");
      return;
    }

    const payload = JSON.stringify({ 
      text: message 
    });
    
    const options = { 
      method: "post", 
      contentType: "application/json", 
      payload: payload, 
      muteHttpExceptions: true 
    };

    const response = UrlFetchApp.fetch(webhookUrl, options);
    const statusCode = response.getResponseCode();
    
    if (statusCode < 200 || statusCode >= 300) {
      const errorMsg = `Error HTTP ${statusCode} al enviar a Slack: ${response.getContentText()}`;
      Logger.log(errorMsg);
      throw new Error(errorMsg);
    }
  },

  enviarNotificacionGuardia: function(message) {
    const webhookUrl = Config.SLACK_WEBHOOK_GUARDIA;
    
    if (!webhookUrl || webhookUrl.trim() === "") {
      Logger.log("Webhook de Slack Guardia no configurado, saltando envío.");
      return;
    }

    const payload = JSON.stringify({ 
      text: message 
    });
    
    const options = { 
      method: "post", 
      contentType: "application/json", 
      payload: payload, 
      muteHttpExceptions: true 
    };

    const response = UrlFetchApp.fetch(webhookUrl, options);
    const statusCode = response.getResponseCode();
    
    if (statusCode < 200 || statusCode >= 300) {
      const errorMsg = `Error HTTP ${statusCode} al enviar a Slack Guardia: ${response.getContentText()}`;
      Logger.log(errorMsg);
      throw new Error(errorMsg);
    }
  },

  /**
   * Publica en el canal de logs una alarma silenciada.
   * `cierre` es opcional: si viene (`{ cerrado, detalle }`), se agrega una línea contando
   * si el ticket se pudo cerrar en Jira o no, así el fallo no queda sólo en los Logger.
   */
  enviarLogExcepcion: function(mensaje, ticketKey, cierre) {
    // Si el webhook no está configurado, el aviso no se pierde: baja al Logger.
    let webhookURL;
    try {
      webhookURL = Config.obtenerWebhookLogs();
    } catch (e) {
      Logger.log(`Log de excepción omitido (${e.message}): ${mensaje}`);
      return;
    }

    let header = "🔇 *Alarma Silenciada*";
    if (ticketKey) {
      header = `🔇 *Alarma Silenciada* | <https://wetcom.atlassian.net/browse/${ticketKey}|${ticketKey}>`;
    }

    let pie = "";
    if (cierre) {
      pie = cierre.cerrado
        ? "\n✅ _Ticket cerrado automáticamente._"
        : `\n⚠️ _No se pudo cerrar el ticket: ${cierre.detalle}_`;
    }

    const payload = JSON.stringify({
      text: `${header}\n_${mensaje}_${pie}`
    });
    const options = { 
      method: "post", 
      contentType: "application/json", 
      payload: payload, 
      muteHttpExceptions: true 
    };
    UrlFetchApp.fetch(webhookURL, options);
  },

  /**
   * Publica un texto libre en el canal de logs (mismo webhook que enviarLogExcepcion).
   * Pensado para avisos operativos que no son sobre una alarma puntual (ej: falla de una
   * API externa). Best-effort: nunca lanza, para no tumbar al llamador por un problema de
   * Slack encima del problema que ya se está avisando.
   */
  enviarLogTexto: function(mensaje) {
    let webhookURL;
    try {
      webhookURL = Config.obtenerWebhookLogs();
    } catch (e) {
      Logger.log(`Log omitido (${e.message}): ${mensaje}`);
      return;
    }

    try {
      UrlFetchApp.fetch(webhookURL, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ text: mensaje }),
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log(`No se pudo publicar en el canal de logs: ${e.message}`);
    }
  }
};
