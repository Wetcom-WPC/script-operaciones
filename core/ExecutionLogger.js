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
// --- BUFFERS EN MEMORIA PARA ESCRITURA EN BLOQUE (BATCHED WRITES) ---
const _bufferEstadoFinal = [];
const _bufferErrores = [];
const _bufferMails = [];
const _upsertsEstadoFinal = [];

function flushLogs() {
  try {
    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    
    // Flush Estado Final (Upserts y Appends)
    const sheetEF = ss.getSheetByName(LOG_ESTADO_FINAL_TAB_NAME);
    if (sheetEF) {
      // 1. Ejecutar Upserts individuales (generalmente pocos)
      _upsertsEstadoFinal.forEach(function(u) {
        sheetEF.getRange(u.rowIdx + 2, 1, 1, u.data.length).setValues([u.data]);
      });
      // 2. Ejecutar Insertions en bloque
      if (_bufferEstadoFinal.length > 0) {
        sheetEF.getRange(sheetEF.getLastRow() + 1, 1, _bufferEstadoFinal.length, _bufferEstadoFinal[0].length).setValues(_bufferEstadoFinal);
      }
    }
    
    // Flush Errores
    if (_bufferErrores.length > 0) {
      const sheetErr = ss.getSheetByName(LOG_ERRORES_TAB_NAME);
      if (sheetErr) {
        sheetErr.getRange(sheetErr.getLastRow() + 1, 1, _bufferErrores.length, _bufferErrores[0].length).setValues(_bufferErrores);
      }
    }
    
    // Flush Mails
    if (_bufferMails.length > 0) {
      const sheetMail = ss.getSheetByName(LOG_MAILS_TAB_NAME);
      if (sheetMail) {
        sheetMail.getRange(sheetMail.getLastRow() + 1, 1, _bufferMails.length, _bufferMails[0].length).setValues(_bufferMails);
      }
    }
    
    // Limpiar buffers
    _bufferEstadoFinal.length = 0;
    _bufferErrores.length = 0;
    _bufferMails.length = 0;
    _upsertsEstadoFinal.length = 0;
    
  } catch (e) {
    Logger.log("[LOG] Error al hacer flushLogs: " + e.message);
  }
}

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
        // ACTUALIZAR FILA EXISTENTE (UPSERT)
        const colsToUpdate = existingData[rowIdx];
        colsToUpdate[_EF_COL.INTENTOS]   = (Number(colsToUpdate[_EF_COL.INTENTOS]) || 0) + 1;
        colsToUpdate[_EF_COL.ESTADO]     = estadoLabel;
        colsToUpdate[_EF_COL.TICKETS_CRE]= (Number(colsToUpdate[_EF_COL.TICKETS_CRE]) || 0) + entrada.ticketsCreados;
        colsToUpdate[_EF_COL.TICKETS_ACT]= (Number(colsToUpdate[_EF_COL.TICKETS_ACT]) || 0) + entrada.ticketsActualizados;
        colsToUpdate[_EF_COL.TAREAS_CER] = (Number(colsToUpdate[_EF_COL.TAREAS_CER])  || 0) + entrada.tareasCerradas;
        colsToUpdate[_EF_COL.ULTIMO_ERROR]= entrada.ultimoError || colsToUpdate[_EF_COL.ULTIMO_ERROR];
        colsToUpdate[_EF_COL.ULTIMA_ACT] = timestamp;
        
        _upsertsEstadoFinal.push({rowIdx: rowIdx, data: colsToUpdate});
        // Actualizar caché local
        existingData[rowIdx] = colsToUpdate;
      } else {
        // INSERTAR NUEVA FILA
        if (resultado === "OK") return;
        const newRow = Array(12).fill("");
        newRow[_EF_COL.FECHA]        = fecha;
        newRow[_EF_COL.OPERACION]    = opNombre;
        newRow[_EF_COL.ORIGEN]       = tecnologia;
        newRow[_EF_COL.CLIENTE]      = entrada.cliente;
        newRow[_EF_COL.POD]          = entrada.pod;
        newRow[_EF_COL.INTENTOS]     = 1;
        newRow[_EF_COL.ESTADO]       = estadoLabel;
        newRow[_EF_COL.TICKETS_CRE]  = entrada.ticketsCreados;
        newRow[_EF_COL.TICKETS_ACT]  = entrada.ticketsActualizados;
        newRow[_EF_COL.TAREAS_CER]   = entrada.tareasCerradas;
        newRow[_EF_COL.ULTIMO_ERROR] = entrada.ultimoError || "";
        newRow[_EF_COL.ULTIMA_ACT]   = timestamp;
        
        _bufferEstadoFinal.push(newRow);
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
      _bufferErrores.push([
        fecha, hora, operationName, origen,
        clienteEfectivo, detalleError,
        esReincidente ? "Sí" : "No",
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
    _bufferMails.push([
      fecha, hora, diaSemana,
      cliente, tecnologia, pod, estado,
      cantTotal, cantSoporte, cantOperaciones,
    ]);
  } catch (e) {
    Logger.log("[LOG-MAIL] Error al registrar envío de mail: " + e.message);
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
