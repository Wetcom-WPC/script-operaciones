/**
 * @fileoverview Servicio unificado de notificaciones para Slack y Correo Electrónico (Fase 5).
 * Centraliza el envío de mensajes, la lógica de reintentos, plantillas HTML modernas
 * y reemplaza llamadas ad-hoc de MailApp/GmailApp y UrlFetchApp a webhooks de Slack.
 */

/**
 * Envía un mensaje a un Webhook de Slack con reintentos y tolerancia a fallos.
 * @param {string} webhookUrl URL del webhook de Slack (o clave de POD / identificador).
 * @param {string|Object} textOrPayload String con el texto del mensaje u objeto payload complejo (blocks/attachments).
 * @param {Object} [extraOptions={}] Opciones adicionales de fetch.
 * @returns {boolean} `true` si se envió exitosamente (HTTP 200), `false` en caso contrario.
 */
function sendSlackMessage(webhookUrl, textOrPayload, extraOptions = {}) {
  let url = webhookUrl;
  if (!url || typeof url !== 'string' || !url.startsWith("http")) {
    const defaultWebhook = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL");
    if (!defaultWebhook) {
      Logger.log(`[NotificationService] Error: Webhook inválido (${webhookUrl}) y SLACK_WEBHOOK_GENERAL no configurado.`);
      return false;
    }
    url = defaultWebhook;
  }

  let payloadObj;
  if (typeof textOrPayload === 'string') {
    payloadObj = { text: textOrPayload };
  } else if (typeof textOrPayload === 'object' && textOrPayload !== null) {
    payloadObj = textOrPayload;
  } else {
    Logger.log("[NotificationService] Error: textOrPayload inválido para Slack.");
    return false;
  }

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payloadObj),
    muteHttpExceptions: true,
    ...extraOptions
  };

  try {
    const response = fetchWithRetries(url, options);
    if (response && response.getResponseCode() === 200) {
      return true;
    } else {
      const code = response ? response.getResponseCode() : 'SIN RESPUESTA';
      const text = response ? response.getContentText() : '';
      Logger.log(`[NotificationService] Falló envío a Slack (${code}): ${text}`);
      return false;
    }
  } catch (e) {
    Logger.log(`[NotificationService] Excepción al enviar a Slack: ${e.message}`);
    return false;
  }
}

/**
 * Envía un correo electrónico estandarizado utilizando GmailApp, con soporte para HTML y adjuntos.
 * @param {Object} params Opciones de envío.
 * @param {string} params.to Dirección de correo de destino (destinatario/s).
 * @param {string} params.subject Asunto del correo.
 * @param {string} [params.body] Texto plano del correo (si no se provee y hay htmlBody, se genera un texto por defecto).
 * @param {string} [params.htmlBody] Cuerpo HTML del correo.
 * @param {string} [params.cc] Direcciones en copia (CC).
 * @param {string} [params.bcc] Direcciones en copia oculta (BCC).
 * @param {GoogleAppsScript.Base.Blob[]} [params.attachments] Array de blobs adjuntos.
 * @param {string} [params.name="Wetcom Proactive Center"] Nombre del remitente mostrado.
 * @param {string} [params.from] Dirección de correo remitente (si es alias verificado en Gmail).
 * @returns {boolean} `true` si el correo se envió con éxito, `false` en caso de error.
 */
function sendEmail({ to, subject, body, htmlBody, cc, bcc, attachments, name, from }) {
  if (!to || !subject) {
    Logger.log("[NotificationService] Error: 'to' y 'subject' son requeridos para sendEmail.");
    return false;
  }

  // --- SAFEGUARD TERMINANTE PARA ENTORNO DE TESTING (PLAYGROUND) ---
  // Queda terminantemente prohibido enviar correos a PODs y clientes reales en testing.
  // Todo envío se redirige de forma forzosa y exclusiva a ian.lucero@wetcom.com si estamos en TESTING.
  const isTestingEnv = PropertiesService.getScriptProperties().getProperty("ENVIRONMENT") === "TESTING";
  
  if (isTestingEnv) {
    const originalTo = to;
    to = "ian.lucero@wetcom.com";
    cc = "";
    bcc = "";
    if (originalTo && originalTo.toLowerCase() !== to.toLowerCase()) {
      Logger.log(`[SAFEGUARD TESTING] Redirigiendo correo (Destinatario original: "${originalTo}") -> ÚNICO PERMITIDO: "${to}"`);
    }
  }

  const plainTextBody = body || (htmlBody ? "Por favor, vea este mensaje en un cliente de correo compatible con formato HTML." : "");
  const senderName = name || "Wetcom Proactive Center";

  const options = {
    name: senderName
  };

  if (htmlBody) options.htmlBody = htmlBody;
  if (cc) options.cc = cc;
  if (bcc) options.bcc = bcc;
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    options.attachments = attachments;
  }
  if (from) options.from = from;

  let retries = 0;
  const maxRetries = 2;

  while (retries <= maxRetries) {
    try {
      GmailApp.sendEmail(to, subject, plainTextBody, options);
      Logger.log(`[NotificationService] Correo enviado exitosamente a: ${to} | Asunto: "${subject}"`);
      return true;
    } catch (e) {
      Logger.log(`[NotificationService] Error al enviar correo a ${to} (intento ${retries + 1}/${maxRetries + 1}): ${e.message}`);
      if (retries < maxRetries) {
        Utilities.sleep(2000 * Math.pow(2, retries));
      } else {
        Logger.log(`[NotificationService] Fallo definitivo al enviar correo a ${to}: ${e.message}`);
      }
      retries++;
    }
  }
  return false;
}

/**
 * Genera una plantilla HTML profesional y responsive para correos de reportes y alertas de Wetcom.
 * @param {Object} params Configuración de la plantilla.
 * @param {string} params.title Título principal del correo (ej. "Reporte Diario de Operaciones").
 * @param {string} [params.preheader=""] Texto preheader visible en la vista previa del buzón.
 * @param {string} params.contentHtml Contenido HTML interno (párrafos, tablas, listas).
 * @param {string} [params.statusColor="#0056b3"] Color del borde/acento superior (ej. "#28a745" para éxito, "#dc3545" para error, "#ffc107" para advertencia).
 * @param {string} [params.footerText="Wetcom Proactive Center - Sistema de Operaciones Automatizado"] Texto del pie de página.
 * @returns {string} Código HTML completo del correo listo para usar en htmlBody.
 */
function buildHtmlEmailTemplate({ title, preheader = "", contentHtml, statusColor = "#0056b3", footerText = "" }) {
  const defaultFooter = footerText || "Wetcom Proactive Center — Sistema Automatizado de Operaciones y Monitoreo";
  
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f9; margin: 0; padding: 0; color: #333333; }
  .preheader { display: none !important; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; }
  .email-container { max-width: 640px; margin: 30px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); overflow: hidden; border-top: 6px solid ${statusColor}; }
  .header { padding: 24px 30px; background-color: #ffffff; border-bottom: 1px solid #eeeeee; }
  .header h1 { margin: 0; font-size: 22px; color: #1a1a1a; font-weight: 600; }
  .content { padding: 30px; line-height: 1.6; font-size: 15px; color: #444444; }
  .content p { margin-top: 0; margin-bottom: 16px; }
  .content table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; }
  .content th { background-color: #f8f9fa; text-align: left; padding: 10px 12px; border-bottom: 2px solid #dee2e6; color: #495057; }
  .content td { padding: 10px 12px; border-bottom: 1px solid #e9ecef; color: #333333; }
  .footer { background-color: #f8f9fa; padding: 20px 30px; text-align: center; font-size: 12px; color: #6c757d; border-top: 1px solid #eeeeee; }
</style>
</head>
<body>
  <span class="preheader">${preheader}</span>
  <div class="email-container">
    <div class="header">
      <h1>${title}</h1>
    </div>
    <div class="content">
      ${contentHtml}
    </div>
    <div class="footer">
      <p style="margin: 0;">${defaultFooter}</p>
      <p style="margin: 6px 0 0 0; font-size: 11px; color: #adb5bd;">Este es un mensaje generado automáticamente por el orquestador de Operaciones.</p>
    </div>
  </div>
</body>
</html>`;
}
