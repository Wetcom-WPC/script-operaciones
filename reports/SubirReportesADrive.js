/**
 * @fileoverview DADO DE BAJA — el archivado en Drive es ahora un paso del pipeline.
 *
 * Hasta la Etapa 2 este archivo tenía su propio trigger cada 10 minutos que buscaba correos
 * por REMITENTE y archivaba sus adjuntos en Drive, en paralelo al ciclo de operaciones.
 * Ese diseño causó el incidente del 27/07/2026: buscaba con una ventana `newer_than:2h`, y si
 * un lote no llegaba a tiempo (TimeGuard), el correo salía de la ventana y no se archivaba
 * nunca más, sin dejar rastro. Así se perdieron todos los reportes de Veeam ONE de ese día.
 *
 * Hoy:
 *   - El guardado vive en `core/DriveReportService.js` (única fuente de verdad).
 *   - `MailProcessor` lo ejecuta como el paso 'drive' de cada operación, y el correo no se
 *     marca [OPS-PROCESADO] hasta que TODOS sus pasos terminaron bien.
 *   - Los reportes de Veeam ONE tienen sus propios processors (`veeam/VeeamOneReportes.js`).
 *   - Lo que ningún processor reclama lo archiva `reports/ReportesSinProcessor.js`.
 *
 * Solo queda la función para eliminar el trigger viejo en los proyectos donde siga instalado.
 */

/**
 * Elimina el trigger de `organizarReportesEnDrive` si todavía existe.
 *
 * Ejecutar UNA vez por proyecto al desplegar la Etapa 2. Mientras el trigger siga vivo no
 * rompe nada (el guardado es idempotente), pero consume cuota de Gmail al pedo y archiva
 * adjuntos que ningún processor reclamó, sin el gating de [OPS-PROCESADO].
 */
function eliminarTriggerOrganizarDrive() {
  let eliminados = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "organizarReportesEnDrive") {
      ScriptApp.deleteTrigger(t);
      eliminados++;
    }
  });

  if (eliminados > 0) {
    Logger.log(`🗑️ [Etapa 2] Se eliminaron ${eliminados} trigger(s) de organizarReportesEnDrive. El archivado en Drive ahora corre dentro del ciclo de operaciones.`);
  } else {
    Logger.log("[Etapa 2] No había triggers de organizarReportesEnDrive instalados: nada que eliminar.");
  }
  return eliminados;
}
