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

var AVISO_WEBHOOKS = {
  "POD1":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AVISOS_POD_1"),
  "POD2":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AVISOS_POD_2"),
  "POD3":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AVISOS_POD_3"),
  "POD4":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AVISOS_POD_4"),
  "POD5":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AVISOS_POD_5"),
  "DEFAULT": PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL")
};

// ─── FUNCIÓN PRINCIPAL ───────────────────────────────────────────────────────

function verificarReporte() {

  // FRENO FIN DE SEMANA
  var diaSemana = new Date().getDay();
  if (diaSemana === 0 || diaSemana === 6) {
    Logger.log("EJECUCIÓN OMITIDA: Fin de semana.");
    return;
  }

  // FRENO DE FERIADOS
  if (esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado en el calendario de Alarmas Wetcom.");
    return;
  }

  var maxReintentos = 3;
  var intentoActual = 0;
  var exito = false;

  while (intentoActual < maxReintentos && !exito) {
    try {

      // 1. Abrir hoja de Configuracion Reportes
      var spreadsheet = SpreadsheetApp.openById(AVISO_CONFIG_SHEET_ID);
      var sheet = spreadsheet.getSheetByName(AVISO_CONFIG_TAB_NAME);
      if (!sheet) {
        Logger.log("Error: No se encontró la pestaña '" + AVISO_CONFIG_TAB_NAME + "'.");
        return;
      }

      var data        = sheet.getDataRange().getValues();
      var baseFolder  = DriveApp.getFolderById(AVISO_BASE_FOLDER_ID);
      var fechaHoy    = new Date();
      var fechaCarpeta = Utilities.formatDate(fechaHoy, Session.getScriptTimeZone(), "yyyyMMdd");
      var diaSemanaStr = obtenerNombreDia(fechaHoy);
      var semanaMes   = obtenerSemanaDelMes(fechaHoy);
      var diaDelMes   = fechaHoy.getDate();

      var mensajesPorPod     = {};
      var reportesPorCliente = {};

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

        if (!reportesPorCliente[clienteNombre]) {
          reportesPorCliente[clienteNombre] = {
            pod: pod,
            encontrados: [],
            noEncontrados: [],
            urlCarpeta: null
          };
        }

        var clienteFolder = obtenerSubCarpeta(baseFolder, clienteNombre);
        if (!clienteFolder) {
          agregarMensaje(mensajesPorPod, pod, ":warning: *" + clienteNombre + "*: No se encontró la carpeta en Drive.");
          continue;
        }

        var fechaFolder = obtenerSubCarpeta(clienteFolder, fechaCarpeta);
        if (!fechaFolder) {
          agregarMensaje(mensajesPorPod, pod, ":warning: *" + clienteNombre + "*: No se encontró la carpeta " + fechaCarpeta + ".");
          continue;
        }

        var resultado = verificarArchivoPorPalabraClave(fechaFolder, palabraClaveArchivo);
        reportesPorCliente[clienteNombre].urlCarpeta = fechaFolder.getUrl();

        if (resultado.encontrado) {
          reportesPorCliente[clienteNombre].encontrados.push(palabraClaveArchivo);
        } else {
          reportesPorCliente[clienteNombre].noEncontrados.push(palabraClaveArchivo);
        }
      }

      // 3. Construcción y envío de mensajes
      for (var cliente in reportesPorCliente) {
        var datos = reportesPorCliente[cliente];
        var pod   = datos.pod;
        var url   = datos.urlCarpeta || "";

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

      for (var pod in mensajesPorPod) {
        if (mensajesPorPod[pod].length > 0) {
          var webhookUrl = AVISO_WEBHOOKS[pod] || AVISO_WEBHOOKS["DEFAULT"];
          _enviarMensajeSlackPod(mensajesPorPod[pod].join("\n"), webhookUrl);
        }
      }

      exito = true;

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
    UrlFetchApp.fetch(webhookUrl, options);
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

