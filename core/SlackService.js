/**
 * Envía una única notificación de resumen a Slack al final de la ejecución.
 * VERSIÓN CORREGIDA: Maneja correctamente los objetos de advertencia.
 */
function enviarResumenSlack(operationName, summaryReport) {
  // Va ANTES del corte por webhook y ANTES de leer el summaryReport, por dos motivos:
  //  - Si el unico evento de la operacion fue una tarea que no se encontro, sin esto el
  //    resumen cortaria por "no hay nada que reportar" y el problema seguiria invisible.
  //  - El registro de cierres tiene que drenarse igual aunque no haya webhook: si no, los
  //    cierres quedan colgados y se los cuenta la proxima operacion.
  _normalizarCierresDeTareas(summaryReport);

  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL.trim() === "") return;

  const { exitos, advertencias, errores, tareasCerradas, tareasCerradasDetalle, drive } = summaryReport;

  // Si no hay absolutamente nada que reportar, no hace nada.
  if (errores.length === 0 && advertencias.length === 0 && exitos.length === 0 && tareasCerradas === 0 && (!drive || drive.length === 0)) {
    return;
  }

  // Registramos en log SOLAMENTE si el script hizo algo útil (procesó al menos un correo)
  _registrarEnLog(operationName, summaryReport);

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
 * Pasa el registro de cierres de tareas programadas (core/JiraService.js) al summaryReport,
 * para que lo informen el mensaje de Slack y la planilla de log sin tocar ningun processor.
 *
 * Dos reglas distintas, y la diferencia importa:
 *
 *   - Los cierres EXITOSOS se recuentan desde el registro, pisando lo que haya acumulado el
 *     processor. El registro los tiene todos; el contador del processor, solo si se acordo de
 *     mirar el resultado. Recontar en vez de sumar es lo que evita contar doble a los que si
 *     se acordaron.
 *   - Los PROBLEMAS solo se informan si nadie los informo ya (reportado = false). El unico
 *     que los informa por su cuenta es MailProcessor.cerrarTareaProgramadaSiCorresponde().
 *
 * @param {Object} summaryReport Resumen de la operacion, se modifica in situ.
 */
function _normalizarCierresDeTareas(summaryReport) {
  if (typeof consumirCierresDeTareas !== "function") return;

  let cierres;
  try {
    cierres = consumirCierresDeTareas();
  } catch (e) {
    Logger.log("[Cierres] No se pudo leer el registro de cierres: " + e.message);
    return;
  }
  if (!cierres || cierres.length === 0) return;

  summaryReport.advertencias = summaryReport.advertencias || [];
  summaryReport.errores      = summaryReport.errores      || [];

  const exitosos = cierres.filter(function (c) { return c.estado === 'SUCCESS'; });
  if (exitosos.length > 0) {
    summaryReport.tareasCerradas = exitosos.length;
    summaryReport.tareasCerradasDetalle = exitosos.map(function (c) {
      return c.tarea + " (" + c.cliente + ")";
    });
  }

  cierres.forEach(function (c) {
    if (c.reportado || c.estado === 'SUCCESS') return;

    if (c.estado === 'NOT_FOUND') {
      summaryReport.advertencias.push({
        cliente: c.cliente,
        problema: 'No se encontro la tarea programada "' + c.tarea + '" creada hoy en el proyecto ' + c.proyecto + ', asi que no se cerro.',
        accion: "Verificar que la tarea se haya creado hoy y que el nombre coincida EXACTO. El correo igual se dio por procesado."
      });
      return;
    }

    // DUPLICADO y DEFERRED a proposito NO se informan desde aca:
    //
    //   - DUPLICADO es lo normal, no un problema. Varios reportes llegan dos veces por diseno
    //     (los de Veeam mandan primero el PDF y despues el mismo correo con PDF + XLSX): el
    //     14/10/2026 hubo 5 duplicados en una sola corrida. Informarlos convertiria media
    //     docena de resumenes diarios de "Ejecucion Exitosa" a "con Advertencias" sin que
    //     haya nada que hacer. Igual queda el 📩 en el log de ejecucion.
    //   - DEFERRED significa "no se cerro porque el correo ya venia con un paso fallido". Ese
    //     fallo ya se informa por su cuenta; avisar de nuevo seria contar el mismo problema
    //     dos veces, con dos redacciones distintas.
    if (c.estado === 'DUPLICADO' || c.estado === 'DEFERRED') return;

    // FAILURE, ERROR, SIN_RESPUESTA: el cierre se intento y no se concreto.
    summaryReport.errores.push({
      cliente: c.cliente,
      error: 'No se pudo cerrar la tarea programada "' + c.tarea + '"',
      detalle: "Proyecto " + c.proyecto + " | Estado: " + c.estado + (c.detalle ? " | " + c.detalle : "")
    });
  });
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


