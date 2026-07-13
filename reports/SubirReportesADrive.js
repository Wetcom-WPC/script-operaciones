/**
 * ==========================================================
 * LÓGICA PRINCIPAL DEL SCRIPT
 * ==========================================================
 */

function organizarReportesEnDrive() {
  var idCarpetaPrincipal = "1RZOjoQdpcT1IB2qiJSvTvZH-R3set9Bq";
  var idHojaCalculo = "1ZriSQeckRp_hWXS0X-CdGzrnnplCj2KmcLHgAbXo6qU";
  var horasAtras = 2; 

  guardarYConvertirAdjuntosEnDrive(idCarpetaPrincipal, idHojaCalculo, horasAtras);
}

function guardarYConvertirAdjuntosEnDrive(idCarpetaPrincipal, idHojaCalculo, horasAtras) {
  Logger.log("--- INICIANDO PROCESO (Modo: ID invisible) ---");
  
  var scriptProperties = PropertiesService.getScriptProperties();
  var spreadsheet = SpreadsheetApp.openById(idHojaCalculo);

  // ─── CLIENTES NORMALES (Sheet1) ───────────────────────────────────────────
  var hojaClientes = spreadsheet.getSheetByName("Sheet1");
  if (!hojaClientes) { Logger.log("ERROR: No se encontró 'Sheet1'."); return; }

  var listaClientesRaw = hojaClientes.getRange("A2:C" + hojaClientes.getLastRow()).getValues();
  var clientes = {};
  listaClientesRaw.forEach(function(fila) {
    var remitente    = fila[0];
    var nombreCliente = fila[1];
    var projectKey   = fila[3];
    if (nombreCliente) {
      if (!clientes[nombreCliente]) {
        clientes[nombreCliente] = { nombre: nombreCliente, remitentes: [], projectKey: projectKey, carpetaId: null };
      }
      if (remitente && clientes[nombreCliente].remitentes.indexOf(remitente) === -1) {
        clientes[nombreCliente].remitentes.push(remitente);
      }
    }
  });

  // ─── CLIENTES ADJUNTOS (pestaña "Adjuntos") — sin tickets Jira ───────────
  // Columnas: A=Remitente | B=Nombre del Cliente | ... | N=ID Carpeta Reportes
  var hojaAdjuntos = spreadsheet.getSheetByName("Adjuntos");
  var clientesAdjuntos = {};
  if (hojaAdjuntos) {
    var listaAdjuntosRaw = hojaAdjuntos.getRange("A2:N" + hojaAdjuntos.getLastRow()).getValues();
    listaAdjuntosRaw.forEach(function(fila) {
      var remitente        = fila[0];
      var nombreCliente    = fila[1];
      var idCarpetaReportes = fila[13]; // Col N
      if (nombreCliente && remitente && idCarpetaReportes) {
        if (!clientesAdjuntos[nombreCliente]) {
          clientesAdjuntos[nombreCliente] = {
            nombre: nombreCliente,
            remitentes: [],
            projectKey: null,       // Sin tickets Jira
            carpetaId: idCarpetaReportes.toString().trim()
          };
        }
        if (clientesAdjuntos[nombreCliente].remitentes.indexOf(remitente) === -1) {
          clientesAdjuntos[nombreCliente].remitentes.push(remitente);
        }
      }
    });
    Logger.log("Clientes Adjuntos cargados: " + Object.keys(clientesAdjuntos).join(", "));
  } else {
    Logger.log("AVISO: No se encontró la pestaña 'Adjuntos'. Se continúa solo con Sheet1.");
  }

  var carpetaPrincipal = DriveApp.getFolderById(idCarpetaPrincipal);

  const REPORTES_QUE_CIERRAN_TAREAS_BASE = [
    "VMs protegidas",
    "Replicas protegidas",
    "Capacity Planning",
    "VM Daily Protection Status",
    "Hosts y VMs con contencion de CPU",
    "Inventario de VMs",
  ];
  const REPORTES_QUE_CIERRAN_TAREAS_LOWER = REPORTES_QUE_CIERRAN_TAREAS_BASE.map(function(n) { return n.toLowerCase(); });

  // ─── PROCESAR CLIENTES NORMALES (Sheet1) ─────────────────────────────────
  for (var nombreCliente in clientes) {
    var carpetaClienteDefault = obtenerOCrearCarpeta(carpetaPrincipal, nombreCliente);
    var clienteInfo = clientes[nombreCliente];

    clienteInfo.remitentes.forEach(function(remitente) {
      var query = "from:" + remitente + " newer_than:" + horasAtras + "h";
      var hilos = GmailApp.search(query);

      hilos.forEach(function(hilo) {
        hilo.getMessages().forEach(function(mensaje) {
          var mensajeId = mensaje.getId();
          var keyPropiedad = "PROCESADO_" + mensajeId;
          if (scriptProperties.getProperty(keyPropiedad)) return;

          var fechaMensaje = mensaje.getDate();
          var nombreCarpetaFecha = formatearFechaParaNombre(fechaMensaje);
          var adjuntos = mensaje.getAttachments();

          if (adjuntos.length > 0) {
            Logger.log("Procesando mensaje NUEVO ID: " + mensajeId + " de: " + remitente);

            adjuntos.forEach(function(adjunto) {
              var nombreArchivo = adjunto.getName();
              var nombreArchivoLower = nombreArchivo.toLowerCase();
              var carpetaDestinoFinal = carpetaClienteDefault;

              // --- LÓGICA JIRA ---
              if (clienteInfo.projectKey) {
                for (var i = 0; i < REPORTES_QUE_CIERRAN_TAREAS_LOWER.length; i++) {
                  if (nombreArchivoLower.includes(REPORTES_QUE_CIERRAN_TAREAS_LOWER[i])) {
                    Logger.log("Archivo '" + nombreArchivo + "' detectado para cierre de tarea.");
                    var tareaKey = findExistingJiraTicket(REPORTES_QUE_CIERRAN_TAREAS_BASE[i], clienteInfo.projectKey, "Tarea Programada");
                    if (tareaKey) resolveJiraTicket(tareaKey, JIRA_STATUS_TO_CLOSE);
                    break;
                  }
                }
              }

              // --- LÓGICA DRP ---
              if (nombreArchivoLower.includes('drp')) {
                for (var nombreClienteLista in clientes) {
                  if (nombreArchivoLower.includes(nombreClienteLista.toLowerCase())) {
                    carpetaDestinoFinal = obtenerOCrearCarpeta(carpetaPrincipal, clientes[nombreClienteLista].nombre);
                    break;
                  }
                }
              }

              // --- GUARDADO ---
              var carpetaFecha = obtenerOCrearCarpeta(carpetaDestinoFinal, nombreCarpetaFecha);
              convertirYGuardar(adjunto, carpetaFecha);
            });

            scriptProperties.setProperty(keyPropiedad, "true");
            Logger.log("Mensaje registrado como procesado en memoria interna.");
          }
        });
      });
    });
  }

  // ─── PROCESAR CLIENTES ADJUNTOS (pestaña "Adjuntos") ─────────────────────
  // Sin tickets Jira. Guardan en su carpeta específica (col N del Índice General).
  for (var nombreClienteAdj in clientesAdjuntos) {
    var clienteInfoAdj = clientesAdjuntos[nombreClienteAdj];
    var carpetaClienteAdj = DriveApp.getFolderById(clienteInfoAdj.carpetaId);

    clienteInfoAdj.remitentes.forEach(function(remitente) {
      var query = "from:" + remitente + " newer_than:" + horasAtras + "h";
      var hilos = GmailApp.search(query);

      hilos.forEach(function(hilo) {
        hilo.getMessages().forEach(function(mensaje) {
          var mensajeId = mensaje.getId();
          var keyPropiedad = "PROCESADO_" + mensajeId;
          if (scriptProperties.getProperty(keyPropiedad)) return;

          var fechaMensaje = mensaje.getDate();
          var nombreCarpetaFecha = formatearFechaParaNombre(fechaMensaje);
          var adjuntos = mensaje.getAttachments();

          if (adjuntos.length > 0) {
            Logger.log("[ADJUNTOS] Procesando mensaje NUEVO ID: " + mensajeId + " de: " + remitente + " (" + nombreClienteAdj + ")");

            adjuntos.forEach(function(adjunto) {
              var carpetaFecha = obtenerOCrearCarpeta(carpetaClienteAdj, nombreCarpetaFecha);
              convertirYGuardar(adjunto, carpetaFecha);
            });

            scriptProperties.setProperty(keyPropiedad, "true");
            Logger.log("[ADJUNTOS] Mensaje registrado como procesado.");
          }
        });
      });
    });
  }

  Logger.log("--- PROCESO FINALIZADO ---");
}

/**
 * ==========================================================
 * FUNCIONES AUXILIARES
 * ==========================================================
 */

function convertirYGuardar(adjunto, carpetaDestino) {
  var nombreArchivo = adjunto.getName();
  var extension = nombreArchivo.split('.').pop().toLowerCase();

  try {
    var nuevoNombre;
    if (extension === 'csv') {
      nuevoNombre = nombreArchivo.replace(/\.csv$/i, ".xlsx");
      Logger.log("Convirtiendo CSV: " + nombreArchivo);
      var csvData = adjunto.getDataAsString("UTF-8");
      if (csvData.charCodeAt(0) === 0xFEFF) { csvData = csvData.substring(1); }
      var tempSheet = SpreadsheetApp.create("temp_csv_" + Date.now());
      var sheet = tempSheet.getSheets()[0];
      var data = Utilities.parseCsv(csvData);
      if (data.length > 0 && data[0].length > 0) {
        sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
        var numColumnas = data[0].length;
        sheet.getRange(1, 1, 1, numColumnas).setBackground("#008000").setFontColor("#FFFFFF").setFontWeight("bold");
        sheet.autoResizeColumns(1, numColumnas);
        SpreadsheetApp.flush();
        guardarComoXlsxYBorrarTemp(tempSheet.getId(), carpetaDestino, nuevoNombre);
      } else {
        Logger.log("CSV '" + nombreArchivo + "' está vacío. Omitiendo.");
        DriveApp.getFileById(tempSheet.getId()).setTrashed(true);
      }

    } else if (extension === 'json') {
      nuevoNombre = nombreArchivo.replace(/\.json$/i, ".xlsx");
      var jsonString = adjunto.getDataAsString("UTF-8");
      var jsonData = JSON.parse(jsonString);
      var datosDeTabla = null;
      for (var key in jsonData) {
        if (Array.isArray(jsonData[key])) { datosDeTabla = jsonData[key]; break; }
      }
      if (datosDeTabla && datosDeTabla.length > 0 && typeof datosDeTabla[0] === 'object' && Object.keys(datosDeTabla[0]).length > 0) {
        var headers = Object.keys(datosDeTabla[0]);
        var data = [headers];
        datosDeTabla.forEach(function(row) { data.push(headers.map(function(h) { return row[h]; })); });
        var tempSpreadsheet = SpreadsheetApp.create("temp_json_table_" + Date.now());
        var sheet = tempSpreadsheet.getSheets()[0];
        sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
        sheet.getRange(1, 1, 1, headers.length).setBackground("#008000").setFontColor("#FFFFFF").setFontWeight("bold");
        sheet.autoResizeColumns(1, headers.length);
        SpreadsheetApp.flush();
        guardarComoXlsxYBorrarTemp(tempSpreadsheet.getId(), carpetaDestino, nuevoNombre);
      } else {
        var mensaje = jsonData.Message || "Reporte sin datos tabulares o con tabla vacía.";
        var tempSpreadsheet = SpreadsheetApp.create("temp_json_message_" + Date.now());
        var sheet = tempSpreadsheet.getSheets()[0];
        sheet.getRange("A1").setValue(mensaje).setBackground("#E2F0D9").setFontWeight("bold").setWrap(true);
        sheet.autoResizeColumn(1);
        SpreadsheetApp.flush();
        guardarComoXlsxYBorrarTemp(tempSpreadsheet.getId(), carpetaDestino, nuevoNombre);
      }

    } else {
      crearArchivoSiNoExiste(carpetaDestino, nombreArchivo, adjunto.copyBlob());
    }
  } catch (e) {
    Logger.log("ERROR al procesar el archivo '" + nombreArchivo + "': " + e.toString());
  }
}

function crearArchivoSiNoExiste(carpetaDestino, nombreArchivo, contenido, mimeType) {
  var nombreFinal = nombreArchivo;
  var contador = 1;
  var partes = nombreArchivo.split('.');
  var ext = partes.length > 1 ? "." + partes.pop() : "";
  var base = partes.join('.');
  while (carpetaDestino.getFilesByName(nombreFinal).hasNext()) {
    nombreFinal = base + " (" + contador + ")" + ext;
    contador++;
  }
  if (nombreFinal !== nombreArchivo) Logger.log("Renombrando a: '" + nombreFinal + "'");
  var archivoCreado;
  if (mimeType) {
    archivoCreado = carpetaDestino.createFile(nombreFinal, contenido, mimeType);
  } else {
    archivoCreado = carpetaDestino.createFile(contenido);
    if (archivoCreado.getName() !== nombreFinal) {
      try { archivoCreado.setName(nombreFinal); } catch (e) { Logger.log("Error al renombrar: " + e.message); }
    }
  }
  Logger.log("-> Archivo '" + nombreFinal + "' guardado en Drive.");
}

function guardarComoXlsxYBorrarTemp(idTempSheet, carpetaDestino, nuevoNombre) {
  Utilities.sleep(2000);
  var url = "https://docs.google.com/spreadsheets/d/" + idTempSheet + "/export?format=xlsx";
  var token = ScriptApp.getOAuthToken();
  var opciones = { headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true };
  try {
    var respuesta = UrlFetchApp.fetch(url, opciones);
    if (respuesta.getResponseCode() == 200) {
      crearArchivoSiNoExiste(carpetaDestino, nuevoNombre, respuesta.getBlob());
    } else {
      Logger.log("Error al exportar a XLSX (ID: " + idTempSheet + "): Código " + respuesta.getResponseCode());
    }
  } catch (e) {
    Logger.log("Excepción al exportar a XLSX: " + e.message);
  } finally {
    try { DriveApp.getFileById(idTempSheet).setTrashed(true); } catch (e) { Logger.log("Error al borrar temp: " + e.message); }
  }
}

function obtenerOCrearCarpeta(carpetaPadre, nombreHijo) {
  var carpetas = carpetaPadre.getFoldersByName(nombreHijo);
  if (carpetas.hasNext()) return carpetas.next();
  Logger.log("Creando carpeta nueva: " + nombreHijo);
  return carpetaPadre.createFolder(nombreHijo);
}

function formatearFechaParaNombre(fecha) {
  var year  = fecha.getFullYear().toString();
  var month = ('0' + (fecha.getMonth() + 1)).slice(-2);
  var day   = ('0' + fecha.getDate()).slice(-2);
  return year + month + day;
}

function crearTriggerOrganizarDrive() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "organizarReportesEnDrive") {
      ScriptApp.deleteTrigger(t);
      Logger.log("🗑️ Trigger antiguo eliminado.");
    }
  });
  ScriptApp.newTrigger("organizarReportesEnDrive")
    .timeBased()
    .everyMinutes(10)
    .create();
  Logger.log("✅ Trigger creado: organizarReportesEnDrive cada 10 minutos.");
}