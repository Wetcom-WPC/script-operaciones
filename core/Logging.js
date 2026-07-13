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

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────

const LOG_SHEET_ID              = PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID");
const LOG_ESTADO_FINAL_TAB_NAME = "Estado Final";
const LOG_ERRORES_TAB_NAME      = "Errores del Script";
const LOG_MAILS_TAB_NAME        = "Envío de Mails";
const LOG_FALTANTES_TAB_NAME    = "Logs Reportes Faltantes";

// Columnas de Estado Final (índices base 0 para búsqueda interna)
const _EF_COL = {
  FECHA:          0,   // A
  OPERACION:      1,   // B
  ORIGEN:         2,   // C
  CLIENTE:        3,   // D
  POD:            4,   // E
  INTENTOS:       5,   // F
  ESTADO:         6,   // G
  TICKETS_CRE:    7,   // H
  TICKETS_ACT:    8,   // I
  TAREAS_CER:     9,   // J
  ULTIMO_ERROR:   10,  // K
  ULTIMA_ACT:     11,  // L
};

// ─── MAPEO operationName → tecnología ────────────────────────────────────────
const _LOG_TECNOLOGIA_MAP = {
  "Affinity Rules":                                   "vRO",
  "Alertas de vSphere":                               "vRO",
  "VMs con preguntas":                                "vRO",
  "Discos montados en proxy":                         "vRO",
  "Alertas de vROps":                                 "vROps",
  "Cluster DRS":                                      "vROps",
  "Storage DRS":                                      "vROps",
  "Capacidad de particiones":                         "vROps",
  "Espacio en datastores":                            "vROps",
  "VMs inaccesibles":                                 "vROps",
  "VMs en datastores locales":                        "vROps",
  "VMs operativas":                                   "vROps",
  "VMs con snapshots":                                "vROps",
  "VMs apagadas por periodo de tiempo significativo": "vROps",
  "Idle VMs":                                         "vROps",
  "Undersized VMs":                                   "vROps",
  "Oversized VMs":                                    "vROps",
  "Orphaned VMs":                                     "Veeam ONE",
  "VMs en mas de un Job":                             "Veeam ONE",
  "Espacio en Repositorios":                          "Veeam BR",
  "Jobs Veeam":                                       "Veeam BR",
  "Proxies de Veeam":                                 "Veeam BR",
  "Componentes de View":                              "Connection Server",
  "Dashboard View":                                   "Connection Server",
  "Estado de Agentes View":                           "Connection Server",
  "Zombies VMDKs":                                    "RVTools",
  "VMs sin connect at power on":                      "RVTools",
};

// ─── FUNCIÓN PRINCIPAL: llamada desde enviarResumenSlack ──────────────────────

function _registrarEnLog(operationName, summaryReport) {
  try {
    const ss    = SpreadsheetApp.openById(LOG_SHEET_ID);
    const sheet = ss.getSheetByName(LOG_ESTADO_FINAL_TAB_NAME);
    if (!sheet) {
      Logger.log("[LOG] Pestaña 'Estado Final' no encontrada. Ejecutar inicializarHojaLog() primero.");
      return;
    }

    const tz        = "America/Argentina/Buenos_Aires";
    const ahora     = new Date();
    const timestamp = Utilities.formatDate(ahora, tz, "yyyy-MM-dd HH:mm:ss");
    const fecha     = Utilities.formatDate(ahora, tz, "yyyy-MM-dd");

    const esRVToolsManual = operationName.startsWith("RVTools MANUAL:");
    const clienteRVTools  = esRVToolsManual
      ? operationName.replace("RVTools MANUAL:", "").trim()
      : null;
    const tecnologia      = esRVToolsManual ? "RVTools" : (_LOG_TECNOLOGIA_MAP[operationName] || "Otro");
    const opNombre        = esRVToolsManual ? "RVTools Manual" : operationName;

    const exitos       = summaryReport.exitos       || [];
    const errores      = summaryReport.errores      || [];
    const advertencias = summaryReport.advertencias || [];
    const tareasCerradas = summaryReport.tareasCerradas || 0;

    // Determinar resultado
    let resultado;
    if      (errores.length > 0)                            resultado = "ERROR";
    else if (advertencias.length > 0)                       resultado = "ADVERTENCIA";
    else if (exitos.length > 0 || tareasCerradas > 0)       resultado = "ANOMALIAS";
    else                                                     resultado = "OK";

    // Registrar errores en pestaña dedicada
    if (errores.length > 0) {
      const errorConCliente = errores.find(function(e) { return e && e.cliente; });
      const clienteError    = esRVToolsManual
        ? clienteRVTools
        : (errorConCliente ? errorConCliente.cliente : "—");
      _registrarErrorScript(opNombre, tecnologia, clienteError, errores);
    }

    // Armar entradas por cliente
    const entradas = _armarEntradas(
      esRVToolsManual, clienteRVTools, exitos, errores,
      tareasCerradas, resultado
    );

    // Leer filas existentes para upsert
    const lastRow      = sheet.getLastRow();
    const existingData = lastRow > 1
      ? sheet.getRange(2, 1, lastRow - 1, Object.keys(_EF_COL).length).getValues()
      : [];

    entradas.forEach(function(entrada) {
      const estadoLabel = _estadoLabel(resultado);

      // Buscar fila existente: misma fecha + operación + cliente
      const rowIdx = existingData.findIndex(function(r) {
        return r[_EF_COL.FECHA].toString().substring(0, 10) === fecha
            && r[_EF_COL.OPERACION].toString()              === opNombre
            && r[_EF_COL.CLIENTE].toString()                === entrada.cliente;
      });

      if (rowIdx >= 0) {
        // ── UPDATE: actualizar fila existente ──
        const filaSheet    = rowIdx + 2; // +2: header + base 1
        const intentosPrev = Number(existingData[rowIdx][_EF_COL.INTENTOS]) || 0;

        sheet.getRange(filaSheet, _EF_COL.INTENTOS    + 1).setValue(intentosPrev + 1);
        sheet.getRange(filaSheet, _EF_COL.ESTADO      + 1).setValue(estadoLabel);
        sheet.getRange(filaSheet, _EF_COL.TICKETS_CRE + 1)
          .setValue((Number(existingData[rowIdx][_EF_COL.TICKETS_CRE]) || 0) + entrada.ticketsCreados);
        sheet.getRange(filaSheet, _EF_COL.TICKETS_ACT + 1)
          .setValue((Number(existingData[rowIdx][_EF_COL.TICKETS_ACT]) || 0) + entrada.ticketsActualizados);
        sheet.getRange(filaSheet, _EF_COL.TAREAS_CER  + 1)
          .setValue((Number(existingData[rowIdx][_EF_COL.TAREAS_CER])  || 0) + entrada.tareasCerradas);
        sheet.getRange(filaSheet, _EF_COL.ULTIMO_ERROR + 1)
          .setValue(entrada.ultimoError || existingData[rowIdx][_EF_COL.ULTIMO_ERROR]);
        sheet.getRange(filaSheet, _EF_COL.ULTIMA_ACT  + 1).setValue(timestamp);

        // Actualizar caché local para evitar falsos duplicados en la misma ejecución
        existingData[rowIdx][_EF_COL.INTENTOS]     = intentosPrev + 1;
        existingData[rowIdx][_EF_COL.ESTADO]        = estadoLabel;
        existingData[rowIdx][_EF_COL.ULTIMO_ERROR]  = entrada.ultimoError;
        existingData[rowIdx][_EF_COL.ULTIMA_ACT]    = timestamp;

      } else {
        // ── INSERT: nueva fila ──
        // Si no hay historial previo y el resultado es OK, no hay nada que mostrar
        if (resultado === "OK") return;
        const newRow = [
          fecha,
          opNombre,
          tecnologia,
          entrada.cliente,
          entrada.pod,
          1,
          estadoLabel,
          entrada.ticketsCreados,
          entrada.ticketsActualizados,
          entrada.tareasCerradas,
          entrada.ultimoError,
          timestamp,
        ];
        sheet.appendRow(newRow);
        existingData.push(newRow);
      }
    });

  } catch (e) {
    Logger.log("[LOG] Error al registrar en Estado Final: " + e.message);
  }
}

// ─── REGISTRO DE ERRORES DEL SCRIPT ──────────────────────────────────────────

function _registrarErrorScript(operationName, origen, cliente, errores) {
  try {
    const ss    = SpreadsheetApp.openById(LOG_SHEET_ID);
    const sheet = ss.getSheetByName(LOG_ERRORES_TAB_NAME);
    if (!sheet) return;

    const tz        = "America/Argentina/Buenos_Aires";
    const ahora     = new Date();
    const fecha     = Utilities.formatDate(ahora, tz, "yyyy-MM-dd");
    const hora      = Utilities.formatDate(ahora, tz, "HH:mm:ss");
    const diaSemana = Utilities.formatDate(ahora, tz, "EEEE");

    var historial = [];
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      historial = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    }

    errores.forEach(function(err) {
      const clienteEfectivo = (err && err.cliente) ? err.cliente : cliente;
      const detalleError    = typeof err === "string"
        ? err
        : ((err.error || "") + (err.detalle ? " — " + err.detalle : ""));

      const esReincidente = historial.some(function(h) {
        const mismaOp      = (h[2] || "").toLowerCase() === operationName.toLowerCase();
        const mismoCli     = (h[4] || "").toLowerCase() === clienteEfectivo.toLowerCase();
        const errorSimilar = (h[5] || "").length > 10
                          && detalleError.length > 10
                          && (h[5] || "").substring(0, 30).toLowerCase()
                             === detalleError.substring(0, 30).toLowerCase();
        return mismaOp && mismoCli && errorSimilar;
      });

      sheet.appendRow([
        fecha, hora, operationName, origen,
        clienteEfectivo, detalleError,
        esReincidente ? "⚠️ SÍ" : "No",
        diaSemana,
      ]);
    });
  } catch (e) {
    Logger.log("[LOG-ERROR] Error al registrar en Errores del Script: " + e.message);
  }
}

// ─── FUNCIÓN PÚBLICA PARA REGISTRO DE ENVÍO DE MAILS ─────────────────────────

function registrarEnvioMail(tecnologia, cliente, pod, totalTickets, itemsErrores, itemsAdvertencias, asunto, modoTest) {
  try {
    const ss    = SpreadsheetApp.openById(LOG_SHEET_ID);
    const sheet = ss.getSheetByName(LOG_MAILS_TAB_NAME);
    if (!sheet) return;

    const tz        = "America/Argentina/Buenos_Aires";
    const ahora     = new Date();
    const fecha     = Utilities.formatDate(ahora, tz, "yyyy-MM-dd");
    const hora      = Utilities.formatDate(ahora, tz, "HH:mm:ss");
    const diaSemana = Utilities.formatDate(ahora, tz, "EEEE");

    const cantSoporte     = (itemsErrores      || []).length;
    const cantOperaciones = (itemsAdvertencias || []).length;
    const cantTotal       = (totalTickets      || []).length;

    let estado;
    if (cantSoporte > 0)          estado = "🔴 Con Incidencias";
    else if (cantOperaciones > 0) estado = "🟡 Con Advertencias";
    else                          estado = "🟢 Sin Anomalías";

    sheet.appendRow([
      fecha, hora, diaSemana,
      cliente, tecnologia, pod, estado,
      cantTotal, cantSoporte, cantOperaciones,
    ]);
  } catch (e) {
    Logger.log("[LOG-MAIL] Error al registrar envío de mail: " + e.message);
  }
}

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
  ];
  tabMails.getRange(1, 1, 1, colsMails.length).setValues([colsMails])
          .setFontWeight("bold").setBackground("#1A5276").setFontColor("#FFFFFF");
  tabMails.setFrozenRows(1);

  [[1,100],[2,80],[3,100],[4,180],[5,120],[6,70],[7,160],[8,100],[9,100],[10,110]]
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

// ─── SISTEMA DE ARCHIVADO MENSUAL ────────────────────────────────────────────

var LOG_ARCHIVO_FOLDER_ID = "PEGAR_ID_CARPETA_HISTORICO_AQUI";

function archivarLogMensual() {
  try {
    const tz          = "America/Argentina/Buenos_Aires";
    const hoy         = new Date();
    const mesAnterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const nombreMes   = Utilities.formatDate(mesAnterior, tz, "yyyy-MM");
    const labelMes    = Utilities.formatDate(mesAnterior, tz, "MMMM yyyy");
    const primerDia   = Utilities.formatDate(mesAnterior, tz, "yyyy-MM-01");
    const ultimoDia   = Utilities.formatDate(
      new Date(hoy.getFullYear(), hoy.getMonth(), 0), tz, "yyyy-MM-dd");

    Logger.log("[ARCHIVO] Iniciando archivado de " + labelMes);

    const ssOrigen  = SpreadsheetApp.openById(LOG_SHEET_ID);
    const folder    = DriveApp.getFolderById(LOG_ARCHIVO_FOLDER_ID);
    const ssArchivo = SpreadsheetApp.create("Registro Operacional - " + nombreMes);
    const file      = DriveApp.getFileById(ssArchivo.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);

    const pestanas = [
      LOG_ESTADO_FINAL_TAB_NAME,
      LOG_ERRORES_TAB_NAME,
      LOG_MAILS_TAB_NAME,
      LOG_FALTANTES_TAB_NAME,
    ];

    var totalArchivadas = 0;
    var primeraHoja     = true;

    pestanas.forEach(function(nombre) {
      try {
        const shOrigen = ssOrigen.getSheetByName(nombre);
        if (!shOrigen) return;
        const allData = shOrigen.getDataRange().getValues();
        if (allData.length <= 1) return;

        const header       = allData[0];
        const filasDelMes  = allData.slice(1).filter(function(r) {
          const val = r[1] || r[0];
          if (!val) return false;
          const str = val instanceof Date
            ? Utilities.formatDate(val, tz, "yyyy-MM-dd")
            : val.toString().substring(0, 10);
          return str >= primerDia && str <= ultimoDia;
        });
        if (filasDelMes.length === 0) return;

        const shArchivo = primeraHoja ? ssArchivo.getActiveSheet() : ssArchivo.insertSheet();
        shArchivo.setName(nombre);
        primeraHoja = false;

        const data = [header].concat(filasDelMes);
        shArchivo.getRange(1, 1, data.length, header.length).setValues(data);
        shArchivo.getRange(1, 1, 1, header.length)
          .setFontWeight("bold").setBackground("#2C3E50").setFontColor("#FFFFFF");
        shArchivo.setFrozenRows(1);

        totalArchivadas += filasDelMes.length;
        Logger.log("[ARCHIVO] " + nombre + ": " + filasDelMes.length + " filas.");

        const toDelete = [];
        allData.slice(1).forEach(function(r, idx) {
          const val = r[1] || r[0];
          if (!val) return;
          const str = val instanceof Date
            ? Utilities.formatDate(val, tz, "yyyy-MM-dd")
            : val.toString().substring(0, 10);
          if (str >= primerDia && str <= ultimoDia) toDelete.push(idx + 2);
        });
        toDelete.reverse().forEach(function(n) { shOrigen.deleteRow(n); });

      } catch (e) {
        Logger.log("[ARCHIVO] Error en " + nombre + ": " + e.message);
      }
    });

    SpreadsheetApp.flush();
    Logger.log("[ARCHIVO] ✅ Completado: " + totalArchivadas + " filas archivadas.");
  } catch (e) {
    Logger.log("[ARCHIVO] ❌ Error crítico: " + e.message);
  }
}

function configurarTriggerArchivadoMensual() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === "archivarLogMensual"; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("archivarLogMensual").timeBased().onMonthDay(1).atHour(6).create();
  Logger.log("✅ Trigger mensual configurado.");
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

const _FALTANTES_TECH_MAP = [
  { palabras: ["veeam","backup","replica","job","repositorio","proxy","agente"], tech: "Veeam" },
  { palabras: ["vsphere","cluster","drs","datastore","snapshot","vm","host"],   tech: "vROps" },
  { palabras: ["horizon","view","agente view"],                                  tech: "Connection Server" },
  { palabras: ["rvtools","zombie","vmdk","connect at power"],                    tech: "RVTools" },
  { palabras: ["affinity","preguntas","alertas de vsphere"],                     tech: "vRO" },
];

function _deducirTecnologia(idReporte) {
  const lower = idReporte.toLowerCase();
  for (var i = 0; i < _FALTANTES_TECH_MAP.length; i++) {
    if (_FALTANTES_TECH_MAP[i].palabras.some(function(p) { return lower.includes(p); }))
      return _FALTANTES_TECH_MAP[i].tech;
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

// ─── HELPERS PRIVADOS ─────────────────────────────────────────────────────────

function _armarEntradas(esRVToolsManual, clienteRVTools, exitos, errores, tareasCerradas, resultado) {
  if (esRVToolsManual) {
    return [{
      cliente:             clienteRVTools,
      pod:                 _getPod(clienteRVTools),
      ticketsCreados:      _contarPorPalabra(exitos, "cread"),
      ticketsActualizados: _contarPorPalabra(exitos, ["actualiz", "update"]),
      tareasCerradas,
      ultimoError:         _primerError(errores),
    }];
  }

  const clientesTickets = _extraerClientesYKeys(exitos);
  if (clientesTickets.length > 0) {
    return clientesTickets.map(function(ct) {
      return {
        cliente:             ct.cliente,
        pod:                 _getPod(ct.cliente),
        ticketsCreados:      ct.ticketsCreados,
        ticketsActualizados: ct.ticketsActualizados,
        tareasCerradas,
        ultimoError:         _primerError(errores),
      };
    });
  }

  // Fallback: extraer cliente desde errores si no hay éxitos
  const errorConCliente = errores.find(function(e) { return e && e.cliente; });
  const clienteFallback = errorConCliente ? errorConCliente.cliente : "—";
  return [{
    cliente:             clienteFallback,
    pod:                 clienteFallback !== "—" ? _getPod(clienteFallback) : "",
    ticketsCreados:      0,
    ticketsActualizados: 0,
    tareasCerradas,
    ultimoError:         _primerError(errores),
  }];
}

function _estadoLabel(resultado) {
  if (resultado === "ERROR")       return "⚠️ No resuelto";
  if (resultado === "ADVERTENCIA") return "🟡 Con advertencias";
  return "✅ Resuelto";
}

function _extraerClientesYKeys(exitos) {
  const mapa = {};
  exitos.forEach(function(e) {
    const msg     = typeof e === "string" ? e : (e.mensaje || JSON.stringify(e));
    const cliente = _extraerCliente(msg);
    if (!cliente) return;
    if (!mapa[cliente]) mapa[cliente] = { ticketsCreados: 0, ticketsActualizados: 0, anomalias: 0, keys: [] };
    const keys = msg.match(/[A-Z]+-\d+/g) || [];
    mapa[cliente].keys.push.apply(mapa[cliente].keys, keys);
    const msgL = msg.toLowerCase();
    if      (msgL.includes("cread"))                          { mapa[cliente].ticketsCreados++;      mapa[cliente].anomalias++; }
    else if (msgL.includes("actualiz") || msgL.includes("update")) { mapa[cliente].ticketsActualizados++; mapa[cliente].anomalias++; }
  });
  return Object.keys(mapa).map(function(cliente) {
    const d = mapa[cliente];
    return {
      cliente,
      resultado:           d.ticketsCreados > 0 || d.ticketsActualizados > 0 ? "ANOMALIAS" : "OK",
      anomalias:           d.anomalias,
      ticketsCreados:      d.ticketsCreados,
      ticketsActualizados: d.ticketsActualizados,
      keys:                d.keys.filter(function(v, i, a) { return a.indexOf(v) === i; }).join(", "),
    };
  });
}

function _extraerCliente(msg) {
  if (!msg) return null;
  const keyMatch = msg.match(/([A-Z]+-\d+)/);
  if (keyMatch) {
    const projectKey = keyMatch[1].split("-")[0];
    try {
      const data = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID)
                     .getSheets()[0].getDataRange().getValues();
      const fila = data.find(function(r) {
        const opsKey = r[3]  ? r[3].toString().trim().toUpperCase()  : "";
        const sopKey = r[13] ? r[13].toString().trim().toUpperCase() : "";
        return opsKey === projectKey || sopKey === projectKey;
      });
      if (fila) return fila[1].toString().trim();
    } catch(e) {}
  }
  const m = msg.match(/(?:reporte de|para|de)\s+([A-ZÁÉÍÓÚÑ][^.,()\n<|]{2,50?})\s+(?:procesado|recibido|sin|creado|actualiz)/i);
  return m ? m[1].trim() : null;
}

function _contarPorPalabra(exitos, palabras) {
  const lista = Array.isArray(palabras) ? palabras : [palabras];
  return exitos.filter(function(e) {
    const m = (typeof e === "string" ? e : (e.mensaje || "")).toLowerCase();
    return lista.some(function(p) { return m.includes(p); });
  }).length;
}

function _primerError(errores) {
  if (!errores || errores.length === 0) return "";
  const e = errores[0];
  return typeof e === "string" ? e : ((e.error || "") + (e.detalle ? " — " + e.detalle : ""));
}

function _getPod(clienteNombre) {
  try {
    const data = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID)
                   .getSheets()[0].getDataRange().getValues();
    const fila = data.find(function(r) {
      return r[11] && r[11].toString().trim().toLowerCase() === clienteNombre.toLowerCase();
    });
    return fila ? (fila[8] || "") : "";
  } catch (e) { return ""; }
}