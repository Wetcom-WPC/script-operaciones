/**
 * @fileoverview Alarma mensual para restablecer la contraseña de Miqueas (Comafi).
 * Ejecución: Día 12 de cada mes, entre las 8:00 y las 9:00 AM.
 */

// 1. REEMPLAZA ESTA URL CON EL WEBHOOK DE TU CANAL DE SLACK
const SLACK_WEBHOOK_URL_COMAFI = "REDACTED_SLACK_WEBHOOK"; 

function enviarAlertaPasswordMiqueas() {
  
  // 2. REEMPLAZA ESTO CON EL ID DE SLACK DE THIAGO (Ej: "U0123ABCD")
  const idThiago = "U087XUMAQSJ"; 

  // Armamos el mensaje con el formato de menciones de Slack (<!channel> y <@ID>)
  const mensaje = `🚨 *ATENCIÓN:* Se venció la password de Miqueas de Comafi y hay que restablecerla.\n\n` +
                  `🔗 *Link para restablecer:* https://passwordreset.microsoftonline.com/passwordreset#!/\n` +
                  `🔑 *Aclaración:* Pedir token a Nico Moraez.`;

  const payload = {
    "text": mensaje
  };

  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload)
  };

  try {
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL_COMAFI, options);
    Logger.log("Mensaje enviado a Slack con éxito.");
  } catch (e) {
    Logger.log("Error al enviar mensaje a Slack: " + e.message);
  }
}