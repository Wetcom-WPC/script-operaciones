/**
 * @fileoverview Gestión automática de la planilla "Tareas Programadas".
 *
 * ESTRUCTURA DE LA PLANILLA:
 *   Fila 1: Fecha del día (F1:K1 unificada)
 *   Fila 2: Encabezados (POD | Clients | VPN | ID Ops | ID Sop | Veeam | vSphere | Horizon | Nutanix | Tanzu | NSX)
 *   Fila 3+: Datos de clientes
 *   Col A-E: Fijas (no se tocan)
 *   Col F-K: Resultados del día (se rellenan a las 11am y se limpian a las 5:30pm)
 *
 * FUNCIONES:
 *   rellenarTareasProgramadas()  → trigger 11:00am
 *   limpiarTareasProgramadas()   → trigger 17:30
 *   configurarTriggersGestorTP() → ejecutar UNA VEZ manualmente
 *
 * REQUISITO:
 *   - Los nombres en col B deben coincidir con los de "Envío de Mails" del Registro Operacional.
 *   - Hacer merge manual de F1:K1 en la sheet antes de ejecutar.
 *   - Fila 2 debe tener: F=Veeam | G=vSphere | H=Horizon | I=Nutanix | J=Tanzu | K=NSX
 */

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────

const TP_SHEET_ID        = "1XO8n5bfOITiiX3QC2UlvYLIG_X3QtZAuGehvcg4FOLI";
const TP_HOJA_NOMBRE     = "Tareas Programadas";
const TP_COL_CLIENTE     = 2;  // Columna B
const TP_FILA_FECHA      = 1;  // Fila donde se escribe la fecha
const TP_FILA_DATOS      = 3;  // Primera fila de clientes
const TP_COL_INICIO      = 6;  // Columna F
const TP_COL_FIN         = 11; // Columna K

const REGISTRO_OP_ID     = "1O-iTAhWRonBcAp3xN7t5_y_TZTvyAtoBP0TIVAIzweQ";
const REGISTRO_MAILS_TAB = "Envío de Mails";

const TP_TECH_COL_MAP = {
  "Veeam":   [6],
  "vSphere": [7, 8],  // G (vSphere) + H (Horizon) si no es gris
  "Nutanix": [9],
  "Tanzu":   [10],
  "NSX":     [11]
};

const TP_ESTADO_SIMBOLO = {
  "🟢 Sin Anomalías":    "✅",
  "🟡 Con Advertencias": "!",
  "🔴 Con Incidencias":  "❌"
};

// ─── RELLENAR A LAS 11AM ──────────────────────────────────────────────────────

function rellenarTareasProgramadas() {
  try {
    var tz  = "America/Argentina/Buenos_Aires";
    var hoy = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

    Logger.log("[TP] Iniciando relleno para " + hoy);

    // 1. Abrir planilla Tareas Programadas
    var hojTP = SpreadsheetApp.openById(TP_SHEET_ID).getSheetByName(TP_HOJA_NOMBRE);
    if (!hojTP) { Logger.log("[TP] No se encontró la pestaña '" + TP_HOJA_NOMBRE + "'"); return; }

    // 2. Escribir fecha en F1:K1
    var fechaDisplay = Utilities.formatDate(new Date(), tz, "dd/MM/yyyy");
    var numCols      = TP_COL_FIN - TP_COL_INICIO + 1;
    var celdaFecha   = hojTP.getRange(TP_FILA_FECHA, TP_COL_INICIO, 1, numCols);
    celdaFecha.merge();
    celdaFecha.setValue(fechaDisplay);
    celdaFecha.setHorizontalAlignment("center");
    celdaFecha.setFontWeight("bold");

    // 3. Leer Envío de Mails del Registro Operacional
    var mailData = SpreadsheetApp.openById(REGISTRO_OP_ID)
                     .getSheetByName(REGISTRO_MAILS_TAB)
                     .getDataRange().getValues();

    var mailsHoy = mailData.slice(1).filter(function(r) {
      var fechaFila = r[0] instanceof Date
        ? Utilities.formatDate(r[0], tz, "yyyy-MM-dd")
        : r[0].toString().substring(0, 10);
      return fechaFila === hoy;
    });

    if (mailsHoy.length === 0) {
      Logger.log("[TP] Sin registros de mails para hoy.");
      SpreadsheetApp.flush();
      return;
    }
    Logger.log("[TP] Mails encontrados: " + mailsHoy.length);

    // 4. Leer columna de clientes
    var lastRow     = hojTP.getLastRow();
    var numFilas    = lastRow - TP_FILA_DATOS + 1;
    if (numFilas <= 0) { Logger.log("[TP] Sin filas de datos."); return; }
    var colClientes = hojTP.getRange(TP_FILA_DATOS, TP_COL_CLIENTE, numFilas, 1).getValues();

    // 5. Procesar cada mail
    var actualizaciones = 0;
    mailsHoy.forEach(function(mail) {
      var cliente = (mail[3] || "").toString().trim();
      var tech    = (mail[4] || "").toString().trim();
      var estado  = (mail[6] || "").toString().trim();

      if (!cliente || !tech || !estado) return;

      var simbolo = TP_ESTADO_SIMBOLO[estado];
      if (!simbolo) { Logger.log("[TP] Estado no mapeado: " + estado); return; }

      var cols = TP_TECH_COL_MAP[tech];
      if (!cols) { Logger.log("[TP] Tecnología no mapeada: " + tech); return; }

      var filaIdx = _buscarCliente(colClientes, cliente);
      if (filaIdx === -1) { Logger.log("[TP] Cliente no encontrado: " + cliente); return; }
      var filaReal = TP_FILA_DATOS + filaIdx;

      cols.forEach(function(col) {
        hojTP.getRange(filaReal, col).setValue(simbolo);
        actualizaciones++;
        Logger.log("[TP] ✅ " + cliente + " | col " + col + " | " + tech + " → " + simbolo);
      });
    });

    SpreadsheetApp.flush();
    Logger.log("[TP] Completado. Celdas actualizadas: " + actualizaciones);

  } catch (e) {
    Logger.log("[TP] Error en rellenarTareasProgramadas: " + e.message);
  }
}

// ─── LIMPIAR A LAS 5:30PM ─────────────────────────────────────────────────────

function limpiarTareasProgramadas() {
  try {
    var hojTP = SpreadsheetApp.openById(TP_SHEET_ID).getSheetByName(TP_HOJA_NOMBRE);
    if (!hojTP) { Logger.log("[TP] No se encontró la pestaña '" + TP_HOJA_NOMBRE + "'"); return; }

    var lastRow  = hojTP.getLastRow();
    var numFilas = lastRow - TP_FILA_DATOS + 1;
    var numCols  = TP_COL_FIN - TP_COL_INICIO + 1;

    // Limpiar resultados (filas de datos, col F-K)
    if (numFilas > 0) {
      hojTP.getRange(TP_FILA_DATOS, TP_COL_INICIO, numFilas, numCols).clearContent();
    }

    // Limpiar fecha (fila 1, col F-K)
    hojTP.getRange(TP_FILA_FECHA, TP_COL_INICIO, 1, numCols).clearContent();

    SpreadsheetApp.flush();
    Logger.log("[TP] Limpieza completada. Columnas F-K y fecha vaciadas.");

  } catch (e) {
    Logger.log("[TP] Error en limpiarTareasProgramadas: " + e.message);
  }
}

// ─── CONFIGURAR TRIGGERS ──────────────────────────────────────────────────────

function configurarTriggersGestorTP() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "rellenarTareasProgramadas" ||
        t.getHandlerFunction() === "limpiarTareasProgramadas") {
      ScriptApp.deleteTrigger(t);
      Logger.log("[TP] Trigger eliminado: " + t.getHandlerFunction());
    }
  });

  ScriptApp.newTrigger("rellenarTareasProgramadas")
    .timeBased().everyDays(1).atHour(11).create();

  ScriptApp.newTrigger("limpiarTareasProgramadas")
    .timeBased().everyDays(1).atHour(17).create();

  Logger.log("[TP] ✅ Triggers creados:");
  Logger.log("     → rellenarTareasProgramadas: diario ~11:00am");
  Logger.log("     → limpiarTareasProgramadas:  diario ~17:00-18:00");
  Logger.log("NOTA: Para exactamente las 17:30, configurar limpiarTareasProgramadas");
  Logger.log("      manualmente en el panel de Triggers.");
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function _buscarCliente(colClientes, nombre) {
  for (var i = 0; i < colClientes.length; i++) {
    var val = (colClientes[i][0] || "").toString().trim().toLowerCase();
    if (val === nombre.toLowerCase()) return i;
  }
  return -1;
}

function _esCeldaGris(bgColor) {
  if (!bgColor || bgColor === "#ffffff" || bgColor === "white") return false;
  try {
    var hex = bgColor.replace("#", "");
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var r = parseInt(hex.substring(0,2), 16);
    var g = parseInt(hex.substring(2,4), 16);
    var b = parseInt(hex.substring(4,6), 16);
    return (r + g + b) / 3 < 80;
  } catch(e) { return false; }
}