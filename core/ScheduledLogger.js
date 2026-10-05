/**
 * @fileoverview Sistema de Logging Operacional - Proyecto Automatizar Operaciones
 * =================================================================================
 * ESTRUCTURA DE TABS:
 *   - Estado Final          → una fila por (fecha + operación + cliente), con upsert
 *   - Errores del Script    → log detallado de cada error individual
 *   - Envío de Mails        → registro de mails enviados
 *   - Logs Reportes Faltantes → reportes que no llegaron
 *
 * INTEGRACIÓN:
 *   1. En FuncionesCompartidas.gs, al INICIO de enviarResumenSlack():
 *        _registrarEnLog(operationName, summaryReport);
 *   2. En Main.gs: eliminar registrarResumenDiario() (ya no existe).
 *   3. Ejecutar UNA VEZ manualmente: inicializarHojaLog()
 * =================================================================================
 */
// ─── INICIALIZACIÓN ───────────────────────────────────────────────────────────
function inicializarHojaLog() {
  const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
  // ── Estado Final ──────────────────────────────────────────────────────────
  var tabEF = ss.getSheetByName(LOG_ESTADO_FINAL_TAB_NAME) || ss.insertSheet(LOG_ESTADO_FINAL_TAB_NAME);
  tabEF.clearConditionalFormatRules();
  const colsEF = [
    "Fecha",              // A
    "Operación",          // B
    "Origen",             // C
    "Cliente",            // D
    "POD",                // E
    "Intentos",           // F
    "Estado",             // G
    "Tickets Creados",    // H
    "Tickets Actualizados", // I
    "Tareas Cerradas",    // J
    "Último Error",       // K
    "Última Actualización", // L
  ];
  tabEF.getRange(1, 1, 1, colsEF.length).setValues([colsEF])
       .setFontWeight("bold").setBackground("#1a1a2e").setFontColor("#FFFFFF");
  tabEF.setFrozenRows(1);
  [[1,100],[2,220],[3,120],[4,200],[5,70],[6,75],[7,150],
   [8,120],[9,140],[10,115],[11,300],[12,160]]
  .forEach(function(cw) { tabEF.setColumnWidth(cw[0], cw[1]); });
  const rG = tabEF.getRange("G2:G");
  tabEF.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("✅ Resuelto")
      .setBackground("#D4EDDA").setFontColor("#155724").setRanges([rG]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("🟡 Con advertencias")
      .setBackground("#FFF3CD").setFontColor("#856404").setRanges([rG]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("⚠️ No resuelto")
      .setBackground("#F8D7DA").setFontColor("#721C24").setRanges([rG]).build(),
  ]);
  // ── Errores del Script ────────────────────────────────────────────────────
  var tabErr = ss.getSheetByName(LOG_ERRORES_TAB_NAME) || ss.insertSheet(LOG_ERRORES_TAB_NAME);
  tabErr.clearConditionalFormatRules();
  const colsErr = [
    "Fecha",              // A
    "Hora",               // B
    "Operación",          // C
    "Origen",             // D
    "Cliente",            // E
    "Detalle del Error",  // F
    "¿Reincidente?",      // G
    "Día Semana",         // H
  ];
  tabErr.getRange(1, 1, 1, colsErr.length).setValues([colsErr])
        .setFontWeight("bold").setBackground("#922B21").setFontColor("#FFFFFF");
  tabErr.setFrozenRows(1);
  [[1,100],[2,80],[3,200],[4,120],[5,180],[6,400],[7,110],[8,100]]
  .forEach(function(cw) { tabErr.setColumnWidth(cw[0], cw[1]); });
  const rReinc = tabErr.getRange("G2:G");
  tabErr.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("⚠️ SÍ")
      .setBackground("#F9EBEA").setFontColor("#922B21").setRanges([rReinc]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("No")
      .setBackground("#FFFFFF").setFontColor("#555555").setRanges([rReinc]).build(),
  ]);
  // ── Envío de Mails ────────────────────────────────────────────────────────
  var tabMails = ss.getSheetByName(LOG_MAILS_TAB_NAME) || ss.insertSheet(LOG_MAILS_TAB_NAME);
  tabMails.clearConditionalFormatRules();
  const colsMails = [
    "Fecha",          // A
    "Hora",           // B
    "Día Semana",     // C
    "Cliente",        // D
    "Tecnología",     // E
    "POD",            // F
    "Estado",         // G
    "Total Tickets",  // H
    "Soporte",        // I
    "Operaciones",    // J
    "Operador",       // K  (quién tildó la casilla en el Índice)
  ];
  tabMails.getRange(1, 1, 1, colsMails.length).setValues([colsMails])
          .setFontWeight("bold").setBackground("#1A5276").setFontColor("#FFFFFF");
  tabMails.setFrozenRows(1);
  [[1,100],[2,80],[3,100],[4,180],[5,120],[6,70],[7,160],[8,100],[9,100],[10,110],[11,200]]
  .forEach(function(cw) { tabMails.setColumnWidth(cw[0], cw[1]); });
  const rEstMail = tabMails.getRange("G2:G");
  tabMails.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("🟢 Sin Anomalías")
      .setBackground("#D4EDDA").setFontColor("#155724").setRanges([rEstMail]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("🟡 Con Advertencias")
      .setBackground("#FFF3CD").setFontColor("#856404").setRanges([rEstMail]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("🔴 Con Incidencias")
      .setBackground("#F8D7DA").setFontColor("#721C24").setRanges([rEstMail]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("🧪 TEST")
      .setBackground("#E8EAF6").setFontColor("#3949AB").setRanges([rEstMail]).build(),
  ]);
  // ── Logs Reportes Faltantes ───────────────────────────────────────────────
  var tabFalt = ss.getSheetByName(LOG_FALTANTES_TAB_NAME) || ss.insertSheet(LOG_FALTANTES_TAB_NAME);
  const colsFalt = ["Fecha","Hora","Cliente","POD","Tecnología","Operación"];
  tabFalt.getRange(1, 1, 1, colsFalt.length).setValues([colsFalt])
         .setFontWeight("bold").setBackground("#6C3483").setFontColor("#FFFFFF");
  tabFalt.setFrozenRows(1);
  [[1,100],[2,80],[3,200],[4,80],[5,130],[6,250]]
  .forEach(function(cw) { tabFalt.setColumnWidth(cw[0], cw[1]); });
  SpreadsheetApp.flush();
  Logger.log("✅ Hoja de Log inicializada con nueva estructura (4 pestañas).");
}
// ─── PESTAÑA REPORTES FALTANTES ───────────────────────────────────────────────
function inicializarPestanaReportesFaltantes() {
  const ss  = SpreadsheetApp.openById(LOG_SHEET_ID);
  var tab   = ss.getSheetByName(LOG_FALTANTES_TAB_NAME);
  if (tab) { Logger.log("[LOG] La pestaña ya existe."); return; }
  tab = ss.insertSheet(LOG_FALTANTES_TAB_NAME);
  const cols = ["Fecha","Hora","Cliente","POD","Tecnología","Operación"];
  tab.getRange(1, 1, 1, cols.length).setValues([cols])
     .setFontWeight("bold").setBackground("#6C3483").setFontColor("#FFFFFF");
  tab.setFrozenRows(1);
  [[1,100],[2,80],[3,200],[4,80],[5,130],[6,250]]
    .forEach(function(cw) { tab.setColumnWidth(cw[0], cw[1]); });
  SpreadsheetApp.flush();
  Logger.log("✅ Pestaña '" + LOG_FALTANTES_TAB_NAME + "' creada.");
}
/**
 * Texto comparable: sin mayúsculas, sin tildes y sin puntuación ni espacios de más.
 * "09:00 - Capacidad de Particiones" -> "09 00 capacidad de particiones".
 */
function _faltantesNormalizar(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Red de contención para los identificadores de la planilla "Reportes Faltantes" que NO son
// el nombre de una operación (ahí el nombre lo escribe una persona, no el código). El orden
// importa: gana la primera regla que matchea, así que van de lo más específico a lo más
// genérico. La versión anterior tenía "vm" y "job" arriba de todo y se llevaba puesto medio
// mapa — "Zombies VMDKs" caía en vROps y "Orphaned VMs" también.
const _FALTANTES_TECH_FALLBACK = [
  { palabras: ["rvtools", "zombie", "vmdk", "connect at power"],        tech: "RVTools" },
  { palabras: ["horizon", "view"],                                      tech: "Connection Server" },
  { palabras: ["nutanix"],                                              tech: "Nutanix" },
  { palabras: ["tanzu"],                                                tech: "Tanzu" },
  { palabras: ["veeam one", "veeamone", "orphaned", "mas de un job",
               "repositorio"],                                          tech: "Veeam ONE" },
  { palabras: ["veeam", "backup", "replica", "proxy", "malware"],       tech: "Veeam" },
  { palabras: ["vrops", "vrealize operations", "aria operations"],      tech: "vROps" },
  { palabras: ["vro", "orchestrator", "affinity", "preguntas",
               "snapshot"],                                             tech: "vRO" },
  // Lo que queda del parque vSphere sin decir de dónde sale lo reporta vROps.
  { palabras: ["cluster", "drs", "datastore", "particion", "idle",
               "undersized", "oversized", "inaccesible", "apagada"],    tech: "vROps" },
];

/**
 * Tecnología de un reporte de la planilla "Reportes Faltantes".
 *
 * Primero busca el nombre exacto de la operación en TECNOLOGIA_POR_OPERACION
 * (core/ExecutionLogger.js), que es la misma fuente que usa el log de Estado Final: así el
 * dashboard no puede decir una tecnología distinta de la que dice el log para el mismo
 * reporte (AGENTS.md §5). Como el identificador de la planilla lo carga una persona y suele
 * traer prefijos ("09-00 Alertas de vSphere"), si no hay match exacto prueba por contención y
 * recién al final cae en las palabras clave.
 *
 * @param {string} idReporte Identificador del reporte tal como figura en la planilla.
 * @returns {string} Tecnología, o "Otro" si no se pudo deducir.
 */
function _deducirTecnologia(idReporte) {
  const norm = _faltantesNormalizar(idReporte);
  if (!norm) return "Otro";

  // 1. Nombre exacto de operación.
  const operaciones = Object.keys(TECNOLOGIA_POR_OPERACION);
  for (var i = 0; i < operaciones.length; i++) {
    if (_faltantesNormalizar(operaciones[i]) === norm) return TECNOLOGIA_POR_OPERACION[operaciones[i]];
  }

  // 2. El identificador CONTIENE el nombre de una operación. Se queda con el nombre más largo
  //    que matchee: "VMs en mas de un Job" tiene que ganarle a cualquier coincidencia corta.
  var largoMejor = 0;
  var techMejor = null;
  for (var j = 0; j < operaciones.length; j++) {
    const op = _faltantesNormalizar(operaciones[j]);
    if (op.length > 3 && op.length > largoMejor && norm.indexOf(op) !== -1) {
      largoMejor = op.length;
      techMejor = TECNOLOGIA_POR_OPERACION[operaciones[j]];
    }
  }
  if (techMejor) return techMejor;

  // 3. Palabras clave.
  for (var k = 0; k < _FALTANTES_TECH_FALLBACK.length; k++) {
    const regla = _FALTANTES_TECH_FALLBACK[k];
    for (var m = 0; m < regla.palabras.length; m++) {
      if (norm.indexOf(regla.palabras[m]) !== -1) return regla.tech;
    }
  }
  return "Otro";
}
function _getPodDesdeMaestro(clienteNombre) {
  try {
    const data = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID)
                   .getSheets()[0].getDataRange().getValues();
    const fila = data.find(function(r) {
      return r[1] && r[1].toString().trim().toLowerCase() === clienteNombre.toLowerCase();
    });
    return fila ? (fila[8] || "") : "";
  } catch (e) { return ""; }
}
function logReporteFaltante(clienteNombre, idReporte, fechaHoy) {
  try {
    const ss    = SpreadsheetApp.openById(LOG_SHEET_ID);
    const sheet = ss.getSheetByName(LOG_FALTANTES_TAB_NAME);
    if (!sheet) return;
    const tz    = "America/Argentina/Buenos_Aires";
    const fecha = Utilities.formatDate(fechaHoy || new Date(), tz, "yyyy-MM-dd");
    const hora  = Utilities.formatDate(new Date(), tz, "HH:mm:ss");
    sheet.appendRow([fecha, hora, clienteNombre,
      _getPodDesdeMaestro(clienteNombre), _deducirTecnologia(idReporte), idReporte]);
  } catch (e) {
    Logger.log("[LOG-FALTANTES] Error al registrar: " + e.message);
  }
}
