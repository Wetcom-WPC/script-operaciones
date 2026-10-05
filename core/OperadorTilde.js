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

/**
 * La fecha guardada en la columna "Tildado", en milisegundos, o 0 si no se puede leer.
 * No usa `instanceof Date`: esta función corre dentro de la librería, y un valor que viene de
 * la planilla del proyecto que la llama no siempre pasa esa prueba. Cuando fallaba, la fecha
 * quedaba en 0 y el tilde se descartaba como si fuera viejo (todos los envíos salían sin
 * operador). Se mira si el valor sabe responder getTime(), y si no, se intenta interpretarlo.
 */
function _operadorTildeFechaMs(valor) {
  if (!valor) return 0;
  if (typeof valor.getTime === "function") {
    const ms = valor.getTime();
    return isNaN(ms) ? 0 : ms;
  }
  const ms = new Date(valor).getTime();
  return isNaN(ms) ? 0 : ms;
}

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

/**
 * Filas (1-based, en la pestaña) de los tildes de fila/col, de la más vieja a la más nueva.
 *
 * Puede haber más de una: las anotaciones se agregan al final y nunca se modifican en el
 * lugar, así que re-tildar la misma casilla deja otra fila. Vale la ÚLTIMA.
 */
function _operadorTildeBuscarTodas(hoja, fila, col) {
  if (!hoja || hoja.getLastRow() < 2) return [];
  const valores = hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues();
  const filas = [];
  for (let i = 0; i < valores.length; i++) {
    if (Number(valores[i][0]) === Number(fila) && Number(valores[i][1]) === Number(col)) filas.push(i + 2);
  }
  return filas;
}

/** La anotación vigente del tilde fila/col, o -1. Es la última, que es la más reciente. */
function _operadorTildeBuscar(hoja, fila, col) {
  const filas = _operadorTildeBuscarTodas(hoja, fila, col);
  return filas.length ? filas[filas.length - 1] : -1;
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

  // SIN CANDADO, A PROPÓSITO.
  //
  // Antes esto leía la pestaña y después escribía en la fila encontrada (o al final). Entre
  // leer y escribir, dos activadores simultáneos se pisaban, así que le puse un candado. Fue
  // peor: cuando el equipo marca varias casillas seguidas, cada ejecución tarda unos segundos
  // y la octava ya supera los 30 de espera. El 05/10 se perdieron tildes con
  // "No se pudo tomar el candado para la fila 7", mientras otro cliente anotaba bien dos
  // segundos después.
  //
  // appendRow agrega al final en una sola operación del lado de Sheets: no hay un "leer" que
  // pueda quedar viejo, así que dos activadores a la vez no se pisan y no hace falta
  // serializarlos. Re-tildar deja otra fila, y vale la última (ver _operadorTildeBuscar).
  const hoja = _operadorTildeHoja(spreadsheet, true);
  hoja.appendRow([Number(fila), Number(col), String(cliente || "").trim(), mail, new Date()]);
  Logger.log("[Operador] Anotado: fila " + fila + ", col " + col + " (" + String(cliente || "").trim() + ") -> " + mail);

  _operadorTildePodar(hoja);
  return true;
}

// Como ya no se pisa ninguna fila, la pestaña solo crece. En uso normal se vacía sola (cada
// envío borra su anotación), pero si algo queda colgado conviene un techo.
const OPERADOR_TILDE_MAX_FILAS = 500;

function _operadorTildePodar(hoja) {
  try {
    const sobran = hoja.getLastRow() - 1 - OPERADOR_TILDE_MAX_FILAS;
    if (sobran > 0) hoja.deleteRows(2, sobran);
  } catch (e) {
    // Podar es prolijidad, no parte del trabajo: si falla, el tilde ya quedó anotado.
    Logger.log("[Operador] No se pudo podar la pestaña: " + e.message);
  }
}

/**
 * Quién tildó la casilla, si el tilde sigue vigente y la fila sigue siendo del mismo cliente;
 * si no, "". No lo borra: se borra cuando el mail salió (olvidarOperadorTilde), así un envío
 * que falla y se reintenta conserva a quién lo pidió.
 */
function leerOperadorTilde(spreadsheet, fila, col, clienteActual) {
  const hoja = _operadorTildeHoja(spreadsheet, false);
  const existente = _operadorTildeBuscar(hoja, fila, col);
  if (existente < 0) {
    Logger.log("[Operador] No hay tilde anotado para la fila " + fila + " (col " + col + "): el envío queda sin operador.");
    return "";
  }
  const r = hoja.getRange(existente, 1, 1, OPERADOR_TILDE_COLS.length).getValues()[0];
  if (String(r[2] || "").trim() !== String(clienteActual || "").trim()) {
    Logger.log("[Operador] La fila " + fila + " cambió de cliente desde el tilde (anotado \"" + r[2] +
      "\", ahora \"" + clienteActual + "\"): el envío queda sin operador.");
    return "";
  }
  // Cada motivo se avisa por separado: antes todos caían en el mismo mensaje de "más de 20 h",
  // así que una fecha ilegible parecía un tilde viejo.
  const cuando = _operadorTildeFechaMs(r[4]);
  if (!cuando) {
    Logger.log("[Operador] No se pudo leer la fecha del tilde de la fila " + fila + " (valor: \"" + r[4] +
      "\", tipo " + typeof r[4] + "): el envío queda sin operador.");
    return "";
  }
  const horas = (Date.now() - cuando) / 3600000;
  if (horas > OPERADOR_TILDE_VIGENCIA_HORAS) {
    Logger.log("[Operador] El tilde de la fila " + fila + " es de hace " + horas.toFixed(1) + " h (más de " +
      OPERADOR_TILDE_VIGENCIA_HORAS + " h): no se usa.");
    return "";
  }
  const operador = String(r[3] || "");
  Logger.log("[Operador] Fila " + fila + " (col " + col + "): " + operador + ", tildado hace " + horas.toFixed(1) + " h.");
  return operador;
}

/** Borra el tilde anotado (después de que el mail salió, o si se destildó). */
function olvidarOperadorTilde(spreadsheet, fila, col) {
  const hoja = _operadorTildeHoja(spreadsheet, false);
  // Todas, no solo la última: re-tildar una casilla deja varias anotaciones, y si quedara
  // alguna, el envío de mañana tomaría al operador de hoy.
  // De atrás para adelante, para que borrar una no corra el número de las otras.
  const filas = _operadorTildeBuscarTodas(hoja, fila, col);
  for (let i = filas.length - 1; i >= 0; i--) hoja.deleteRow(filas[i]);
}
