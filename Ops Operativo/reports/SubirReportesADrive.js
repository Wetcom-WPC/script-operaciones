/**
 * ==========================================================
 * LÓGICA PRINCIPAL DEL SCRIPT
 * ==========================================================
 */

function organizarReportesEnDrive() {
  var idCarpetaPrincipal = PropertiesService.getScriptProperties().getProperty("DRIVE_AVISO_BASE_FOLDER_ID");
  var idHojaCalculo = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
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
      if (remitente) {
        remitente.split(',').forEach(function(s) {
          var cleanSender = s.trim();
          if (cleanSender !== "" && clientes[nombreCliente].remitentes.indexOf(cleanSender) === -1) {
            clientes[nombreCliente].remitentes.push(cleanSender);
          }
        });
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
        remitente.split(',').forEach(function(s) {
          var cleanSender = s.trim();
          if (cleanSender !== "" && clientesAdjuntos[nombreCliente].remitentes.indexOf(cleanSender) === -1) {
            clientesAdjuntos[nombreCliente].remitentes.push(cleanSender);
          }
        });
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

  // --- NUEVO: en vez de un GmailApp.search() por cada remitente de cada cliente (N+1, agotaba la cuota diaria de Gmail),
  // armamos un índice remitente -> cliente y hacemos búsquedas combinadas por lote ({from:a from:b} = OR en Gmail). ---
  var indiceRemitentes = [];
  for (var ncNormal in clientes) {
    clientes[ncNormal].remitentes.forEach(function(r) { indiceRemitentes.push({ remitente: r, tipo: 'normal', nombreCliente: ncNormal }); });
  }
  for (var ncAdj in clientesAdjuntos) {
    clientesAdjuntos[ncAdj].remitentes.forEach(function(r) { indiceRemitentes.push({ remitente: r, tipo: 'adjunto', nombreCliente: ncAdj }); });
  }

  var carpetaClienteCache = {};
  function obtenerCarpetaClienteCacheada(nombreCliente) {
    if (!carpetaClienteCache[nombreCliente]) {
      carpetaClienteCache[nombreCliente] = obtenerOCrearCarpeta(carpetaPrincipal, nombreCliente);
    }
    return carpetaClienteCache[nombreCliente];
  }

  function extraerEmailDeFrom(fromHeader) {
    var match = fromHeader.match(/<(.+)>/);
    return (match ? match[1] : fromHeader).trim().toLowerCase();
  }

  function emailCoincideConRemitente(emailFrom, remitente) {
    return emailFrom.indexOf(remitente.trim().toLowerCase()) !== -1;
  }

  const timeGuard = new TimeGuard({ operationName: "Subir Reportes a Drive" });
  var TAM_LOTE_REMITENTES = 20; // remitentes por consulta combinada, para no exceder el largo de una query de Gmail
  for (var i = 0; i < indiceRemitentes.length; i += TAM_LOTE_REMITENTES) {
    if (!timeGuard.check(`Lote de remitentes ${i}-${i + TAM_LOTE_REMITENTES}`)) {
      Logger.log(`[SubirReportesADrive] TimeGuard activado en loop de lotes.`);
      break;
    }
    var lote = indiceRemitentes.slice(i, i + TAM_LOTE_REMITENTES);
    var terminos = lote.map(function(e) { return "from:" + e.remitente; }).join(" ");
    var query = "{" + terminos + "} newer_than:" + horasAtras + "h";
    var hilos = GmailApp.search(query);

    hilos.forEach(function(hilo) {
      hilo.getMessages().forEach(function(mensaje) {
        var mensajeId = mensaje.getId();
        var keyPropiedad = "PROCESADO_" + mensajeId;
        if (scriptProperties.getProperty(keyPropiedad)) return;

        var adjuntos = mensaje.getAttachments();
        if (adjuntos.length === 0) return;

        var emailRemitente = extraerEmailDeFrom(mensaje.getFrom());
        var entradaMatch = lote.find(function(e) { return emailCoincideConRemitente(emailRemitente, e.remitente); });
        if (!entradaMatch) return;

        var fechaMensaje = mensaje.getDate();
        var nombreCarpetaFecha = formatearFechaParaNombre(fechaMensaje);

        if (entradaMatch.tipo === 'normal') {
          var clienteInfo = clientes[entradaMatch.nombreCliente];
          var carpetaClienteDefault = obtenerCarpetaClienteCacheada(entradaMatch.nombreCliente);
          Logger.log("Procesando mensaje NUEVO ID: " + mensajeId + " de: " + emailRemitente);

          adjuntos.forEach(function(adjunto) {
            var nombreArchivo = adjunto.getName();
            var nombreArchivoLower = nombreArchivo.toLowerCase();
            var carpetaDestinoFinal = carpetaClienteDefault;

            // --- LÓGICA JIRA ---
            if (clienteInfo.projectKey) {
              for (var k = 0; k < REPORTES_QUE_CIERRAN_TAREAS_LOWER.length; k++) {
                if (nombreArchivoLower.includes(REPORTES_QUE_CIERRAN_TAREAS_LOWER[k])) {
                  Logger.log("Archivo '" + nombreArchivo + "' detectado para cierre de tarea.");
                  const mappedClientConfig = {
                    clientName: clienteInfo.nombre,
                    jiraProjectKey: clienteInfo.projectKey
                  };
                  buscarYCerrarTareaProgramada(REPORTES_QUE_CIERRAN_TAREAS_BASE[k], mappedClientConfig, false);
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
        } else {
          var clienteInfoAdj = clientesAdjuntos[entradaMatch.nombreCliente];
          var carpetaClienteAdj = DriveApp.getFolderById(clienteInfoAdj.carpetaId);
          Logger.log("[ADJUNTOS] Procesando mensaje NUEVO ID: " + mensajeId + " de: " + emailRemitente + " (" + entradaMatch.nombreCliente + ")");

          adjuntos.forEach(function(adjunto) {
            var carpetaFecha = obtenerOCrearCarpeta(carpetaClienteAdj, nombreCarpetaFecha);
            convertirYGuardar(adjunto, carpetaFecha);
          });

          scriptProperties.setProperty(keyPropiedad, "true");
          Logger.log("[ADJUNTOS] Mensaje registrado como procesado.");
        }
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
      var data = parseCsvRobust(csvData);
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
    var respuesta = fetchWithRetries(url, opciones);
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
