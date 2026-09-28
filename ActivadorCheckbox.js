/**
 * =================================================================
 * CONTROLADOR DE EVENTOS (TRIGGER ON EDIT) - V12
 * Cambios vs V11:
 *  - CASO 3 (enviarMailUnitario) eliminado — deprecado.
 *    El envío de mails vSphere/Veeam/Nutanix es manejado
 *    exclusivamente por procesarEnviosPorLote (trigger de tiempo).
 *  - El reset de checkbox a FALSE ya NO se aplica a las columnas
 *    R, S, T (18, 19, 20): esas deben quedar en TRUE para que
 *    procesarEnviosPorLote las detecte dentro de los siguientes 5 min.
 *  - Todas las demás columnas siguen reseteando normalmente.
 * =================================================================
 */

// --- CONFIGURACIÓN DE COLUMNAS (Sheet1) ---
const COL_CHECK_CONSUMO = 9;  // Col I (Botón para Consumo CPU/Memoria)
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
const CELDA_MAESTRA  = "B4";

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
  } else {
    // El mail lo manda procesarEnviosPorLote hasta 5 min después, con la cuenta del dueño
    // del trigger: ahí ya no se sabe quién operó. Se anota ahora, que es el único momento
    // en que el evento trae al usuario.
    anotarOperadorDelTilde(e, sheet, row, col);
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

  // ======================================================
  // CASO 1: EJECUCIÓN MAESTRA
  // ======================================================
  if (range.getA1Notation() === CELDA_MAESTRA) {
    try {
      SpreadsheetApp.getActive().toast("🚀 Iniciando motor completo...", "Estado", -1);
      AutomatizarOperaciones.ejecutarCicloDeOperaciones();
      SpreadsheetApp.getActive().toast("✅ Ciclo finalizado.", "Éxito");
    } catch (error) {
      SpreadsheetApp.getUi().alert("❌ Error: " + error.toString());
    }
    return;
  }

  // ======================================================
  // CASO 2: EJECUCIÓN MANUAL REPORTE CONSUMO CPU/MEMORIA
  // ======================================================
  if (row > 1 && col === COL_CHECK_CONSUMO) {
    SpreadsheetApp.getActive().toast(`⏳ Extrayendo datos de consumo...`, "Reporte Consumo", -1);
    try {
      const reporteAlertas = AutomatizarOperaciones.generarReporteConsumoVsphere();

      if (reporteAlertas && reporteAlertas.length > 0) {
        SpreadsheetApp.getActive().toast(`✅ Datos extraídos. Listos para los correos.`, "Éxito", 10);
      } else {
        SpreadsheetApp.getActive().toast(`ℹ️ Sin alertas de consumo en las últimas 12h.`, "Aviso", 10);
      }
    } catch (err) {
      SpreadsheetApp.getUi().alert(`❌ Error al extraer el reporte de consumo:\n${err.toString()}`);
    }
    return;
  }

  // ── CASO 3 y CASO 4 ELIMINADOS ────────────────────────────────────────────
  // El envío de mails (R/S/T) y el procesamiento de RVTools (U) ahora lo
  // maneja procesarEnviosPorLote (trigger cada 5 min, 8-11 AM).
  // Si el usuario marca esas columnas, el trigger las procesará en la próxima vuelta.
  // ─────────────────────────────────────────────────────────────────────────
}

// ─── Quién operó ─────────────────────────────────────────────────────────────
// Se guarda en la pestaña oculta "_Operadores" de esta planilla, con las funciones de la
// librería (core/OperadorTilde.js): el dashboard escribe ahí mismo cuando se tilda desde
// "Control de Envíos", así que hay un solo lugar y una sola implementación.

function anotarOperadorDelTilde(e, sheet, row, col) {
  try {
    // e.user solo existe en activadores instalables y dentro del dominio. Sin él no se adivina:
    // Session.getActiveUser() en un activador instalable puede devolver al dueño del activador
    // (alarmas@), que es justamente el dato equivocado.
    const email = (e.user && typeof e.user.getEmail === "function") ? e.user.getEmail() : "";
    if (!email) {
      Logger.log("[Operador] El evento no trae usuario: el envío de la fila " + row + " queda sin operador.");
      return;
    }
    const cliente = sheet.getRange(row, 12).getValue(); // Col L
    AutomatizarOperaciones.registrarOperadorTilde(sheet.getParent(), row, col, cliente, email);
  } catch (err) {
    Logger.log("[Operador] No se pudo anotar el operador de la fila " + row + ": " + err.message);
  }
}

function leerOperadorDelTilde(row, col, empresaActual) {
  try {
    return AutomatizarOperaciones.leerOperadorTilde(SpreadsheetApp.getActiveSpreadsheet(), row, col, empresaActual);
  } catch (err) {
    Logger.log("[Operador] No se pudo leer el operador de la fila " + row + ": " + err.message);
    return "";
  }
}

function olvidarOperadorDelTilde(row, col) {
  try {
    AutomatizarOperaciones.olvidarOperadorTilde(SpreadsheetApp.getActiveSpreadsheet(), row, col);
  } catch (err) {}
}

/**
 * Activador "al editar" MÍNIMO: solo anota quién tildó (o destildó) una casilla de envío.
 * No resetea nada ni dispara nada, a diferencia de vigilarCheckbox (que además lanza el ciclo
 * completo desde la celda maestra, el reporte de consumo y la auditoría de licencias, y que hoy
 * no tiene activador instalado). Se instala una vez con crearTriggerRegistrarOperador().
 */
function registrarOperadorAlTildar(e) {
  if (!e || !e.range) return;
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== HOJA_OBJETIVO) return;
  // Una sola celda: pegar un bloque no es "alguien tildó una casilla".
  if (range.getNumRows() !== 1 || range.getNumColumns() !== 1) return;
  const col = range.getColumn();
  const row = range.getRow();
  if (row < 2 || !COLS_MANEJADAS_POR_TIMER.includes(col)) return;

  if (range.getValue() === true) {
    anotarOperadorDelTilde(e, sheet, row, col);
  } else {
    olvidarOperadorDelTilde(row, col);
  }
}

/**
 * Instala (o reinstala) el activador de registrarOperadorAlTildar. Ejecutarlo UNA vez, con la
 * cuenta de alarmas@ (la misma que es dueña de los demás activadores del Índice).
 */
function crearTriggerRegistrarOperador() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "registrarOperadorAlTildar") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("registrarOperadorAlTildar")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  Logger.log("✅ Activador creado: registrarOperadorAlTildar (al editar), dueño " + Session.getEffectiveUser().getEmail());
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