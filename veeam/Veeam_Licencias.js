/**
 * =================================================================
 * SCRIPT DE AUDITORÍA DE LICENCIAS (VEEAM) - WETCOM (PRODUCCIÓN)
 * LIBRERÍA CORE: "Automatizar Operaciones"
 * =================================================================
 * Lee TODOS los archivos de la subcarpeta YYYY -> YYYYMMDD
 * Pestaña de configuración: "Licencias"
 */

const VEEAM_LIC_OPERATION_NAME = "Auditoría de Licencias Veeam";
const VEEAM_LIC_NOMBRE_PESTANA = "Licencias"; 
const VEEAM_LIC_DIAS_UMBRAL = 90;

// Índices de columna en la pestaña "Licencias" (nueva estructura)
const VEEAM_LIC_COL_EMAIL     = 0; // A: Destinatario
const VEEAM_LIC_COL_POD       = 1; // B: PODs
const VEEAM_LIC_COL_CLIENTE   = 2; // C: Cliente
const VEEAM_LIC_COL_FOLDER    = 4; // E: ID Carpeta Veeam
const VEEAM_LIC_COL_ACTIVO    = 5; // F: Activo (SI/NO)

const VEEAM_LIC_PROP_CICLO    = 'VEEAM_LIC_CICLO';
const VEEAM_LIC_PROP_ENVIADOS = 'VEEAM_LIC_ENVIADOS';
const VEEAM_LIC_PROP_BOOKMARK = 'VEEAM_LIC_BOOKMARK';
const VEEAM_LIC_PROP_REPORTE  = 'VEEAM_LIC_REPORT';
const VEEAM_LIC_LOCK_ESPERA   = 5000;
const VEEAM_LIC_MAX_TIEMPO    = 270000;

// 1. Ejecución Manual On-Demand (Ignora el calendario)
function ejecutarManualVeeamLic() {
  console.log("🚀 Iniciando ejecución manual Veeam...");
  procesarTodasLasLicenciasVeeam({ nuevoCiclo: true, forzar: true });
}

// 2. Instalador del Trigger
function instalarTriggerVeeamLic() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'gatilloDiarioVeeamLic') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('gatilloDiarioVeeamLic').timeBased().everyDays(1).atHour(8).create();
  console.log("✅ Trigger Diario Veeam (Guardián) instalado a las 8 AM.");
}

// 3. El Guardián (Se ejecuta todos los días pero solo avanza el último día hábil)
function gatilloDiarioVeeamLic() {
  if (typeof esUltimoDiaHabilMes === "function" && esUltimoDiaHabilMes()) {
    console.log("📅 HOY ES EL ÚLTIMO DÍA HÁBIL DEL MES. Iniciando auditoría Veeam...");
    procesarTodasLasLicenciasVeeam({ nuevoCiclo: true });
  } else {
    console.log("💤 Hoy no es el último día hábil del mes. Abortando ejecución Veeam.");
  }
}

// 4. El Resucitador (Usado cuando el script se corta por Time-Out)
function continuarProcesamientoVeeamLic() {
  console.log("🔄 Reanudando procesamiento Veeam desde el marcapáginas...");
  procesarTodasLasLicenciasVeeam({ nuevoCiclo: false });
}

function limpiarTriggersContinuacionVeeamLic() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'continuarProcesamientoVeeamLic') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function resetearCicloVeeamLic() {
  const props = PropertiesService.getScriptProperties();
  [VEEAM_LIC_PROP_CICLO, VEEAM_LIC_PROP_BOOKMARK, VEEAM_LIC_PROP_REPORTE, VEEAM_LIC_PROP_ENVIADOS].forEach(p => props.deleteProperty(p));
  limpiarTriggersContinuacionVeeamLic();
  console.log("🧹 Estado del ciclo Veeam reseteado.");
}

// ── MOTOR PRINCIPAL ──
function procesarTodasLasLicenciasVeeam(opciones) {
  const opts = opciones || { nuevoCiclo: false, forzar: false };
  const tiempoInicio = Date.now();
  const props = PropertiesService.getScriptProperties();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(VEEAM_LIC_LOCK_ESPERA)) {
    console.warn("🔒 Ya hay otra ejecución de licencias Veeam en curso. Abortando.");
    return;
  }

  try {
    const ciclo = typeof cicloActual === "function" ? cicloActual() : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");

    if (opts.nuevoCiclo) {
      if (!opts.forzar && props.getProperty(VEEAM_LIC_PROP_CICLO) === ciclo) {
        console.warn(🛑 El ciclo Veeam  ya fue iniciado. Abortando.);
        return;
      }
      console.log(🆕 Arrancando ciclo Veeam .);
      limpiarTriggersContinuacionVeeamLic();
      props.setProperty(VEEAM_LIC_PROP_CICLO, ciclo);
      props.deleteProperty(VEEAM_LIC_PROP_BOOKMARK);
      props.deleteProperty(VEEAM_LIC_PROP_REPORTE);
      props.deleteProperty(VEEAM_LIC_PROP_ENVIADOS);
    }

    let ss;
    try {
      const ID_HOJA = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID") || "1ZriSQeckRp_hWXS0X-CdGzrnnplCj2KmcLHgAbXo6qU";
      ss = SpreadsheetApp.openById(ID_HOJA);
    } catch (e) {
      console.error("❌ Error: No se pudo abrir el Índice General.");
      return;
    }
    const hoja = ss.getSheetByName(VEEAM_LIC_NOMBRE_PESTANA);
    if (!hoja) return;
    const datos = hoja.getDataRange().getValues();

    let indexInicial = parseInt(props.getProperty(VEEAM_LIC_PROP_BOOKMARK)) || 1;
    let summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };

    const reporteGuardado = props.getProperty(VEEAM_LIC_PROP_REPORTE);
    if (reporteGuardado) summaryReport = JSON.parse(reporteGuardado);

    let rawEnviados = props.getProperty(VEEAM_LIC_PROP_ENVIADOS);
    const enviados = new Set(rawEnviados ? JSON.parse(rawEnviados) : []);

    for (let i = indexInicial; i < datos.length; i++) {
      if (Date.now() - tiempoInicio > VEEAM_LIC_MAX_TIEMPO) {
        console.warn(⏳ TIEMPO LÍMITE ALCANZADO (Fila ). Guardando marcapáginas Veeam...);
        props.setProperty(VEEAM_LIC_PROP_BOOKMARK, i.toString());
        props.setProperty(VEEAM_LIC_PROP_REPORTE, JSON.stringify(summaryReport));
        ScriptApp.newTrigger('continuarProcesamientoVeeamLic').timeBased().after(60 * 1000).create();
        return;
      }

      const emailDestino = datos[i][VEEAM_LIC_COL_EMAIL];
      const pod = datos[i][VEEAM_LIC_COL_POD];
      const cliente = datos[i][VEEAM_LIC_COL_CLIENTE];
      const folderId = datos[i][VEEAM_LIC_COL_FOLDER];
      const activo = (datos[i][VEEAM_LIC_COL_ACTIVO] || "").toString().trim().toUpperCase();

      if (!cliente || !emailDestino || !folderId) continue;
      if (activo === "NO") {
        console.log(⏭️ Fila  - : INACTIVO. Se omite.);
        continue;
      }

      const marca = ${i}|;
      if (enviados.has(marca)) {
        console.log(↩️ Fila  - : ya notificado. Se omite.);
        continue;
      }

      console.log(\n🔎 Procesando fila  - Cliente:  (Veeam)...);
      const erroresAntes = summaryReport.errores.length;
      procesarInfraestructuraClienteVeeam(cliente, emailDestino, folderId, pod, summaryReport);

      if (summaryReport.errores.length === erroresAntes) {
        enviados.add(marca);
        props.setProperty(VEEAM_LIC_PROP_ENVIADOS, JSON.stringify(Array.from(enviados)));
      }

      props.setProperty(VEEAM_LIC_PROP_BOOKMARK, (i + 1).toString());
      props.setProperty(VEEAM_LIC_PROP_REPORTE, JSON.stringify(summaryReport));
    }

    console.log("\n🏁 CICLO DE AUDITORÍA VEEAM FINALIZADO.");
    props.deleteProperty(VEEAM_LIC_PROP_BOOKMARK);
    props.deleteProperty(VEEAM_LIC_PROP_REPORTE);
    props.deleteProperty(VEEAM_LIC_PROP_ENVIADOS);

    if (typeof enviarResumenSlack === "function" && (summaryReport.errores.length > 0 || summaryReport.exitos.length > 0)) {
      enviarResumenSlack(VEEAM_LIC_OPERATION_NAME, summaryReport);
    }
  } finally {
    lock.releaseLock();
  }
}

function procesarInfraestructuraClienteVeeam(cliente, emailDestino, rootFolderId, pod, summaryReport) {
  let rutaLog = "";
  let nombresArchivos = [];
  try {
    const rootFolder = DriveApp.getFolderById(rootFolderId);
    const anioFolder = typeof obtenerSubcarpetaMasReciente === "function" ? obtenerSubcarpetaMasReciente(rootFolder, /^\d{4}/) : rootFolder.getFolders().next();
    if (!anioFolder) throw new Error("No se encontró carpeta de Año (YYYY)");
    const fechaFolder = typeof obtenerSubcarpetaMasReciente === "function" ? obtenerSubcarpetaMasReciente(anioFolder, /^\d{8}/) : anioFolder.getFolders().next();
    if (!fechaFolder) throw new Error(No se encontró carpeta de Fecha en );

    rutaLog = ${anioFolder.getName()} > ;
    console.log(📂 Ruta resuelta Veeam: );

    const files = fechaFolder.getFiles();
    let archivosAProcesar = [];
    while (files.hasNext()) {
      let file = files.next();
      let name = file.getName().toLowerCase();
      if (name.endsWith(".csv")) {
        archivosAProcesar.push(file);
        nombresArchivos.push(file.getName());
      }
    }

    if (archivosAProcesar.length === 0) throw new Error(Sin archivos CSV válidos en la ruta);
    
    let todasLasLicenciasCliente = [];

    for (const file of archivosAProcesar) {
      console.log(⏳ [] Leyendo CSV: );
      const content = file.getBlob().getDataAsString();
      let parsedData;
      if (typeof parseCsvDeReporte === "function") {
        parsedData = parseCsvDeReporte(content, file.getName());
      } else {
        throw new Error("Librería de parseo CSV no encontrada.");
      }
      
      const licenciasArchivo = analizarLicenciasVeeam(parsedData, cliente);
      todasLasLicenciasCliente = todasLasLicenciasCliente.concat(licenciasArchivo);
    }

    let licenciasUnicas = [];
    let setDuplicados = new Set();
    todasLasLicenciasCliente.forEach(lic => {
      let key = ${lic.servidor}|||||;
      if (!setDuplicados.has(key)) {
        setDuplicados.add(key);
        licenciasUnicas.push(lic);
      }
    });

    if (licenciasUnicas.length > 0) {
      console.log(📧 Despachando reporte Veeam de  a  ( licencias procesadas).);
      enviarAlertaLicenciasVeeam(cliente, emailDestino, licenciasUnicas);
      enviarAlertaSlackVeeamLic(cliente, licenciasUnicas);
    } else {
      console.warn(⚠️ [] Archivo procesado pero no se encontraron datos de licencias válidos.);
      summaryReport.advertencias.push({ ticket: "-", problema: [] CSV vacío o formato inválido, accion: "Revisar archivo en Drive" });
    }
    
    summaryReport.exitos.push({ mensaje: **: Reporte Veeam OK });
    return { ruta: rutaLog, archivos: nombresArchivos.join("\n") };

  } catch (e) {
    console.error(❌ [] Error Veeam: );
    summaryReport.errores.push({ error: Fallo , detalle: e.message });
    return { ruta: rutaLog || "Error", archivos: nombresArchivos.length > 0 ? nombresArchivos.join("\n") : "Ninguno" };
  }
}

function normalizarColumnaVeeam(texto) {
  return texto.toString().trim().toLowerCase().replace(/[\s\-_]+/g, '');
}

function analizarLicenciasVeeam(parsedData, clienteFallback) {
  if (!parsedData || parsedData.length < 2) return [];

  const rawHeaders = parsedData[0];
  const headers = rawHeaders.map(h => normalizarColumnaVeeam(h));

  const map = {
    server:     ["server", "servidor", "vbrserver", "hostname"],
    edition:    ["edition", "licenseedition", "edición", "product"],
    type:       ["type", "licensetype", "tipo"],
    status:     ["status", "estado"],
    expiration: ["expirationdate", "expiration", "vencimiento"],
    licensed:   ["licensedinstances", "total", "capacity", "licensedsocketsnumber", "licensedsockets"],
    used:       ["usedinstances", "used", "consumidas", "usedsocketsnumber", "usedsockets"],
    workload:   ["workloadtype", "workload", "carga"]
  };

  const findIdx = (aliasArr) => headers.findIndex(h => aliasArr.includes(h));

  const idx = {
    server: findIdx(map.server),
    edition: findIdx(map.edition),
    type: findIdx(map.type),
    status: findIdx(map.status),
    expiration: findIdx(map.expiration),
    licensed: findIdx(map.licensed),
    used: findIdx(map.used),
    workload: findIdx(map.workload)
  };

  if (idx.edition === -1 || idx.licensed === -1 || idx.used === -1) {
    console.warn("⚠️ Faltan columnas críticas en el CSV de Veeam. Columnas encontradas:", rawHeaders);
    return [];
  }

  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  const licencias = [];

  for (let i = 1; i < parsedData.length; i++) {
    const row = parsedData[i];
    if (!row || row.length < 2) continue;

    const edition = (row[idx.edition] || "").toString().trim();
    if (!edition) continue;

    const server = idx.server !== -1 ? (row[idx.server] || clienteFallback) : clienteFallback;
    const type = idx.type !== -1 ? (row[idx.type] || "Desconocido") : "Desconocido";
    const status = idx.status !== -1 ? (row[idx.status] || "") : "";
    const workload = idx.workload !== -1 ? (row[idx.workload] || "General") : "General";
    
    let rawUsed = row[idx.used];
    let rawLic = row[idx.licensed];
    let usedNum = typeof normalizarNumero === "function" ? normalizarNumero(rawUsed, rawUsed) : parseInt(rawUsed) || 0;
    let licNum = typeof normalizarNumero === "function" ? normalizarNumero(rawLic, rawLic) : parseInt(rawLic) || 0;
    
    let rawExp = idx.expiration !== -1 ? (row[idx.expiration] || "").toString().trim() : "";
    let diasRestantes = 999999;

    if (rawExp.toLowerCase() !== "" && rawExp.toLowerCase() !== "never") {
      let dStr = rawExp.split(" ")[0];
      let expDate = null;
      if (typeof interpretarFecha === "function") {
        expDate = interpretarFecha(dStr);
      } else {
        let parsed = new Date(dStr);
        if (!isNaN(parsed.getTime())) expDate = { obj: parsed };
      }
      
      if (expDate) {
        expDate.obj.setHours(0,0,0,0);
        diasRestantes = Math.ceil((expDate.obj.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
      } else {
        // Fallback robusto para ISO/YYYY-MM-DD
        let parts = dStr.split(/[\/\-]/);
        if (parts.length >= 3) {
          let y = parseInt(parts[0]), m = parseInt(parts[1]), d = parseInt(parts[2]);
          if (y > 2000) {
            let dt = new Date(y, m-1, d);
            diasRestantes = Math.ceil((dt.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
          }
        }
      }
    }

    if (status.toLowerCase().includes("expired")) diasRestantes = -1;

    licencias.push({
      servidor: server,
      nombre: edition,
      tipo: type,
      vencimiento: rawExp || "Never",
      diasRestantes: diasRestantes,
      usadas: usedNum,
      total: licNum,
      workload: workload
    });
  }

  return licencias;
}

function enviarAlertaLicenciasVeeam(cliente, destinatarioRaw, todasLasLicencias) {
  const emailsAEnviar = destinatarioRaw.toString().split(',').map(e => e.trim()).filter(e => e !== "").join(',');
  
  const vencidas = todasLasLicencias.filter(a => a.usadas > 0 && a.diasRestantes < 0);
  const proximas = todasLasLicencias.filter(a => a.usadas > 0 && a.diasRestantes >= 0 && a.diasRestantes <= VEEAM_LIC_DIAS_UMBRAL);
  const sanasEnUso = todasLasLicencias.filter(a => a.usadas > 0 && a.diasRestantes > VEEAM_LIC_DIAS_UMBRAL);
  const sinUso = todasLasLicencias.filter(a => a.usadas === 0);

  const sortServidorDias = (a, b) => {
    if (a.servidor < b.servidor) return -1;
    if (a.servidor > b.servidor) return 1;
    return a.diasRestantes - b.diasRestantes;
  };

  vencidas.sort(sortServidorDias);
  proximas.sort(sortServidorDias);
  sanasEnUso.sort(sortServidorDias);
  sinUso.sort(sortServidorDias);

  const todoOK = (vencidas.length === 0 && proximas.length === 0);

  let colorHeader = "#5cb85c"; // Verde
  let iconoHeader = "✅";
  let statusTxt = "Auditoría Exitosa";
  let situacionTxt = "Todas las licencias de Veeam en uso se encuentran vigentes.";

  if (vencidas.length > 0) {
    colorHeader = "#d9534f";
    iconoHeader = "❌";
    statusTxt = "Licencias Veeam Vencidas";
    situacionTxt = "Se requiere acción inmediata para renovar licencias expiradas en uso.";
  } else if (proximas.length > 0) {
    colorHeader = "#f0ad4e";
    iconoHeader = "⚠️";
    statusTxt = "Atención: Licencias Veeam Próximas a Vencer";
    situacionTxt = "Se han detectado licencias en uso que vencerán en el corto plazo.";
  }

  const fechaHoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy");
  const asunto = ${iconoHeader} Estado de Licencias Veeam - Wetcom /  - ;
  
  let cuerpoHtml = \
  <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; max-width: 850px;">
    <div style="border: 1px solid #ddd; border-left: 6px solid \; padding: 20px; background-color: #f9f9f9; border-radius: 4px;">
      <h2 style="margin-top: 0; color: \; font-size: 18px;">\</h2>
      <p style="font-size: 14px;">Auditoría Veeam completa para <b>\</b>.</p>
      <p style="font-size: 14px;"><b>Situación:</b> \</p>
  \;

  const formatUso = (u, t, w) => {
    let un = typeof formatearNumero === "function" ? formatearNumero(u) : u;
    let tn = typeof formatearNumero === "function" ? formatearNumero(t) : t;
    return \\ de \ (\)\;
  };

  const formatTable = (titulo, items, bgHeader, colorHeader, bgSub, colorSub) => {
    if (items.length === 0) return "";
    let html = \
      <div style="margin-top: 20px;">
        <table style="border-collapse: collapse; width: 100%; background-color: white; font-size: 13px; border: 1px solid #ddd;">
          <tr style="background-color: \; color: \;">
            <th colspan="6" style="padding: 10px; border: 1px solid #ddd; text-align: left; font-size: 14px;">\</th>
          </tr>
          <tr style="background-color: \; color: \;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Servidor</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Licencia</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Tipo</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Vencimiento</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Días</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Uso</th>
          </tr>\;
    items.forEach(a => {
      let isCrit = (a.diasRestantes < 0);
      let diasDisplay = (a.diasRestantes === 999999) ? "-" : (isCrit ? "VENCIDA" : a.diasRestantes);
      let rowColor = a.usadas === 0 ? "color: #666; background-color: #f2f2f2;" : "background-color: #fff;";
      
      html += \<tr style="\">
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">\</td>
        <td style="padding: 10px; border: 1px solid #ddd;">\</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">\</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; \">\</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center; \">\</td>
        <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">\</td>
      </tr>\;
    });
    html += \</table></div>\;
    return html;
  };

  cuerpoHtml += formatTable("CRÍTICO - LICENCIAS VENCIDAS (EN USO)", vencidas, "#d9534f", "white", "#fdf7f7", "#761c19");
  cuerpoHtml += formatTable("ATENCIÓN - PRÓXIMAS A VENCER", proximas, "#f0ad4e", "white", "#fcf8f2", "#8a6d3b");
  
  if (sanasEnUso.length > 0 || sinUso.length > 0) {
    let bgH = todoOK ? "#5cb85c" : "#e2e3e5"; 
    let colH = todoOK ? "white" : "#495057";
    let bgS = todoOK ? "#f9fdf9" : "#f8f9fa";
    let colS = todoOK ? "#2b542c" : "#495057";
    cuerpoHtml += formatTable("SALUDABLE - ESTADO OK / NO UTILIZADAS", sanasEnUso.concat(sinUso), bgH, colH, bgS, colS);
  }

  cuerpoHtml += \</div><p style="margin-top: 25px; font-size: 12px; color: #666;">Saludos,<br><b>Wetcom Proactive Center</b></p></div>\;
  
  if (emailsAEnviar) {
    if (typeof sendEmail === "function") {
      sendEmail({ to: emailsAEnviar, subject: asunto, htmlBody: cuerpoHtml, name: 'Wetcom Proactive Center' });
    } else {
      GmailApp.sendEmail(emailsAEnviar, asunto, "", { htmlBody: cuerpoHtml, name: 'Wetcom Proactive Center' });
    }
  }
}

function enviarAlertaSlackVeeamLic(cliente, alertas) {
  if (typeof SLACK_WEBHOOK_URL === 'undefined' || typeof sendSlackMessage !== 'function') return;
  const vencidas = alertas.filter(a => a.usadas > 0 && a.diasRestantes < 0);
  const proximas = alertas.filter(a => a.usadas > 0 && a.diasRestantes >= 0 && a.diasRestantes <= VEEAM_LIC_DIAS_UMBRAL);
  if (vencidas.length === 0 && proximas.length === 0) return; 
  
  let msg = \*Reporte de Licencias Veeam - \*\n\;
  if (vencidas.length > 0) msg += \🔴 *CRÍTICO:* \ licencias vencidas en uso.\n\;
  if (proximas.length > 0) msg += \🟡 *WARNING:* \ próximas a vencer.\n\;
  sendSlackMessage(SLACK_WEBHOOK_URL, msg);
}

function ejecutarClienteSeleccionadoVeeamLic() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(VEEAM_LIC_NOMBRE_PESTANA);
  if (!hoja) return ui.alert("❌ Error", "No se encontró la pestaña.", ui.ButtonSet.OK);
  
  const fila = hoja.getActiveCell().getRow();
  if (fila === 1) return ui.alert("⚠️ Advertencia", "Selecciona una fila válida.", ui.ButtonSet.OK);
  
  const rangoFila = hoja.getRange(fila, 1, 1, 6).getValues()[0];
  const emailDestino = rangoFila[VEEAM_LIC_COL_EMAIL];
  const pod = rangoFila[VEEAM_LIC_COL_POD];
  const cliente = rangoFila[VEEAM_LIC_COL_CLIENTE];
  const folderId = rangoFila[VEEAM_LIC_COL_FOLDER];
  const activo = (rangoFila[VEEAM_LIC_COL_ACTIVO] || "").toString().trim().toUpperCase();
  
  if (!cliente || !emailDestino || !folderId) {
    return ui.alert("⚠️ Fila Incompleta", "Faltan datos de Veeam para este cliente.", ui.ButtonSet.OK);
  }
  if (activo === "NO") {
    return ui.alert("⚠️ Cliente Inactivo", "El cliente está inactivo.", ui.ButtonSet.OK);
  }
  
  const respuesta = ui.alert("Confirmar", \¿Auditar Veeam para \?\, ui.ButtonSet.YES_NO);
  if (respuesta !== ui.Button.YES) return;
  
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  ss.toast(\Procesando licencias Veeam de \...\, "🚀 Auditoría en Curso", -1);
  
  try {
    const res = procesarInfraestructuraClienteVeeam(cliente, emailDestino, folderId, pod, summaryReport);
    if (summaryReport.errores.length > 0) {
      ui.alert("❌ Errores", summaryReport.errores[0].detalle, ui.ButtonSet.OK);
    } else {
      ui.alert("✅ Éxito", \Reporte enviado a \.\, ui.ButtonSet.OK);
    }
  } catch (error) {
    ui.alert("❌ Error Crítico", error.message, ui.ButtonSet.OK);
  } finally {
    ss.toast("Proceso finalizado.", "🏁 Wetcom Ops", 3);
  }
}