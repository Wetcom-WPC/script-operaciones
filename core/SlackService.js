/**
 * Envía una única notificación de resumen a Slack al final de la ejecución.
 * VERSIÓN CORREGIDA: Maneja correctamente los objetos de advertencia.
 */
function enviarResumenSlack(operationName, summaryReport) {
  _registrarEnLog(operationName, summaryReport);
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL.trim() === "") return;

  const { exitos, advertencias, errores, tareasCerradas, tareasCerradasDetalle, drive } = summaryReport;

  // Si no hay absolutamente nada que reportar, no hace nada.
  if (errores.length === 0 && advertencias.length === 0 && exitos.length === 0 && tareasCerradas === 0 && (!drive || drive.length === 0)) {
    return;
  }

  let titulo;
  let mensaje = "";

  if (errores.length > 0) {
    titulo = `❌ Ejecución con Errores (${operationName})`;
  } else if (advertencias.length > 0) {
    titulo = `⚠️ Ejecución con Advertencias (${operationName})`;
  } else {
    titulo = `✅ Ejecución Exitosa (${operationName})`;
  }

  if (errores.length > 0) {
    mensaje += `\n\n*--- 🚨 ERRORES CRÍTICOS ---*`;
    errores.forEach(err => {
      mensaje += `\n• *Cliente:* ${err.cliente || "_Desconocido_"}`;
      mensaje += `\n  • *Error:* \`${err.error}\``;
      if (err.ticket) mensaje += `\n  • *Ticket:* <${JIRA_DOMAIN}/browse/${err.ticket}|${err.ticket}>`;
      if (err.detalle) mensaje += `\n  • *Detalle:* ${err.detalle}`;
    });
  }

  if (advertencias.length > 0) {
    mensaje += `\n\n*--- ⚠️ ADVERTENCIAS ---*`;
    advertencias.forEach(warn => {
      const warningData = warn.detail || warn;
      if (warningData.cliente) mensaje += `\n• *Cliente:* ${warningData.cliente}`;
      if (warningData.ticketKey) {
        mensaje += `\n• *Ticket:* <${JIRA_DOMAIN}/browse/${warningData.ticketKey}|${warningData.ticketKey}>`;
        mensaje += `\n• *Problema:* ${warningData.problema || 'No se especificó el problema.'}`;
      } else {
        mensaje += `\n• *Problema:* ${warningData.problema || '(Sin detalles adicionales)'}`;
      }
      if (warningData.accion) mensaje += `\n• *Acción:* ${warningData.accion}`;
    });
  }
  
  if (exitos.length > 0 || tareasCerradas > 0) {
    mensaje += `\n\n*--- ✅ ÉXITOS DE NEGOCIO ---*`;
    if (exitos.length > 0) {
      exitos.forEach(succ => {
        mensaje += `\n• ${succ.mensaje}`;
      });
    }
    if (tareasCerradas > 0) {
      if (tareasCerradasDetalle && tareasCerradasDetalle.length > 0) {
        mensaje += `\n• Se cerraron *${tareasCerradas}* tareas programadas: ${tareasCerradasDetalle.join(", ")}`;
      } else {
        mensaje += `\n• Se cerraron *${tareasCerradas}* tareas programadas.`;
      }
    }
  }

  if (drive && drive.length > 0) {
    mensaje += `\n\n*--- 📁 ARCHIVADO EN DRIVE ---*`;
    drive.forEach(d => {
      if (d.estado === 'omitido') {
        mensaje += `\n• ⏭️ *Omitido (ya existía):* ${d.nombre} (${d.cliente})`;
      } else {
        mensaje += `\n• 📁 *Subido:* ${d.nombre} (${d.cliente})`;
      }
    });
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


