/**
 * @fileoverview Servicio único para guardar los adjuntos de los reportes en Drive.
 *
 * ÚNICA fuente de verdad para la subida a Drive: no duplicar esta lógica en otros
 * módulos (ver AGENTS.md §5). Antes vivía dentro de `reports/SubirReportesADrive.js`,
 * acoplada a su propio trigger y a una ventana `newer_than:Xh`; ahora es un paso más
 * del pipeline de `MailProcessor`, invocable desde cualquier operación.
 *
 * Todas las funciones devuelven estado explícito en vez de fallar en silencio
 * (AGENTS.md §7): cuando algo sale mal, el log dice SIEMPRE cliente + archivo + motivo,
 * que es lo mínimo para poder diagnosticar sin tener que reproducir el caso.
 */

/**
 * Índice cliente -> carpeta de Drive, leído del Índice Maestro una sola vez por ejecución.
 * Mismo patrón que MasterSheetSingleton: abrir la hoja en cada correo era caro y
 * contaba contra la cuota de Sheets.
 */
const DriveClientIndexSingleton = (function () {
  let _indice = null;

  /** Extrae la casilla real de un header From ("Nombre <mail@dom>" -> "mail@dom"). */
  function extraerEmailDeFrom(fromHeader) {
    const match = String(fromHeader || '').match(/<(.+)>/);
    return (match ? match[1] : String(fromHeader || '')).trim().toLowerCase();
  }

  function construir() {
    const idHoja = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
    const idCarpetaBase = PropertiesService.getScriptProperties().getProperty("DRIVE_AVISO_BASE_FOLDER_ID");

    if (!idHoja || !idCarpetaBase) {
      Logger.log(`[Drive] ERROR de configuración: falta MASTER_INDEX_SHEET_ID (${!!idHoja}) o DRIVE_AVISO_BASE_FOLDER_ID (${!!idCarpetaBase}) en Script Properties. No se puede subir nada a Drive.`);
      return { entradas: [], carpetaBase: null, clientesNormales: {} };
    }

    const hoja = SpreadsheetApp.openById(idHoja);
    const entradas = [];          // { remitente, nombreCliente, tipo, carpetaId, projectKey }
    const clientesNormales = {};  // nombreCliente -> { nombre, projectKey } (para la lógica DRP)

    // --- Sheet1: clientes con proyecto de Jira; su carpeta se crea por nombre bajo la carpeta base ---
    const hojaClientes = hoja.getSheetByName("Sheet1");
    if (hojaClientes) {
      // Rango A2:D -> A=Remitente, B=Nombre del Cliente, C=ID Excepciones, D=Jira Project Key.
      const filas = hojaClientes.getRange("A2:D" + hojaClientes.getLastRow()).getValues();
      filas.forEach(function (fila) {
        const remitentesRaw = fila[0];
        const nombreCliente = fila[1];
        const projectKey = fila[3];
        if (!nombreCliente) return;

        if (!clientesNormales[nombreCliente]) {
          clientesNormales[nombreCliente] = { nombre: nombreCliente, projectKey: projectKey };
        }
        if (!remitentesRaw) return;

        String(remitentesRaw).split(',').forEach(function (s) {
          const remitente = s.trim().toLowerCase();
          if (!remitente) return;
          entradas.push({ remitente: remitente, nombreCliente: nombreCliente, tipo: 'normal', carpetaId: null, projectKey: projectKey });
        });
      });
    } else {
      Logger.log("[Drive] ERROR: no se encontró la pestaña 'Sheet1' en el Índice Maestro.");
    }

    // --- Pestaña "Adjuntos": clientes SIN Jira, con carpeta de Drive propia (columna N) ---
    const hojaAdjuntos = hoja.getSheetByName("Adjuntos");
    if (hojaAdjuntos) {
      const filas = hojaAdjuntos.getRange("A2:N" + hojaAdjuntos.getLastRow()).getValues();
      filas.forEach(function (fila) {
        const remitentesRaw = fila[0];
        const nombreCliente = fila[1];
        const carpetaId = fila[13]; // Columna N
        if (!nombreCliente || !remitentesRaw || !carpetaId) return;

        String(remitentesRaw).split(',').forEach(function (s) {
          const remitente = s.trim().toLowerCase();
          if (!remitente) return;
          entradas.push({
            remitente: remitente,
            nombreCliente: nombreCliente,
            tipo: 'adjunto',
            carpetaId: String(carpetaId).trim(),
            projectKey: null
          });
        });
      });
    } else {
      Logger.log("[Drive] AVISO: no existe la pestaña 'Adjuntos'; se continúa solo con 'Sheet1'.");
    }

    Logger.log(`[Drive] Índice de destinos cargado: ${entradas.length} remitente(s) sobre ${Object.keys(clientesNormales).length} cliente(s) de Sheet1.`);
    return { entradas: entradas, carpetaBase: DriveApp.getFolderById(idCarpetaBase), clientesNormales: clientesNormales };
  }

  return {
    get: function () {
      if (!_indice) _indice = construir();
      return _indice;
    },
    /**
     * Resuelve a qué cliente/carpeta corresponde un remitente.
     * @returns {Object|null} Entrada del índice, o null si el remitente no está configurado.
     */
    resolverPorRemitente: function (fromHeader) {
      const email = extraerEmailDeFrom(fromHeader);
      const indice = this.get();
      return indice.entradas.find(function (e) { return email.indexOf(e.remitente) !== -1; }) || null;
    },
    /**
     * Entrada del cliente de pruebas, usada en TESTING sin mirar el remitente.
     * @returns {Object|null} Entrada del índice, o null si el cliente de testing no está cargado.
     */
    resolverEntradaDeTesting: function () {
      const indice = this.get();
      const entrada = indice.entradas.find(function (e) { return e.nombreCliente === TESTING_SAFETY_CLIENT_NAME; });
      if (!entrada) {
        Logger.log(`[Drive] ERROR: el entorno es TESTING pero "${TESTING_SAFETY_CLIENT_NAME}" no figura en el Índice Maestro, así que no hay carpeta segura donde archivar.`);
      }
      return entrada || null;
    },
    emailDeFrom: extraerEmailDeFrom
  };
})();

/**
 * Guarda en Drive TODOS los adjuntos de un mensaje, en la carpeta del cliente y del día.
 *
 * Sube todos los adjuntos (no solo el que matchea el processor): los reportes de Veeam
 * traen PDF + XLSX y ambos deben quedar archivados.
 *
 * @param {GoogleAppsScript.Gmail.GmailMessage} mensaje Mensaje a archivar.
 * @param {string} [nombreOperacion] Nombre de la operación, solo para enriquecer los logs.
 * @returns {{ok: boolean, subidos: Array<string>, omitidos: Array<string>, errores: Array<string>, cliente: string}}
 */
function subirAdjuntosDeMensajeADrive(mensaje, nombreOperacion, blobsAlternativos = null) {
  const etiquetaOp = nombreOperacion ? `[${nombreOperacion}] ` : '';
  const resultado = { ok: true, subidos: [], omitidos: [], errores: [], cliente: "_Desconocido_" };

  const adjuntos = blobsAlternativos || mensaje.getAttachments();
  if (adjuntos.length === 0) {
    Logger.log(`[Drive] ${etiquetaOp}El correo "${mensaje.getSubject()}" no tiene adjuntos: nada que archivar.`);
    return resultado;
  }

  const indice = DriveClientIndexSingleton.get();
  if (!indice.carpetaBase) {
    resultado.ok = false;
    resultado.errores.push("Carpeta base de Drive no configurada (DRIVE_AVISO_BASE_FOLDER_ID).");
    return resultado;
  }

  // En TESTING el remitente no decide nada: todo va a la carpeta del cliente de pruebas.
  const enTesting = esEntornoTesting();
  const entrada = enTesting
    ? DriveClientIndexSingleton.resolverEntradaDeTesting()
    : DriveClientIndexSingleton.resolverPorRemitente(mensaje.getFrom());

  if (!entrada) {
    resultado.ok = false;
    const motivo = enTesting
      ? `El entorno es TESTING pero "${TESTING_SAFETY_CLIENT_NAME}" no está cargado en el Índice Maestro, así que no hay carpeta segura donde archivar "${mensaje.getSubject()}".`
      : `Remitente "${DriveClientIndexSingleton.emailDeFrom(mensaje.getFrom())}" no está en el Índice Maestro (ni Sheet1 ni Adjuntos), así que no se sabe en qué carpeta archivar "${mensaje.getSubject()}".`;
    resultado.errores.push(motivo);
    Logger.log(`[Drive] ${etiquetaOp}ERROR: ${motivo}`);
    return resultado;
  }
  if (enTesting) {
    Logger.log(`[Drive] ${etiquetaOp}[SAFEGUARD TESTING] Se ignora el remitente "${DriveClientIndexSingleton.emailDeFrom(mensaje.getFrom())}": todo se archiva bajo "${entrada.nombreCliente}".`);
  }

  resultado.cliente = entrada.nombreCliente;
  const nombreCarpetaFecha = formatearFechaParaNombre(mensaje.getDate());

  // Carpeta del cliente: la de la columna N si es de "Adjuntos", o una por nombre bajo la base.
  let carpetaCliente;
  try {
    carpetaCliente = entrada.tipo === 'adjunto'
      ? DriveApp.getFolderById(entrada.carpetaId)
      : obtenerOCrearCarpeta(indice.carpetaBase, entrada.nombreCliente);
  } catch (e) {
    resultado.ok = false;
    const motivo = `No se pudo abrir la carpeta de "${entrada.nombreCliente}" (tipo ${entrada.tipo}, id ${entrada.carpetaId || 'por nombre'}): ${e.message}`;
    resultado.errores.push(motivo);
    Logger.log(`[Drive] ${etiquetaOp}ERROR: ${motivo}`);
    return resultado;
  }

  adjuntos.forEach(function (adjunto) {
    const nombreArchivo = adjunto.getName();
    let carpetaDestino = carpetaCliente;

    // --- LÓGICA DRP: un reporte cuyo nombre menciona a otro cliente se archiva en la carpeta de ese cliente ---
    // En TESTING se saltea: compara el nombre del archivo contra TODOS los clientes reales del
    // Índice Maestro, así que un archivo de prueba que por casualidad mencione a uno terminaría
    // en la carpeta de Drive de ese cliente real.
    if (!enTesting && nombreArchivo.toLowerCase().includes('drp')) {
      for (const nombreOtroCliente in indice.clientesNormales) {
        if (nombreArchivo.toLowerCase().includes(nombreOtroCliente.toLowerCase())) {
          try {
            carpetaDestino = obtenerOCrearCarpeta(indice.carpetaBase, nombreOtroCliente);
            Logger.log(`[Drive] ${etiquetaOp}"${nombreArchivo}" es DRP: se archiva bajo "${nombreOtroCliente}" en vez de "${entrada.nombreCliente}".`);
          } catch (e) {
            Logger.log(`[Drive] ${etiquetaOp}AVISO: no se pudo abrir la carpeta DRP de "${nombreOtroCliente}" (${e.message}); se usa la de "${entrada.nombreCliente}".`);
          }
          break;
        }
      }
    }

    let carpetaFecha;
    try {
      carpetaFecha = obtenerOCrearCarpeta(carpetaDestino, nombreCarpetaFecha);
    } catch (e) {
      resultado.ok = false;
      const motivo = `Cliente "${entrada.nombreCliente}" / archivo "${nombreArchivo}": no se pudo crear la carpeta del día ${nombreCarpetaFecha}: ${e.message}`;
      resultado.errores.push(motivo);
      Logger.log(`[Drive] ${etiquetaOp}ERROR: ${motivo}`);
      return;
    }

    const guardado = convertirYGuardar(adjunto, carpetaFecha, entrada.nombreCliente);
    if (guardado.ok) {
      if (guardado.omitido) {
        resultado.omitidos.push(guardado.nombreFinal);
      } else {
        resultado.subidos.push(guardado.nombreFinal);
      }
    } else {
      resultado.ok = false;
      resultado.errores.push(`Cliente "${entrada.nombreCliente}" / archivo "${nombreArchivo}": ${guardado.motivo}`);
    }
  });

  Logger.log(`[Drive] ${etiquetaOp}Cliente "${entrada.nombreCliente}": ${resultado.subidos.length} subido(s), ${resultado.omitidos.length} ya existente(s), ${resultado.errores.length} con error.`);
  return resultado;
}

/**
 * ==========================================================
 * FUNCIONES AUXILIARES DE GUARDADO
 * ==========================================================
 */

/**
 * Convierte (CSV/JSON -> XLSX) y guarda un adjunto en Drive.
 * @returns {{ok: boolean, omitido: boolean, nombreFinal: string, motivo: string}}
 */
function convertirYGuardar(adjunto, carpetaDestino, nombreCliente) {
  const nombreArchivo = adjunto.getName();
  const extension = nombreArchivo.split('.').pop().toLowerCase();
  const ctx = `cliente "${nombreCliente || '_Desconocido_'}" / archivo "${nombreArchivo}"`;

  try {
    if (extension === 'csv') {
      const nuevoNombre = nombreArchivo.replace(/\.(xlsx|csv|xls|json)$/i, ".xlsx");
      let csvData = adjunto.getDataAsString("UTF-8");
      if (csvData.charCodeAt(0) === 0xFEFF) csvData = csvData.substring(1);

      // El parseo (separador + filas envueltas en comillas) vive en DataProcessingService.js.
      const data = parseCsvDeReporte(csvData);
      if (!data.length || !data[0].length) {
        Logger.log(`[Drive] El CSV de ${ctx} vino vacío: no se genera XLSX.`);
        return { ok: true, omitido: true, nombreFinal: nuevoNombre, motivo: "CSV vacío" };
      }

      const tempSheet = SpreadsheetApp.create("temp_csv_" + Date.now());
      const sheet = tempSheet.getSheets()[0];
      sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
      sheet.getRange(1, 1, 1, data[0].length).setBackground("#008000").setFontColor("#FFFFFF").setFontWeight("bold");
      sheet.autoResizeColumns(1, data[0].length);
      SpreadsheetApp.flush();
      return guardarComoXlsxYBorrarTemp(tempSheet.getId(), carpetaDestino, nuevoNombre, ctx);
    }

    if (extension === 'json') {
      const nuevoNombre = nombreArchivo.replace(/\.(xlsx|csv|xls|json)$/i, ".xlsx");
      const jsonData = JSON.parse(adjunto.getDataAsString("UTF-8"));
      let datosDeTabla = null;
      for (const key in jsonData) {
        if (Array.isArray(jsonData[key])) { datosDeTabla = jsonData[key]; break; }
      }

      const tempSpreadsheet = SpreadsheetApp.create("temp_json_" + Date.now());
      const sheet = tempSpreadsheet.getSheets()[0];

      if (datosDeTabla && datosDeTabla.length > 0 && typeof datosDeTabla[0] === 'object' && Object.keys(datosDeTabla[0]).length > 0) {
        const headers = Object.keys(datosDeTabla[0]);
        const data = [headers];
        datosDeTabla.forEach(function (row) { data.push(headers.map(function (h) { return row[h]; })); });
        sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
        sheet.getRange(1, 1, 1, headers.length).setBackground("#008000").setFontColor("#FFFFFF").setFontWeight("bold");
        sheet.autoResizeColumns(1, headers.length);
      } else {
        const mensaje = jsonData.Message || "Reporte sin datos tabulares o con tabla vacía.";
        Logger.log(`[Drive] El JSON de ${ctx} no traía tabla; se archiva el mensaje: "${mensaje}"`);
        sheet.getRange("A1").setValue(mensaje).setBackground("#E2F0D9").setFontWeight("bold").setWrap(true);
        sheet.autoResizeColumn(1);
      }
      SpreadsheetApp.flush();
      return guardarComoXlsxYBorrarTemp(tempSpreadsheet.getId(), carpetaDestino, nuevoNombre, ctx);
    }

    // Resto de formatos (PDF, XLSX ya generado, etc.): se guardan tal cual.
    return crearArchivoSiNoExiste(carpetaDestino, nombreArchivo, adjunto.copyBlob(), null, ctx);

  } catch (e) {
    const motivo = `excepción al convertir/guardar (${e.message})`;
    Logger.log(`[Drive] ERROR en ${ctx}: ${motivo}. Stack: ${e.stack}`);
    return { ok: false, omitido: false, nombreFinal: nombreArchivo, motivo: motivo };
  }
}

/**
 * Crea el archivo en Drive si todavía no existe.
 *
 * Es IDEMPOTENTE a propósito: si ya hay un archivo con ese nombre en la carpeta del día,
 * no hace nada. Antes se renombraba a "Reporte (1).xlsx", lo que llenaba las carpetas de
 * copias cada vez que un correo se reprocesaba (se veía seguido en los logs del 27/07/2026).
 * Como la carpeta destino es por cliente y por día, mismo nombre == mismo reporte.
 *
 * @returns {{ok: boolean, omitido: boolean, nombreFinal: string, motivo: string}}
 */
function crearArchivoSiNoExiste(carpetaDestino, nombreArchivo, contenido, mimeType, ctx) {
  try {
    if (carpetaDestino.getFilesByName(nombreArchivo).hasNext()) {
      Logger.log(`[Drive] "${nombreArchivo}" ya existía en la carpeta del día: se omite (${ctx || 'sin contexto'}).`);
      return { ok: true, omitido: true, nombreFinal: nombreArchivo, motivo: "ya existía" };
    }

    if (mimeType) {
      carpetaDestino.createFile(nombreArchivo, contenido, mimeType);
    } else {
      const archivoCreado = carpetaDestino.createFile(contenido);
      if (archivoCreado.getName() !== nombreArchivo) {
        try {
          archivoCreado.setName(nombreArchivo);
        } catch (e) {
          // No es fatal: el archivo está guardado, solo quedó con otro nombre.
          Logger.log(`[Drive] AVISO: el archivo se guardó pero no se pudo renombrar a "${nombreArchivo}" (${ctx || 'sin contexto'}): ${e.message}`);
        }
      }
    }
    Logger.log(`[Drive] -> "${nombreArchivo}" guardado (${ctx || 'sin contexto'}).`);
    return { ok: true, omitido: false, nombreFinal: nombreArchivo, motivo: "" };

  } catch (e) {
    const motivo = `no se pudo crear el archivo en Drive (${e.message})`;
    Logger.log(`[Drive] ERROR: ${motivo} (${ctx || 'sin contexto'}).`);
    return { ok: false, omitido: false, nombreFinal: nombreArchivo, motivo: motivo };
  }
}

/**
 * Exporta una hoja temporal a XLSX, la guarda en Drive y borra la temporal.
 * @returns {{ok: boolean, omitido: boolean, nombreFinal: string, motivo: string}}
 */
function guardarComoXlsxYBorrarTemp(idTempSheet, carpetaDestino, nuevoNombre, ctx) {
  // Drive tarda un instante en dejar la hoja recién creada disponible para exportar.
  Utilities.sleep(2000);
  const url = "https://docs.google.com/spreadsheets/d/" + idTempSheet + "/export?format=xlsx";
  const opciones = { headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };

  try {
    const respuesta = fetchWithRetries(url, opciones);
    if (respuesta.getResponseCode() !== 200) {
      const motivo = `la exportación a XLSX devolvió HTTP ${respuesta.getResponseCode()}`;
      Logger.log(`[Drive] ERROR: ${motivo} (${ctx || 'sin contexto'}, hoja temporal ${idTempSheet}).`);
      return { ok: false, omitido: false, nombreFinal: nuevoNombre, motivo: motivo };
    }
    return crearArchivoSiNoExiste(carpetaDestino, nuevoNombre, respuesta.getBlob(), null, ctx);

  } catch (e) {
    const motivo = `excepción al exportar a XLSX (${e.message})`;
    Logger.log(`[Drive] ERROR: ${motivo} (${ctx || 'sin contexto'}, hoja temporal ${idTempSheet}).`);
    return { ok: false, omitido: false, nombreFinal: nuevoNombre, motivo: motivo };

  } finally {
    try {
      DriveApp.getFileById(idTempSheet).setTrashed(true);
    } catch (e) {
      // Si no se puede borrar, queda basura en Drive pero el reporte sí se guardó: solo avisamos.
      Logger.log(`[Drive] AVISO: no se pudo borrar la hoja temporal ${idTempSheet} (${e.message}). Queda para limpieza manual.`);
    }
  }
}

/** Devuelve la subcarpeta con ese nombre, creándola si no existe. */
function obtenerOCrearCarpeta(carpetaPadre, nombreHijo) {
  const carpetas = carpetaPadre.getFoldersByName(nombreHijo);
  if (carpetas.hasNext()) return carpetas.next();
  Logger.log(`[Drive] Creando carpeta nueva: "${nombreHijo}".`);
  return carpetaPadre.createFolder(nombreHijo);
}

/** Formatea una fecha como YYYYMMDD, que es el nombre de las carpetas por día. */
function formatearFechaParaNombre(fecha) {
  const year = fecha.getFullYear().toString();
  const month = ('0' + (fecha.getMonth() + 1)).slice(-2);
  const day = ('0' + fecha.getDate()).slice(-2);
  return year + month + day;
}
