/**
 * @fileoverview Quién tildó una casilla de envío del Índice (R/S/T/U).
 *
 * El mail de operaciones lo manda procesarEnviosPorLote (Índice) hasta 5 minutos después del
 * tilde, con la cuenta de alarmas@: en ese momento ya no se sabe quién operó. Por eso el
 * operador se anota en el instante del tilde, que puede venir de dos lados:
 *
 *   - La planilla del Índice: un activador "al editar" (registrarOperadorAlTildar, en el
 *     proyecto del Índice) recibe al usuario en e.user.
 *   - El dashboard ("Control de Envíos"): webapp_marcarCheckboxIndice sabe quién está usando
 *     la pantalla. Esa edición la hace el script, así que ningún activador de edición se
 *     entera: hay que anotarlo ahí.
 *
 * Los dos caminos escriben en el mismo lugar, una pestaña oculta de la planilla del Índice,
 * con estas mismas funciones (el Índice las llama a través de la librería). Una sola
 * implementación: si el formato cambia, cambia acá (AGENTS.md §5).
 */

const OPERADOR_TILDE_TAB = "_Operadores";
const OPERADOR_TILDE_COLS = ["Fila", "Columna", "Cliente (col L)", "Operador", "Tildado"];
// Un tilde viejo no se le atribuye a un envío de hoy: las casillas se resetean de noche, pero
// si una fila quedó colgada de un día anterior, pasadas estas horas ya no vale.
const OPERADOR_TILDE_VIGENCIA_HORAS = 20;

function _operadorTildeHoja(spreadsheet, crearSiFalta) {
  let hoja = spreadsheet.getSheetByName(OPERADOR_TILDE_TAB);
  if (!hoja && crearSiFalta) {
    hoja = spreadsheet.insertSheet(OPERADOR_TILDE_TAB);
    hoja.getRange(1, 1, 1, OPERADOR_TILDE_COLS.length).setValues([OPERADOR_TILDE_COLS]).setFontWeight("bold");
    hoja.setFrozenRows(1);
    hoja.hideSheet();
  }
  return hoja;
}

/** Fila (1-based, en la pestaña) del tilde fila/col, o -1. */
function _operadorTildeBuscar(hoja, fila, col) {
  if (!hoja || hoja.getLastRow() < 2) return -1;
  const valores = hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues();
  for (let i = 0; i < valores.length; i++) {
    if (Number(valores[i][0]) === Number(fila) && Number(valores[i][1]) === Number(col)) return i + 2;
  }
  return -1;
}

/**
 * Anota quién tildó la casilla fila/col. Si ya había un tilde anotado para esa casilla, lo pisa.
 * @param {Spreadsheet} spreadsheet La planilla del Índice.
 * @param {number} fila @param {number} col
 * @param {string} cliente Valor de la columna L de esa fila (para detectar filas movidas).
 * @param {string} email Quién tildó.
 */
function registrarOperadorTilde(spreadsheet, fila, col, cliente, email) {
  const mail = String(email || "").trim().toLowerCase();
  if (!mail) return false;
  const hoja = _operadorTildeHoja(spreadsheet, true);
  const datos = [Number(fila), Number(col), String(cliente || "").trim(), mail, new Date()];
  const existente = _operadorTildeBuscar(hoja, fila, col);
  if (existente > 0) hoja.getRange(existente, 1, 1, datos.length).setValues([datos]);
  else hoja.getRange(hoja.getLastRow() + 1, 1, 1, datos.length).setValues([datos]);
  return true;
}

/**
 * Quién tildó la casilla, si el tilde sigue vigente y la fila sigue siendo del mismo cliente;
 * si no, "". No lo borra: se borra cuando el mail salió (olvidarOperadorTilde), así un envío
 * que falla y se reintenta conserva a quién lo pidió.
 */
function leerOperadorTilde(spreadsheet, fila, col, clienteActual) {
  const hoja = _operadorTildeHoja(spreadsheet, false);
  const existente = _operadorTildeBuscar(hoja, fila, col);
  if (existente < 0) return "";
  const r = hoja.getRange(existente, 1, 1, OPERADOR_TILDE_COLS.length).getValues()[0];
  if (String(r[2] || "").trim() !== String(clienteActual || "").trim()) {
    Logger.log("[Operador] La fila " + fila + " cambió de cliente desde el tilde: el envío queda sin operador.");
    return "";
  }
  const cuando = r[4] instanceof Date ? r[4].getTime() : 0;
  if (!cuando || Date.now() - cuando > OPERADOR_TILDE_VIGENCIA_HORAS * 3600000) {
    Logger.log("[Operador] El tilde de la fila " + fila + " es de hace más de " + OPERADOR_TILDE_VIGENCIA_HORAS + " h: no se usa.");
    return "";
  }
  return String(r[3] || "");
}

/** Borra el tilde anotado (después de que el mail salió, o si se destildó). */
function olvidarOperadorTilde(spreadsheet, fila, col) {
  const hoja = _operadorTildeHoja(spreadsheet, false);
  const existente = _operadorTildeBuscar(hoja, fila, col);
  if (existente > 0) hoja.deleteRow(existente);
}
