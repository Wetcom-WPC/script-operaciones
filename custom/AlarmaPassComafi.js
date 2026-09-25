/**
 * @fileoverview Alarma mensual para restablecer la contraseña de Miqueas (Comafi).
 * Ejecución: Día 12 de cada mes, entre las 8:00 y las 9:00 AM.
 */

function enviarAlertaPasswordMiqueas() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_COMAFI");
  if (!webhookUrl || webhookUrl.trim() === "") {
    Logger.log("[AlarmaPassComafi] Error: SLACK_WEBHOOK_COMAFI no está configurado en las Script Properties.");
    return;
  }

  const mensaje = `🚨 *ATENCIÓN <!channel>:* Se venció la password de Miqueas de Comafi y hay que restablecerla.\n\n` +
                  `🔗 *Link para restablecer:* https://passwordreset.microsoftonline.com/passwordreset#!/\n` +
                  `🔑 *Aclaración:* Pedir token a POD 2.`;

  const payload = { "text": mensaje };
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload)
  };

  try {
    fetchWithRetries(webhookUrl, options);
    Logger.log("Mensaje enviado a Slack con éxito.");
  } catch (e) {
    Logger.log("Error al enviar mensaje a Slack: " + e.message);
  }
}
