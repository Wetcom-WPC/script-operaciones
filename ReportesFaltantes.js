/**
 * ======================================================================
 * CONFIGURACIÓN Y CONSTANTES GLOBALES
 * ======================================================================
 */
const SLACK_WEBHOOK_URL_YASC = "https://hooks.slack.com/services/REDACTED";
//LOGS:"https://hooks.slack.com/services/REDACTED"
// POD-WPC: https://hooks.slack.com/services/REDACTED

const ID_HOJA_MAESTRA = "1ZriSQeckRp_hWXS0X-CdGzrnnplCj2KmcLHgAbXo6qU";
// LOG_SHEET_ID ya está declarada globalmente en el repo (OperationsLogger.gs) — no redeclarar.

const NOMBRE_PESTANA_MAESTRA = "Reportes Faltantes";
const FILA_ENCABEZADOS = 1;

const COL = {
  CLIENTE:        0,
  ID_REPORTE:     1,
  ID_CARPETA_RAIZ: 2,
  FRECUENCIA:     3,
  FECHA_ORIGEN:   4
};

let CACHE_ARCHIVOS_CARPETA = {};

/**
 * ======================================================================
 * FUNCIÓN PRINCIPAL (TRIGGER DIARIO)
 * ======================================================================
 */
function ejecutarAuditoriaDiaria() {
  // FRENO DE FERIADOS — Usa la función centralizada del repo
  if (esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado en el calendario de Alarmas Wetcom.");
    return;
  }

  let ss;
  try {
    ss = SpreadsheetApp.openById(ID_HOJA_MAESTRA);
  } catch (e) {
    Logger.log("❌ ERROR CRÍTICO: No se pudo abrir la hoja de cálculo. Verifica ID_HOJA_MAESTRA.");
    return;
  }

  const hoja = ss.getSheetByName(NOMBRE_PESTANA_MAESTRA);
  if (!hoja) {
    Logger.log("❌ ERROR CRÍTICO: No se encontró la pestaña '" + NOMBRE_PESTANA_MAESTRA + "'");
    return;
  }

  // slice() en lugar de splice() para no mutar el array original
  const datos = hoja.getDataRange().getValues().slice(FILA_ENCABEZADOS);

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  let reportesFaltantes = {};
  let totalFaltantes = 0;

  Logger.log("Iniciando auditoría para fecha: " + Utilities.formatDate(hoy, Session.getScriptTimeZone(), "dd/MM/yyyy"));

  for (let i = 0; i < datos.length; i++) {
    const fila = datos[i];
    const numFilaExcel = i + 1 + FILA_ENCABEZADOS;

    const cliente       = fila[COL.CLIENTE];
    const idReporte     = fila[COL.ID_REPORTE]      ? fila[COL.ID_REPORTE].toString().trim()      : "";
    const idCarpetaRaiz = fila[COL.ID_CARPETA_RAIZ] ? fila[COL.ID_CARPETA_RAIZ].toString().trim() : "";
    const frecuencia    = fila[COL.FRECUENCIA];
    const fechaOrigen   = fila[COL.FECHA_ORIGEN]    ? new Date(fila[COL.FECHA_ORIGEN])             : null;

    if (!cliente || !idReporte || !idCarpetaRaiz || !frecuencia) continue;

    try {
      if (debeLlegarHoy(frecuencia, fechaOrigen, hoy)) {
        Logger.log(`[Fila ${numFilaExcel}] Revisando: ${cliente} - "${idReporte}"`);
        const llego = verificarEnDrive(idCarpetaRaiz, idReporte, hoy);

        if (!llego) {
          if (!reportesFaltantes[cliente]) reportesFaltantes[cliente] = [];
          reportesFaltantes[cliente].push(idReporte);
          totalFaltantes++;
          Logger.log(`❌ FALTANTE: ${cliente} - ${idReporte}`);
          // Usa la función centralizada del repo (OperationsLogger.gs)
          // que ya tiene el nombre correcto de pestaña: LOG_FALTANTES_TAB_NAME = "Logs Reportes Faltantes"
          logReporteFaltante(cliente, idReporte, hoy);
        } else {
          Logger.log(`✅ RECIBIDO: ${cliente} - ${idReporte}`);
        }
      }
    } catch (e) {
      Logger.log(`⚠️ ERROR en Fila ${numFilaExcel} (${cliente}): ${e.message}`);
      if (!reportesFaltantes[cliente]) reportesFaltantes[cliente] = [];
      reportesFaltantes[cliente].push(`ERROR PROCESO: ${idReporte}`);
      totalFaltantes++;
    }
  }

  Logger.log(`Auditoría finalizada. Faltantes: ${totalFaltantes}.`);
  enviarNotificacionSlack(reportesFaltantes, totalFaltantes, hoy);
}

/**
 * ======================================================================
 * LÓGICA DE NEGOCIO: VERIFICACIÓN EN DRIVE
 * ======================================================================
 */
function verificarEnDrive(idCarpetaRaiz, identificadorReporte, fechaHoy) {
  const diaStr  = Utilities.formatDate(fechaHoy, Session.getScriptTimeZone(), "yyyyMMdd");
  const cacheKey = idCarpetaRaiz + "_" + diaStr;

  if (!CACHE_ARCHIVOS_CARPETA[cacheKey]) {
    try {
      const raiz = DriveApp.getFolderById(idCarpetaRaiz);
      const carpetasDia = raiz.getFoldersByName(diaStr);

      if (!carpetasDia.hasNext()) {
        Logger.log(`❌ ERROR DRIVE: No existe carpeta del día "${diaStr}" en la raíz.`);
        CACHE_ARCHIVOS_CARPETA[cacheKey] = [];
        return false;
      }
      const carpetaDia = carpetasDia.next();

      const archivos = carpetaDia.getFiles();
      let listaNombresArchivos = [];
      while (archivos.hasNext()) {
        listaNombresArchivos.push(archivos.next().getName());
      }
      CACHE_ARCHIVOS_CARPETA[cacheKey] = listaNombresArchivos;
      Logger.log(`📂 Caché OK: ${diaStr} tiene ${listaNombresArchivos.length} archivos.`);

    } catch (e) {
      Logger.log(`🔥 EXCEPCIÓN DRIVE (ID Raíz: ${idCarpetaRaiz}): ${e.message}`);
      throw new Error("Error de acceso a Drive. Verifica permisos e ID.");
    }
  }

  const archivosEnCarpeta = CACHE_ARCHIVOS_CARPETA[cacheKey];
  return archivosEnCarpeta.some(nombreReal => nombreReal.includes(identificadorReporte));
}

/**
 * ======================================================================
 * LÓGICA DE NEGOCIO: FRECUENCIA
 * ======================================================================
 */
function debeLlegarHoy(frecuenciaRaw, fechaOrigen, fechaHoy) {
  const frecuencia = frecuenciaRaw.toString().toLowerCase().trim();

  if (frecuencia === "diario" || frecuencia === "diaria") return true;

  const diasSemana = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
  const hoyDiaSemana = diasSemana[fechaHoy.getDay()];

  if (diasSemana.includes(frecuencia) || frecuencia.includes(",")) {
    const diasFrecuencia = frecuencia.split(",").map(d => d.trim());
    if (diasFrecuencia.includes(hoyDiaSemana)) return true;
    // Día válido pero no es hoy → silencioso, no es un error
    return false;
  }

  if (!isNaN(frecuencia)) return fechaHoy.getDate() === parseInt(frecuencia);

  if (frecuencia === "semestral" || frecuencia === "trimestral" || frecuencia === "anual") {
    if (!fechaOrigen) {
      Logger.log(`⚠️ Frecuencia "${frecuenciaRaw}" requiere una Fecha Origen en la hoja (columna E). Verifica la fila.`);
      return false;
    }
    if (fechaHoy.getDate() !== fechaOrigen.getDate()) return false;
    let mesesDif = (fechaHoy.getFullYear() - fechaOrigen.getFullYear()) * 12;
    mesesDif -= fechaOrigen.getMonth();
    mesesDif += fechaHoy.getMonth();
    if (mesesDif <= 0) return false;
    if (frecuencia === "trimestral") return (mesesDif % 3 === 0);
    if (frecuencia === "semestral")  return (mesesDif % 6 === 0);
    if (frecuencia === "anual")      return (mesesDif % 12 === 0);
  }

  // Si llegamos acá es una frecuencia genuinamente desconocida (ej: typo "Diaro")
  Logger.log(`⚠️ Frecuencia desconocida: "${frecuenciaRaw}". Revisá el valor en la hoja (¿typo?).`);
  return false;
}

/**
 * ======================================================================
 * INTEGRACIÓN: SLACK
 * ======================================================================
 */
function enviarNotificacionSlack(reportesFaltantes, totalFaltantes, fechaHoy) {
  if (!SLACK_WEBHOOK_URL_YASC || SLACK_WEBHOOK_URL_YASC.includes("T00000000")) {
    Logger.log("⚠️ ALERTA: Webhook de Slack no configurado.");
    return;
  }

  const fechaStr = Utilities.formatDate(fechaHoy, Session.getScriptTimeZone(), "dd/MM/yyyy");
  let payload = {};

  if (totalFaltantes > 0) {
    const numClientesAfectados = Object.keys(reportesFaltantes).length;
    let mensajePrincipal = `El día de la fecha no recibimos *${totalFaltantes} reportes* de *${numClientesAfectados} clientes*.`;
    let detalles = "";
    for (const cliente in reportesFaltantes) {
      detalles += `• *${cliente}*:\n`;
      reportesFaltantes[cliente].forEach(reporte => { detalles += `   - ${reporte}\n`; });
    }
    payload = { "blocks": [
      { "type": "header",  "text": { "type": "plain_text", "text": "🚨 Alerta: Reportes no recibidos", "emoji": true } },
      { "type": "section", "text": { "type": "mrkdwn", "text": `*Fecha:* ${fechaStr}\n${mensajePrincipal}` } },
      { "type": "section", "text": { "type": "mrkdwn", "text": "🔗 *Links útiles:*\n• <https://docs.google.com/spreadsheets/d/1O-iTAhWRonBcAp3xN7t5_y_TZTvyAtoBP0TIVAIzweQ/edit?gid=577353825#gid=577353825| Registro de Reportes Faltantes>" } },
      { "type": "divider" },
      { "type": "section", "text": { "type": "mrkdwn", "text": detalles } }
    ]};
  } else {
    payload = { "blocks": [
      { "type": "section", "text": { "type": "mrkdwn", "text": `✅ *Reportes Completos - ${fechaStr}*\nConfirmado: Todos los reportes han llegado correctamente.` } }
    ]};
  }

  try {
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL_YASC, { "method": "post", "contentType": "application/json", "payload": JSON.stringify(payload) });
    Logger.log("✅ Notificación Slack enviada.");
  } catch (e) {
    Logger.log("❌ Error Slack: " + e.message);
  }
}

/**
 * Crea el activador diario para la función 'ejecutarAuditoriaDiaria'.
 */
function crearTriggerAuditoriaDiaria() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === "ejecutarAuditoriaDiaria") {
      ScriptApp.deleteTrigger(t);
      Logger.log("🗑️ Se eliminó un activador antiguo duplicado.");
    }
  });

  ScriptApp.newTrigger("ejecutarAuditoriaDiaria")
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  Logger.log("✅ Activador creado con éxito. Se ejecutará todos los días entre las 08:00 y las 09:00 hs.");
}