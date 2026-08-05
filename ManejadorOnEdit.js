/**
 * =================================================================
 * CONTROLADOR DE EVENTOS (TRIGGER ON EDIT) - V13
 * Cambios vs V12:
 *  - CASO 1 (ejecución maestra vía B4) eliminado — deprecado.
 *  - CASO 2 (Consumo CPU/Memoria) eliminado — deprecado.
 * =================================================================
 */

// --- CONFIGURACIÓN DE COLUMNAS (Sheet1) ---
const COL_CHECK_VSPHERE = 18; // Col R — manejado por procesarEnviosPorLote
const COL_CHECK_VEEAM   = 19; // Col S — manejado por procesarEnviosPorLote
const COL_CHECK_NUTANIX = 20; // Col T — manejado por procesarEnviosPorLote
const COL_CHECK_RVTOOLS = 21; // Col U — manejado por onEdit (este script)
const COL_CHECK_TANZU   = 25; // Col Y — manejado por procesarEnviosPorLote

// Columnas que NO deben resetearse a FALSE aquí: son leídas por procesarEnviosPorLote
// Incluye RVTools (U) y Tanzu (Y) — manejados por el trigger de tiempo
const COLS_MANEJADAS_POR_TIMER = [COL_CHECK_VSPHERE, COL_CHECK_VEEAM, COL_CHECK_NUTANIX, COL_CHECK_RVTOOLS, COL_CHECK_TANZU];

// --- COLUMNAS (Pestaña Licencias) ---
const COL_CHECK_LIC_TAB = 5; // Col E
const COL_LOG_DATOS     = 6; // Col F

const HOJA_OBJETIVO  = "Sheet1";
const HOJA_LICENCIAS = "Licencias";

function vigilarCheckbox(e) {
  Logger.log("=== TRIGGER DISPARADO ===");
  Logger.log("Hoja: "  + (e && e.range ? e.range.getSheet().getName() : "SIN EVENTO"));
  Logger.log("Celda: " + (e && e.range ? e.range.getA1Notation()      : "SIN EVENTO"));
  Logger.log("Valor: " + (e && e.range ? e.range.getValue()            : "SIN EVENTO"));

  if (!e || !e.range) {
    Logger.log("ERROR: No se recibió el objeto de evento.");
    return;
  }

  const range     = e.range;
  const sheet     = range.getSheet();
  const sheetName = sheet.getName();
  const row       = range.getRow();
  const col       = range.getColumn();

  if (range.getValue() !== true) return;
  if (sheetName !== HOJA_OBJETIVO && sheetName !== HOJA_LICENCIAS) return;

  // ── Reset selectivo ────────────────────────────────────────────────────────
  // Las columnas R, S, T (mails vSphere/Veeam/Nutanix) NO se resetean aquí.
  // procesarEnviosPorLote las leerá en su próxima vuelta (≤ 5 min) y las
  // procesará. Las demás columnas sí se resetean de forma inmediata.
  const esManejadasPorTimer = sheetName === HOJA_OBJETIVO &&
                              COLS_MANEJADAS_POR_TIMER.includes(col);
  if (!esManejadasPorTimer) {
    range.setValue("FALSE");
  }

  // ======================================================
  // CASO 5: EJECUCIÓN MANUAL DE LICENCIAS (Pestaña Licencias)
  // ======================================================
  if (sheetName === HOJA_LICENCIAS && row > 1 && col === COL_CHECK_LIC_TAB) {
    const dataRow      = sheet.getRange(row, 1, 1, 4).getValues()[0];
    const destinatario = dataRow[0];
    const pod          = dataRow[1];
    const cliente      = dataRow[2];
    const folderId     = dataRow[3];

    if (!cliente || !folderId) {
      SpreadsheetApp.getUi().alert("❌ Faltan datos críticos (Cliente o ID Carpeta) en esta fila.");
      return;
    }

    sheet.getRange(row, COL_LOG_DATOS).setValue("⏳ Procesando...");
    SpreadsheetApp.getActive().toast(`⏳ Iniciando auditoría para ${cliente}...`, "Auditoría On-Demand", 5);

    try {
      const resultado = AutomatizarOperaciones.procesarLicenciasManualLibreria(cliente, destinatario, folderId, pod);
      const logFinal = `📂 Ruta: ${resultado.ruta}\n📄 Archivos:\n${resultado.archivos}`;
      sheet.getRange(row, COL_LOG_DATOS).setValue(logFinal);

      if (resultado.success) {
        SpreadsheetApp.getActive().toast(`✅ Completado: ${cliente}`, "Éxito", 10);
      } else {
        SpreadsheetApp.getUi().alert(`⚠️ Problema en la auditoría:\n${resultado.message}`);
      }
    } catch (err) {
      sheet.getRange(row, COL_LOG_DATOS).setValue("❌ Error de conexión");
      SpreadsheetApp.getUi().alert(`❌ Error al conectar con la librería:\n${err.toString()}`);
    }
    return;
  }

  // ======================================================
  // LÓGICA PARA "Sheet1"
  // ======================================================
  if (sheetName !== HOJA_OBJETIVO) return;


  // ── CASO 3 y CASO 4 ELIMINADOS ────────────────────────────────────────────
  // El envío de mails (R/S/T) y el procesamiento de RVTools (U) ahora lo
  // maneja procesarEnviosPorLote (trigger cada 5 min, 8-11 AM).
  // Si el usuario marca esas columnas, el trigger las procesará en la próxima vuelta.
  // ─────────────────────────────────────────────────────────────────────────
}

function ejecutarCicloDeOperaciones() {
  AutomatizarOperaciones.ejecutarCicloDeOperaciones();
}

/**
 * Crea el trigger onEdit para vigilarCheckbox.
 * EJECUTAR UNA VEZ MANUALMENTE para restaurar el trigger faltante.
 */
function crearTriggerVigilarCheckbox() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "vigilarCheckbox") {
      ScriptApp.deleteTrigger(t);
      Logger.log("Trigger anterior eliminado.");
    }
  });

  ScriptApp.newTrigger("vigilarCheckbox")
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  Logger.log("✅ Trigger vigilarCheckbox creado bajo: " + Session.getActiveUser().getEmail());
}