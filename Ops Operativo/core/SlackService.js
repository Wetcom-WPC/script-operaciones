/**
 * Envía una única notificación de resumen a Slack al final de la ejecución.
 * VERSIÓN CORREGIDA: Maneja correctamente los objetos de advertencia.
 */
function enviarResumenSlack(operationName, summaryReport) {
  _registrarEnLog(operationName, summaryReport);
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL.trim() === "") return;

  const { exitos, advertencias, errores, tareasCerradas } = summaryReport;

  // Si no hay absolutamente nada que reportar, no hace nada.
  if (errores.length === 0 && advertencias.length === 0 && exitos.length === 0 && tareasCerradas === 0) {
    return;
  }

  let titulo;
  let mensaje = "";

  // 1. Define el título basado en la severidad máxima del evento.
  if (errores.length > 0) {
    titulo = `❌ Ejecución con Errores (${operationName})`;
  } else if (advertencias.length > 0) {
    titulo = `⚠️ Ejecución con Advertencias (${operationName})`;
  } else {
    titulo = `✅ Ejecución Exitosa (${operationName})`;
  }

  // 2. Construye el mensaje por bloques, sin usar "else if".

  // Bloque de Errores (si existen)
  if (errores.length > 0) {
    mensaje += `\n\n*--- 🚨 ERRORES CRÍTICOS ---*`;
    errores.forEach(err => {
      mensaje += `\n• *Cliente:* ${err.cliente || "_Desconocido_"}`; // NUEVO
      mensaje += `\n  • *Error:* \`${err.error}\``;
      if (err.ticket) mensaje += `\n  • *Ticket:* <${JIRA_DOMAIN}/browse/${err.ticket}|${err.ticket}>`; // NUEVO
      if (err.detalle) mensaje += `\n  • *Detalle:* ${err.detalle}`;
    });
  }

    // --- INICIO DE LA CORRECCIÓN EN EL BLOQUE DE ADVERTENCIAS ---
  if (advertencias.length > 0) {
    mensaje += `\n\n*--- ⚠️ ADVERTENCIAS ---*`;
    advertencias.forEach(warn => {
      // Log de diagnóstico para ver el objeto exacto que llega.
      Logger.log(`Objeto de advertencia recibido para Slack: ${JSON.stringify(warn)}`);

      // Lógica robusta para encontrar los datos, buscando en el objeto principal o en su propiedad "detail".
      const warningData = warn.detail || warn;

      // Verificación ANTES de imprimir para evitar "undefined".
      if (warningData.ticketKey) {
        mensaje += `\n• *Ticket:* <${JIRA_DOMAIN}/browse/${warningData.ticketKey}|${warningData.ticketKey}>`;
        mensaje += `\n• *Problema:* ${warningData.problema || 'No se especificó el problema.'}`;
      } else {
        // Mensaje genérico si no se encuentra el ticketKey, usando la información que sí tengamos.
        mensaje += `\n• *Problema:* Ocurrió un fallo durante una operación. ${warningData.problema || '(Sin detalles adicionales)'}`;
      }
      
      if (warningData.accion) mensaje += `\n• *Acción:* ${warningData.accion}`;
    });
  }
  
  // Bloque de Éxitos (si existen)
  if (exitos.length > 0) {
    mensaje += `\n\n*--- ✅ ÉXITOS ---*`;
    exitos.forEach(succ => {
      mensaje += `\n• ${succ.mensaje}`;
    });
  }

  // Bloque de Tareas Cerradas (si existen)
  if (tareasCerradas > 0) {
    // Si ya hay una sección de éxitos, lo añade ahí. Si no, crea su propia sección.
    if (exitos.length === 0) {
       mensaje += `\n\n*--- ✅ ÉXITOS ---*`;
    }
    mensaje += `\n• Se cerraron *${tareasCerradas}* tareas programadas.`;
  }
  
  const fullMessage = `*${titulo}*${mensaje}`;
  try {
    sendSlackMessage(SLACK_WEBHOOK_URL, fullMessage);
  } catch (e) { /* Fallo silencioso */ }
}

/**
 * Envía una alerta crítica en tiempo real a Slack en caso de fallos severos (ej. agotamiento de reintentos de red o TimeGuard).
 * @param {string} titulo Título de la alerta crítica.
 * @param {string} detalle Descripción o detalle del fallo.
 * @param {string} [stackTrace=""] Traza de pila opcional.
 */
function enviarAlertaCriticaSlack(titulo, detalle, stackTrace = "") {
  try {
    if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL.trim() === "") return;
    
    let mensaje = `*🚨 ALERTA CRÍTICA: ${titulo}*\n• *Detalle:* ${detalle}`;
    if (stackTrace) {
      mensaje += `\n• *Stack:* \`${stackTrace.substring(0, 400)}\``;
    }
    
    const payload = JSON.stringify({ text: mensaje });
    // Usamos UrlFetchApp directo o fetch de 1 intento para no hacer bucle con fetchWithRetries si falla Slack
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: payload,
      muteHttpExceptions: true
    });
    Logger.log(`[SlackService] Alerta crítica enviada: ${titulo}`);
  } catch (e) {
    Logger.log(`[SlackService] Error al enviar alerta crítica a Slack: ${e.message}`);
  }
}


