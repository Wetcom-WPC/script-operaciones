/** 
 * ================================================================
 * SCRIPT AUDITOR DE CORREOS DE OPERACIONES POR TECNOLOGÍA (9:45 AM)
 * ================================================================
 */

const WEBHOOKS_POR_POD = {
  "POD1":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AUDITOR_POD_1"),
  "POD2":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AUDITOR_POD_2"),
  "POD3":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AUDITOR_POD_3"),
  "POD4":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AUDITOR_POD_4"),
  "POD5":    PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AUDITOR_POD_5"),
  "DEFAULT": PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL")
};

const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
const HOJA_INDICE = "Sheet1";
const HOJA_ADJUNTOS = "Adjuntos";

// --- LISTA DE CORREOS VÁLIDOS (Evita pruebas internas a wpc@) ---
const CORREOS_PODS = ["pod1@wetcom.com", "pod2@wetcom.com", "pod3@wetcom.com", "pod4@wetcom.com", "pod5@wetcom.com"];

function auditarMailsOperaciones() {
  const hoy = new Date();
  const diaDeLaSemana = hoy.getDay();

  // FRENO DE FIN DE SEMANA
  if (diaDeLaSemana === 0 || diaDeLaSemana === 6) {
    Logger.log("Hoy es fin de semana. El auditor no trabajará hoy.");
    return; 
  }

   // ---> NUEVO: EL PATOVICA DE FERIADOS <---
  if (esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado en el calendario de Alarmas Wetcom.");
    borrarActivadorTemporal(); // Super importante para cortar la cadena de triggers
    return;
  }

  Logger.log("--- INICIANDO AUDITORÍA DE MAILS (NIVEL TECNOLOGÍA) ---");
  
  let spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    Logger.log("Error crítico al abrir la spreadsheet: " + e.message);
    return;
  }

  const clientesPorPod = {};

  // 1. LEEMOS LA HOJA PRINCIPAL
  const hojaPrincipal = spreadsheet.getSheetByName(HOJA_INDICE);
  if (!hojaPrincipal) {
    Logger.log(`No se encontró la hoja principal: ${HOJA_INDICE}`);
    return;
  }

  procesarHoja(hojaPrincipal, clientesPorPod, "HOJA PRINCIPAL");

  // 2. LEEMOS LA HOJA ADJUNTOS
  const hojaAdjuntos = spreadsheet.getSheetByName(HOJA_ADJUNTOS);
  if (hojaAdjuntos) {
    procesarHoja(hojaAdjuntos, clientesPorPod, "HOJA ADJUNTOS");
  } else {
    Logger.log(`No se encontró la hoja secundaria: ${HOJA_ADJUNTOS}. Se continúa solo con ${HOJA_INDICE}.`);
  }

  // 3. BUSCAMOS EN GMAIL LA "REALIDAD"
  const fechaBusqueda = Utilities.formatDate(hoy, "GMT-3", "yyyy/MM/dd");
  const fechaAsuntoExacta = Utilities.formatDate(hoy, "GMT-3", "dd/MM/yyyy");
  
  Logger.log(`[BÚSQUEDA GMAIL] Fecha requerida en el Asunto: ${fechaAsuntoExacta}`);

  const query = `subject:"Operaciones" subject:"Wetcom" after:${fechaBusqueda}`;
  const hilos = GmailApp.search(query);
  
  Logger.log(`[BÚSQUEDA GMAIL] Hilos encontrados en la bandeja: ${hilos.length}`);

  const enviosReales = {};

  hilos.forEach(hilo => {
    const mensajes = hilo.getMessages();

    mensajes.forEach(mensaje => {
      const asunto = mensaje.getSubject();
      const destinatarioPara = (mensaje.getTo() || "").toLowerCase();
      
      Logger.log(`\n📧 Evaluando Correo: "${asunto}"`);
      Logger.log(`   └─ Campo Para (To): ${destinatarioPara}`);
      
      if (asunto.includes("Operaciones") && asunto.includes("- Wetcom /")) {
         
         if (!asunto.includes(fechaAsuntoExacta)) {
            Logger.log(`   🚫 DESCARTADO: El asunto no contiene la fecha estricta de hoy (${fechaAsuntoExacta}).`);
            return; 
         }

         // Verifica si alguno de los correos válidos está incluido en el destinatario
         const enviadoAUnPod = CORREOS_PODS.some(correoPod => destinatarioPara.includes(correoPod));
         
         if (!enviadoAUnPod) {
            Logger.log(`   🚫 DESCARTADO: Fue enviado a pruebas u otros destinatarios (${destinatarioPara}), no a los correos oficiales de los PODs.`);
            return; 
         }

         const partes = asunto.split("- Wetcom /");
         if (partes.length > 1) {
            const restoDelAsunto = partes[1]; 
            const subPartes = restoDelAsunto.split("-");
            
            if (subPartes.length >= 2) {
                const nombreCliente = subPartes[0].trim().toLowerCase(); 
                const tecnologiaMail = subPartes[1].trim().toLowerCase();
                
                Logger.log(`   ✅ ACEPTADO: Mapeado al cliente "${nombreCliente}" con tecnología "${tecnologiaMail}".`);

                if (!enviosReales[nombreCliente]) enviosReales[nombreCliente] = [];

                if (tecnologiaMail.includes("vsphere") && !enviosReales[nombreCliente].includes("vSphere")) {
                    enviosReales[nombreCliente].push("vSphere");
                }
                if (tecnologiaMail.includes("veeam") && !enviosReales[nombreCliente].includes("Veeam")) {
                    enviosReales[nombreCliente].push("Veeam");
                }
                if (tecnologiaMail.includes("nutanix") && !enviosReales[nombreCliente].includes("Nutanix")) {
                    enviosReales[nombreCliente].push("Nutanix");
                }
                if (tecnologiaMail.includes("horizon") && !enviosReales[nombreCliente].includes("Horizon")) {
                    enviosReales[nombreCliente].push("Horizon");
                }
            } else {
                Logger.log(`   ⚠️ FORMATO DESCONOCIDO: No se pudo separar cliente y tecnología en "${restoDelAsunto}".`);
            }
         }
      } else {
         Logger.log(`   🚫 DESCARTADO: No cumple con la estructura de palabras clave.`);
      }
    });
  });

  // 4. CRUZAMOS LOS DATOS Y AVISAMOS POR POD
  Logger.log("\n--- GENERANDO REPORTES PARA SLACK ---");

  for (const pod in clientesPorPod) {
     const webhookUrl = WEBHOOKS_POR_POD[pod];
     if (!webhookUrl) continue;

     const listaIdeal = clientesPorPod[pod];
     
     const completos = [];
     const parciales = [];
     const faltantes = [];

     for (const cliente in listaIdeal) {
        const tecsEsperadas = listaIdeal[cliente]; 
        if (tecsEsperadas.length === 0) continue;

        // BÚSQUEDA FLEXIBLE
        let tecsEnviadas = [];
        for (const nombreExtraido in enviosReales) {
           if (
             cliente.toLowerCase().includes(nombreExtraido) ||
             nombreExtraido.includes(cliente.toLowerCase())
           ) {
               enviosReales[nombreExtraido].forEach(t => {
                   if (!tecsEnviadas.includes(t)) tecsEnviadas.push(t);
               });
           }
        }

        const enviaronBien = tecsEsperadas.filter(t => tecsEnviadas.includes(t));
        const nosFaltan = tecsEsperadas.filter(t => !tecsEnviadas.includes(t));

        if (nosFaltan.length === 0) {
            completos.push(`• ${cliente} _(${enviaronBien.join(", ")})_`);
        } else if (enviaronBien.length === 0) {
            faltantes.push(`• ${cliente} _(Falta: ${nosFaltan.join(", ")})_`);
        } else {
            parciales.push(`• ${cliente} _(✅ ${enviaronBien.join(", ")} | ❌ Falta: ${nosFaltan.join(", ")})_`);
        }
     }

     const horaTexto = Utilities.formatDate(hoy, "GMT-3", "HH:mm");
     let mensajeSlack = `🔔 *Auditoría de Mails de Operaciones (${horaTexto} hs)*\n\n`;

     mensajeSlack += `*✅ ENVIADOS COMPLETOS (${completos.length}):*\n`;
     if (completos.length > 0) {
        completos.forEach(c => mensajeSlack += `${c}\n`);
     } else {
        mensajeSlack += `_Ninguno_\n`;
     }

     if (parciales.length > 0) {
         mensajeSlack += `\n*⚠️ ENVÍOS PARCIALES (${parciales.length}):*\n`;
         parciales.forEach(c => mensajeSlack += `${c}\n`);
     }

     mensajeSlack += `\n*❌ FALTANTES TOTALES (${faltantes.length}):*\n`;
     if (faltantes.length > 0) {
        faltantes.forEach(c => mensajeSlack += `${c}\n`);
     } else {
        mensajeSlack += `_Ninguno_\n`;
     }

     enviarAlertaSlackPorPod(webhookUrl, mensajeSlack);
     Logger.log(`Enviado reporte a Slack para el ${pod}`);
  }
}

/**
 * Procesa una hoja y agrega sus clientes/tecnologías al objeto clientesPorPod
 */
function procesarHoja(hoja, clientesPorPod, origen) {
  const lastRow = hoja.getLastRow();
  if (lastRow < 2) {
    Logger.log(`[${origen}] La hoja ${hoja.getName()} no tiene datos para procesar.`);
    return;
  }

  // Leemos hasta la columna V (22 columnas)
  const datos = hoja.getRange(2, 1, lastRow - 1, 25).getValues();

  Logger.log(`[${origen}] Procesando hoja "${hoja.getName()}" con ${datos.length} filas.`);

  datos.forEach((fila, index) => {
    const numeroFila = index + 2;

    // Columna Y = índice 24
    const pod = fila[24] ? fila[24].toString().trim().toUpperCase() : "";
    // Columna L = índice 11
    const cliente = fila[11] ? fila[11].toString().trim() : "";
    // Columna M = índice 12
    const serviciosStr = fila[12] ? fila[12].toString().toLowerCase() : "";
    // Columna D = índice 3
    const opsKey = fila[3] ? fila[3].toString().trim() : "";
    // Columna N = índice 13
    const soporteKey = fila[13] ? fila[13].toString().trim() : ""; 

    if (!(pod && cliente && (opsKey || soporteKey) && serviciosStr)) {
      Logger.log(`[${origen}] Fila ${numeroFila} descartada por datos incompletos.`);
      return;
    }

    if (!clientesPorPod[pod]) clientesPorPod[pod] = {};
    if (!clientesPorPod[pod][cliente]) clientesPorPod[pod][cliente] = [];

    if (serviciosStr.includes("vsphere") && !clientesPorPod[pod][cliente].includes("vSphere")) {
      clientesPorPod[pod][cliente].push("vSphere");
    }
    if (serviciosStr.includes("veeam") && !clientesPorPod[pod][cliente].includes("Veeam")) {
      clientesPorPod[pod][cliente].push("Veeam");
    }
    if (serviciosStr.includes("nutanix") && !clientesPorPod[pod][cliente].includes("Nutanix")) {
      clientesPorPod[pod][cliente].push("Nutanix");
    }
    if (serviciosStr.includes("horizon") && !clientesPorPod[pod][cliente].includes("Horizon")) {
      clientesPorPod[pod][cliente].push("Horizon");
    }
  });
}

function enviarAlertaSlackPorPod(webhookUrl, mensaje) {
  const payload = { text: mensaje };
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload)
  };

  try {
    UrlFetchApp.fetch(webhookUrl, options);
  } catch (e) {
    Logger.log("Error al enviar a Slack: " + e.message);
  }
}

/**
 * Verifica si hoy hay un evento creado en el calendario de feriados.
 */
function esFeriadoHoy() {
  // ATENCIÓN: Reemplazá esto por el ID real de tu calendario de Alarmas Wetcom
  const calendarId = PropertiesService.getScriptProperties().getProperty("HOLIDAYS_CALENDAR_ID"); 
  
  try {
    const calendario = CalendarApp.getCalendarById(calendarId);
    if (!calendario) {
      Logger.log("⚠️ ATENCIÓN: No se pudo acceder al calendario. Revisar el ID.");
      return false; // Si hay un error con el ID, asume que NO es feriado para no frenar la empresa.
    }
    
    const hoy = new Date();
    const eventosDeHoy = calendario.getEventsForDay(hoy);
    
    return eventosDeHoy.length > 0;
    
  } catch (error) {
    Logger.log("⚠️ Error al chequear el calendario de feriados: " + error.message);
    return false; // Ante la duda, que corran las operaciones.
  }
}
