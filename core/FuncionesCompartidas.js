function verTransicionesDeMiTicket() {
  const issueKey = "WPC-363"; // <--- PON UN TICKET REAL QUE ESTÉ ABIERTO
  const headers = getJiraHeaders();
  const url = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/transitions`;
  
  const response = UrlFetchApp.fetch(url, { headers: headers });
  Logger.log(response.getContentText());
}

/**
 * Retorna las cabeceras de autorización estándar para la API de Jira.
 * Requiere que la constante JIRA_AUTH_TOKEN_BASE_64 esté definida en ConfiguracionGlobal.gs
 */
function getJiraHeaders() {
  return {
    "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}`,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
}

/**
 * @fileoverview Caja de herramientas de funciones compartidas (Versión Final y Definitiva).
 * Incluye lógica robusta para el vencimiento de excepciones, notificaciones
 * de resumen y logging de diagnóstico mejorado.
 */

/**
 * NUEVA FUNCIÓN (AÑADIR ESTA FUNCIÓN)
 * Busca si un ticket de Jira ya tiene un adjunto con un nombre específico.
 * @param {string} issueKey La clave del ticket (ej. "PROJ-123").
 * @param {string} fileName El nombre del archivo a buscar.
 * @returns {boolean} `true` si el adjunto existe, `false` en caso contrario.
 */
function buscarAdjuntoEnTicket(issueKey, fileName) {
  if (!issueKey || !fileName) return false;
  
  // Usamos la API v3 para obtener solo los campos de adjuntos
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}?fields=attachment`;
  const options = {
    "method": "get",
    "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    if (response.getResponseCode() !== 200) {
      Logger.log(`Error al buscar adjuntos en ${issueKey}: ${response.getContentText()}`);
      return false; // Asumimos que no existe si no podemos verificar
    }
    
    const data = JSON.parse(response.getContentText());
    if (data.fields && data.fields.attachment && data.fields.attachment.length > 0) {
      // Buscamos si alguno de los adjuntos tiene el nombre exacto
      return data.fields.attachment.some(att => att.filename === fileName);
    }
    
    return false; // No tiene adjuntos
  } catch (e) {
    Logger.log(`Excepción al buscar adjuntos en ${issueKey}: ${e.message}`);
    return false; // Asumimos que no existe si hay error
  }
}

/**
 * REEMPLAZA ESTA FUNCIÓN en FuncionesCompartidas.gs
 * * Busca la configuración de un cliente por su NOMBRE (Columna B) en el Índice Maestro.
 * CORREGIDA para ser inmune a espacios en blanco (con .trim()).
 */
function getClientConfigByName(clientName, operationName) {
  try {
    const masterSheet = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0];
    const masterData = masterSheet.getDataRange().getValues();
    
    // --- LÓGICA DE BÚSQUEDA CORREGIDA ---
    // Añadimos .trim() para eliminar espacios en blanco al inicio o final de la celda.
    const clientRow = masterData.find(row => row[1] && row[1].trim().toLowerCase() === clientName.toLowerCase());

    if (!clientRow) {
      Logger.log(`[DRP] No se encontró una fila para el NOMBRE de cliente "${clientName}" en el Índice Maestro.`);
      return null;
    }
    // --- FIN DE LA CORRECCIÓN ---

    const clientNameFound = clientRow[1],
          exceptionFileId = clientRow[2],
          jiraProjectKey = clientRow[3],
          serviceDeskId = clientRow[4],
          requestTypeName = clientRow[5],
          tecnologiaValue = clientRow[6],
          origenValue = clientRow[7] || null;

    if (!clientNameFound || !jiraProjectKey || !serviceDeskId || !requestTypeName || !tecnologiaValue) {
      Logger.log(`ERROR: La configuración para "${clientNameFound}" (encontrado por nombre) está incompleta.`);
      return null;
    }

    const requestTypeId = getRequestTypeIdForServiceDesk(serviceDeskId, requestTypeName);
    if (!requestTypeId) return null;
    
    const exceptionSheet = SpreadsheetApp.openById(exceptionFileId).getSheetByName(operationName);
    
    if (!exceptionSheet) {
      Logger.log(`ADVERTENCIA: No se encontró la PESTAÑA de excepciones "${operationName}" en el archivo del cliente ${clientNameFound}. Se continuará sin excepciones.`);
      return { exceptions: {}, clientName: clientNameFound.trim(), jiraProjectKey, serviceDeskId, requestTypeId, tecnologia: tecnologiaValue, origen: origenValue }; // Añadido trim() aquí también por si acaso
    }

    // --- LÓGICA DE EXCEPCIONES (COPIADA DE getClientConfig) ---
    const exceptionRange = exceptionSheet.getDataRange();
    const exceptionData = exceptionRange.getValues();
    exceptionData.shift();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    exceptionData.forEach((row, index) => {
      const isActive = (row[5] || "").toString().toUpperCase();
      if (isActive !== 'SI') return;
      let isRuleValid = true;
      let reasonForInvalidity = "";
      const expiryDateValue = row[4];
      if (expiryDateValue) {
        let expiryDate;
        if (expiryDateValue instanceof Date) { expiryDate = expiryDateValue; }
        else if (typeof expiryDateValue === 'string' && expiryDateValue.includes('/')) {
          const parts = expiryDateValue.split('/');
          if (parts.length === 3) expiryDate = new Date(parseInt(parts[2], 10), parseInt(parts[0], 10) - 1, parseInt(parts[1], 10));
        }
        if (expiryDate && !isNaN(expiryDate.getTime())) {
          expiryDate.setHours(0, 0, 0, 0);
          if (expiryDate < today) {
            isRuleValid = false;
            reasonForInvalidity = "La fecha ha vencido.";
          }
        }
      }
    });

    const activeExceptions = exceptionData.filter(row => (row[5] || "").toString().toUpperCase() === 'SI');
    const groupedExceptions = {};
    activeExceptions.forEach(row => {
      const exceptionId = row[0];
      if (!groupedExceptions[exceptionId]) groupedExceptions[exceptionId] = [];
      groupedExceptions[exceptionId].push({
        column: row[1], matchType: row[2], 
        values: (row[3] || "").toString().split(',').map(v => v.trim().toLowerCase())
      });
    });
    // --- FIN LÓGICA DE EXCEPCIONES ---

    return {
      exceptions: groupedExceptions, clientName: clientNameFound.trim(), jiraProjectKey: jiraProjectKey, // Añadido trim() aquí también
      serviceDeskId: serviceDeskId, requestTypeId: requestTypeId,
      tecnologia: tecnologiaValue, origen: origenValue
    };
  } catch (e) {
    Logger.log(`ERROR CRÍTICO DENTRO DE getClientConfigByName: ${e.message}`);
    Logger.log(`Stack: ${e.stack}`);
    return null; 
  }
}

function buscarYCerrarTareaProgramada(taskNameBase, clientConfig, useClientNameInTask) {
  if (!taskNameBase || !clientConfig || !clientConfig.clientName) {
    return { status: 'SKIPPED' };
  }

  let fullTaskName;
  
  if (useClientNameInTask) {
    // Opción A: El nombre de la tarea es "Nombre Tarea - Nombre Cliente"
    fullTaskName = `${taskNameBase} - ${clientConfig.clientName}`;
  } else {
    // Opción B: El nombre de la tarea es genérico (ej. "Cluster DRS")
    fullTaskName = taskNameBase;
  }

  const projectKey = clientConfig.jiraProjectKey;

  Logger.log(`Buscando Tarea Programada para el reporte de "${taskNameBase}"...`);
  Logger.log(` -> Nombre del Ticket: "${fullTaskName}"`);
  Logger.log(` -> Dentro del Proyecto de Jira: "${projectKey}"`);
  
  const taskKeyToClose = findExistingJiraTicket(fullTaskName, projectKey, "Tarea Programada");
  
  if (taskKeyToClose) {
    Logger.log(`✔ Tarea encontrada: ${taskKeyToClose}. Procediendo a cerrarla.`);
    return resolveJiraTicket(taskKeyToClose, JIRA_STATUS_TO_CLOSE);
  } else {
    Logger.log(`ℹ No se encontró una tarea programada abierta con ese nombre en el proyecto ${projectKey}.`);
    return { status: 'NOT_FOUND' };
  }
}

/**
 * Un analizador de CSV más robusto que maneja comillas internas y saltos de línea.
 * @param {string} csvText El contenido del archivo CSV como texto.
 * @returns {Array<Array<string>>} Un array 2D con los datos del CSV.
 */
function parseCsvRobust(csvText) {
  const lines = csvText.split('\n');
  const result = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const row = [];
    let currentField = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = i < line.length - 1 ? line[i+1] : null;

      if (char === '"' && inQuotes && nextChar === '"') {
        currentField += '"';
        i++; // Skip next quote
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        row.push(currentField);
        currentField = '';
      } else {
        currentField += char;
      }
    }
    row.push(currentField);
    result.push(row);
  }
  return result;
}

/**
 * NUEVA FUNCIÓN DE BÚSQUEDA
 * Construye una consulta de búsqueda de Gmail que solo incluye los remitentes
 * definidos en el Índice Maestro.
 * @param {string} emailSubject El asunto del correo a buscar.
 * @returns {string} La consulta de búsqueda completa para Gmail.
 */
function construirBusquedaGmail(emailSubject) {
  // Lee la primera hoja del Índice Maestro
  const masterSheet = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0];
  // Obtiene todos los valores de la primera columna (A), donde están los dominios/emails
  const senderData = masterSheet.getRange("A2:A").getValues();

  // Filtra las celdas vacías y extrae los remitentes
  const senders = senderData
    .flat()
    .filter(sender => sender.trim() !== "");

  if (senders.length === 0) {
    Logger.log("ADVERTENCIA: No se encontraron remitentes en el Índice Maestro. La búsqueda no devolverá resultados.");
    // Devolvemos una búsqueda que probablemente no encuentre nada para evitar errores.
    return "subject:\"búsqueda-imposible-sin-remitentes\"";
  }

  // Construye la parte de la consulta para los remitentes: (from:dominio1 OR from:dominio2 ...)
  const fromQuery = `(from:${senders.join(" OR from:")})`;

  // Combina todo en la consulta final
  const finalQuery = `${fromQuery} subject:"${emailSubject}" has:attachment is:unread`;
  
  Logger.log(`Construyendo búsqueda de Gmail con filtro de remitentes: ${finalQuery}`);
  return finalQuery;
}


// --- NUEVO SISTEMA DE NOTIFICACIONES ---
/**
 * NUEVA FUNCIÓN ANTI-SPAM
 * Revisa si un ticket de Jira ya fue actualizado hoy con un identificador específico.
 * @param {string} issueKey La clave del ticket de Jira (ej. "PROJ-123").
 * @param {string} fingerprint Un texto único para la actualización de hoy (ej. el nombre de la alerta).
 * @returns {boolean} Devuelve `true` si ya fue actualizado hoy, `false` en caso contrario.
 */
// REEMPLAZA ESTA FUNCIÓN COMPLETA EN "Funciones compartidas.gs"

function haSidoActualizadoHoy(issueKey, fingerprint) {
  try {
    const todayMarker = `[AUTO-UPDATE:${new Date().toISOString().slice(0, 10)}]`;
    const fullFingerprint = `${todayMarker} ${fingerprint}`;

    const endpoint = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=1`;
    const options = {
      "method": "get",
      "contentType": "application/json",
      "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
      "muteHttpExceptions": true
    };
    
    const response = UrlFetchApp.fetch(endpoint, options);
    if (response.getResponseCode() !== 200) return false;

    const data = JSON.parse(response.getContentText());
    if (data.comments && data.comments.length > 0) {
      // --- INICIO DE LA CORRECCIÓN ---
      // El cuerpo del comentario ('body') es un objeto JSON (ADF). Lo convertimos a texto para poder buscar.
      const lastCommentBodyObject = data.comments[0].body;
      const lastCommentAsText = JSON.stringify(lastCommentBodyObject);
      // --- FIN DE LA CORRECCIÓN ---

      // Comprobamos si el texto del último comentario contiene nuestra huella.
      if (lastCommentAsText.includes(fullFingerprint)) {
        Logger.log(`El ticket ${issueKey} ya fue actualizado hoy con la alerta "${fingerprint}". Se omitirá el comentario duplicado.`);
        return true;
      }
    }
    return false;
  } catch (e) {
    Logger.log(`Error al verificar los comentarios del ticket ${issueKey}: ${e.message}`);
    return false;
  }
}


/**
 * Envía una única notificación de resumen a Slack al final de la ejecución.
 * VERSIÓN CORREGIDA: Maneja correctamente los objetos de advertencia.
 */
function enviarResumenSlack(operationName, summaryReport) {
  _registrarEnLog(operationName, summaryReport);
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL.trim() === "") return;

  const { exitos, advertencias, errores, tareasCerradas } = summaryReport;

  // Si no hay absolutamente nada que reportar, no hace nada.
  if (errores.length === 0 && advertencias.length === 0 && exitos.length === 0 && tareasCerradas === 0) {
    return;
  }

  let titulo;
  let mensaje = "";

  // 1. Define el título basado en la severidad máxima del evento.
  if (errores.length > 0) {
    titulo = `❌ Ejecución con Errores (${operationName})`;
  } else if (advertencias.length > 0) {
    titulo = `⚠️ Ejecución con Advertencias (${operationName})`;
  } else {
    titulo = `✅ Ejecución Exitosa (${operationName})`;
  }

  // 2. Construye el mensaje por bloques, sin usar "else if".

  // Bloque de Errores (si existen)
  if (errores.length > 0) {
    mensaje += `\n\n*--- 🚨 ERRORES CRÍTICOS ---*`;
    errores.forEach(err => {
      mensaje += `\n• *Cliente:* ${err.cliente || "_Desconocido_"}`; // NUEVO
      mensaje += `\n  • *Error:* \`${err.error}\``;
      if (err.ticket) mensaje += `\n  • *Ticket:* <${JIRA_DOMAIN}/browse/${err.ticket}|${err.ticket}>`; // NUEVO
      if (err.detalle) mensaje += `\n  • *Detalle:* ${err.detalle}`;
    });
  }

    // --- INICIO DE LA CORRECCIÓN EN EL BLOQUE DE ADVERTENCIAS ---
  if (advertencias.length > 0) {
    mensaje += `\n\n*--- ⚠️ ADVERTENCIAS ---*`;
    advertencias.forEach(warn => {
      // Log de diagnóstico para ver el objeto exacto que llega.
      Logger.log(`Objeto de advertencia recibido para Slack: ${JSON.stringify(warn)}`);

      // Lógica robusta para encontrar los datos, buscando en el objeto principal o en su propiedad "detail".
      const warningData = warn.detail || warn;

      // Verificación ANTES de imprimir para evitar "undefined".
      if (warningData.ticketKey) {
        mensaje += `\n• *Ticket:* <${JIRA_DOMAIN}/browse/${warningData.ticketKey}|${warningData.ticketKey}>`;
        mensaje += `\n• *Problema:* ${warningData.problema || 'No se especificó el problema.'}`;
      } else {
        // Mensaje genérico si no se encuentra el ticketKey, usando la información que sí tengamos.
        mensaje += `\n• *Problema:* Ocurrió un fallo durante una operación. ${warningData.problema || '(Sin detalles adicionales)'}`;
      }
      
      if (warningData.accion) mensaje += `\n• *Acción:* ${warningData.accion}`;
    });
  }
  
  // Bloque de Éxitos (si existen)
  if (exitos.length > 0) {
    mensaje += `\n\n*--- ✅ ÉXITOS ---*`;
    exitos.forEach(succ => {
      mensaje += `\n• ${succ.mensaje}`;
    });
  }

  // Bloque de Tareas Cerradas (si existen)
  if (tareasCerradas > 0) {
    // Si ya hay una sección de éxitos, lo añade ahí. Si no, crea su propia sección.
    if (exitos.length === 0) {
       mensaje += `\n\n*--- ✅ ÉXITOS ---*`;
    }
    mensaje += `\n• Se cerraron *${tareasCerradas}* tareas programadas.`;
  }
  
  const fullMessage = `*${titulo}*${mensaje}`;
  const payload = JSON.stringify({ text: fullMessage });
  const options = { "method": "post", "contentType": "application/json", "payload": payload, "muteHttpExceptions": true };
  
  try {
    const response = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, options);
    Logger.log(`Respuesta de Slack: Código ${response.getResponseCode()}. Mensaje: "${response.getContentText()}"`);
  } catch (e) { /* Fallo silencioso */ }
}


// --- FUNCIÓN PRINCIPAL DE CONFIGURACIÓN Y EXCEPCIONES ---

/**
 * Extrae la configuración del cliente de forma robusta, manejando diferentes
 * formatos de remitente de correo electrónico.
 */
function getClientConfig(senderEmail, operationName, soporte = false) {
  try {
    // --- INICIO DE LA CORRECCIÓN ---
    // Lógica mejorada para extraer siempre la dirección de email limpia,
    // incluso si el remitente viene en formato "Nombre <email@dominio.com>".
    let cleanEmail = senderEmail;
    const emailMatch = senderEmail.match(/<([^>]+)>/); // Busca el contenido dentro de <...>
    if (emailMatch && emailMatch[1]) {
      cleanEmail = emailMatch[1]; // Si lo encuentra, usa ese como el email limpio
    }
    
    // Ahora, extrae el dominio del email limpio
    const domainMatch = cleanEmail.match(/@(.+)/);
    // --- FIN DE LA CORRECCIÓN ---

    if (!domainMatch || !domainMatch[1]) {
      Logger.log(`No se pudo extraer un dominio válido del remitente original: "${senderEmail}"`);
      return null;
    }
    const domain = "@" + domainMatch[1].trim();

    var idHojaCalculo = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
    const masterSheet = SpreadsheetApp.openById(idHojaCalculo).getSheets()[0];
    const masterData = masterSheet.getDataRange().getValues();
    const clientRow = masterData.find(row => row[0].toLowerCase() === domain.toLowerCase());

    if (!clientRow) {
      Logger.log(`No se encontró una fila para el dominio "${domain}" (extraído de "${senderEmail}") en el Índice Maestro.`);
      return null;
    }

    const clientName = clientRow[1],
          exceptionFileId = clientRow[2],
          jiraProjectKey = clientRow[3],
          serviceDeskId = clientRow[4],
          requestTypeName = clientRow[5],
          tecnologiaValue = clientRow[6],
          origenValue = clientRow[7] || null,
          jiraProjectKeySop = clientRow[13],
          serviceDeskIdSop = clientRow[14],
          requestTypeNameSop = clientRow[16],
          clientNameSop = clientRow[15];



    if (!clientName || !jiraProjectKey || !serviceDeskId || !requestTypeName || !tecnologiaValue) {
      Logger.log(`ERROR: La configuración para "${clientName}" (dominio ${domain}) está incompleta en el Índice Maestro.`);
      return null;
    }

    const requestTypeId = getRequestTypeIdForServiceDesk(serviceDeskId, requestTypeName);
    const requestTypeIdSop = getRequestTypeIdForServiceDesk(serviceDeskIdSop, requestTypeNameSop);
    if (!requestTypeId) return null;
    
    const exceptionSheet = SpreadsheetApp.openById(exceptionFileId).getSheetByName(operationName);
    
    if (!exceptionSheet && !soporte) {
      Logger.log(`ADVERTENCIA: No se encontró la PESTAÑA de excepciones "${operationName}" en el archivo del cliente ${clientName}. Se continuará sin excepciones.`);
      return { exceptions: {}, clientName, jiraProjectKey, serviceDeskId, requestTypeId, tecnologia: tecnologiaValue, origen: origenValue };
    }else if (!exceptionSheet && soporte) {
      Logger.log(`ADVERTENCIA: No se encontró la PESTAÑA de excepciones "${operationName}" en el archivo del cliente ${clientName}. Se continuará sin excepciones.`);
      return { exceptions: {}, clientNameSop, jiraProjectKeySop, serviceDeskIdSop, requestTypeIdSop, tecnologia: "Veeam Backup & Replication", origen: origenValue };
    }

    const exceptionRange = exceptionSheet.getDataRange();
    const exceptionData = exceptionRange.getValues();
    exceptionData.shift();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    exceptionData.forEach((row, index) => {
      const isActive = (row[5] || "").toString().toUpperCase();
      if (isActive !== 'SI') return;

      let isRuleValid = true;
      let reasonForInvalidity = "";

      const expiryDateValue = row[4];
      if (expiryDateValue) {
        let expiryDate;
        if (expiryDateValue instanceof Date) {
          expiryDate = expiryDateValue;
        } else if (typeof expiryDateValue === 'string' && expiryDateValue.includes('/')) {
          const parts = expiryDateValue.split('/');
          if (parts.length === 3) expiryDate = new Date(parseInt(parts[2], 10), parseInt(parts[0], 10) - 1, parseInt(parts[1], 10));
        }
        if (expiryDate && !isNaN(expiryDate.getTime())) {
          expiryDate.setHours(0, 0, 0, 0);
          if (expiryDate < today) {
            isRuleValid = false;
            reasonForInvalidity = "La fecha ha vencido.";
          }
        }
      }
      
      /***if (isRuleValid) {
        const ticketApprovalLink = row[6];
        if (!ticketApprovalLink) {
          isRuleValid = false;
          reasonForInvalidity = "Falta el Ticket de Aprobación obligatorio.";
        } else if (typeof ticketApprovalLink === 'string' && ticketApprovalLink.includes('/browse/')) {
          const ticketKeyMatch = ticketApprovalLink.match(/\/browse\/([A-Z]+-\d+)/);
          if (ticketKeyMatch && ticketKeyMatch[1]) {
            if (!doesJiraTicketExist(ticketKeyMatch[1])) {
              isRuleValid = false;
              reasonForInvalidity = `El ticket de aprobación ${ticketKeyMatch[1]} no existe.`;
            }
          } else {
            isRuleValid = false;
            reasonForInvalidity = "El formato del link del Ticket de Aprobación es incorrecto.";
          }
        } else {
          isRuleValid = false;
          reasonForInvalidity = `El valor "${ticketApprovalLink}" no es un link de Jira válido.`;
        }
      }***/

      if (!isRuleValid) {
        Logger.log(`Desactivando excepción "${row[0]}". Motivo: ${reasonForInvalidity}`);
        exceptionSheet.getRange(index + 2, 6).setValue("NO");
        row[5] = "NO";
      }
    });

    const activeExceptions = exceptionData.filter(row => (row[5] || "").toString().toUpperCase() === 'SI');
    const groupedExceptions = {};
    activeExceptions.forEach(row => {
      const exceptionId = row[0];
      if (!groupedExceptions[exceptionId]) groupedExceptions[exceptionId] = [];
      groupedExceptions[exceptionId].push({
        column: row[1], matchType: row[2], 
        values: (row[3] || "").toString().split(',').map(v => v.trim().toLowerCase())
      });
    });
    if (soporte){
      return {
      exceptions: groupedExceptions, clientNameSop, jiraProjectKeySop, serviceDeskIdSop, 
      requestTypeIdSop, tecnologia: "Veeam Backup & Replication", origen: origenValue
      }
    }
    return {
      exceptions: groupedExceptions, clientName, jiraProjectKey, serviceDeskId, 
      requestTypeId, tecnologia: tecnologiaValue, origen: origenValue
    };
  } catch (e) {
    Logger.log(`ERROR CRÍTICO DENTRO DE getClientConfig: ${e.message}`);
    Logger.log(`Stack: ${e.stack}`);
    return null; 
  }
}


// --- FUNCIONES DE INTERACCIÓN CON JIRA ---

function doesJiraTicketExist(ticketKey) {
  if (!ticketKey) return false;
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}?fields=id`;
  const options = {
    "method": "get", "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "muteHttpExceptions": true
  };
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    return response.getResponseCode() === 200;
  } catch (e) { return false; }
}

function createTicketAndNotify(summary, description, attachmentBlob, clientConfig, operationName) {
  // --- NUEVO: evita crear tickets duplicados en reintentos (ej. tras un HTTP 500 al adjuntar) ---
  const existingTicketKey = findExistingJiraTicket(summary, clientConfig.jiraProjectKey);
  if (existingTicketKey) {
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        return attachmentResult; // Mismo comportamiento que antes: si falla, el mail sigue sin marcarse leído y reintenta
      }
    }
    return { status: 'SUCCESS', detail: { mensaje: `Se actualizó el ticket ya existente <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}>.` } };
  }
  // --- FIN NUEVO ---

  const issue = createJiraTicketForVM(summary, description, clientConfig);
  if (issue && issue.issueKey) {
    let attachmentStatus = null;
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(issue.issueKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        addCommentToJiraTicket(issue.issueKey, `🚨 **¡Atención!** Se creó este ticket pero **falló la subida del reporte adjunto**. El sistema reintentará adjuntarlo automáticamente.`);
        attachmentStatus = attachmentResult; 
      }
    }
    const accountIdAsignado = PropertiesService.getScriptProperties().getProperty("JIRA_DEFAULT_ASSIGNEE_ID") || chequearSiEsInformativa(clientConfig.clientName, operationName);
    if (accountIdAsignado) {
        ticketInformativo(issue.issueKey, accountIdAsignado);
        if (attachmentStatus) return attachmentStatus; 
        return { 
          status: 'SUCCESS', 
          detail: { mensaje: `✅ *Informativo:* Ticket <${JIRA_DOMAIN}/browse/${issue.issueKey}|${issue.issueKey}> cerrado y asignado.` } 
        };
    }
    // 3. SI NO ES INFORMATIVO, SIGUE EL FLUJO NORMAL
    if (attachmentStatus) return attachmentStatus; // Retornamos el error si hubo fallo
    return { status: 'SUCCESS', detail: { mensaje: `Se creó el ticket <${JIRA_DOMAIN}/browse/${issue.issueKey}|${issue.issueKey}>.` } };
  } else {
    return { status: 'ERROR', detail: { error: "No se pudo crear el ticket en Jira.", detalle: `Resumen: "${summary}"` } };
  }
}

function createTicketCOMAFI(summary, description, attachmentBlob, clientConfig) {
  const issue = createJiraTicketForCOM(summary, description, clientConfig);
  if (issue && issue.issueKey) {
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(issue.issueKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        addCommentToJiraTicket(issue.issueKey, `🚨 **¡Atención!** Se creó este ticket pero **falló la subida del reporte adjunto**. El sistema reintentará adjuntarlo automáticamente.`);
        return attachmentResult;
      }
    }
    return { status: 'SUCCESS', detail: { mensaje: `Se creó el ticket <${JIRA_DOMAIN}/browse/${issue.issueKey}|${issue.issueKey}>.` } };
  } else {
    return { status: 'ERROR', detail: { error: "No se pudo crear el ticket en Jira.", detalle: `Resumen: "${summary}"` } };
  }
}
function createJiraTicketForCOM(summary, description, clientConfig) {
  const ORIGEN_FIELD_ID = "customfield_12305"; 
  const TECNOLOGIA_FIELD_ID = "customfield_12316";
  const DUEDATE_FIELD_ID = "duedate";
  
  const today = new Date();
  today.setDate(today.getDate() + 7);
  const dueDateString = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");

  // CAMBIO: Endpoint de Jira Core (API v2 es más compatible con strings simples)
  const endpoint = JIRA_DOMAIN + "/rest/api/2/issue";

  const payload = {
    "fields": {
      "project": { "id": clientConfig.projectId },
      "summary": summary,
      "description": description,                  // En API v2 esto sigue siendo un string simple
      [DUEDATE_FIELD_ID]: dueDateString,
      [TECNOLOGIA_FIELD_ID]: { "value": clientConfig.tecnologia }
    }
  };

  if (clientConfig.origen) {
    payload.fields[ORIGEN_FIELD_ID] = { "value": clientConfig.origen };
  }

  const options = {
    "method": "post",
    "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      return JSON.parse(response.getContentText());
    }
    console.log(response.getContentText()); // Para depurar errores
    return null;
  } catch (e) { return null; }
}

function createTicketAndNotifySoporte(summary, description, attachmentBlob, clientConfig) {
  const issue = createJiraTicketForSoporte(summary, description, clientConfig);
  if (issue && issue.issueKey) {
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(issue.issueKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        addCommentToJiraTicket(issue.issueKey, `🚨 **¡Atención!** Se creó este ticket pero **falló la subida del reporte adjunto**. El sistema reintentará adjuntarlo automáticamente.`);
        return attachmentResult;
      }
    }
    return { status: 'SUCCESS', detail: { mensaje: `Se creó el ticket <${JIRA_DOMAIN}/browse/${issue.issueKey}|${issue.issueKey}>.` } };
  } else {
    return { status: 'ERROR', detail: { error: "No se pudo crear el ticket en Jira.", detalle: `Resumen: "${summary}"` } };
  }
}

function createJiraTicketForVM(summary, description, clientConfig) {
  const ORIGEN_FIELD_ID = "customfield_12305"; 
  const TECNOLOGIA_FIELD_ID = "customfield_12316";
  const DUEDATE_FIELD_ID = "duedate";
  const today = new Date();
  today.setDate(today.getDate() + 7);
  const dueDateString = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const endpoint = JIRA_DOMAIN + "/rest/servicedeskapi/request";
  const payload = {
    "serviceDeskId": clientConfig.serviceDeskId, "requestTypeId": clientConfig.requestTypeId,
    "requestFieldValues": {
      "summary": summary, "description": description,
      [DUEDATE_FIELD_ID]: dueDateString,
      [TECNOLOGIA_FIELD_ID]: { "value": clientConfig.tecnologia }
    }
  };
  if (clientConfig.origen) {
    payload.requestFieldValues[ORIGEN_FIELD_ID] = { "value": clientConfig.origen };
  }
  const options = {
    "method": "post", "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  };
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      return JSON.parse(response.getContentText());
    }
    return null;
  } catch (e) { return null; }
}

/**
 * Busca en la hoja 'Informativas' si una tarea debe cerrarse automáticamente.
 * @param {string} clientName Nombre del cliente.
 * @param {string} operationName Nombre de la tarea/operación.
 * @returns {string|null} El accountId del asignado si es informativa, null si no.
 */
function chequearSiEsInformativa(clientName, operationName) {
  try {
    // ID del Spreadsheet del Índice Maestro (ajustar si es necesario)
    const ss = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID)
    const sheet = ss.getSheetByName("Informativas");
    
    if (!sheet) {
      Logger.log("⚠️ La hoja 'Informativas' no existe.");
      return null;
    }

    const data = sheet.getDataRange().getValues();
    // Asumimos columnas: A: Cliente, B: Tarea, C: Nombre, D: Informante ID (accountId)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0].toString().trim().toLowerCase() === clientName.toLowerCase() &&
          row[1].toString().trim().toLowerCase() === operationName.toLowerCase()) {
        return row[3]; // Retorna el accountId de la columna D
      }
    }
  } catch (e) {
    Logger.log("❌ Error en chequearSiEsInformativa: " + e.message);
  }
  return null;
}

/**
 * Asigna y avanza un ticket informativo, usando un delay para evitar pisarse con Jira.
 */
function ticketInformativo(issueKey, accountId) {
  const headers = getJiraHeaders();
  const baseUrl = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}`;
  const transitionsUrl = `${baseUrl}/transitions`;

  try {
    // 1. AGREGAR COMENTARIO INFORMATIVO
    const commentPayload = JSON.stringify({
      "body": {
        "type": "doc",
        "version": 1,
      }
    });
    UrlFetchApp.fetch(`${baseUrl}/comment`, {
      method: "post",
      headers: headers,
      payload: commentPayload,
      muteHttpExceptions: true
    });

    // 2. PRIMER SALTO: A "EN PROGRESO" (ID: 11)
    UrlFetchApp.fetch(transitionsUrl, {
      method: "post",
      headers: headers,
      payload: JSON.stringify({ "transition": { "id": "11" } }),
      muteHttpExceptions: true
    });

    // --- NUEVA ESTRATEGIA: ASIGNAR MIENTRAS ESTÁ EN PROGRESO ---
    const preAssign = UrlFetchApp.fetch(`${baseUrl}/assignee`, {
      method: "put",
      headers: headers,
      payload: JSON.stringify({ "accountId": accountId }),
      muteHttpExceptions: true
    });
    Logger.log(`Intento de asignación En Progreso: Código ${preAssign.getResponseCode()}`);

    // 3. SEGUNDO SALTO: A "CERRADO" (ID: 21) -> Usamos tu payload que funciona perfecto
    UrlFetchApp.fetch(transitionsUrl, {
      method: "post",
      headers: headers,
      payload: JSON.stringify({ "transition": { "id": "21" } }),
      muteHttpExceptions: true
    });

    // 4. PAUSA ESTRATÉGICA (Damos tiempo a que Jira asiente el estado Cerrado en su DB)
    Utilities.sleep(3000);

    // 5. ASIGNACIÓN FINAL (Seguro contra post-funciones)
    const postAssign = UrlFetchApp.fetch(`${baseUrl}/assignee`, {
      method: "put",
      headers: headers,
      payload: JSON.stringify({ "accountId": accountId }),
      muteHttpExceptions: true
    });
    
    // Logueamos la respuesta exacta de Jira para no trabajar a ciegas
    Logger.log(`Intento de asignación Final: Código ${postAssign.getResponseCode()} - Detalles: ${postAssign.getContentText()}`);
    Logger.log(`✅ Ticket ${issueKey} procesado y flujo finalizado.`);

  } catch (e) {
    Logger.log(`❌ Error crítico en ticketInformativo ${issueKey}: ` + e.message);
  }
}

function createJiraTicketForSoporte(summary, description, clientConfig) {
  const ORIGEN_FIELD_ID = "customfield_12305"; 
  const TECNOLOGIA_FIELD_ID = "customfield_12316";
  
  // 1. Definimos el ID del campo de sistema para prioridad
  const PRIORITY_FIELD_ID = "priority"; 
  const today = new Date();
  today.setDate(today.getDate() + 7);  
  const endpoint = JIRA_DOMAIN + "/rest/servicedeskapi/request";
  
  const payload = {
    "serviceDeskId": clientConfig.serviceDeskIdSop, 
    "requestTypeId": clientConfig.requestTypeIdSop,
    "requestFieldValues": {
      "summary": summary, 
      "description": description,
      [TECNOLOGIA_FIELD_ID]: { "value": "Veeam Backup & Replication" },
      
      // 2. Agregamos el objeto de prioridad.
      // Se espera que clientConfig.priority sea el ID numérico (ej: "4" para Baja)
      [PRIORITY_FIELD_ID]: { "id": "4" } 
    }
  };

//  if (clientConfig.origen) {
//    payload.requestFieldValues[ORIGEN_FIELD_ID] = { "value": clientConfig.origen };
//  }
  
  const options = {
    "method": "post", 
    "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload), 
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      return JSON.parse(response.getContentText());
    }
    // Es recomendable dejar un log si falla para ver el error de Jira
    console.log("Error Jira: " + response.getContentText());
    return null;
  } catch (e) { return null; }
}

function findExistingJiraTicket(summary, projectKey, issueTypeName) {
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/search/jql`;
  let jql = `summary ~ "${summary.replace(/"/g, '\\"')}" AND statusCategory != "Done"`;
  if (projectKey) jql += ` AND project = "${projectKey}"`;
  if (issueTypeName) jql += ` AND issuetype = "${issueTypeName}"`;
  jql += " ORDER BY created DESC";
  const payload = { "jql": jql, "maxResults": 1, "fields": ["key"] };
  const options = {
    "method": "post", "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  };
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      if (data.issues && data.issues.length > 0) return data.issues[0].key;
    }
    return null;
  } catch (e) { return null; }
}

function resolveJiraTicket(issueKey, statusToClose) {
  try {
    const transitionsUrl = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/transitions`;
    const optionsGet = { "method": "get", "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` }, "muteHttpExceptions": true };
    const responseGet = UrlFetchApp.fetch(transitionsUrl, optionsGet);
    if (responseGet.getResponseCode() !== 200) return { status: 'FAILURE' };

    const data = JSON.parse(responseGet.getContentText());
    const closeTransition = data.transitions.find(t => t.to.name === statusToClose);
    if (closeTransition) {
      const payload = { "transition": { "id": closeTransition.id } };
      const optionsPost = { "method": "post", "contentType": "application/json", "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` }, "payload": JSON.stringify(payload), "muteHttpExceptions": true };
      const responsePost = UrlFetchApp.fetch(transitionsUrl, optionsPost);
      if (responsePost.getResponseCode() === 204) {
        return { status: 'SUCCESS' };
      }
    }
    return { status: 'FAILURE' };
  } catch (e) { return { status: 'ERROR', detail: { error: e.message } }; }
}

function addCommentToJiraTicket(issueKey, commentText) {
  const endpoint = `${JIRA_DOMAIN}/rest/servicedeskapi/request/${issueKey}/comment`;
  const payload = { "body": commentText, "public": false };
  const options = { "method": "post", "contentType": "application/json", "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` }, "payload": JSON.stringify(payload), "muteHttpExceptions": true };
  try { UrlFetchApp.fetch(endpoint, options); } catch (e) { /* Fallo silencioso */ }
}

function addAttachmentToJiraTicket(issueKey, fileBlob) {
  const endpoint = `${JIRA_DOMAIN}/rest/api/2/issue/${issueKey}/attachments`;
  const boundary = `------${Utilities.base64Encode(Math.random().toString())}`;
  const data = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileBlob.getName()}"\r\nContent-Type: ${fileBlob.getContentType()}\r\n\r\n`;
  const payload = Utilities.newBlob(data).getBytes().concat(fileBlob.getBytes()).concat(Utilities.newBlob(`\r\n--${boundary}--\r\n`).getBytes());
  const options = {
    "method": "post", "contentType": `multipart/form-data; boundary=${boundary}`,
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}`, "X-Atlassian-Token": "no-check" },
    "payload": payload, "muteHttpExceptions": true
  };
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    const responseCode = response.getResponseCode();
    if (responseCode === 200) return { status: 'SUCCESS' };
    if (responseCode === 500) return { status: 'HTTP_500', detail: { ticketKey: issueKey, problema: 'Error 500 de Jira al adjuntar.', accion: 'Se reintentará.' } };
    return { status: 'WARNING', detail: { ticketKey: issueKey, problema: 'Fallo genérico al adjuntar.', accion: 'Revisar manualmente.' } };
  } catch (e) { return { status: 'ERROR', detail: { error: e.message } }; }
}

function getRequestTypeIdForServiceDesk(serviceDeskId, requestTypeName) {
  const endpoint = `${JIRA_DOMAIN}/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype`;
  const options = { "method": "get", "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` }, "muteHttpExceptions": true };
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      const foundType = data.values.find(type => type.name === requestTypeName);
      
      // Si no hace match, imprimimos qué estábamos buscando y qué nos devolvió Jira
      if (!foundType) {
        const nombresDisponibles = data.values.map(t => t.name).join(", ");
        Logger.log(`🚨 ERROR DE COINCIDENCIA: Buscábamos "${requestTypeName}" pero no está. Los disponibles en Jira son: [${nombresDisponibles}]`);
        return null;
      }
      return foundType.id;
      
    } else {
      // Si Jira nos tira un error 400, 403, 404, etc.
      Logger.log(`🚨 ERROR DE CONEXIÓN JIRA (HTTP ${response.getResponseCode()}): ${response.getContentText()}`);
      return null;
    }
  } catch (e) { 
    Logger.log(`🚨 EXCEPCIÓN CRÍTICA: ${e.message}`);
    return null; 
  }
}

/**
 * Normaliza un texto de encabezado para una comparación robusta.
 * Quita espacios al inicio/final, convierte a minúsculas y colapsa
 * múltiples espacios internos en uno solo.
 * @param {string} header El texto del encabezado.
 * @returns {string} El texto normalizado.
 */
function normalizarEncabezado(header) {
  if (typeof header !== 'string') return '';
  return header
    .trim()                  // 1. Quita espacios en los extremos
    .toLowerCase()           // 2. Convierte todo a minúsculas
    .replace(/\s+/g, ' ');   // 3. Reemplaza uno o más espacios/tabs/saltos por un solo espacio
}


/**
 * FUNCIÓN MODIFICADA
 * Verifica si una fila de reporte debe ser omitida según las reglas de excepción.
 * Ahora utiliza la normalización de encabezados para ser más robusta.
 * @param {Array} reportRow - La fila de datos del reporte.
 * @param {Array<string>} headers - La lista de encabezados YA NORMALIZADOS del reporte.
 * @param {Object} exceptions - El objeto con las reglas de excepción del cliente.
 * @returns {boolean} - `true` si la fila cumple con alguna regla de excepción, `false` en caso contrario.
 */
function isRowExcepted(reportRow, headers, exceptions) {
  for (const exceptionId in exceptions) {
    const ruleGroup = exceptions[exceptionId];
    const allConditionsMet = ruleGroup.every(condition => {
      // Normalizamos la columna leída desde el Excel de Excepciones antes de buscarla
      const normalizedConditionColumn = normalizarEncabezado(condition.column);
      const colIndex = headers.indexOf(normalizedConditionColumn);

      if (colIndex === -1) {
        // Este log es útil para depurar por qué una regla de excepción no funciona
        Logger.log(`ADVERTENCIA DE EXCEPCIÓN: La columna "${condition.column}" (normalizada como "${normalizedConditionColumn}") definida en el Excel de excepciones no se encontró en el reporte.`);
        return false; // La condición falla porque la columna no existe en el reporte
      }
      const reportValueStr = (reportRow[colIndex] || "").trim();
      return condition.values.some(exceptionValue => {
        const reportValueLower = reportValueStr.toLowerCase();
        switch (condition.matchType.toLowerCase()) {
          case 'exacta': return (reportValueLower === exceptionValue);
          case 'contiene': return reportValueLower.includes(exceptionValue);
          case 'empieza con': return reportValueLower.startsWith(exceptionValue);
          case 'termina con': return reportValueLower.endsWith(exceptionValue);
          case 'mayor que': case 'menor que':
            const reportNum = parseFloat(reportValueStr);
            const exceptionNum = parseFloat(exceptionValue);
            if (!isNaN(reportNum) && !isNaN(exceptionNum)) {
              if (condition.matchType.toLowerCase() === 'mayor que') return reportNum > exceptionNum;
              else return reportNum < exceptionNum;
            } return false;
          default: return false;
        }
      });
    });
    if (allConditionsMet) return true; // Si todas las condiciones de un grupo se cumplen, la fila está exceptuada
  }
  return false;
}

function convertDataToXlsxBlob(dataArray, newFileName) {
  let tempSheet = null;
  try {
    // --- INICIO DE LA CORRECCIÓN ---
    // Se añade una pausa de 1500 milisegundos (1.5 segundos) para evitar
    // errores intermitentes de permisos al crear varios archivos seguidos.
    Utilities.sleep(1500);
    // --- FIN DE LA CORRECCIÓN ---

    if (!dataArray || dataArray.length === 0 || !Array.isArray(dataArray[0])) {
      Logger.log("Error en convertDataToXlsxBlob: El array de datos está vacío o mal formado.");
      return null;
    }
    
    const numColumns = dataArray[0].length;
    for (let i = 1; i < dataArray.length; i++) {
      while (dataArray[i].length < numColumns) {
        dataArray[i].push('');
      }
    }
    
    tempSheet = SpreadsheetApp.create(`Temp_Conversion_${new Date().getTime()}`);
    const sheet = tempSheet.getSheets()[0];
    sheet.getRange(1, 1, dataArray.length, dataArray[0].length).setValues(dataArray);
    SpreadsheetApp.flush();

    const url = `https://docs.google.com/spreadsheets/d/${tempSheet.getId()}/export?format=xlsx`;
    const params = { "method": "GET", "headers": { "Authorization": `Bearer ${ScriptApp.getOAuthToken()}` }, "muteHttpExceptions": true };
    const response = UrlFetchApp.fetch(url, params);
    
    if (response.getResponseCode() !== 200) {
      Logger.log(`Error al exportar la hoja temporal. Código de respuesta: ${response.getResponseCode()}`);
      return null;
    }

    const xlsxBlob = response.getBlob();
    xlsxBlob.setName(newFileName);
    return xlsxBlob;
  } catch (e) {
    Logger.log(`Error CRÍTICO en convertDataToXlsxBlob: ${e.message} | Stack: ${e.stack}`);
    return null;
  }
  finally { 
    if (tempSheet) {
      DriveApp.getFileById(tempSheet.getId()).setTrashed(true);
    }
  }
}
/**
 * Función de diagnóstico para ver los encabezados de un reporte tal como los ve el script.
 * Se ejecuta manualmente desde el editor de Apps Script.
 */
function diagnosticarEncabezadosDeReporte() {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    'Diagnóstico de Encabezados',
    'Ingresa el nombre EXACTO de la operación (ej. "VMs operativas", "Cluster DRS"):',
    ui.ButtonSet.OK_CANCEL);

  if (result.getSelectedButton() !== ui.Button.OK || !result.getResponseText()) {
    return;
  }
  
  const operationName = result.getResponseText().trim();
  Logger.log(`--- Iniciando diagnóstico para la operación: "${operationName}" ---`);

  const searchQuery = `subject:"${operationName}" has:attachment`;
  const threads = GmailApp.search(searchQuery, 0, 1);

  if (threads.length === 0) {
    Logger.log(`No se encontró ningún correo con el asunto que contenga "${operationName}".`);
    return;
  }

  const message = threads[0].getMessages()[threads[0].getMessageCount() - 1];
  const attachment = message.getAttachments()[0];
  if (!attachment) {
    Logger.log("El correo más reciente no tiene adjuntos.");
    return;
  }
  
  Logger.log(`Correo encontrado. Asunto: "${message.getSubject()}"`);
  Logger.log(`Adjunto: "${attachment.getName()}"`);

  let headers = [];
  const fileName = attachment.getName().toLowerCase();

  try {
    if (fileName.endsWith(".csv")) {
      const allRows = Utilities.parseCsv(attachment.getDataAsString("UTF-8"));
      if (allRows.length > 0) {
        headers = allRows[0].map(h => h.replace(/\uFEFF/g, '').trim().replace(/^"|"$/g, ''));
      }
    } else if (fileName.endsWith(".json")) {
      const jsonString = attachment.getDataAsString("UTF-8");
      const parsedJson = JSON.parse(jsonString.replace(/^\uFEFF/, ''));
      const reportData = parsedJson.Report || parsedJson.alerts || parsedJson;
      if (Array.isArray(reportData) && reportData.length > 0) {
        headers = Object.keys(reportData[0]);
      }
    } else {
      Logger.log("El adjunto no es un archivo .csv o .json reconocido.");
      return;
    }
  } catch (e) {
    Logger.log(`Error al procesar el archivo: ${e.message}`);
    return;
  }

  if (headers.length > 0) {
    Logger.log("--- Encabezados Detectados ---");
    headers.forEach((header, index) => {
      Logger.log(`[${index}] "${header}"`);
    });
    Logger.log("--------------------------------");
    SpreadsheetApp.getUi().alert("Diagnóstico completo. Revisa los logs para ver los encabezados.");
  } else {
    Logger.log("No se pudieron extraer encabezados del reporte.");
  }
}
function forzarReautorizacion() {
  // Esta función no hace nada.
  MailApp.sendEmail("test@test.com", "test", "test");
}

/**
 * NUEVA FUNCIÓN DE ESTILO ESTÁNDAR (CORPORATIVO)
 * Toma datos crudos, busca la tabla, limpia columnas, aplica estilo verde/blanco y exporta.
 * * @param {Array<Array<string>>} rawData - Datos crudos leídos del Excel (incluyendo filas de metadatos arriba).
 * @param {string} fileName - Nombre del archivo de salida.
 * @param {Array<string>} columnsToIgnore - Lista de encabezados a eliminar (ej: ["Average VM..."]).
 * @param {string} headerKeyword - Palabra clave para encontrar dónde empieza la tabla (ej: "Virtual Machine").
 * @returns {Blob} El archivo Excel formateado listo para Jira.
 */
function generateStyledReportBlob(rawData, fileName, columnsToIgnore = [], headerKeyword = "") {
  let tempSheet = null;
  let tempFileId = null;

  try {
    if (!rawData || rawData.length === 0) return null;

    // --- 1. DETECTAR EL ENCABEZADO Y RECORTAR ---
    // Muchos reportes tienen texto basura arriba ("Scope:...", "Date:..."). Buscamos la tabla real.
    let tableData = rawData;
    if (headerKeyword) {
      const headerIndex = rawData.findIndex(row => 
        row.join(" ").toLowerCase().includes(headerKeyword.toLowerCase())
      );
      if (headerIndex !== -1) {
        tableData = rawData.slice(headerIndex); // Nos quedamos solo desde el encabezado hacia abajo
      }
    }

    if (tableData.length === 0) return null;

    // --- 2. FILTRAR COLUMNAS (Vacías + Ignoradas) ---
    const headers = tableData[0];
    const indicesToRemove = [];
    const ignoreNormalized = columnsToIgnore.map(c => c.toLowerCase().trim());

    headers.forEach((h, index) => {
      const hStr = (h || "").toString();
      const hNorm = hStr.toLowerCase().trim();
      // Eliminar si está vacío o si está en la lista de ignorados
      if (hStr.trim() === "" || ignoreNormalized.some(ign => hNorm.includes(ign))) {
        indicesToRemove.push(index);
      }
    });
    // Ordenar descendente para borrar sin romper índices
    indicesToRemove.sort((a, b) => b - a);

    const cleanData = tableData.map(row => {
      const newRow = [...row];
      indicesToRemove.forEach(index => {
        if (index < newRow.length) newRow.splice(index, 1);
      });
      return newRow;
    });

    if (cleanData.length === 0) return null;

    // --- 3. CREAR EXCEL TEMPORAL ---
    tempSheet = SpreadsheetApp.create(`TEMP_REPORT_${new Date().getTime()}`);
    tempFileId = tempSheet.getId();
    const sheet = tempSheet.getSheets()[0];
    
    // Escribir datos limpios
    const range = sheet.getRange(1, 1, cleanData.length, cleanData[0].length);
    range.setValues(cleanData);
    
    // --- 4. APLICAR ESTILO CORPORATIVO ---
    
    // A. Bordes Negros a TODA la tabla
    range.setBorder(true, true, true, true, true, true, "black", SpreadsheetApp.BorderStyle.SOLID);
    
    // B. Encabezados (Fila 1): Fondo Verde (#34a853), Letra Blanca, Negrita
    const headerRange = sheet.getRange(1, 1, 1, cleanData[0].length);
    headerRange.setBackground("#34a853");
    headerRange.setFontColor("white");
    headerRange.setFontWeight("bold");
    headerRange.setHorizontalAlignment("center");
    headerRange.setVerticalAlignment("middle");
    
    // C. Primera Columna con datos (Fila 2 en adelante): Fondo Verde (#34a853), Letra Blanca, Negrita
    if (cleanData.length > 1) {
      const firstColRange = sheet.getRange(2, 1, cleanData.length - 1, 1);
      firstColRange.setBackground("#34a853");
      firstColRange.setFontColor("white");
      firstColRange.setFontWeight("bold");
    }
    
    // D. Ajustar anchos
    sheet.autoResizeColumns(1, cleanData[0].length);
    SpreadsheetApp.flush();

    // --- 5. EXPORTAR A BLOB ---
    const url = `https://docs.google.com/spreadsheets/d/${tempFileId}/export?format=xlsx`;
    const params = { "method": "GET", "headers": { "Authorization": `Bearer ${ScriptApp.getOAuthToken()}` }, "muteHttpExceptions": true };
    const response = UrlFetchApp.fetch(url, params);
    
    if (response.getResponseCode() === 200) {
      const blob = response.getBlob();
      blob.setName(fileName);
      return blob;
    } else {
      throw new Error("Error exportando XLSX.");
    }

  } catch (e) {
    Logger.log("Error en generateStyledReportBlob: " + e.message);
    return null;
  } finally {
    if (tempFileId) {
      try { Drive.Files.update({trashed: true}, tempFileId); } catch (e) {}
    }
  }

  function obtenerLlavesDeSoporte() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetById(MASTER_INDEX_SHEET_ID); 
  
  // Traemos desde la fila 2 (asumiendo que la 1 tiene encabezados) columnas N, O y P.
  // En este rango, N = índice 0, O = índice 1, P = índice 2
  const data = sheet.getRange("N2:P" + sheet.getLastRow()).getValues();
  const llavesSoporte = [];
  
  data.forEach(row => {
    const keySoporte = row[0]; // Columna N
    if (keySoporte) {
      // Lo guardamos en mayúsculas y sin espacios extra para evitar problemas
      llavesSoporte.push(keySoporte.toString().toUpperCase().trim()); 
    }
  });
  
  return llavesSoporte; 
}

}

