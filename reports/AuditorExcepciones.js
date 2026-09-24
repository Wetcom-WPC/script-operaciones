/**
 * ======================================================================
 * AUDITOR SEMANAL DE VENCIMIENTO DE EXCEPCIONES
 * ======================================================================
 * 
 * Revisa todas las planillas de excepciones vinculadas en el Índice Maestro.
 * Notifica a Slack:
 *  1. Excepciones ya vencidas (con alerta destacada si continúan marcadas como 'SI').
 *  2. Excepciones próximas a vencer dentro de los próximos 7 días.
 * 
 * Se programa para ejecutarse los viernes por la mañana o manualmente a demanda.
 */

/**
 * Función principal para ejecutar la auditoría de excepciones.
 * 
 * @param {Object} [opciones]
 * @param {boolean} [opciones.forzar=false] Si es true, omite chequeo de día viernes y feriados (para tests).
 * @param {string} [opciones.webhookUrl] Webhook específico de Slack a donde enviar el reporte.
 * @param {boolean} [opciones.soloLog=false] Si es true, solo loguea en consola sin enviar a Slack.
 * @returns {Object} Resumen de la auditoría.
 */
function auditarVencimientoExcepciones(opciones = {}) {
  const hoy = new Date();
  const esViernes = hoy.getDay() === 5;
  const forzar = opciones.forzar === true;

  // 1. Control de día de la semana (por defecto solo corre los viernes)
  if (!esViernes && !forzar) {
    Logger.log(`[AuditorExcepciones] Hoy no es viernes (día ${hoy.getDay()}). Ejecución omitida. (Usar forzar=true para probar).`);
    return { status: "OMITIDO", motivo: "NO_ES_VIERNES" };
  }

  // 2. Control de feriados
  if (typeof esFeriadoHoy === "function" && esFeriadoHoy() && !forzar) {
    Logger.log("[AuditorExcepciones] Hoy es feriado. Ejecución omitida.");
    return { status: "OMITIDO", motivo: "ES_FERIADO" };
  }

  Logger.log("=== INICIANDO AUDITORÍA SEMANAL DE EXCEPCIONES ===");

  // Normalizar hoy a medianoche (00:00:00) para cálculo exacto de días
  const hoyMedianoche = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());

  // 3. Obtener planillas de excepciones únicas desde el Índice Maestro
  const planillas = _obtenerPlanillasExcepcionesUnicas();
  if (planillas.length === 0) {
    Logger.log("⚠️ No se encontraron planillas de excepciones en el Índice Maestro.");
    return { status: "ERROR", motivo: "SIN_PLANILLAS" };
  }

  Logger.log(`Se encontraron ${planillas.length} planillas únicas de excepciones para auditar.`);

  const vencidas = [];
  const proximasAVencer = [];
  let totalPestanasAuditadas = 0;
  let totalExcepcionesAuditadas = 0;
  let planillasConError = 0;

  // 4. Recorrer cada planilla de excepciones
  planillas.forEach((item, index) => {
    try {
      const ss = SpreadsheetApp.openById(item.fileId);
      const sheets = ss.getSheets();

      sheets.forEach(sheet => {
        if (sheet.isSheetHidden()) return; // Ignorar hojas ocultas

        const sheetName = sheet.getName();
        // Omitir hojas de sistema si las hubiera
        if (sheetName.toLowerCase().startsWith("_") || sheetName.toLowerCase().includes("readme")) return;

        const data = sheet.getDataRange().getValues();
        if (!data || data.length < 2) return; // Sin filas de datos

        const headers = data[0].map(h => String(h || "").trim().toLowerCase());
        const colIndices = _detectarColumnasExcepciones(headers);

        // Si la hoja no tiene al menos columna de vencimiento o ID, no es hoja de excepciones
        if (colIndices.vencimiento === -1 && colIndices.id === -1) return;

        totalPestanasAuditadas++;

        for (let r = 1; r < data.length; r++) {
          const row = data[r];
          // Fila vacía
          if (!row || row.join("").trim() === "") continue;

          totalExcepcionesAuditadas++;

          const idExcepcion = String(row[colIndices.id] || `Fila ${r + 1}`).trim();
          const columnaReporte = String(row[colIndices.columna] || "").trim();
          const valoresIgnorar = String(row[colIndices.valores] || "").trim();
          const activaRaw = String(row[colIndices.activa] || "").trim().toUpperCase();
          const esActiva = activaRaw === "SI";
          const ticket = String(row[colIndices.ticket] || "").trim();
          const responsable = String(row[colIndices.responsable] || "").trim();
          const fechaVencimientoRaw = row[colIndices.vencimiento];

          if (!fechaVencimientoRaw) continue; // Excepción sin fecha (permanente)

          const fechaVencimiento = _parsearFechaExcepcion(fechaVencimientoRaw);
          if (!fechaVencimiento) continue;

          // Cálculo de diferencia en días
          const diffMs = fechaVencimiento.getTime() - hoyMedianoche.getTime();
          const diffDias = Math.round(diffMs / (1000 * 60 * 60 * 24));
          const fechaStr = Utilities.formatDate(fechaVencimiento, "America/Argentina/Buenos_Aires", "dd/MM/yyyy");

          const detalle = {
            cliente: item.clientes.join(", "),
            pestana: sheetName,
            id: idExcepcion,
            columna: columnaReporte,
            valores: valoresIgnorar,
            activa: esActiva,
            activaRaw: activaRaw || "NO",
            fechaVencimiento: fechaStr,
            diasRestantes: diffDias,
            ticket: ticket,
            responsable: responsable,
            fileUrl: ss.getUrl()
          };

          if (diffDias < 0) {
            // Ya vencida
            // Priorizamos: o está marcada como SI (anomalía crítica), o venció en los últimos 14 días
            vencidas.push(detalle);
          } else if (diffDias <= 7) {
            // Vence dentro de los próximos 7 días (hasta el próximo viernes)
            if (esActiva) {
              proximasAVencer.push(detalle);
            }
          }
        }
      });
    } catch (e) {
      Logger.log(`❌ Error al auditar planilla de "${item.clientes.join(", ")}" (${item.fileId}): ${e.message}`);
      planillasConError++;
    }
  });

  Logger.log(`Auditoría finalizada: ${planillas.length} planillas, ${totalPestanasAuditadas} pestañas, ${totalExcepcionesAuditadas} excepciones.`);
  Logger.log(`Resultados -> Vencidas: ${vencidas.length} | Próximas a vencer (7d): ${proximasAVencer.length}`);

  // 5. Enviar reporte a Slack si corresponde
  if (!opciones.soloLog) {
    const props = PropertiesService.getScriptProperties();
    const webhook = opciones.webhookUrl
      || props.getProperty("SLACK_WEBHOOK_AUDITOR_EXCEPCIONES")
      || props.getProperty("SLACK_WEBHOOK_YASC")
      || props.getProperty("SLACK_WEBHOOK_GENERAL");

    if (webhook) {
      const payloadSlack = _construirMensajeSlackExcepciones({
        vencidas,
        proximasAVencer,
        totalPlanillas: planillas.length,
        totalPestanas: totalPestanasAuditadas,
        planillasConError
      });
      sendSlackMessage(webhook, payloadSlack);
      Logger.log("✅ Reporte de excepciones enviado a Slack exitosamente.");
    } else {
      Logger.log("⚠️ No se encontró webhook configurado para enviar la auditoría a Slack.");
    }
  }

  return {
    status: "OK",
    totalPlanillas: planillas.length,
    totalPestanas: totalPestanasAuditadas,
    totalExcepciones: totalExcepcionesAuditadas,
    vencidas,
    proximasAVencer
  };
}

/**
 * Función para probar la auditoría en Slack (fuerza la ejecución y manda al canal de mock o general).
 */
function probarAuditorExcepcionesEnSlack() {
  Logger.log("=== PROBANDO AUDITOR DE EXCEPCIONES (FORZADO) ===");
  const props = PropertiesService.getScriptProperties();
  const webhookMock = props.getProperty("SLACK_WEBHOOK_MOCK_TAREAS_PROGRAMADAS")
    || props.getProperty("SLACK_WEBHOOK_AUDITOR_EXCEPCIONES")
    || props.getProperty("SLACK_WEBHOOK_GENERAL");

  return auditarVencimientoExcepciones({
    forzar: true,
    webhookUrl: webhookMock
  });
}

/**
 * Configura el activador semanal para correr todos los viernes a las 09:00 AM.
 */
function configurarActivadorAuditorExcepciones() {
  eliminarActivadorAuditorExcepciones();

  ScriptApp.newTrigger("auditarVencimientoExcepciones")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(9)
    .create();

  Logger.log("✅ Activador semanal creado: 'auditarVencimientoExcepciones' todos los viernes a las 09:00 hs.");
}

/**
 * Elimina cualquier activador existente de la función auditarVencimientoExcepciones.
 */
function eliminarActivadorAuditorExcepciones() {
  let borrados = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "auditarVencimientoExcepciones") {
      ScriptApp.deleteTrigger(t);
      borrados++;
    }
  });
  if (borrados > 0) {
    Logger.log(`Se eliminaron ${borrados} activador(es) existente(s) de 'auditarVencimientoExcepciones'.`);
  }
}

// ======================================================================
// HELPERS INTERNOS DE LECTURA Y FORMATEO
// ======================================================================

/**
 * Extrae y agrupa por archivo las planillas de excepciones del Índice Maestro.
 * @returns {Array<{fileId: string, clientes: string[]}>}
 */
function _obtenerPlanillasExcepcionesUnicas() {
  const masterData = (typeof MasterSheetSingleton !== "undefined" && MasterSheetSingleton.getMasterData)
    ? MasterSheetSingleton.getMasterData()
    : _leerMasterDataDirecto();

  if (!masterData || masterData.length < 2) return [];

  const map = {};

  for (let i = 1; i < masterData.length; i++) {
    const row = masterData[i];
    if (!row) continue;
    const clientName = row[1] ? String(row[1]).trim() : "";
    const exceptionFileId = row[2] ? String(row[2]).trim() : "";

    if (!exceptionFileId || exceptionFileId.length < 15) continue; // ID inválido o vacío

    if (!map[exceptionFileId]) {
      map[exceptionFileId] = { fileId: exceptionFileId, clientes: [] };
    }
    if (clientName && !map[exceptionFileId].clientes.includes(clientName)) {
      map[exceptionFileId].clientes.push(clientName);
    }
  }

  return Object.values(map);
}

/**
 * Fallback para leer el Índice Maestro directo si MasterSheetSingleton no está inicializado.
 */
function _leerMasterDataDirecto() {
  try {
    const sheetId = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
    if (!sheetId) return [];
    return SpreadsheetApp.openById(sheetId).getSheets()[0].getDataRange().getValues();
  } catch (e) {
    Logger.log(`[AuditorExcepciones] Error leyendo Índice Maestro directo: ${e.message}`);
    return [];
  }
}

/**
 * Detecta dinámicamente los índices de columnas en una pestaña de excepciones.
 */
function _detectarColumnasExcepciones(headers) {
  const findCol = (terms) => headers.findIndex(h => terms.some(t => h.includes(t)));

  let id = findCol(["id de excepción", "id excepcion", "id de excepcion", "exception id", "id"]);
  let columna = findCol(["columna del reporte", "columna reporte", "columna"]);
  let valores = findCol(["valores a ignorar", "valores a ignorar /", "valores a ignorar", "valores", "valor"]);
  let vencimiento = findCol(["válida hasta", "valida hasta", "vencimiento", "fecha vencimiento", "fecha límite", "fecha limite"]);
  let activa = findCol(["excepción activa", "excepcion activa", "activa", "activo"]);
  let ticket = findCol(["ticket de aprobación", "ticket aprobacion", "ticket"]);
  let responsable = findCol(["responsable", "owner", "solicitante"]);
  let notas = findCol(["notas", "riesgo", "observaciones"]);

  // Fallbacks estándar del proyecto (A=0, B=1, C=2, D=3, E=4, F=5, G=6, H=7, I=8)
  if (id === -1) id = 0;
  if (columna === -1) columna = 1;
  if (valores === -1) valores = 3;
  if (vencimiento === -1) vencimiento = 4;
  if (activa === -1) activa = 5;
  if (ticket === -1) ticket = 6;
  if (responsable === -1) responsable = 7;
  if (notas === -1) notas = 8;

  return { id, columna, valores, vencimiento, activa, ticket, responsable, notas };
}

/**
 * Parsea fechas en distintos formatos comunes de Google Sheets / Excel.
 * @param {any} val
 * @returns {Date|null}
 */
function _parsearFechaExcepcion(val) {
  if (!val) return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    return new Date(val.getFullYear(), val.getMonth(), val.getDate());
  }

  const str = String(val).trim();
  if (!str) return null;

  // Formato DD/MM/YYYY o DD-MM-YYYY
  if (str.includes("/") || str.includes("-")) {
    const separador = str.includes("/") ? "/" : "-";
    const partes = str.split(separador);
    if (partes.length === 3) {
      // YYYY-MM-DD
      if (partes[0].length === 4) {
        const y = parseInt(partes[0], 10);
        const m = parseInt(partes[1], 10) - 1;
        const d = parseInt(partes[2], 10);
        const fecha = new Date(y, m, d);
        return isNaN(fecha.getTime()) ? null : fecha;
      }
      // DD/MM/YYYY
      const d = parseInt(partes[0], 10);
      const m = parseInt(partes[1], 10) - 1;
      const y = parseInt(partes[2], 10);
      const fecha = new Date(y, m, d);
      return isNaN(fecha.getTime()) ? null : fecha;
    }
  }

  const timestamp = Date.parse(str);
  if (!isNaN(timestamp)) {
    const d = new Date(timestamp);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  return null;
}

/**
 * Construye el mensaje formateado para Slack.
 */
function _construirMensajeSlackExcepciones(datos) {
  const { vencidas, proximasAVencer, totalPlanillas, totalPestanas, planillasConError } = datos;
  const hoyStr = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "dd/MM/yyyy");

  // CASO 1: TODO AL DÍA
  if (vencidas.length === 0 && proximasAVencer.length === 0) {
    return {
      text: `✨ *[Auditoría Semanal de Excepciones — ${hoyStr}]*\n` +
            `¡Excelente! Todas las excepciones están al día. No se detectaron excepciones vencidas ni próximas a vencer a 7 días en las *${totalPlanillas} planillas* revisadas (${totalPestanas} pestañas).`
    };
  }

  // CASO 2: HAY ALERTAS
  let texto = `📋 *[Auditoría Semanal] Vencimiento de Excepciones — ${hoyStr}*\n` +
              `_Se revisaron ${totalPlanillas} planillas de clientes (${totalPestanas} pestañas)._\n\n`;

  // SECCIÓN 1: VENCIDAS
  if (vencidas.length > 0) {
    // Ordenar: primero las que siguen activas (más críticas)
    vencidas.sort((a, b) => (b.activa ? 1 : 0) - (a.activa ? 1 : 0));

    texto += `🚨 *EXCEPCIONES YA VENCIDAS (${vencidas.length}):*\n`;
    vencidas.forEach(v => {
      const iconoEstado = v.activa ? "⚠️ *ACTIVA (Requiere acción)*" : "Inactiva";
      const diasVencida = Math.abs(v.diasRestantes);
      const tiempoTxt = diasVencida === 0 ? "hoy" : `hace ${diasVencida} día(s)`;

      texto += `• *${v.cliente}* › _${v.pestana}_: \`${v.id}\`\n`;
      texto += `  └ Venció *${tiempoTxt}* (${v.fechaVencimiento}) | Estado: ${iconoEstado}\n`;
      if (v.valores) texto += `  └ Valores: \`${_truncar(v.valores, 40)}\`\n`;
      if (v.responsable || v.ticket) {
        texto += `  └ Responsable: ${v.responsable || "N/A"} | Ticket: ${v.ticket || "N/A"}\n`;
      }
    });
    texto += `\n`;
  }

  // SECCIÓN 2: PRÓXIMAS A VENCER (7 DÍAS)
  if (proximasAVencer.length > 0) {
    // Ordenar por días restantes (la que vence antes primero)
    proximasAVencer.sort((a, b) => a.diasRestantes - b.diasRestantes);

    texto += `⏳ *PRÓXIMAS A VENCER EN 7 DÍAS (${proximasAVencer.length}):*\n`;
    proximasAVencer.forEach(p => {
      const tiempoTxt = p.diasRestantes === 0 ? "¡Vence HOY!" : `Vence en ${p.diasRestantes} día(s)`;

      texto += `• *${p.cliente}* › _${p.pestana}_: \`${p.id}\`\n`;
      texto += `  └ ⏰ *${tiempoTxt}* (${p.fechaVencimiento})\n`;
      if (p.valores) texto += `  └ Valores: \`${_truncar(p.valores, 40)}\`\n`;
      if (p.responsable || p.ticket) {
        texto += `  └ Responsable: ${p.responsable || "N/A"} | Ticket: ${p.ticket || "N/A"}\n`;
      }
    });
    texto += `\n`;
  }

  if (planillasConError > 0) {
    texto += `⚠️ _Nota: Hubo ${planillasConError} planilla(s) que no se pudieron abrir por permisos o ID inexistente. Revisar logs de Apps Script._\n`;
  }

  texto += `👉 _Por favor revisar las planillas correspondientes para coordinar renovación con el cliente o dar de baja la excepción._`;

  return { text: texto };
}

/**
 * Trunca un string con puntos suspensivos si excede la longitud dada.
 */
function _truncar(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.substring(0, maxLen - 3) + "..." : str;
}
