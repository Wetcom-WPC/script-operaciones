/**
 * =================================================================
 * SCRIPT DE AUDITORÍA DE LICENCIAS (RVTOOLS) - WETCOM (PRODUCCIÓN)
 * LIBRERÍA CORE: "Automatizar Operaciones"
 * =================================================================
 * Lee TODOS los archivos de la subcarpeta YYYY -> YYYYMMDD
 * Pestaña de configuración: "Licencias"
 */

const LICENCIAS_OPERATION_NAME = "Auditoría de Licencias";
const ID_HOJA_CONFIGURACION = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID"); 
const NOMBRE_PESTANA_CONFIG = "Licencias"; 

const LICENSE_TAB_NAME = "vLicense";
const DIAS_UMBRAL_VENCIMIENTO = 90; // <---------------- ⚠️ Umbral para disparar el aviso.

// Límite de seguridad de Google: 4.5 minutos (270,000 ms). Max permitido es 6 min.
const MAX_TIEMPO_EJECUCION = 270000; 

/**
 * =================================================================
 * 1. MÉTODOS DE ENTRADA (TRIGGERS Y PUENTES)
 * =================================================================
 */

// 1. Ejecución Manual On-Demand (Ignora el calendario)
function ejecutarManual() {
  console.log("🚀 Iniciando ejecución manual...");
  limpiarTriggersContinuacion(); 
  PropertiesService.getScriptProperties().deleteProperty('LICENCIAS_BOOKMARK');
  PropertiesService.getScriptProperties().deleteProperty('LICENCIAS_REPORT');
  procesarTodasLasLicencias();
}

// 2. Instalador del Trigger (Ahora es DIARIO)
function instalarTriggerMensual() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'gatilloDiarioGuardián') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('gatilloDiarioGuardián').timeBased().everyDays(1).atHour(7).create();
  console.log("✅ Trigger Diario (Guardián) instalado a las 7 AM.");
}

// 3. El Guardián (Se ejecuta todos los días pero solo avanza el último día hábil)
function gatilloDiarioGuardián() {
  if (esUltimoDiaHabilMes()) {
    console.log("📅 HOY ES EL ÚLTIMO DÍA HÁBIL DEL MES. Iniciando auditoría global...");
    limpiarTriggersContinuacion();
    PropertiesService.getScriptProperties().deleteProperty('LICENCIAS_BOOKMARK');
    PropertiesService.getScriptProperties().deleteProperty('LICENCIAS_REPORT');
    procesarTodasLasLicencias();
  } else {
    console.log("💤 Hoy no es el último día hábil del mes. Abortando ejecución.");
  }
}

// 4. El Resucitador (Usado cuando el script se corta por Time-Out)
function continuarProcesamiento() {
  console.log("🔄 Reanudando procesamiento desde el marcapáginas...");
  limpiarTriggersContinuacion(); 
  procesarTodasLasLicencias();
}

// 5. Puente Front-End (BotonCheckbox)
function procesarLicenciasManualLibreria(cliente, destinatario, folderId, pod) {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  try {
    const resultadoMotor = procesarInfraestructuraCliente(cliente, destinatario, folderId, pod, summaryReport);
    if (summaryReport.errores.length > 0) {
      return { success: false, message: summaryReport.errores[0].detalle, ruta: resultadoMotor.ruta, archivos: resultadoMotor.archivos };
    }
    return { success: true, message: `Reporte enviado a ${destinatario}`, ruta: resultadoMotor.ruta, archivos: resultadoMotor.archivos };
  } catch (e) {
    return { success: false, message: e.message, ruta: "Error de acceso", archivos: "N/A" };
  }
}

/**
 * =================================================================
 * 2. MOTOR PRINCIPAL Y CONTROL DE TIEMPO
 * =================================================================
 */

function procesarTodasLasLicencias() {
  const tiempoInicio = Date.now();
  const props = PropertiesService.getScriptProperties();
  
  let ss;
  try {
    ss = SpreadsheetApp.openById(ID_HOJA_CONFIGURACION);
  } catch (e) {
    console.error("❌ Error: No se pudo abrir el Índice General.");
    return;
  }
  const hoja = ss.getSheetByName(NOMBRE_PESTANA_CONFIG);
  if (!hoja) return;
  const datos = hoja.getDataRange().getValues();
  
  let indexInicial = parseInt(props.getProperty('LICENCIAS_BOOKMARK')) || 1;
  let summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  
  const reporteGuardado = props.getProperty('LICENCIAS_REPORT');
  if (reporteGuardado) {
    summaryReport = JSON.parse(reporteGuardado);
  }

  const clientesValidos = datos.slice(1).filter(row => row[0] && row[2] && row[3]);
  const totalClientes = clientesValidos.length;
  
  if (indexInicial === 1) {
    console.log(`📋 Iniciando lote nuevo: ${totalClientes} clientes configurados.`);
  }

  let clientesProcesadosEsteLote = 0;

  for (let i = indexInicial; i < datos.length; i++) {
    if (Date.now() - tiempoInicio > MAX_TIEMPO_EJECUCION) {
      console.warn(`⏳ TIEMPO LÍMITE ALCANZADO (Fila ${i}). Guardando marcapáginas y reiniciando en 1 minuto...`);
      props.setProperty('LICENCIAS_BOOKMARK', i.toString());
      props.setProperty('LICENCIAS_REPORT', JSON.stringify(summaryReport));
      
      ScriptApp.newTrigger('continuarProcesamiento')
        .timeBased()
        .after(60 * 1000) 
        .create();
      
      return; 
    }

    const emailDestino = datos[i][0]; 
    const pod = datos[i][1];
    const cliente = datos[i][2];      
    const folderId = datos[i][3];     
    
    if (!cliente || !emailDestino || !folderId) continue;
    
    clientesProcesadosEsteLote++;
    console.log(`\n🔎 Procesando fila ${i} - Cliente: ${cliente} (POD: ${pod})...`);
    procesarInfraestructuraCliente(cliente, emailDestino, folderId, pod, summaryReport);
  }
  
  console.log("\n🏁 CICLO DE AUDITORÍA TOTALMENTE FINALIZADO.");
  props.deleteProperty('LICENCIAS_BOOKMARK');
  props.deleteProperty('LICENCIAS_REPORT');
  
  if (typeof enviarResumenSlack === "function" && (summaryReport.errores.length > 0 || summaryReport.exitos.length > 0)) {
    enviarResumenSlack(LICENCIAS_OPERATION_NAME, summaryReport);
  }
}

function procesarInfraestructuraCliente(cliente, emailDestino, rootFolderId, pod, summaryReport) {
  let rutaLog = "";
  let nombresArchivos = [];
  try {
    const rootFolder = DriveApp.getFolderById(rootFolderId);
    const anioFolder = obtenerSubcarpetaMasReciente(rootFolder, /^\d{4}/);
    if (!anioFolder) throw new Error("No se encontró carpeta de Año (YYYY)");
    const fechaFolder = obtenerSubcarpetaMasReciente(anioFolder, /^\d{8}/);
    if (!fechaFolder) throw new Error(`No se encontró carpeta de Fecha en ${anioFolder.getName()}`);

    let targetFolder = fechaFolder;
    if ((pod || "").toString().trim().toUpperCase() === "WPC") {
      const rvToolsFolder = buscarCarpetaPorNombre(fechaFolder, "RVTools");
      if (!rvToolsFolder) throw new Error(`No se encontró carpeta 'RVTools'`);
      targetFolder = rvToolsFolder;
      rutaLog = `${anioFolder.getName()} > ${fechaFolder.getName()} > RVTools`;
    } else {
      rutaLog = `${anioFolder.getName()} > ${fechaFolder.getName()}`;
    }

    console.log(`📂 Ruta resuelta: ${rutaLog}`);

    const files = targetFolder.getFiles();
    let archivosAProcesar = [];
    while (files.hasNext()) {
      let file = files.next();
      let name = file.getName().toLowerCase();
      if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
        archivosAProcesar.push(file);
        nombresArchivos.push(file.getName());
      }
    }

    if (archivosAProcesar.length === 0) throw new Error(`Sin archivos Excel válidos en la ruta`);

    console.log(`📄 Se encontraron ${archivosAProcesar.length} archivo(s) Excel. Leyendo...`);

    let todasLasLicenciasCliente = [];
    let errorCriticoCliente = false;

    for (const file of archivosAProcesar) {
      let tempSheetId = null;
      let exitoArchivo = false;
      let intentos = 0;
      const MAX_INTENTOS = 3;

      while (intentos < MAX_INTENTOS && !exitoArchivo) {
        try {
          intentos++;
          console.log(`⏳ [${cliente}] Abriendo archivo: ${file.getName()} (Intento ${intentos})`);
          const tempSheetFile = executeDriveWithBackoff(() => Drive.Files.copy({ mimeType: MimeType.GOOGLE_SHEETS, name: `[TEMP_LIC]` }, file.getId()));
          tempSheetId = tempSheetFile.id;
          Utilities.sleep(10000); 
          const tempSpreadsheet = SpreadsheetApp.openById(tempSheetId);
          
          const licenciasArchivo = analizarPestanaLicencias(tempSpreadsheet);
          todasLasLicenciasCliente = todasLasLicenciasCliente.concat(licenciasArchivo);
          
          exitoArchivo = true;
        } catch (e) {
          if (intentos >= MAX_INTENTOS) {
            console.error(`❌ [${cliente}] Fallo definitivo al leer el archivo ${file.getName()}: ${e.message}`);
            errorCriticoCliente = true;
            summaryReport.errores.push({ error: `[${cliente}] Timeout archivo`, detalle: `Fallo tras ${MAX_INTENTOS} intentos en ${file.getName()}` });
          } else {
            console.warn(`⚠️ [${cliente}] Problema al abrir, reintentando en breve...`);
            Utilities.sleep(5000 * intentos);
          }
        } finally {
          if (tempSheetId) DriveApp.getFileById(tempSheetId).setTrashed(true);
        }
      }
      if (errorCriticoCliente) break;
    }

    if (errorCriticoCliente) {
      return { ruta: rutaLog, archivos: nombresArchivos.join("\n") };
    }

    let licenciasUnicas = [];
    let setDuplicados = new Set();
    todasLasLicenciasCliente.forEach(lic => {
      let key = `${lic.sitio}|${lic.nombre}|${lic.vencimiento}|${lic.usadas}`;
      if (!setDuplicados.has(key)) {
        setDuplicados.add(key);
        licenciasUnicas.push(lic);
      }
    });

    console.log(`📧 Despachando reporte de ${cliente} a ${emailDestino} (${licenciasUnicas.length} licencias procesadas).`);
    enviarAlertaLicencias(cliente, emailDestino, licenciasUnicas);
    enviarAlertaSlackDetallada(cliente, licenciasUnicas);
    
    summaryReport.exitos.push({ mensaje: `*${cliente}*: Reporte OK` });
    return { ruta: rutaLog, archivos: nombresArchivos.join("\n") };

  } catch (e) {
    console.error(`❌ [${cliente}] Error: ${e.message}`);
    summaryReport.errores.push({ error: `Fallo ${cliente}`, detalle: e.message });
    return { ruta: rutaLog || "Error", archivos: nombresArchivos.length > 0 ? nombresArchivos.join("\n") : "Ninguno" };
  }
}

/**
 * =================================================================
 * 3. HERRAMIENTAS DE PROCESAMIENTO Y CALENDARIO
 * =================================================================
 */

function limpiarTriggersContinuacion() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'continuarProcesamiento') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/**
 * 💡 NUEVO: Lógica inteligente para determinar el último día hábil del mes,
 * integrando el Calendario Oficial de Feriados de Argentina.
 */
function esUltimoDiaHabilMes() {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth();
  const diaHoy = hoy.getDate();

  // 1. Intentar obtener los feriados del mes usando el calendario de Google
  let feriadosDelMes = [];
  try {
    const calendarId = PropertiesService.getScriptProperties().getProperty("HOLIDAYS_CALENDAR_ID"); // Calendario oficial AR
    const cal = CalendarApp.getCalendarById(calendarId);
    
    if (cal) {
      const primerDiaMes = new Date(anio, mes, 1);
      const primerDiaProximoMes = new Date(anio, mes + 1, 1);
      const eventos = cal.getEvents(primerDiaMes, primerDiaProximoMes);
      
      // Guardamos en un array solo los números de los días feriados
      feriadosDelMes = eventos.map(e => e.getStartTime().getDate());
    }
  } catch (e) {
    console.warn("⚠️ No se pudo acceder al calendario de feriados. Usando fallback (solo detectará fines de semana).", e.message);
  }

  // 2. Calcular cuál es el último día hábil iterando hacia atrás
  const ultimoDiaDelMes = new Date(anio, mes + 1, 0).getDate();
  let ultimoDiaHabil = ultimoDiaDelMes;

  for (let dia = ultimoDiaDelMes; dia > 0; dia--) {
    const fechaTest = new Date(anio, mes, dia);
    const diaSemana = fechaTest.getDay(); // 0: Dom, 6: Sab

    // Si es fin de semana, saltar
    if (diaSemana === 0 || diaSemana === 6) continue;

    // Si es feriado oficial, saltar
    if (feriadosDelMes.includes(dia)) continue;

    // Si pasó los filtros, encontramos el último día hábil real
    ultimoDiaHabil = dia;
    break;
  }

  return (diaHoy === ultimoDiaHabil);
}

function obtenerSubcarpetaMasReciente(carpetaPadre, regexPatron) {
  const subcarpetas = carpetaPadre.getFolders();
  let carpetaMasReciente = null;
  let nombreMasReciente = "";
  while (subcarpetas.hasNext()) {
    let carpetaActual = subcarpetas.next();
    let nombreActual = carpetaActual.getName();
    if (regexPatron && !regexPatron.test(nombreActual)) continue;
    if (nombreActual > nombreMasReciente) {
      nombreMasReciente = nombreActual;
      carpetaMasReciente = carpetaActual;
    }
  }
  return carpetaMasReciente;
}

function buscarCarpetaPorNombre(carpetaPadre, nombreExacto) {
  const subcarpetas = carpetaPadre.getFolders();
  const nombreLower = nombreExacto.toLowerCase();
  while (subcarpetas.hasNext()) {
    let carpetaActual = subcarpetas.next();
    if (carpetaActual.getName().toLowerCase() === nombreLower) return carpetaActual;
  }
  return null;
}

function obtenerSitio(spreadsheet) {
  const sheet = spreadsheet.getSheetByName("vMetaData");
  if (!sheet) return "Desconocido";
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return "Desconocido";
  
  const headers = data[0].map(h => h.toString().toLowerCase().trim());
  const idxServer = headers.findIndex(h => h === "server" || h === "vcenter" || h.includes("vcenter server"));
  
  if (idxServer !== -1 && data[1][idxServer]) {
    return data[1][idxServer].toString().trim();
  }
  return "Desconocido";
}

function interpretarFecha(val) {
  if (!val) return null;
  let str = String(val).trim();
  let dateOnly = str.split(" ")[0]; 
  let parts = dateOnly.split(/[\/\-]/);
  let d;
  if (parts.length >= 3) {
    let p1 = parseInt(parts[0], 10), p2 = parseInt(parts[1], 10), p3 = parseInt(parts[2], 10);
    if (p1 > 1000) d = new Date(p1, p2 - 1, p3);
    else if (p3 > 1000) {
      if (p1 > 12) d = new Date(p3, p2 - 1, p1);
      else d = new Date(p3, p1 - 1, p2);
    } else { d = new Date(str); }
  } else { d = new Date(str); }
  
  if (d && !isNaN(d.getTime())) {
    return { obj: d };
  }
  return null;
}

function analizarPestanaLicencias(spreadsheet) {
  const sitioEncontrado = obtenerSitio(spreadsheet); 
  const sheet = spreadsheet.getSheetByName(LICENSE_TAB_NAME);
  if (!sheet) return [];
  
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return [];
  
  const headers = data[0].map(h => h.toString().toLowerCase().trim());
  const idxName = headers.findIndex(h => h === "name" || h.includes("license name"));
  const idxExpiration = headers.findIndex(h => h.includes("expiration"));
  const idxUsed = headers.findIndex(h => h === "used" || h.includes("used licenses") || h === "count");
  const idxTotal = headers.findIndex(h => h === "total" || h.includes("capacity"));
  const idxCostUnit = headers.findIndex(h => h.includes("cost unit"));

  if (idxName === -1 || idxExpiration === -1 || idxUsed === -1) return [];
  
  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  const todasLasLicencias = [];
  
  data.slice(1).forEach(row => {
    let rawUsed = row[idxUsed] ? row[idxUsed].toString().trim() : "0";
    const used = parseInt(rawUsed, 10) || 0;
    
    let rawExp = row[idxExpiration] ? row[idxExpiration].toString().trim() : "";
    let valStr = rawExp.toLowerCase();

    let diasRestantes = 999999; 

    if (valStr !== "" && valStr !== "never") {
      if (valStr.includes("expir") || valStr.includes("vencid")) {
        diasRestantes = -1; 
      } else {
        let expDate = interpretarFecha(rawExp); 
        if (expDate) {
          expDate.obj.setHours(0, 0, 0, 0); 
          diasRestantes = Math.ceil((expDate.obj.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
        }
      }
    }

    todasLasLicencias.push({
      sitio: sitioEncontrado,
      nombre: row[idxName] || "Desconocido",
      vencimiento: rawExp, 
      diasRestantes: diasRestantes,
      usadas: used,
      total: idxTotal !== -1 ? (row[idxTotal] || "N/A") : "N/A",
      metrica: idxCostUnit !== -1 ? (row[idxCostUnit] || "Unidades") : "Unidades"
    });
  });
  return todasLasLicencias;
}

/**
 * =================================================================
 * 4. SISTEMA DE ALERTAS (REPORTING MULTI-ESTADO COMPLETO)
 * =================================================================
 */

function enviarAlertaLicencias(cliente, destinatarioRaw, todasLasLicencias) {
  const emailsAEnviar = destinatarioRaw.toString().split(',').map(e => e.trim()).filter(e => e !== "").join(',');
  
  const vencidas = todasLasLicencias.filter(a => a.usadas > 0 && a.diasRestantes < 0);
  const proximas = todasLasLicencias.filter(a => a.usadas > 0 && a.diasRestantes >= 0 && a.diasRestantes <= DIAS_UMBRAL_VENCIMIENTO);
  const sanasEnUso = todasLasLicencias.filter(a => a.usadas > 0 && a.diasRestantes > DIAS_UMBRAL_VENCIMIENTO);
  const sinUso = todasLasLicencias.filter(a => a.usadas === 0);

  const sortSitioDias = (a, b) => {
    if (a.sitio < b.sitio) return -1;
    if (a.sitio > b.sitio) return 1;
    return a.diasRestantes - b.diasRestantes;
  };
  const sortSitioNombre = (a, b) => {
    if (a.sitio < b.sitio) return -1;
    if (a.sitio > b.sitio) return 1;
    return a.nombre.localeCompare(b.nombre);
  };

  vencidas.sort(sortSitioDias);
  proximas.sort(sortSitioDias);
  sanasEnUso.sort(sortSitioNombre);
  sinUso.sort(sortSitioNombre);

  const todoOK = (vencidas.length === 0 && proximas.length === 0);

  let colorHeader = "#5cb85c"; // Verde
  let iconoHeader = "✅";
  let statusTxt = "Auditoría Exitosa";
  let situacionTxt = "Todas las licencias en uso se encuentran vigentes y operativas.";

  if (vencidas.length > 0) {
    colorHeader = "#d9534f"; // Rojo
    iconoHeader = "❌";
    statusTxt = "Licencias Vencidas Detectadas";
    situacionTxt = "Se requiere acción inmediata para renovar licencias expiradas en uso.";
  } else if (proximas.length > 0) {
    colorHeader = "#f0ad4e"; // Naranja
    iconoHeader = "⚠️";
    statusTxt = "Atención: Licencias Próximas a Vencer";
    situacionTxt = "Se han detectado licencias en uso que vencerán en el corto plazo.";
  }

  // --- NUEVO FORMATO DE ASUNTO ---
  const fechaHoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy");
  const asunto = `${iconoHeader} Estado de Licencias vSphere - Wetcom / ${cliente} - ${fechaHoy}`;
  // -------------------------------
  
  let cuerpoHtml = `
  <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; max-width: 850px;">
    <div style="border: 1px solid #ddd; border-left: 6px solid ${colorHeader}; padding: 20px; background-color: #f9f9f9; border-radius: 4px;">
      <h2 style="margin-top: 0; color: ${colorHeader}; font-size: 18px;">${statusTxt}</h2>
      <p style="font-size: 14px;">Auditoría completa para <b>${cliente}</b>.</p>
      <p style="font-size: 14px;"><b>Situación:</b> ${situacionTxt}</p>
  `;

  // --- CUADRO 1: CRÍTICAS (ROJO) ---
  if (vencidas.length > 0) {
    cuerpoHtml += `
      <div style="margin-top: 20px;">
        <table style="border-collapse: collapse; width: 100%; background-color: white; font-size: 13px; border: 1px solid #ddd;">
          <tr style="background-color: #d9534f; color: white;">
            <th colspan="5" style="padding: 10px; border: 1px solid #ddd; text-align: left; font-size: 14px;">CRÍTICO - LICENCIAS VENCIDAS (EN USO)</th>
          </tr>
          <tr style="background-color: #fdf7f7; color: #761c19;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Sitio</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Licencia</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Vencimiento</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Días</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Uso</th>
          </tr>`;
    vencidas.forEach(a => {
      cuerpoHtml += `<tr>
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">${a.sitio}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; color: #d9534f;"><b>${a.vencimiento}</b></td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; color: #d9534f;"><b>VENCIDA</b></td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.usadas} de ${a.total} (${a.metrica})</td>
      </tr>`;
    });
    cuerpoHtml += `</table></div>`;
  }

  // --- CUADRO 2: ADVERTENCIAS (NARANJA) ---
  if (proximas.length > 0) {
    cuerpoHtml += `
      <div style="margin-top: 20px;">
        <table style="border-collapse: collapse; width: 100%; background-color: white; font-size: 13px; border: 1px solid #ddd;">
          <tr style="background-color: #f0ad4e; color: white;">
            <th colspan="5" style="padding: 10px; border: 1px solid #ddd; text-align: left; font-size: 14px;">ATENCIÓN - PRÓXIMAS A VENCER</th>
          </tr>
          <tr style="background-color: #fcf8f2; color: #8a6d3b;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Sitio</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Licencia</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Vencimiento</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Días</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Uso</th>
          </tr>`;
    proximas.forEach(a => {
      cuerpoHtml += `<tr>
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">${a.sitio}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.vencimiento}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; color: #d9534f;"><b>${a.diasRestantes}</b></td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.usadas} de ${a.total} (${a.metrica})</td>
      </tr>`;
    });
    cuerpoHtml += `</table></div>`;
  }

  // --- CUADRO 3: ESTADO OK Y SIN USO (ESTILO DINÁMICO) ---
  if (sanasEnUso.length > 0 || sinUso.length > 0) {
    let bgHeaderSanas = todoOK ? "#5cb85c" : "#e2e3e5"; 
    let colorHeaderSanas = todoOK ? "white" : "#495057";
    let bgSubHeaderSanas = todoOK ? "#f9fdf9" : "#f8f9fa";
    let colorSubHeaderSanas = todoOK ? "#2b542c" : "#495057";

    cuerpoHtml += `
      <div style="margin-top: 20px;">
        <table style="border-collapse: collapse; width: 100%; background-color: white; font-size: 13px; border: 1px solid #ddd;">
          <tr style="background-color: ${bgHeaderSanas}; color: ${colorHeaderSanas};">
            <th colspan="5" style="padding: 10px; border: 1px solid #ddd; text-align: left; font-size: 14px;">SALUDABLE - ESTADO OK / NO UTILIZADAS</th>
          </tr>
          <tr style="background-color: ${bgSubHeaderSanas}; color: ${colorSubHeaderSanas};">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Sitio</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Licencia</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Vencimiento</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Días</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Uso</th>
          </tr>`;
    
    sanasEnUso.forEach(a => {
      let diasDisplay = (a.diasRestantes === 999999) ? "-" : a.diasRestantes;
      cuerpoHtml += `<tr style="background-color: #ffffff;">
        <td style="padding: 10px; border: 1px solid #ddd;">${a.sitio}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.vencimiento}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${diasDisplay}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.usadas} de ${a.total} (${a.metrica})</td>
      </tr>`;
    });

    sinUso.forEach(a => {
      let diasDisplay = (a.diasRestantes === 999999 || a.diasRestantes < 0) ? "-" : a.diasRestantes;
      cuerpoHtml += `<tr style="background-color: #f2f2f2; color: #666666;">
        <td style="padding: 10px; border: 1px solid #ddd;">${a.sitio}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${a.nombre}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.vencimiento}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${diasDisplay}</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${a.usadas} de ${a.total} (${a.metrica})</td>
      </tr>`;
    });
    cuerpoHtml += `</table></div>`;
  }

  cuerpoHtml += `</div><p style="margin-top: 25px; font-size: 12px; color: #666;">Saludos,<br><b>Wetcom Proactive Center</b></p></div>`;
  
  if (emailsAEnviar) {
    sendEmail({
      to: emailsAEnviar,
      subject: asunto,
      htmlBody: cuerpoHtml,
      name: 'Wetcom Proactive Center'
    });
  }
}

function enviarAlertaSlackDetallada(cliente, alertas) {
  if (typeof SLACK_WEBHOOK_URL === 'undefined') return;
  const vencidas = alertas.filter(a => a.usadas > 0 && a.diasRestantes < 0);
  const proximas = alertas.filter(a => a.usadas > 0 && a.diasRestantes >= 0 && a.diasRestantes <= DIAS_UMBRAL_VENCIMIENTO);
  if (vencidas.length === 0 && proximas.length === 0) return; 
  
  let msg = `*Reporte de Licencias - ${cliente}*\n`;
  if (vencidas.length > 0) msg += `🔴 *CRÍTICO:* ${vencidas.length} licencias vencidas en uso.\n`;
  if (proximas.length > 0) msg += `🟡 *WARNING:* ${proximas.length} próximas a vencer.\n`;
  sendSlackMessage(SLACK_WEBHOOK_URL, msg);
}

/**
 * Crea un menú personalizado en la hoja de cálculo al abrirse.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚀 Wetcom Ops')
    .addItem('Auditar Cliente Seleccionado', 'ejecutarClienteSeleccionado')
    .addToUi();
}

/**
 * Detecta la fila seleccionada por el usuario y ejecuta la auditoría 
 * solo para ese cliente específico.
 */
function ejecutarClienteSeleccionado() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(NOMBRE_PESTANA_CONFIG); // "Licencias"
  
  if (!hoja) {
    ui.alert("❌ Error", `No se encontró la pestaña "${NOMBRE_PESTANA_CONFIG}".`, ui.ButtonSet.OK);
    return;
  }
  
  // 1. Obtener la fila donde el usuario tiene el cursor
  const celdaActiva = hoja.getActiveCell();
  const fila = celdaActiva.getRow();
  
  // Evitar procesar la cabecera (Fila 1)
  if (fila === 1) {
    ui.alert("⚠️ Advertencia", "Por favor, selecciona una fila de cliente válida (Fila 2 en adelante).", ui.ButtonSet.OK);
    return;
  }
  
  // 2. Leer los datos exactos de esa fila según la estructura de tu "Licencias"
  // Columna A: Destinatario | B: PODs | C: Cliente | D: ID Carpeta RVTools
  const rangoFila = hoja.getRange(fila, 1, 1, 4).getValues()[0];
  const emailDestino = rangoFila[0];
  const pod = rangoFila[1];
  const cliente = rangoFila[2];
  const folderId = rangoFila[3];
  
  // 3. Validar que la fila contenga los datos mínimos indispensables
  if (!cliente || !emailDestino || !folderId) {
    ui.alert("⚠️ Fila Incompleta", `La fila ${fila} no tiene configurados todos los campos necesarios (Cliente, Destinatario o ID de Carpeta).`, ui.ButtonSet.OK);
    return;
  }
  
  // 4. Confirmación visual para el operador
  const respuesta = ui.alert(
    "Confirmar Auditoría",
    `¿Deseas lanzar la auditoría individual para el cliente?\n\n• Cliente: ${cliente}\n• POD: ${pod || 'N/A'}\n• Destinatario: ${emailDestino}`,
    ui.ButtonSet.YES_NO
  );
  
  if (respuesta !== ui.Button.YES) {
    console.log("❌ Ejecución individual cancelada por el usuario.");
    return;
  }
  
  // 5. Lanzar el motor para este cliente específico
  console.log(`\n🔎 [Manual Individual] Procesando Fila ${fila} - Cliente: ${cliente} (POD: ${pod})...`);
  
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  
  // Mostrar un Toast/Notificación flotante en el Excel para avisar que inició
  ss.toast(`Procesando licencias de ${cliente}...`, "🚀 Auditoría en Curso", -1);
  
  try {
    const resultado = procesarInfraestructuraCliente(cliente, emailDestino, folderId, pod, summaryReport);
    
    // 6. Informar el resultado en la UI de la planilla
    if (summaryReport.errores.length > 0) {
      ui.alert("❌ Finalizado con Errores", `Hubo un problema al procesar el cliente ${cliente}:\n${summaryReport.errores[0].detalle}`, ui.ButtonSet.OK);
    } else {
      ui.alert("✅ Auditoría Exitosa", `El reporte de ${cliente} ha sido procesado y enviado a ${emailDestino} de forma conforme.`, ui.ButtonSet.OK);
    }
  } catch (error) {
    ui.alert("❌ Error Crítico", `Ocurrió un error inesperado en el motor: ${error.message}`, ui.ButtonSet.OK);
  } finally {
    // Quitar la notificación flotante
    ss.toast("Proceso finalizado.", "🏁 Wetcom Ops", 3);
  }
}
