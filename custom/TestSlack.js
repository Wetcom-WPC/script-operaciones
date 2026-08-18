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

/**
 * Función para probar en Slack el nuevo formato de logs (Auditoría Fase 6).
 * Emite tres mensajes de prueba con datos simulados (Éxito completo, Advertencias, Errores).
 */
function testearNuevosLogsSlack() {
  Logger.log("Enviando logs de prueba a Slack para validar el nuevo formato...");

  // 1. Caso Ideal: Todo OK, archivos subidos y TPs cerradas
  const mockTodoOk = {
    exitos: [], // Ya no se mezclan los de Drive acá
    advertencias: [],
    errores: [],
    tareasCerradas: 2,
    tareasCerradasDetalle: ["Replicas protegidas (San Juan)", "Jobs Veeam (Santa Cruz)"],
    drive: [
      { nombre: "Report Veeam - Replicas protegidas.pdf", cliente: "Operaciones Banco de San Juan", estado: "subido" },
      { nombre: "Report Veeam - Replicas protegidas.xlsx", cliente: "Operaciones Banco de San Juan", estado: "omitido" },
      { nombre: "Jobs Veeam.csv", cliente: "Operaciones Banco de Santa Cruz", estado: "subido" }
    ]
  };
  enviarResumenSlack("[TEST] Veeam ONE - Flujo Ideal", mockTodoOk);
  Utilities.sleep(1000);

  // 2. Caso Advertencia: TP duplicada y algún ticket informativo
  const mockAdvertencia = {
    exitos: [
      { mensaje: "Se actualizó el ticket <http://jira/browse/OBC-123|OBC-123> con el nuevo reporte." }
    ],
    advertencias: [
      {
        cliente: "Operaciones Banco Santa Fe",
        problema: "El reporte llegó más de una vez hoy: la tarea OBSF-444 ya estaba en estado 'Cerrada'.",
        accion: "No se reabrió la tarea. Revisar origen."
      }
    ],
    errores: [],
    tareasCerradas: 0,
    tareasCerradasDetalle: [],
    drive: [
      { nombre: "Affinity Rules.xlsx", cliente: "Operaciones Banco Santa Fe", estado: "omitido" }
    ]
  };
  enviarResumenSlack("[TEST] Affinity Rules - Duplicado", mockAdvertencia);
  Utilities.sleep(1000);

  // 3. Caso Error Terminal: La TP de VeeamOne no existe
  const mockError = {
    exitos: [],
    advertencias: [],
    errores: [
      {
        cliente: "Operaciones Banco de San Juan",
        error: "No existe ninguna tarea programada creada hoy",
        detalle: "Proyecto OBDSJ. Verificar que la tarea se haya creado y coincida el nombre."
      }
    ],
    tareasCerradas: 0,
    tareasCerradasDetalle: [],
    drive: [
      { nombre: "Capacity Planning.pdf", cliente: "Operaciones Banco de San Juan", estado: "subido" }
    ] // Aunque hay error terminal, el Drive sí se guardó antes de chequear la TP
  };
  enviarResumenSlack("[TEST] Capacity Planning - Error TP", mockError);
  
  Logger.log("✅ Tests de logs enviados a Slack.");
}
