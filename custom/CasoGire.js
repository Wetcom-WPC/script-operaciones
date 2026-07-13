/**
 * ------------------------------------------------------------------
 * SCRIPT MAESTRO: SISTEMA DE REPORTES FILTRADOS WETCOM (V2.0)
 * ------------------------------------------------------------------
 * Características: 
 * - Lectura Índice 
 * - Búsqueda en Subcarpeta diaria (yyyymmdd)
 * - Limpieza agresiva de nombres
 * - Filtrado inteligente de excepciones
 * - Envío consolidado
 */

// --- 1. CONFIGURACIÓN DEL ÍNDICE ---
const NOMBRE_HOJA_INDICE = 'Adjuntos'; 

// --- 2. MAPEO DE COLUMNAS (A=0, B=1...) ---
const COL_ID_EXCEPCIONES = 2; // Col C: ID del Excel de Excepciones
const COL_EMAIL_PREFIX = 8;   // Col I: Prefijo del Mail (POD)
const COL_CLIENTE = 11;       // Col L: Nombre del Cliente
const COL_FOLDER_ID = 13;     // Col N: ID de la Carpeta Raíz de Reportes

// --- 3. CONFIGURACIÓN GENERAL ---
const DOMINIO_EMAIL = '@wetcom.com';
const CC_EMAIL = 'wpc@wetcom.com';

/**
 * FUNCIÓN PRINCIPAL: Iniciar aquí.
 */
function enviarReportesMasivos() {
  const ss = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID);
  const hoja = ss.getSheetByName(NOMBRE_HOJA_INDICE);
  const datos = hoja.getDataRange().getValues();
  
  // Empezamos en i = 1 para saltar encabezados
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    
    const cliente = fila[COL_CLIENTE];
    const folderId = fila[COL_FOLDER_ID];
    const emailPrefix = fila[COL_EMAIL_PREFIX];
    const idExcepciones = fila[COL_ID_EXCEPCIONES];
    
    if (!folderId || !emailPrefix) {
      console.log(`[SKIP] Fila ${i+1}: Faltan datos críticos.`);
      continue;
    }

    const emailDestino = emailPrefix + DOMINIO_EMAIL;
    console.log(`>>> INICIANDO: ${cliente} | Destino: ${emailDestino}`);
    
    try {
      procesarCliente(cliente, folderId, emailDestino, idExcepciones);
    } catch (e) {
      console.error(`ERROR CRÍTICO en ${cliente}: ${e.stack}`);
    }
  }
}

/**
 * Procesa la carpeta del cliente (buscando subcarpeta diaria) y filtra reportes.
 */
function procesarCliente(cliente, rootFolderId, emailDestino, idExcepciones) {
  const rootFolder = DriveApp.getFolderById(rootFolderId);
  
  // 1. GENERAR NOMBRE DE SUBCARPETA
  const hoy = new Date();
  const nombreSubcarpeta = Utilities.formatDate(hoy, Session.getScriptTimeZone(), "yyyyMMdd");
  
  console.log(`   [BUSCANDO] Subcarpeta del día: "${nombreSubcarpeta}"`);
  
  const folderIterator = rootFolder.getFoldersByName(nombreSubcarpeta);
  let targetFolder = null;
  
  if (folderIterator.hasNext()) {
    targetFolder = folderIterator.next();
    console.log(`   [OK] Entrando a carpeta: ${nombreSubcarpeta}`);
  } else {
    console.warn(`   [ALERTA] No se encontró la carpeta "${nombreSubcarpeta}" en el ID raíz.`);
    return; 
  }

  // 2. PROCESAR ARCHIVOS
  const files = targetFolder.getFiles();
  let adjuntosFinales = [];
  let archivosProcesados = 0; // Contador para saber si al menos revisamos algo
  
  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName();
    
    if (file.getMimeType() === MimeType.MICROSOFT_EXCEL || fileName.endsWith('.xlsx')) {
      archivosProcesados++;
      const nombreOperacion = limpiarNombreReporte(fileName);
      const reglasExcepcion = cargarReglasDeExcepcion(idExcepciones, nombreOperacion);
      
      let tempId = null;
      try {
        tempId = convertirExcelASheet(file);
        const sheet = SpreadsheetApp.openById(tempId).getSheets()[0];
        const data = sheet.getDataRange().getValues();
        
        // Check A1 (Success)
        const celdaA1 = (data[0] && data[0][0]) ? data[0][0].toString() : "";
        if (celdaA1.includes("No se detectaron conflictos")) {
          console.log(`   [OK - A1] ${nombreOperacion} limpio.`);
          continue;
        }

        // Filtrado de Datos
        const headersOriginales = data[0];
        const filasDatos = data.slice(1);
        const headersNorm = headersOriginales.map(h => normalizarTexto(h));

        const filasAlertasReales = filasDatos.filter(row => {
           if (row.join('').trim() === '') return false;
           return !esFilaExceptuada(row, headersNorm, reglasExcepcion);
        });

        if (filasAlertasReales.length > 0) {
          console.log(`   [ANOMALÍA] ${nombreOperacion}: ${filasAlertasReales.length} alertas.`);
          const nombreAdjunto = fileName.replace(".xlsx", " - FILTRADO.xlsx");
          const blobNuevo = crearExcelFiltrado(headersOriginales, filasAlertasReales, nombreAdjunto);
          if (blobNuevo) adjuntosFinales.push(blobNuevo);
        } else {
          console.log(`   [OK - FILTRADO] ${nombreOperacion}: Solo excepciones.`);
        }

      } catch (err) {
        console.error(`   Error archivo ${fileName}: ${err.message}`);
      } finally {
        if (tempId) Drive.Files.remove(tempId);
      }
    }
  }
  
  // 3. DECISIÓN DE ENVÍO
  if (adjuntosFinales.length > 0) {
    // CASO A: Hay problemas -> Enviamos adjuntos
    enviarEmailFinal(cliente, emailDestino, adjuntosFinales);
  } else {
    // CASO B: Todo limpio -> Enviamos correo de Éxito
    if (archivosProcesados > 0) {
       console.log(`   [EXITO] Todo limpio para ${cliente}. Enviando notificación de Success.`);
       enviarEmailExito(cliente, emailDestino);
    } else {
       console.warn(`   [WARN] Carpeta vacía o sin excels para ${cliente}. No se envía nada.`);
    }
  }
}

// ======================================================
// LÓGICA DE EXCEPCIONES
// ======================================================

function cargarReglasDeExcepcion(idExcel, nombreSheet) {
  if (!idExcel) return [];
  try {
    const ss = SpreadsheetApp.openById(idExcel);
    const sheet = ss.getSheetByName(nombreSheet);
    
    if (!sheet) {
      console.warn(`   [WARN] No existe hoja de excepciones para: "${nombreSheet}"`);
      return [];
    }

    const data = sheet.getDataRange().getValues();
    data.shift(); // Quitar header

    let reglas = [];
    data.forEach(row => {
      // Asume: Col B=Columna, Col C=Match, Col D=Valores, Col F=Activo
      const activo = row[5]; 
      if (String(activo).toUpperCase() === 'SI') {
        reglas.push({
          columnaObjetivo: normalizarTexto(row[1]),
          tipoMatch: String(row[2]).toLowerCase(),
          valores: String(row[3]).toLowerCase().split(',').map(v => v.trim())
        });
      }
    });
    return reglas;

  } catch (e) {
    console.warn(`   No se pudo leer excepciones: ${e.message}`);
    return [];
  }
}

function esFilaExceptuada(fila, headers, reglas) {
  if (!reglas || reglas.length === 0) return false;

  return reglas.some(regla => {
    const colIndex = headers.indexOf(regla.columnaObjetivo);
    if (colIndex === -1) return false;

    const valorCelda = String(fila[colIndex] || "").toLowerCase().trim();

    return regla.valores.some(valorExcepcion => {
      switch (regla.tipoMatch) {
        case 'exacta': return valorCelda === valorExcepcion;
        case 'contiene': return valorCelda.includes(valorExcepcion);
        case 'empieza con': return valorCelda.startsWith(valorExcepcion);
        case 'termina con': return valorCelda.endsWith(valorExcepcion);
        default: return false;
      }
    });
  });
}

// ======================================================
// HERRAMIENTAS DE TEXTO Y LIMPIEZA
// ======================================================

// ======================================================
// NUEVA FUNCIÓN DE LIMPIEZA ESTRICTA
// ======================================================

function limpiarNombreReporte(fileName) {
  // 1. Quitar extensión (.xlsx)
  let nombre = fileName.replace(/\.xlsx$/i, '');

  // 2. LIMPIEZA TOTAL DE PREFIJOS NUMÉRICOS
  // La Regex ^[\d\-\s]+ significa:
  // "Desde el inicio (^), busca cualquier combinación de:
  //  dígitos (\d), guiones (\-) o espacios (\s) y bórralos todos."
  // Esto elimina "2026-01-13 10-00", "09-00", "09-01", etc. de un solo golpe.
  nombre = nombre.replace(/^[\d\-\s]+/, '');

  // 3. LIMPIEZA DE PALABRAS BASURA (Case Insensitive)
  // Agrega aquí todas las variantes que ensucian el nombre
  const palabrasAElminar = [
    "vSphere World",
    "vSphere PROD",
    "Wetcom",
    "Gire", 
    " - " // Guiones sueltos que quedan en el medio
  ];

  palabrasAElminar.forEach(palabra => {
    // La bandera "gi" asegura que borre mayúsculas y minúsculas (Wetcom, WETCOM, wetcom)
    const regex = new RegExp(escapeRegExp(palabra), "gi"); 
    nombre = nombre.replace(regex, "");
  });

  // 4. Limpieza final de espacios (quita dobles espacios y espacios al inicio/final)
  return nombre.replace(/\s+/g, ' ').trim();
}

// Función auxiliar necesaria para que los puntos o guiones no rompan la búsqueda
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}

function normalizarTexto(txt) {
  if (!txt) return "";
  return String(txt).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ======================================================
// HERRAMIENTAS DE EXCEL Y EMAIL
// ======================================================

function crearExcelFiltrado(headers, filas, nombreArchivo) {
  const ssTemp = SpreadsheetApp.create("Temp_Export_" + new Date().getTime());
  try {
    const sheet = ssTemp.getSheets()[0];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(2, 1, filas.length, filas[0].length).setValues(filas);
    SpreadsheetApp.flush();
    
    const url = `https://docs.google.com/spreadsheets/d/${ssTemp.getId()}/export?format=xlsx`;
    const params = { 
      method: "GET", 
      headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(url, params);
    if (response.getResponseCode() === 200) {
      const blob = response.getBlob();
      blob.setName(nombreArchivo);
      return blob;
    }
  } catch(e) {
    console.error("Error generando Excel: " + e.message);
  } finally {
    Drive.Files.remove(ssTemp.getId());
  }
  return null;
}

function convertirExcelASheet(file) {
  const resource = {
    title: "temp_read_" + file.getId(),
    mimeType: MimeType.GOOGLE_SHEETS,
    parents: [{id: file.getParents().next().getId()}]
  };
  return Drive.Files.copy(resource, file.getId()).id;
}

// ======================================================
// ENVÍO DE CORREO (CON EMOJIS DE ESTADO)
// ======================================================

function enviarEmailFinal(cliente, destinatario, adjuntos) {
  const hoy = new Date();
  const esViernes = (hoy.getDay() === 5);
  const fechaStr = Utilities.formatDate(hoy, Session.getScriptTimeZone(), "dd/MM/yyyy");
  
  // Asunto Base
  let asuntoBase = `Operaciones Diarias - Wetcom / ${cliente} - vSphere - ${fechaStr}`;
  if (esViernes) {
    asuntoBase = `Operaciones Diarias y Semanales - Wetcom / ${cliente} - vSphere - ${fechaStr}`;
  }

  // AGREGAMOS EMOJI DE ALERTA ⚠️
  const asunto = `⚠️ ${asuntoBase}`;

  const cuerpo = 
`Estimados, buenos días, espero que se encuentren bien.

Envío a continuación los reportes de operaciones de vSphere correspondientes al día de la fecha.

Se adjuntan reportes del día de la fecha.

Ante cualquier duda o consulta, estamos a su disposición.

Saludos cordiales.`;

  GmailApp.sendEmail(destinatario, asunto, cuerpo, {
    cc: CC_EMAIL,
    attachments: adjuntos,
    name: 'Operaciones Wetcom'
  });
  console.log(`   [ENVIADO] Mail de ANOMALÍAS (⚠️) a ${destinatario}.`);
}

function enviarEmailExito(cliente, destinatario) {
  const hoy = new Date();
  const esViernes = (hoy.getDay() === 5);
  const fechaStr = Utilities.formatDate(hoy, Session.getScriptTimeZone(), "dd/MM/yyyy");
  
  // Asunto Base
  let asuntoBase = `Operaciones Diarias - Wetcom / ${cliente} - vSphere - ${fechaStr}`;
  if (esViernes) {
    asuntoBase = `Operaciones Diarias y Semanales - Wetcom / ${cliente} - vSphere - ${fechaStr}`;
  }

  // AGREGAMOS EMOJI DE ÉXITO ✅
  const asunto = `✅ ${asuntoBase}`;

  const cuerpo = 
`Estimados, buenos días, espero que se encuentren bien.

Envío a continuación los reportes de operaciones de vSphere correspondientes al día de la fecha.

Se informa que las validaciones del día de la fecha finalizaron correctamente sin anomalías detectadas.

Ante cualquier duda o consulta, estamos a su disposición.

Saludos cordiales.`;

  GmailApp.sendEmail(destinatario, asunto, cuerpo, {
    cc: CC_EMAIL,
    name: 'Operaciones Wetcom'
  });
  
  console.log(`   [ENVIADO] Mail de ÉXITO (✅) a ${destinatario}.`);
}