/** 
 * ================================================================
 * SCRIPT AUDITOR DE CORREOS DE OPERACIONES POR TECNOLOGÍA (9:45 AM)
 * ================================================================
 */

function getWebhooksPorPod() {
  const props = PropertiesService.getScriptProperties();
  // Fallback inteligente para testing: si se configuró el general o POD1, se reutiliza para los PODs sin webhook individual
  const defaultWebhook = props.getProperty("SLACK_WEBHOOK_GENERAL") || props.getProperty("SLACK_WEBHOOK_AUDITOR_POD_1");
  return {
    "POD1":    props.getProperty("SLACK_WEBHOOK_AUDITOR_POD_1") || defaultWebhook,
    "POD2":    props.getProperty("SLACK_WEBHOOK_AUDITOR_POD_2") || defaultWebhook,
    "POD3":    props.getProperty("SLACK_WEBHOOK_AUDITOR_POD_3") || defaultWebhook,
    "POD4":    props.getProperty("SLACK_WEBHOOK_AUDITOR_POD_4") || defaultWebhook,
    "POD5":    props.getProperty("SLACK_WEBHOOK_AUDITOR_POD_5") || defaultWebhook,
    "DEFAULT": defaultWebhook
  };
}

const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
const HOJA_INDICE = "Sheet1";
const HOJA_ADJUNTOS = "Adjuntos";

// --- LISTA DE CORREOS VÁLIDOS (En testing se permite ian.lucero@wetcom.com como destinatario oficial) ---
const CORREOS_PODS = ["pod1@wetcom.com", "pod2@wetcom.com", "pod3@wetcom.com", "pod4@wetcom.com", "pod5@wetcom.com", "ian.lucero@wetcom.com"];

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

  // 1. LEEMOS LA HOJA PRINCIPAL (Primera pestaña por posición, idéntico a MasterSheetSingleton)
  const hojaPrincipal = spreadsheet.getSheets()[0];
  if (!hojaPrincipal) {
    Logger.log(`No se encontró la hoja principal en la spreadsheet.`);
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
  const timeGuard = new TimeGuard({ operationName: "Auditor Mail" });

  for (const hilo of hilos) {
    if (!timeGuard.check(`Hilo ${hilo.getId()}`)) {
      Logger.log(`[AuditorMail] TimeGuard activado durante análisis de hilos.`);
      break;
    }
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
  }

  // 4. CRUZAMOS LOS DATOS Y AVISAMOS POR POD
  Logger.log("\n--- GENERANDO REPORTES PARA SLACK ---");

  for (const pod in clientesPorPod) {
     const webhooksMap = getWebhooksPorPod();
     const webhookUrl = webhooksMap[pod];
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

  // Leemos hasta 25 columnas de forma segura para no exceder las columnas máximas de la hoja
  const numCols = Math.min(25, hoja.getMaxColumns());
  const datos = hoja.getRange(2, 1, lastRow - 1, numCols).getValues();

  Logger.log(`[${origen}] Procesando hoja "${hoja.getName()}" con ${datos.length} filas.`);

  datos.forEach((fila, index) => {
    const numeroFila = index + 2;

    // Columna Y = índice 24. Si está vacía buscamos en cualquier columna de la fila o asignamos DEFAULT
    let pod = fila[24] ? fila[24].toString().trim().toUpperCase() : "";
    if (!pod) {
      const matchPod = String(fila.join(" ")).match(/pod\s*([1-5])/i);
      if (matchPod) {
        pod = `POD${matchPod[1]}`;
      } else {
        pod = "DEFAULT";
      }
    }

    // Columna L = índice 11, o Columna B = índice 1 si se escribió en formato simplificado (ej: Adjuntos)
    const cliente = (fila[11] ? fila[11].toString().trim() : "") || (fila[1] ? fila[1].toString().trim() : "") || (fila[0] ? fila[0].toString().trim() : "");
    // Columna M = índice 12, o Columna C = índice 2, o Columna G = índice 6
    const serviciosStr = (fila[12] ? fila[12].toString().toLowerCase() : "") || (fila[2] ? fila[2].toString().toLowerCase() : "") || (fila[6] ? fila[6].toString().toLowerCase() : "");
    // Columna D = índice 3, o Columna N = índice 13, o si no se puso clave se usa el mismo nombre del cliente como fallback
    let opsKey = fila[3] ? fila[3].toString().trim() : "";
    let soporteKey = fila[13] ? fila[13].toString().trim() : "";
    if (!(opsKey || soporteKey) && cliente) {
      opsKey = cliente;
    }

    if (!(cliente && (opsKey || soporteKey) && serviciosStr)) {
      Logger.log(`[${origen}] Fila ${numeroFila} descartada por datos incompletos -> Cliente="${cliente}", OpsKey="${opsKey}", SoporteKey="${soporteKey}", Servicios="${serviciosStr}"`);
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
    fetchWithRetries(webhookUrl, options);
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

/**
 * ================================================================
 * AUDITOR DE CARPETAS RVTOOLS EN DRIVE
 * Verifica, cliente por cliente, que exista dentro de su carpeta de
 * RVTools la subcarpeta del día en que corre, y avisa por el canal de
 * Slack del POD al que pertenece cada cliente.
 * ================================================================
 */

// Columnas de la hoja índice, base 0: I = POD, J = link a la carpeta, L = cliente.
const RVTOOLS_COL = { POD: 8, CARPETA: 9, CLIENTE: 11 };

// Slack corta el campo "text" en 40.000 caracteres.
const RVTOOLS_MAX_CHARS_SLACK = 39000;

/**
 * Audita las carpetas de RVTools del día y reporta por POD en Slack.
 * @param {Object}  [opciones] Al correr por trigger llega el evento, que se ignora.
 * @param {boolean} [opciones.dryRun=false] Si es true no envía nada a Slack, solo loguea.
 * @param {Date}    [opciones.fecha] Fecha a auditar. Por defecto, hoy.
 */
function auditarCarpetasRVTools(opciones) {
  const config = opciones || {};
  const dryRun = config.dryRun === true;
  const fecha  = config.fecha instanceof Date ? config.fecha : new Date();

  if (esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado en el calendario de Alarmas Wetcom.");
    return;
  }

  const fechaStr = Utilities.formatDate(fecha, "GMT-3", "dd/MM/yyyy");
  Logger.log(`--- AUDITORÍA DE CARPETAS RVTOOLS (${fechaStr})${dryRun ? " [DRY RUN]" : ""} ---`);

  const filas = _rvtoolsLeerFilasIndice();
  if (!filas || filas.length === 0) return;

  const esperados = _rvtoolsFechasEsperadas(fecha);
  Logger.log(`Se busca una subcarpeta cuyo nombre, sacándole los separadores, sea ${esperados.join(" o ")}.`);

  const porPod = {};
  const timeGuard = new TimeGuard({ operationName: "Auditor RVTools" });

  for (const fila of filas) {
    if (!timeGuard.check(`Cliente ${fila.cliente}`)) {
      Logger.log("[AuditorRVTools] TimeGuard activado: se corta el recorrido de clientes.");
      break;
    }

    if (!porPod[fila.pod]) porPod[fila.pod] = { ok: [], faltan: [], errores: [] };

    if (!fila.folderId) {
      porPod[fila.pod].errores.push(`• ${fila.cliente} _(sin link de carpeta válido en la columna J)_`);
      Logger.log(`⚠️ ${fila.cliente}: la columna J no tiene un link ni un ID de carpeta reconocible.`);
      continue;
    }

    try {
      const carpetaPadre = DriveApp.getFolderById(fila.folderId);
      const encontrada   = _rvtoolsBuscarCarpetaDeFecha(carpetaPadre, esperados, fila.cliente);

      if (encontrada) {
        porPod[fila.pod].ok.push(`• ${fila.cliente} _(${encontrada})_`);
        Logger.log(`✅ ${fila.cliente}: existe la carpeta "${encontrada}".`);
      } else {
        porPod[fila.pod].faltan.push(`• ${fila.cliente}`);
        Logger.log(`❌ ${fila.cliente}: no hay carpeta del día dentro de "${carpetaPadre.getName()}".`);
      }
    } catch (e) {
      porPod[fila.pod].errores.push(`• ${fila.cliente} _(${e.message})_`);
      Logger.log(`🔥 ${fila.cliente}: error al acceder a la carpeta ${fila.folderId}: ${e.message}`);
    }
  }

  _rvtoolsReportarPorPod(porPod, fecha, dryRun);
}

/**
 * Corrida de prueba: hace todo el trabajo pero no envía nada a Slack.
 */
function auditarCarpetasRVToolsDryRun() {
  auditarCarpetasRVTools({ dryRun: true });
}

/**
 * Lee la hoja índice y devuelve una fila por cliente con su POD y el ID de su carpeta.
 * @returns {Array<{cliente: string, pod: string, folderId: string}>|null}
 */
function _rvtoolsLeerFilasIndice() {
  let hoja;
  try {
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    hoja = spreadsheet.getSheetByName(HOJA_INDICE) || spreadsheet.getSheets()[0];
  } catch (e) {
    Logger.log(`Error crítico al abrir la spreadsheet: ${e.message}`);
    return null;
  }

  const ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) {
    Logger.log(`La hoja "${hoja.getName()}" no tiene datos para procesar.`);
    return null;
  }

  const numCols  = Math.min(RVTOOLS_COL.CLIENTE + 1, hoja.getMaxColumns());
  const rango    = hoja.getRange(2, 1, ultimaFila - 1, numCols);
  const valores  = rango.getValues();
  const formulas = rango.getFormulas();
  const richText = rango.getRichTextValues();

  // La hoja trae varias filas por cliente (una por remitente o tecnología) y solo una
  // lleva el ID de RVTools. Nos quedamos con esa: si no, el mismo cliente se reportaría
  // dos veces y en PODs distintos.
  const porCliente = {};
  let filasConCliente = 0;

  valores.forEach((fila, i) => {
    const cliente = (fila[RVTOOLS_COL.CLIENTE] || "").toString().trim();
    if (!cliente) return;
    filasConCliente++;

    // El link puede estar como texto plano, dentro de un =HYPERLINK() o como link de texto enriquecido.
    const celdaRich = richText[i][RVTOOLS_COL.CARPETA];
    const folderId =
      _rvtoolsExtraerFolderId(celdaRich ? celdaRich.getLinkUrl() : "") ||
      _rvtoolsExtraerFolderId(formulas[i][RVTOOLS_COL.CARPETA]) ||
      _rvtoolsExtraerFolderId(fila[RVTOOLS_COL.CARPETA]);

    const clave     = cliente.toLowerCase();
    const yaGuardado = porCliente[clave];

    // Se pisa la fila guardada solo si la nueva aporta el ID que a la anterior le faltaba.
    if (!yaGuardado || (!yaGuardado.folderId && folderId)) {
      porCliente[clave] = {
        cliente: cliente,
        pod: _rvtoolsNormalizarPod(fila[RVTOOLS_COL.POD]),
        folderId: folderId
      };
    }
  });

  const filas = Object.keys(porCliente).map(clave => porCliente[clave]);
  const descartadas = filasConCliente - filas.length;
  Logger.log(`Se leyeron ${filasConCliente} filas con cliente en la columna L y quedaron ${filas.length} clientes únicos${descartadas > 0 ? ` (${descartadas} filas repetidas descartadas)` : ""}.`);
  return filas;
}

/**
 * Lleva el valor de la columna de POD a una de las claves de getWebhooksPorPod().
 */
function _rvtoolsNormalizarPod(valor) {
  const texto = (valor || "").toString().trim().toUpperCase();
  const match = texto.match(/([1-5])/);
  return match ? `POD${match[1]}` : "DEFAULT";
}

/**
 * Saca el ID de carpeta de un link de Drive, de un =HYPERLINK() o de un ID pelado.
 * @returns {string} El ID, o cadena vacía si no se reconoce nada.
 */
function _rvtoolsExtraerFolderId(texto) {
  const valor = (texto || "").toString().trim();
  if (!valor) return "";

  const patrones = [/\/folders\/([-\w]{15,})/, /[?&]id=([-\w]{15,})/, /\/d\/([-\w]{15,})/];
  for (const patron of patrones) {
    const match = valor.match(patron);
    if (match) return match[1];
  }

  return /^[-\w]{15,}$/.test(valor) ? valor : "";
}

/**
 * Nombres de carpeta aceptados para una fecha, ya sin separadores.
 * El formato real en Drive es YYYYMMDD, mismo criterio que encontrarCarpetaMasReciente
 * en RVTools_Main.js; se acepta también YYMMDD por las dudas.
 */
function _rvtoolsFechasEsperadas(fecha) {
  return [
    Utilities.formatDate(fecha, "GMT-3", "yyyyMMdd"),
    Utilities.formatDate(fecha, "GMT-3", "yyMMdd")
  ];
}

/**
 * Busca dentro de una carpeta la subcarpeta correspondiente a la fecha buscada.
 * Compara ignorando separadores, así matchea 20260818, 2026/08/18, 26-08-18, etc.
 * @returns {string|null} El nombre real de la carpeta encontrada, o null.
 */
function _rvtoolsBuscarCarpetaDeFecha(carpetaPadre, esperados, cliente, permitirBajarUnNivel) {
  const bajarUnNivel  = permitirBajarUnNivel !== false;
  const subCarpetas   = carpetaPadre.getFolders();
  const casiFechas    = [];
  const carpetasDeAnio = [];

  while (subCarpetas.hasNext()) {
    const carpeta     = subCarpetas.next();
    const nombre      = carpeta.getName();
    const soloDigitos = nombre.replace(/\D/g, "");

    if (esperados.indexOf(soloDigitos) !== -1) return nombre;
    if (soloDigitos.length >= 6) casiFechas.push(nombre);
    else if (/^\d{4}$/.test(nombre.trim())) carpetasDeAnio.push(carpeta);
  }

  // Algunos clientes (BALANZ, por ejemplo) apuntan la columna J a la carpeta madre y
  // cuelgan las fechas de una subcarpeta de año. Bajamos un nivel solo en ese caso.
  if (bajarUnNivel && carpetasDeAnio.length > 0) {
    for (const carpetaAnio of carpetasDeAnio) {
      const encontrada = _rvtoolsBuscarCarpetaDeFecha(carpetaAnio, esperados, cliente, false);
      if (encontrada) return `${carpetaAnio.getName()}/${encontrada}`;
    }
  }

  // Si habia subcarpetas con pinta de fecha que no matchearon, queda en el log:
  // sirve para detectar que el formato de nombres cambio.
  if (casiFechas.length > 0) {
    const extra = casiFechas.length > 5 ? ` (y ${casiFechas.length - 5} más)` : "";
    Logger.log(`   └─ ${cliente}: subcarpetas con formato de fecha que no matchearon: ${casiFechas.slice(0, 5).join(", ")}${extra}`);
  }
  return null;
}

/**
 * Arma y envía un mensaje por cada POD que tenga clientes auditados.
 */
function _rvtoolsReportarPorPod(porPod, fecha, dryRun) {
  const webhooks = getWebhooksPorPod();
  const fechaStr = Utilities.formatDate(fecha, "GMT-3", "dd/MM/yyyy");
  const horaStr  = Utilities.formatDate(new Date(), "GMT-3", "HH:mm");

  for (const pod in porPod) {
    const datos = porPod[pod];
    if (datos.ok.length + datos.faltan.length + datos.errores.length === 0) continue;

    let mensaje = `📁 *Auditoría de carpetas RVTools — ${fechaStr} (${horaStr} hs)*\n\n`;

    mensaje += `*✅ CON CARPETA DEL DÍA (${datos.ok.length}):*\n`;
    mensaje += datos.ok.length > 0 ? `${datos.ok.join("\n")}\n` : "_Ninguno_\n";

    mensaje += `\n*❌ SIN CARPETA DEL DÍA (${datos.faltan.length}):*\n`;
    mensaje += datos.faltan.length > 0 ? `${datos.faltan.join("\n")}\n` : "_Ninguno_\n";

    if (datos.errores.length > 0) {
      mensaje += `\n*⚠️ NO SE PUDO VERIFICAR (${datos.errores.length}):*\n${datos.errores.join("\n")}\n`;
    }

    if (mensaje.length > RVTOOLS_MAX_CHARS_SLACK) {
      mensaje = `${mensaje.substring(0, RVTOOLS_MAX_CHARS_SLACK)}\n\n_… mensaje recortado por el límite de Slack._`;
    }

    const webhookUrl = webhooks[pod] || webhooks["DEFAULT"];
    if (!webhookUrl) {
      Logger.log(`⚠️ ${pod}: no hay webhook configurado, se omite el envío.`);
      continue;
    }

    if (dryRun) {
      Logger.log(`\n[DRY RUN] Mensaje que se enviaría al ${pod}:\n${mensaje}`);
    } else {
      enviarAlertaSlackPorPod(webhookUrl, mensaje);
      Logger.log(`Enviado reporte de RVTools a Slack para el ${pod}.`);
    }
  }
}

/**
 * Diagnóstico: confirma el mapeo de columnas y muestra los nombres reales de las
 * subcarpetas de los primeros clientes. Conviene correrlo antes de armar el trigger.
 */
function diagnosticarCarpetasRVTools() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const hoja = spreadsheet.getSheetByName(HOJA_INDICE) || spreadsheet.getSheets()[0];
  Logger.log(`--- DIAGNÓSTICO RVTOOLS sobre la hoja "${hoja.getName()}" ---`);

  const encabezados = hoja.getRange(1, 1, 1, Math.min(14, hoja.getMaxColumns())).getValues()[0];
  encabezados.forEach((titulo, i) => {
    const letra = String.fromCharCode(65 + i);
    let marca = "";
    if (i === RVTOOLS_COL.POD)          marca = "  <-- POD";
    else if (i === RVTOOLS_COL.CARPETA) marca = "  <-- CARPETA";
    else if (i === RVTOOLS_COL.CLIENTE) marca = "  <-- CLIENTE";
    Logger.log(`  ${letra} (índice ${i}): "${titulo}"${marca}`);
  });

  const filas = _rvtoolsLeerFilasIndice() || [];
  const sinCarpeta = filas.filter(f => !f.folderId).length;
  Logger.log(`\nClientes leídos: ${filas.length}. Sin carpeta reconocible: ${sinCarpeta}.`);

  filas.filter(f => f.folderId).slice(0, 3).forEach(fila => {
    Logger.log(`\n📂 ${fila.cliente} (${fila.pod}) — carpeta ${fila.folderId}`);
    try {
      const sub = DriveApp.getFolderById(fila.folderId).getFolders();
      const nombres = [];
      while (sub.hasNext() && nombres.length < 10) nombres.push(sub.next().getName());
      Logger.log(`   Subcarpetas: ${nombres.length > 0 ? nombres.join(", ") : "(ninguna)"}`);
    } catch (e) {
      Logger.log(`   🔥 No se pudo abrir: ${e.message}`);
    }
  });
}
