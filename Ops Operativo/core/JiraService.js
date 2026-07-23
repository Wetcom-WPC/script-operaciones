const JIRA_TRANSITION_IN_PROGRESS_ID = "11";
const JIRA_TRANSITION_CLOSED_ID = "21";
const JIRA_PRIORITY_LOW_ID = "4";

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
    "headers": getJiraHeaders(),
    "muteHttpExceptions": true
  };
  
  try {
    const response = fetchWithRetries(endpoint, options);
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

// --- NUEVO SISTEMA DE NOTIFICACIONES ---
/**
 * NUEVA FUNCIÓN ANTI-SPAM
 * Revisa si un ticket de Jira ya fue actualizado hoy con un identificador específico.
 * @param {string} issueKey La clave del ticket de Jira (ej. "PROJ-123").
 * @param {string} fingerprint Un texto único para la actualización de hoy (ej. el nombre de la alerta).
 * @returns {boolean} Devuelve `true` si ya fue actualizado hoy, `false` en caso contrario.
 */

function haSidoActualizadoHoy(issueKey, fingerprint) {
  try {
    const todayMarker = `[AUTO-UPDATE:${new Date().toISOString().slice(0, 10)}]`;
    const fullFingerprint = `${todayMarker} ${fingerprint}`;

    const endpoint = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=1`;
    const options = {
      "method": "get",
      "contentType": "application/json",
      "headers": getJiraHeaders(),
      "muteHttpExceptions": true
    };
    
    const response = fetchWithRetries(endpoint, options);
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


// --- FUNCIONES DE INTERACCIÓN CON JIRA ---

function doesJiraTicketExist(ticketKey) {
  if (!ticketKey) return false;
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}?fields=id`;
  const options = {
    "method": "get", "contentType": "application/json",
    "headers": getJiraHeaders(),
    "muteHttpExceptions": true
  };
  try {
    const response = fetchWithRetries(endpoint, options);
    return response.getResponseCode() === 200;
  } catch (e) { return false; }
}

function createTicketAndNotify(summary, description, attachmentBlob, clientConfig, operationName) {
  // --- NUEVO: evita crear tickets duplicados en reintentos (ej. tras un HTTP 500 al adjuntar) ---
  const existingTicketKey = findExistingJiraTicket(summary, clientConfig.jiraProjectKey);
  if (existingTicketKey) {
    // Si la anomalía sigue abierta, agregamos un comentario de persistencia
    addCommentToJiraTicket(existingTicketKey, "La anomalía persiste.");
    let attachmentOk = true;
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        // Un 500 de Jira no siempre significa que el archivo no llegó: confirmamos contra la API real antes de rendirnos.
        attachmentOk = buscarAdjuntoEnTicket(existingTicketKey, attachmentBlob.getName());
        if (!attachmentOk) {
          return attachmentResult; // Mismo comportamiento que antes: si falla, el mail sigue sin marcarse leído y reintenta
        }
      }
    }
    // El adjunto ya está confirmado en Jira (subido ahora o en un intento previo). Si es informativa y sigue sin cerrarse, la cerramos ahora.
    const accountIdInformativa = chequearSiEsInformativa(clientConfig.clientName, operationName);
    if (accountIdInformativa) {
      ticketInformativo(existingTicketKey, accountIdInformativa);
    }
    return { status: 'SUCCESS', detail: { mensaje: `Se actualizó el ticket ya existente <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}>.` } };
  }
  // --- FIN NUEVO ---

  const issue = createJiraTicketForVM(summary, description, clientConfig);
  if (issue && issue.issueKey) {
    let attachmentStatus = null;
    let attachmentOk = true;
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(issue.issueKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        attachmentOk = buscarAdjuntoEnTicket(issue.issueKey, attachmentBlob.getName());
        if (!attachmentOk) {
          addCommentToJiraTicket(issue.issueKey, `🚨 **¡Atención!** Se creó este ticket pero **falló la subida del reporte adjunto**. El sistema reintentará adjuntarlo automáticamente.`);
          attachmentStatus = attachmentResult;
        }
      }
    }
    const accountIdInformativa = chequearSiEsInformativa(clientConfig.clientName, operationName);
    if (accountIdInformativa) {
        if (attachmentOk) {
          ticketInformativo(issue.issueKey, accountIdInformativa);
          return {
            status: 'SUCCESS',
            detail: { mensaje: `✅ *Informativo:* Ticket <${JIRA_DOMAIN}/browse/${issue.issueKey}|${issue.issueKey}> cerrado y asignado.` }
          };
        }
        // El adjunto todavía no está confirmado: no cerramos el ticket todavía.
        // El próximo reintento lo va a encontrar como "ticket existente" (arriba) y lo va a cerrar ahí una vez confirmado el adjunto.
        return attachmentStatus;
    }

    // Si no es informativa, pero tenemos un asignado por defecto, asignarlo (sin cerrar)
    const defaultAssignee = PropertiesService.getScriptProperties().getProperty("JIRA_DEFAULT_ASSIGNEE_ID");
    if (defaultAssignee) {
        assignJiraTicket(issue.issueKey, defaultAssignee);
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
    "headers": getJiraHeaders(),
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = fetchWithRetries(endpoint, options);
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
    "headers": getJiraHeaders(),
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  };
  try {
    const response = fetchWithRetries(endpoint, options);
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      return JSON.parse(response.getContentText());
    }
    return null;
  } catch (e) { return null; }
}

/**
 * Asigna y avanza un ticket informativo, usando polling para evitar pisarse con Jira.
 */
function ticketInformativo(issueKey, accountId, timeGuard = null) {
  const headers = getJiraHeaders();
  const baseUrl = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}`;
  const transitionsUrl = `${baseUrl}/transitions`;

  try {
    // 1. AGREGAR COMENTARIO INFORMATIVO
    const commentPayload = JSON.stringify({
      "body": {
        "type": "doc",
        "version": 1,
        "content": [{
          "type": "paragraph",
          "content": [{ "type": "text", "text": "Ticket cerrado automáticamente por regla informativa." }]
        }]
      }
    });
    fetchWithRetries(`${baseUrl}/comment`, {
      method: "post",
      headers: headers,
      payload: commentPayload,
      muteHttpExceptions: true
    });

    // 2. PRIMER SALTO: A "EN PROGRESO"
    fetchWithRetries(transitionsUrl, {
      method: "post",
      headers: headers,
      payload: JSON.stringify({ "transition": { "id": JIRA_TRANSITION_IN_PROGRESS_ID } }),
      muteHttpExceptions: true
    });

    // --- ASIGNAR MIENTRAS ESTÁ EN PROGRESO ---
    const preAssign = fetchWithRetries(`${baseUrl}/assignee`, {
      method: "put",
      headers: headers,
      payload: JSON.stringify({ "accountId": accountId }),
      muteHttpExceptions: true
    });
    Logger.log(`Intento de asignación En Progreso: Código ${preAssign.getResponseCode()}`);

    // 3. SEGUNDO SALTO: A "CERRADO"
    fetchWithRetries(transitionsUrl, {
      method: "post",
      headers: headers,
      payload: JSON.stringify({ "transition": { "id": JIRA_TRANSITION_CLOSED_ID } }),
      muteHttpExceptions: true
    });

    // 4. POLLING PARA ESPERAR CIERRE EFECTIVO
    let isClosed = false;
    for (let i = 0; i < 5; i++) {
      if (timeGuard && !timeGuard.check(`Jira Polling ${issueKey}`)) {
        Logger.log(`⚠️ Abortando polling de Jira para el ticket ${issueKey} por límite de tiempo de ejecución (TimeGuard).`);
        break;
      }
      Utilities.sleep(1000); // Espera 1s entre intentos
      const statusCheck = fetchWithRetries(`${baseUrl}?fields=status`, {
        method: "get",
        headers: headers,
        muteHttpExceptions: true
      });
      if (statusCheck.getResponseCode() === 200) {
        const data = JSON.parse(statusCheck.getContentText());
        if (data.fields && data.fields.status && data.fields.status.statusCategory.key === 'done') {
          isClosed = true;
          break;
        }
      }
    }

    if (!isClosed) {
      Logger.log(`⚠️ Advertencia: El ticket ${issueKey} no reflejó el estado "Cerrado" después de 5 segundos.`);
    }

    // 5. ASIGNACIÓN FINAL (Seguro contra post-funciones)
    const postAssign = fetchWithRetries(`${baseUrl}/assignee`, {
      method: "put",
      headers: headers,
      payload: JSON.stringify({ "accountId": accountId }),
      muteHttpExceptions: true
    });
    
    Logger.log(`Intento de asignación Final: Código ${postAssign.getResponseCode()}`);
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
      [PRIORITY_FIELD_ID]: { "id": JIRA_PRIORITY_LOW_ID } 
    }
  };

//  if (clientConfig.origen) {
//    payload.requestFieldValues[ORIGEN_FIELD_ID] = { "value": clientConfig.origen };
//  }
  
  const options = {
    "method": "post", 
    "contentType": "application/json",
    "headers": getJiraHeaders(),
    "payload": JSON.stringify(payload), 
    "muteHttpExceptions": true
  };
  
  try {
    const response = fetchWithRetries(endpoint, options);
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      return JSON.parse(response.getContentText());
    }
    // Es recomendable dejar un log si falla para ver el error de Jira
    Logger.log("Error Jira: " + response.getContentText());
    return null;
  } catch (e) { return null; }
}

function findExistingJiraTicket(summary, projectKey, issueTypeName) {
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/search/jql`;
  let jql = `summary ~ "${summary.replace(/"/g, '\\"')}" AND statusCategory != "Done"`;
  if (projectKey) jql += ` AND project = "${projectKey}"`;
  if (issueTypeName) jql += ` AND issuetype = "${issueTypeName}"`;
  jql += " ORDER BY created DESC";
  
  // Pedimos varios resultados y el campo summary para comparar con exactitud
  const payload = { "jql": jql, "maxResults": 10, "fields": ["key", "summary"] };
  const options = {
    "method": "post", "contentType": "application/json",
    "headers": getJiraHeaders(),
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  };
  try {
    const response = fetchWithRetries(endpoint, options);
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      if (data.issues && data.issues.length > 0) {
        const targetSummary = summary.trim().toLowerCase();
        
        // 1. Buscamos coincidencia exacta primero
        const exactMatch = data.issues.find(issue => issue.fields.summary.trim().toLowerCase() === targetSummary);
        if (exactMatch) return exactMatch.key;
        
        // 2. Si buscamos un ticket No-AVS, filtramos para no agarrar por error uno AVS
        if (!targetSummary.includes('avs')) {
            const nonAvsMatch = data.issues.find(issue => !issue.fields.summary.toLowerCase().includes('avs'));
            if (nonAvsMatch) return nonAvsMatch.key;
        }

        // 3. Fallback al primer resultado
        return data.issues[0].key;
      }
    }
    return null;
  } catch (e) { return null; }
}

function resolveJiraTicket(issueKey, statusToClose) {
  try {
    const transitionsUrl = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/transitions`;
    const optionsGet = { "method": "get", "headers": getJiraHeaders(), "muteHttpExceptions": true };
    const responseGet = fetchWithRetries(transitionsUrl, optionsGet);
    if (responseGet.getResponseCode() !== 200) return { status: 'FAILURE' };

    const data = JSON.parse(responseGet.getContentText());
    const closeTransition = data.transitions.find(t => t.to.name === statusToClose);
    if (closeTransition) {
      const payload = { "transition": { "id": closeTransition.id } };
      const optionsPost = { "method": "post", "contentType": "application/json", "headers": getJiraHeaders(), "payload": JSON.stringify(payload), "muteHttpExceptions": true };
      const responsePost = fetchWithRetries(transitionsUrl, optionsPost);
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
  const options = { "method": "post", "contentType": "application/json", "headers": getJiraHeaders(), "payload": JSON.stringify(payload), "muteHttpExceptions": true };
  try { fetchWithRetries(endpoint, options); } catch (e) { 
    Logger.log(`[JiraService] Fallo al comentar en ${issueKey}: ${e.message}`); 
  }
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
    const response = fetchWithRetries(endpoint, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    Logger.log(`[JIRA ATTACH] Issue: ${issueKey} | Response Code: ${responseCode} | Body: ${responseText}`);
    if (responseCode === 200) return { status: 'SUCCESS' };
    if (responseCode === 500) return { status: 'HTTP_500', detail: { ticketKey: issueKey, problema: 'Error 500 de Jira al adjuntar. Detalle: ' + responseText, accion: 'Se reintentará.' } };
    return { status: 'WARNING', detail: { ticketKey: issueKey, problema: 'Fallo genérico al adjuntar: ' + responseText, accion: 'Revisar manualmente.' } };
  } catch (e) { 
    Logger.log(`[JIRA ATTACH ERROR] Excepción al adjuntar en ${issueKey}: ${e.message}`);
    return { status: 'ERROR', detail: { error: e.message } }; 
  }
}

function getRequestTypeIdForServiceDesk(serviceDeskId, requestTypeName) {
  const cacheKey = `JiraReqType_${serviceDeskId}_${requestTypeName.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const scriptCache = CacheService.getScriptCache();
  const cachedValue = scriptCache.get(cacheKey);
  if (cachedValue) return cachedValue;

  const endpoint = `${JIRA_DOMAIN}/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype`;
  const options = { "method": "get", "headers": getJiraHeaders(), "muteHttpExceptions": true };
  try {
    const response = fetchWithRetries(endpoint, options);
    
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      const foundType = data.values.find(type => type.name === requestTypeName);
      
      // Si no hace match, imprimimos qué estábamos buscando y qué nos devolvió Jira
      if (!foundType) {
        const nombresDisponibles = data.values.map(t => t.name).join(", ");
        Logger.log(`🚨 ERROR DE COINCIDENCIA: Buscábamos "${requestTypeName}" pero no está. Los disponibles en Jira son: [${nombresDisponibles}]`);
        return null;
      }
      scriptCache.put(cacheKey, foundType.id, 21600); // 6 hours
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
 * Asigna un ticket de Jira a un usuario específico mediante su accountId sin alterar su estado.
 */
function assignJiraTicket(issueKey, accountId) {
  const headers = getJiraHeaders();
  const endpoint = `${JIRA_DOMAIN}/rest/api/2/issue/${issueKey}/assignee`;
  const payload = JSON.stringify({ "accountId": accountId });
  const options = {
    method: "put",
    contentType: "application/json",
    headers: headers,
    payload: payload,
    muteHttpExceptions: true
  };
  try {
    const response = fetchWithRetries(endpoint, options);
    if (response.getResponseCode() !== 204) {
      Logger.log(`[JIRA] Falló asignación simple del ticket ${issueKey}: ${response.getContentText()}`);
    }
  } catch (e) {
    Logger.log(`[JIRA] Excepción al asignar ticket ${issueKey}: ${e.message}`);
  }
}

