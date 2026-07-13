/**
 * =================================================================
 * SCRIPT ORQUESTADOR / MOTOR DE ENVÍO (VERSIÓN MULTI-TECNOLOGÍA)
 * =================================================================
 */

// --- 1. CONFIGURACIÓN GLOBAL ---
const JIRA_FILTER_VSPHERE = PropertiesService.getScriptProperties().getProperty("JIRA_FILTER_VSPHERE_DIARIO"); 
const JIRA_FILTER_VEEAM   = PropertiesService.getScriptProperties().getProperty("JIRA_FILTER_VEEAM");   
const JIRA_FILTER_NUTANIX = PropertiesService.getScriptProperties().getProperty("JIRA_FILTER_NUTANIX"); // <-- NUEVO FILTRO
const EMAIL_CC_GLOBAL     = "wpc@wetcom.com";

// --- 2. FUNCIONES DE EJECUCIÓN ---

function ejecutarReporteVsphere() {
  Logger.log("--- Iniciando Reporte vSphere (posible Horizon) ---");
  const tickets = generarReporteDiarioDeTickets(JIRA_FILTER_VSPHERE);
  const consumo = generarReporteConsumoVsphere();
  motorDeEnvio("vSphere", tickets, consumo);
}

function ejecutarReporteVeeam() {
  Logger.log("--- Iniciando Reporte Veeam ---");
  const tickets = generarReporteDiarioDeTickets(JIRA_FILTER_VEEAM);
  motorDeEnvio("Veeam", tickets, null);
}

function ejecutarReporteNutanix() {
  Logger.log("--- Iniciando Reporte Nutanix ---");
  const tickets = generarReporteDiarioDeTickets(JIRA_FILTER_NUTANIX);
  motorDeEnvio("Nutanix", tickets, null);
}

// --- 3. MOTOR DE ENVÍO ---

function motorDeEnvio(tecnologiaProcesada, datosTickets, datosConsumo) {
  const llavesSoporte = obtenerLlavesDeSoporte(); // Traemos las keys del Excel
  const hoy = new Date();
  const esSemanal = (hoy.getDay() === 5); // Corregido a 5 (Viernes)
  const fechaFormateada = Utilities.formatDate(hoy, "GMT-3", "dd/MM/yyyy");

  const { mapaUnificado, mapaEmpresaPod, mapaEmpresaTecs } = obtenerConfiguracionIndice();
  const listaTodasEmpresas = [...new Set(Object.values(mapaUnificado))];
  const reporteFinal = {}; 

  listaTodasEmpresas.forEach(empresa => {
    reporteFinal[empresa] = { tickets: [], consumo: [] };
  });

  for (const equipo in datosTickets) {
    for (const nombreJira in datosTickets[equipo]) {
      const nombreEmpresa = mapaUnificado[nombreJira] || nombreJira;
      if (!reporteFinal[nombreEmpresa]) reporteFinal[nombreEmpresa] = { tickets: [], consumo: [] };
      const tecnologiasJira = datosTickets[equipo][nombreJira];
      for (const tec in tecnologiasJira) {
        reporteFinal[nombreEmpresa].tickets = reporteFinal[nombreEmpresa].tickets.concat(tecnologiasJira[tec]);
      }
    }
  }

  if (tecnologiaProcesada === "vSphere" && datosConsumo) {
    datosConsumo.forEach(item => {
      const nombreEmpresa = mapaUnificado[item.clientName] || item.clientName;
      if (reporteFinal[nombreEmpresa]) {
        reporteFinal[nombreEmpresa].consumo = reporteFinal[nombreEmpresa].consumo.concat(item.alerts);
      }
    });
  }

  for (const empresa in reporteFinal) {
    const tecsHabilitadas = (mapaEmpresaTecs[empresa] || "").toLowerCase();
    const techBuscada = tecnologiaProcesada.toLowerCase();

    if (!tecsHabilitadas.includes(techBuscada)) {
      continue;
    }

    let nombreTecnicaMail = tecnologiaProcesada;
    let introTexto = `reporte de operaciones de ${tecnologiaProcesada}`;
    let esCombinadoHorizon = false;

    if (tecnologiaProcesada === "vSphere" && tecsHabilitadas.includes("horizon")) {
      nombreTecnicaMail = "vSphere/Horizon";
      introTexto = "reporte de operaciones de vSphere y Horizon";
      esCombinadoHorizon = true;
    }

    const datos = reporteFinal[empresa];
    const equipoPOD = mapaEmpresaPod[empresa];
    if (!equipoPOD) continue;

    const emailDestino = `${equipoPOD.toLowerCase().trim()}@wetcom.com`;
    let htmlErrores = "";
    let htmlAdvertencias = "";
    
    datos.tickets.forEach(t => {
      const linea = `<li>${t.summary}. <b>Ticket:</b> <a href="${t.link}">${t.key}</a></li>`;
      
      // Si la Key del proyecto del ticket está en nuestra lista de Soporte, es un Error (❌)
      if (llavesSoporte.includes(t.projectKey.toUpperCase())) {
        htmlErrores += linea;
      } else {
        // Si no está en Soporte, asumimos que es Operaciones (Advertencia ⚠️)
        htmlAdvertencias += linea;
      }
    });
    if (datos.consumo.length > 0) {
      const alertasAgrupadas = {};
      datos.consumo.forEach(a => {
        const frase = a.alarm || "Alerta de consumo";
        if (!alertasAgrupadas[frase]) alertasAgrupadas[frase] = [];
        alertasAgrupadas[frase].push(a.object);
      });
      for (const frase in alertasAgrupadas) {
        htmlAdvertencias += `<li><b>${frase}</b><ul>`;
        [...new Set(alertasAgrupadas[frase])].forEach(obj => htmlAdvertencias += `<li>${obj}</li>`);
        htmlAdvertencias += `</ul></li>`;
      }
    }

    const tieneErrores = htmlErrores !== "";
    const tieneAdvertencias = htmlAdvertencias !== "";
    const emoji = tieneErrores ? "❌" : (tieneAdvertencias ? "⚠️" : "✅");
    const tipoReporte = esSemanal ? "Diarias y Semanales" : "Diarias";
    const asunto = `${emoji} Operaciones ${tipoReporte} - Wetcom / ${empresa} - ${nombreTecnicaMail} - ${fechaFormateada}`;

    let htmlBody = `<div style="font-family: Calibri, sans-serif; color: #333; font-size: 11pt;">
        <p>Estimados, buenos días. Espero que se encuentren bien.</p>
        <p>Envío a continuación el ${introTexto} correspondientes al día de la fecha.</p>`;

    if (esCombinadoHorizon) {
      htmlBody += `<p><b>Ambiente vSphere/Horizon:</b></p>`;
    }

    if (tieneErrores) {
      htmlBody += `<p><b style="color: #d9534f; font-size: 12pt;">❌ Errores detectados:</b></p><ul>${htmlErrores}</ul>`;
      if (tieneAdvertencias) htmlBody += `<p><b style="color: #f0ad4e; font-size: 12pt;">⚠️ Advertencias detectadas:</b></p><ul>${htmlAdvertencias}</ul>`;
    } else if (tieneAdvertencias) {
      htmlBody += `<p><b style="color: #f0ad4e; font-size: 12pt;">⚠️ Warnings detectados</b></p><ul>${htmlAdvertencias}</ul>`;
    } else {
      htmlBody += `<p style="color: #5cb85c; font-weight: bold; font-size: 12pt;">✅ No se detectaron anomalías.</p>`;
    }

    if (tecnologiaProcesada === "Veeam") {
      htmlBody += `<br><p><b>Adicionalmente:</b> se adjuntan reportes de Veeam.</p>`;
    } else if (tecnologiaProcesada === "Nutanix") {
      htmlBody += ``; // Agregado
    } else if (tecnologiaProcesada === "vSphere" && esSemanal) {
      htmlBody += `<br><p><b>Adicionalmente:</b> se adjuntan reportes de ${nombreTecnicaMail}.</p>`;
    }

    htmlBody += `<br><p>Ante cualquier duda o consulta, estamos a su disposición.</p><p>Saludos cordiales.</p></div>`;

    GmailApp.sendEmail(emailDestino, asunto, "", { 
      htmlBody: htmlBody,
      cc: EMAIL_CC_GLOBAL 
    });
    
    Logger.log(`Reporte [${nombreTecnicaMail}] enviado para ${empresa} (CC: ${EMAIL_CC_GLOBAL})`);
  }
}

function obtenerConfiguracionIndice() {
  const mapaUnificado = {};
  const mapaEmpresaPod = {};
  const mapaEmpresaTecs = {}; 
  try {
    const sheet = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0];
    const datos = sheet.getRange("B2:M" + sheet.getLastRow()).getValues();
    datos.forEach(fila => {
      const nombreJira = fila[0];      
      const equipoPOD = fila[7];       
      const nombreReporte = fila[10];  
      const serviciosM = fila[11];     
      if (nombreJira && nombreReporte) {
        const empUnificada = nombreReporte.trim();
        mapaUnificado[nombreJira.trim()] = empUnificada;
        if (equipoPOD) mapaEmpresaPod[empUnificada] = equipoPOD.trim();
        if (serviciosM) mapaEmpresaTecs[empUnificada] = String(serviciosM).trim();
      }
    });
  } catch (e) {
    Logger.log("Error leyendo el Índice: " + e.message);
  }
  return { mapaUnificado, mapaEmpresaPod, mapaEmpresaTecs };
}
