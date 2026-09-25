/**
 * @fileoverview Verificación de reportes diarios en Drive y notificación por Slack.
 *
 * CONFIGURACIÓN:
 *   - La hoja "Configuracion Reportes" vive dentro del Índice General.
 *   - Columnas: Cliente | Activo | Frecuencia | Dias Permitidos | Nombre Reporte | POD
 *   - El nombre del cliente debe coincidir exactamente con el nombre de la carpeta en Drive.
 *   - Para agregar un cliente nuevo, hacerlo manualmente en "Configuracion Reportes".
*/

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────

var AVISO_BASE_FOLDER_ID  = PropertiesService.getScriptProperties().getProperty("DRIVE_AVISO_BASE_FOLDER_ID"); // DRIVE WPC
var AVISO_CONFIG_SHEET_ID = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID"); // Índice General
var AVISO_CONFIG_TAB_NAME = "Configuracion Reportes";

function getAvisoWebhooks() {
  const props = PropertiesService.getScriptProperties();
  return {
    "POD1":    props.getProperty("SLACK_WEBHOOK_AVISOS_POD_1"),
    "POD2":    props.getProperty("SLACK_WEBHOOK_AVISOS_POD_2"),
    "POD3":    props.getProperty("SLACK_WEBHOOK_AVISOS_POD_3"),
    "POD4":    props.getProperty("SLACK_WEBHOOK_AVISOS_POD_4"),
    "POD5":    props.getProperty("SLACK_WEBHOOK_AVISOS_POD_5"),
    "DEFAULT": props.getProperty("SLACK_WEBHOOK_GENERAL")
  };
}

// ─── FUNCIÓN PRINCIPAL ───────────────────────────────────────────────────────

/**
 * Calcula, para cada cliente activo de "Configuracion Reportes", qué reportes llegaron hoy
 * a Drive y cuáles no. NO manda nada a Slack: solo devuelve el estado.
 *
 * Se separó de verificarReporte() para que el dashboard muestre EXACTAMENTE el mismo estado
 * que se avisa por Slack, sin reimplementar el chequeo de Drive. Si esta lógica viviera en
 * dos lados, el día que alguien arregle uno los dos empezarían a decir cosas distintas sobre
 * el mismo cliente y no habría forma de saber a cuál creerle — es el patrón del §5 de
 * AGENTS.md, que en este proyecto ya rompió cosas dos veces.
 *
 * Los frenos de fin de semana y feriado NO están acá a propósito: son del AVISO (no tiene
 * sentido spamear un sábado), no del estado. Si alguien abre el dashboard un sábado, tiene
 * que poder ver qué llegó y qué no.
 *
 * @param {Date} [fecha] Día a evaluar. Por defecto, hoy.
 * @returns {{fecha: string, calculadoA: string, clientes: Object}} Estado por cliente.
 */
function calcularEstadoReportesPorPod(fecha) {
  var fechaHoy     = fecha instanceof Date ? fecha : new Date();
  var tz           = Session.getScriptTimeZone();
  var fechaCarpeta = Utilities.formatDate(fechaHoy, tz, "yyyyMMdd");
  var diaSemanaStr = obtenerNombreDia(fechaHoy);
  var semanaMes    = obtenerSemanaDelMes(fechaHoy);
  var diaDelMes    = fechaHoy.getDate();

  var maxReintentos = 3;
  var intentoActual = 0;

  while (true) {
    try {
      // 1. Abrir hoja de Configuracion Reportes
      var spreadsheet = SpreadsheetApp.openById(AVISO_CONFIG_SHEET_ID);
      var sheet = spreadsheet.getSheetByName(AVISO_CONFIG_TAB_NAME);
      if (!sheet) {
        throw new Error("No se encontró la pestaña '" + AVISO_CONFIG_TAB_NAME + "'.");
      }

      var data       = sheet.getDataRange().getValues();
      var baseFolder = DriveApp.getFolderById(AVISO_BASE_FOLDER_ID);
      var clientes   = {};

      // 2. Procesar cada cliente de la hoja
      for (var i = 1; i < data.length; i++) {
        var clienteNombre       = data[i][0];
        var activo              = data[i][1] === true;
        var frecuencia          = data[i][2] ? data[i][2].toLowerCase() : "";
        var diasPermitidos      = data[i][3] ? String(data[i][3]).split(",").map(function(d) { return d.trim(); }) : [];
        var palabraClaveArchivo = data[i][4];
        var pod                 = data[i][5] ? data[i][5].toString().trim() : "DEFAULT";

        if (!clienteNombre || !activo || !frecuencia) continue;

        if (!verificarFrecuencia(fechaHoy, frecuencia, diasPermitidos, diaSemanaStr, semanaMes, diaDelMes)) {
          continue;
        }

        if (!clientes[clienteNombre]) {
          clientes[clienteNombre] = {
            pod: pod,
            encontrados: [],
            noEncontrados: [],
            urlCarpeta: null,
            errores: []
          };
        }

        var clienteFolder = obtenerSubCarpeta(baseFolder, clienteNombre);
        if (!clienteFolder) {
          clientes[clienteNombre].errores.push("No se encontró la carpeta en Drive.");
          continue;
        }

        var fechaFolder = obtenerSubCarpeta(clienteFolder, fechaCarpeta);
        if (!fechaFolder) {
          clientes[clienteNombre].errores.push("No se encontró la carpeta " + fechaCarpeta + ".");
          continue;
        }

        var resultado = verificarArchivoPorPalabraClave(fechaFolder, palabraClaveArchivo);
        clientes[clienteNombre].urlCarpeta = fechaFolder.getUrl();

        if (resultado.encontrado) {
          clientes[clienteNombre].encontrados.push(palabraClaveArchivo);
        } else {
          clientes[clienteNombre].noEncontrados.push(palabraClaveArchivo);
        }
      }

      return {
        fecha: fechaCarpeta,
        calculadoA: Utilities.formatDate(new Date(), tz, "HH:mm"),
        clientes: clientes
      };

    } catch (error) {
      intentoActual++;
      console.warn("Error en el intento " + intentoActual + ": " + error.message);
      if (intentoActual >= maxReintentos) {
        console.error("Fallo definitivo después de " + maxReintentos + " intentos.");
        throw error;
      }
      if (error.message.includes("Service error: Drive") || error.message.includes("Drive")) {
        Utilities.sleep(2000 * intentoActual);
      } else {
        throw error;
      }
    }
  }
}

/**
 * Avisa por Slack, a cada canal de POD, qué reportes llegaron hoy y cuáles no.
 *
 * El cálculo vive en calcularEstadoReportesPorPod(); acá solo se arma el texto y se manda.
 * Los mensajes salen idénticos a como salían antes del refactor.
 */
function verificarReporte() {

  // FRENO FIN DE SEMANA
  var diaSemana = new Date().getDay();
  if (diaSemana === 0 || diaSemana === 6) {
    Logger.log("EJECUCIÓN OMITIDA: Fin de semana.");
    return;
  }

  // FRENO DE FERIADOS
  if (esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado en el API de feriados.");
    return;
  }

  var estado         = calcularEstadoReportesPorPod(new Date());
  var mensajesPorPod = {};

  for (var cliente in estado.clientes) {
    var datos = estado.clientes[cliente];
    var pod   = datos.pod;
    var url   = datos.urlCarpeta || "";

    datos.errores.forEach(function (motivo) {
      agregarMensaje(mensajesPorPod, pod, ":warning: *" + cliente + "*: " + motivo);
    });

    if (datos.encontrados.length > 0) {
      agregarMensaje(mensajesPorPod, pod,
        ":white_check_mark: *" + cliente + "*: Los reportes *" + datos.encontrados.join(", ") +
        "* fueron recibidos correctamente. :open_file_folder: <" + url + "|Carpeta>");
    }
    if (datos.noEncontrados.length > 0) {
      agregarMensaje(mensajesPorPod, pod,
        ":warning: *" + cliente + "*: Los reportes *" + datos.noEncontrados.join(", ") +
        "* NO han llegado." + (url ? " :open_file_folder: <" + url + "|Carpeta>" : "")
      );
    }
  }

  for (var podDestino in mensajesPorPod) {
    if (mensajesPorPod[podDestino].length > 0) {
      var webhooksMap = getAvisoWebhooks();
      var webhookUrl = webhooksMap[podDestino] || webhooksMap["DEFAULT"];
      _enviarMensajeSlackPod(mensajesPorPod[podDestino].join("\n"), webhookUrl);
    }
  }
}

// ─── FUNCIONES AUXILIARES ────────────────────────────────────────────────────

function agregarMensaje(mensajesPorPod, pod, mensaje) {
  if (!mensajesPorPod[pod]) mensajesPorPod[pod] = [];
  mensajesPorPod[pod].push(mensaje);
}

function verificarArchivoPorPalabraClave(folder, palabraClave) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (file.getName().includes(palabraClave)) {
      return { encontrado: true, url: file.getUrl() };
    }
  }
  return { encontrado: false, url: "" };
}

function _enviarMensajeSlackPod(mensaje, webhookUrl) {
  var payload = JSON.stringify({ text: mensaje });
  var options = { method: "post", contentType: "application/json", payload: payload };
  try {
    fetchWithRetries(webhookUrl, options);
  } catch (e) {
    Logger.log("Error al enviar mensaje a Slack: " + e);
  }
}

function obtenerNombreDia(fecha) {
  var dias = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
  return dias[fecha.getDay()];
}

function obtenerSemanaDelMes(fecha) {
  return Math.ceil(fecha.getDate() / 7);
}

function obtenerSubCarpeta(baseFolder, subFolderName) {
  var folders = baseFolder.getFoldersByName(subFolderName);
  return folders.hasNext() ? folders.next() : null;
}

function verificarFrecuencia(fecha, frecuencia, diasPermitidos, diaSemana, semanaMes, diaDelMes) {
  if (frecuencia === "diario") return true;
  if (frecuencia === "semanal" && diasPermitidos.includes(diaSemana)) return true;
  if (frecuencia === "mensual" && esUltimaSemanaDelMes(fecha) && diasPermitidos.includes(diaSemana)) return true;
  if (frecuencia === "mensual dia fijo" && diasPermitidos.includes(diaDelMes.toString())) return true;
  return false;
}

function esUltimaSemanaDelMes(fecha) {
  var diasEnMes = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0).getDate();
  return (diasEnMes - fecha.getDate()) < 7;
}

function crearTriggerVerificarReporte() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "verificarReporte") {
      ScriptApp.deleteTrigger(t);
      Logger.log("🗑️ Trigger antiguo eliminado.");
    }
  });
  ScriptApp.newTrigger("verificarReporte")
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();
  Logger.log("✅ Trigger diario creado para verificarReporte a las 8am.");
}

