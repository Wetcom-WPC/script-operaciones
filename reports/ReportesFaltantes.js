/**
 * ======================================================================
 * CONFIGURACIÓN Y CONSTANTES GLOBALES
 * ======================================================================
 */
const SLACK_WEBHOOK_URL_YASC = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_YASC");
//LOGS:PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_YASC")
// POD-WPC: https://hooks.slack.com/services/REDACTED

const ID_HOJA_MAESTRA = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
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
 * Función para ejecutar la auditoría de forma segura (solo logs, sin enviar mensajes a Slack ni escribir en la hoja)
 */
function probarAuditoria() {
  Logger.log("=== INICIANDO AUDITORÍA EN MODO PRUEBA ===");
  ejecutarAuditoriaDiaria(true);
  Logger.log("=== FIN DE MODO PRUEBA ===");
}

/**
 * Función para probar la auditoría y enviar el mensaje resultante directamente al canal
 * de pruebas/mock de Slack (mock-tareas-programadas-log), SIN escribir en las planillas de logs de producción.
 */
function probarAuditoriaEnSlack() {
  Logger.log("=== INICIANDO AUDITORÍA CON ENVÍO A CANAL DE MOCK (Slack) ===");
  const props = PropertiesService.getScriptProperties();
  const webhookMock = props.getProperty("SLACK_WEBHOOK_GENERAL") 
                   || props.getProperty("SLACK_WEBHOOK_MOCK_TAREAS_PROGRAMADAS")
                   || props.getProperty("SLACK_WEBHOOK_YASC");

  if (!webhookMock) {
    Logger.log("❌ Error: No se encontró webhook para mock (SLACK_WEBHOOK_GENERAL).");
    return;
  }

  ejecutarAuditoriaDiaria(true, webhookMock);
  Logger.log("=== FIN DE AUDITORÍA CON ENVÍO A MOCK ===");
}

/**
 * ======================================================================
 * FUNCIÓN PRINCIPAL (TRIGGER DIARIO)
 * ======================================================================
 */
function ejecutarAuditoriaDiaria(modoPrueba = false, webhookPrueba = null) {
  // FRENO DE FERIADOS — Usa la función centralizada del repo
  if (!modoPrueba && esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado en el API de feriados.");
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
        const llego = verificarEnDrive(idCarpetaRaiz, idReporte, hoy, cliente);

        if (!llego) {
          if (!reportesFaltantes[cliente]) reportesFaltantes[cliente] = [];
          reportesFaltantes[cliente].push(idReporte);
          totalFaltantes++;
          Logger.log(`❌ FALTANTE: ${cliente} - ${idReporte}`);
          
          if (!modoPrueba) {
            // Usa la función centralizada del repo (OperationsLogger.gs)
            // que ya tiene el nombre correcto de pestaña: LOG_FALTANTES_TAB_NAME = "Logs Reportes Faltantes"
            logReporteFaltante(cliente, idReporte, hoy);
          }
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
  
  if (!modoPrueba) {
    enviarNotificacionSlack(reportesFaltantes, totalFaltantes, hoy);
  } else if (webhookPrueba) {
    Logger.log("MODO PRUEBA: Enviando notificación de prueba a canal de mock en Slack...");
    enviarNotificacionSlack(reportesFaltantes, totalFaltantes, hoy, webhookPrueba);
  } else {
    Logger.log("MODO PRUEBA: Se omitió el envío de mensajes a Slack.");
  }
}

/**
 * ======================================================================
 * LÓGICA DE NEGOCIO: VERIFICACIÓN EN DRIVE
 * ======================================================================
 */
/**
 * Normaliza una cadena para comparación flexible de nombres de reporte:
 * - Pasa a minúsculas y remueve tildes/acentos.
 * - Separa números pegados a letras (ej: "09-00DRP" -> "09-00 DRP").
 * - Convierte caracteres especiales o puntuación en espacios.
 * - Colapsa espacios redundantes.
 */
function normalizarTextoReporte(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/([0-9])([a-z])/gi, '$1 $2')
    .replace(/([a-z])([0-9])/gi, '$1 $2')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Valida si el archivo real en Drive coincide con el reporte esperado:
 * - Tolerante a guiones, espacios y horas agregadas adelante.
 * - Soporta palabras clave significativas y plurales/singulares.
 * - Protege reportes normales de hacer match accidental con DRP.
 */
function coincideNombreReporte(nombreArchivoReal, identificadorEsperado) {
  const normReal = normalizarTextoReporte(nombreArchivoReal);
  const normEsperado = normalizarTextoReporte(identificadorEsperado);

  if (!normReal || !normEsperado) return false;

  // Si el esperado no es DRP pero el archivo real sí es DRP, no cruzar
  if (!normEsperado.includes('drp') && normReal.includes('drp')) return false;

  // 1. Match directo como subcadena normalizada
  if (normReal.includes(normEsperado)) return true;

  // 2. Match por palabras clave significativas (ignora conectores como "de", "en", "el")
  const conectores = new Set(['de', 'en', 'el', 'la', 'los', 'las', 'del', 'con', 'y', 'por', 'para', 'un', 'una']);
  const palabras = normEsperado.split(' ').filter(function (p) {
    return p.length > 1 && !conectores.has(p);
  });

  if (palabras.length === 0) return false;

  return palabras.every(function (palabra) {
    if (normReal.includes(palabra)) return true;
    if (palabra.endsWith('s') && palabra.length > 4 && normReal.includes(palabra.slice(0, -1))) return true;
    return false;
  });
}

function verificarEnDrive(idCarpetaRaiz, identificadorReporte, fechaHoy, cliente) {
  const diaStr  = Utilities.formatDate(fechaHoy, Session.getScriptTimeZone(), "yyyyMMdd");
  const cacheKey = idCarpetaRaiz + "_" + diaStr + "_" + cliente;

  if (!CACHE_ARCHIVOS_CARPETA[cacheKey]) {
    try {
      let raiz = DriveApp.getFolderById(idCarpetaRaiz);
      
      // 1. Buscar carpeta del día directamente en la raíz
      let carpetasDia = raiz.getFoldersByName(diaStr);

      // 2. Si no está en raíz, buscar por carpeta del cliente (o alias)
      if (!carpetasDia.hasNext()) {
        let carpetasCliente = raiz.getFoldersByName(cliente);

        // Probar quitando "Operaciones " (ej: "Dorinka", "Petersen Corp")
        if (!carpetasCliente.hasNext() && cliente.startsWith("Operaciones ")) {
          carpetasCliente = raiz.getFoldersByName(cliente.replace(/^Operaciones\s+/i, '').trim());
        }

        // Probar con alias frecuentes (Walmart / GDN para Dorinka, Sodimac para Falabella, etc.)
        if (!carpetasCliente.hasNext()) {
          const alias = {
            "Operaciones Dorinka": ["Dorinka", "Walmart", "GDN Argentina", "GDN"],
            "Operaciones Compañia Bernal": ["Bernal", "Compañia Bernal", "Ciaber"],
            "Operaciones Falabella": ["Falabella", "Sodimac"]
          };
          const listaAlias = alias[cliente] || [];
          for (let a = 0; a < listaAlias.length; a++) {
            carpetasCliente = raiz.getFoldersByName(listaAlias[a]);
            if (carpetasCliente.hasNext()) break;
          }
        }

        if (carpetasCliente.hasNext()) {
          raiz = carpetasCliente.next();
          carpetasDia = raiz.getFoldersByName(diaStr);
        }
      }

      if (!carpetasDia.hasNext()) {
        const subcarpetas = [];
        try {
          const iter = raiz.getFolders();
          while (iter.hasNext() && subcarpetas.length < 15) {
            subcarpetas.push(iter.next().getName());
          }
        } catch (eSub) {}
        Logger.log(`❌ ERROR DRIVE: No existe carpeta del día "${diaStr}" para el cliente "${cliente}". Carpetas encontradas en "${raiz.getName()}": [${subcarpetas.join(', ')}]`);
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
      Logger.log(`✅ Caché OK: ${cliente}/${diaStr} tiene ${listaNombresArchivos.length} archivos.`);

    } catch (e) {
      Logger.log(`⚠️ EXCEPCIÓN DRIVE (ID Raíz: ${idCarpetaRaiz}, Cliente: ${cliente}): ${e.message}`);
      throw new Error("Error de acceso a Drive. Verifica permisos e ID.");
    }
  }

  const archivosEnCarpeta = CACHE_ARCHIVOS_CARPETA[cacheKey];
  const encontrado = archivosEnCarpeta.some(function (nombreReal) {
    return coincideNombreReporte(nombreReal, identificadorReporte);
  });

  if (!encontrado && archivosEnCarpeta.length > 0) {
    const normId = normalizarTextoReporte(identificadorReporte);
    const palabras = normId.split(' ').filter(function (p) {
      return p.length > 2 && !['drp', 'para', 'con', 'del', 'las', 'los', 'por'].includes(p);
    });
    const parecidos = archivosEnCarpeta.filter(function (nombre) {
      const normN = normalizarTextoReporte(nombre);
      return palabras.some(function (p) { return normN.includes(p); });
    });
    if (parecidos.length > 0) {
      Logger.log(`   🔍 [Diagnóstico] Archivos similares en la carpeta: [${parecidos.slice(0, 5).join(', ')}]`);
    }
  }

  return encontrado;
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
function enviarNotificacionSlack(reportesFaltantes, totalFaltantes, fechaHoy, webhookOverride = null) {
  const urlWebhook = webhookOverride || SLACK_WEBHOOK_URL_YASC;
  if (!urlWebhook || urlWebhook.includes("T00000000")) {
    Logger.log("⚠️ ALERTA: Webhook de Slack no configurado.");
    return;
  }

  const MAX_CHARS_SECCION = 2900; // Slack rechaza secciones de más de 3000; dejamos margen.
  const MAX_BLOCKS        = 50;   // Límite duro de blocks por mensaje.

  const fechaStr = Utilities.formatDate(fechaHoy, Session.getScriptTimeZone(), "dd/MM/yyyy");
  const linkRegistro = "https://docs.google.com/spreadsheets/d/"
    + PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID")
    + "/edit?gid=577353825#gid=577353825";

  let blocks;

  if (totalFaltantes > 0) {
    const numClientesAfectados = Object.keys(reportesFaltantes).length;
    const mensajePrincipal = `El día de la fecha no recibimos *${totalFaltantes} reportes* de *${numClientesAfectados} clientes*.`;

    const lineas = [];
    for (const cliente in reportesFaltantes) {
      lineas.push(`• *${cliente}*:\n`);
      reportesFaltantes[cliente].forEach(reporte => { lineas.push(`   - ${reporte}\n`); });
    }

    blocks = [
      { "type": "header",  "text": { "type": "plain_text", "text": "🚨 Alerta: Reportes no recibidos", "emoji": true } },
      { "type": "section", "text": { "type": "mrkdwn", "text": `*Fecha:* ${fechaStr}\n${mensajePrincipal}` } },
      { "type": "section", "text": { "type": "mrkdwn", "text": `🔗 *Links útiles:*\n  <${linkRegistro}| Registro de Reportes Faltantes>` } },
      { "type": "divider" }
    ];

    if (webhookOverride) {
      blocks.unshift({
        "type": "context",
        "elements": [{ "type": "mrkdwn", "text": "🧪 *[PRUEBA / MOCK]* Mensaje de prueba enviado a canal de testing" }]
      });
    }

    // El detalle va en varias secciones: mandarlo en una sola supera los 3000
    // caracteres que admite Slack y la API responde 400 invalid_blocks.
    const trozos = _dividirEnBloquesDeTexto(lineas, MAX_CHARS_SECCION);
    const espacioDisponible = MAX_BLOCKS - blocks.length - 1; // -1 reservado para el aviso de truncado

    trozos.slice(0, espacioDisponible).forEach(trozo => {
      blocks.push({ "type": "section", "text": { "type": "mrkdwn", "text": trozo } });
    });

    if (trozos.length > espacioDisponible) {
      blocks.push({ "type": "section", "text": { "type": "mrkdwn", "text": `_Detalle truncado por los límites de Slack. Lista completa en <${linkRegistro}|el registro>._` } });
    }
  } else {
    blocks = [
      { "type": "section", "text": { "type": "mrkdwn", "text": `✅ *Reportes Completos - ${fechaStr}*\nConfirmado: Todos los reportes han llegado correctamente.` } }
    ];
    if (webhookOverride) {
      blocks.unshift({
        "type": "context",
        "elements": [{ "type": "mrkdwn", "text": "🧪 *[PRUEBA / MOCK]* Mensaje de prueba enviado a canal de testing" }]
      });
    }
  }

  // sendSlackMessage ya trae reintentos y muteHttpExceptions, y loguea el cuerpo
  // real de la respuesta de Slack (con UrlFetchApp directo llegaba truncada).
  if (sendSlackMessage(urlWebhook, { "blocks": blocks })) {
    Logger.log("✅ Notificación Slack enviada con éxito.");
  } else {
    Logger.log("❌ Error Slack: no se pudo enviar la notificación de reportes faltantes.");
  }
}

/**
 * Reparte una lista de líneas en trozos de texto que no superen `maxChars`,
 * sin cortar una línea al medio salvo que la línea sola ya exceda el máximo.
 * @param {string[]} lineas Líneas ya terminadas en salto de línea.
 * @param {number} maxChars Tamaño máximo de cada trozo.
 * @returns {string[]} Trozos listos para usar como texto de un block de Slack.
 */
function _dividirEnBloquesDeTexto(lineas, maxChars) {
  const trozos = [];
  let actual = "";

  lineas.forEach(linea => {
    if (linea.length > maxChars) {
      if (actual) { trozos.push(actual); actual = ""; }
      for (let i = 0; i < linea.length; i += maxChars) {
        trozos.push(linea.substring(i, i + maxChars));
      }
      return;
    }
    if (actual.length + linea.length > maxChars) {
      trozos.push(actual);
      actual = "";
    }
    actual += linea;
  });

  if (actual) trozos.push(actual);
  return trozos;
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


