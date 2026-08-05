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

  // --- GUARDA CENTRAL: no cerrar la TP si el correo ya falló en algún paso ---
  // Cerrar la tarea programada es lo ÚLTIMO que debe pasar: significa "este reporte quedó listo".
  // Si el adjunto falló (ej. HTTP 500 de Jira), cerrarla igual rompe el reintento: en el próximo
  // ciclo la tarea ya no aparece abierta, buscarYCerrarTareaProgramada devuelve NOT_FOUND (que es
  // terminal) y el correo se aparta a [OPS-ERROR] para siempre, aunque el 500 fuera pasajero.
  // Unos 20 processors llaman a esta función sin mirar el resultado del paso anterior, así que la
  // verificación vive acá, en un solo lugar, en vez de parchear cada uno (mismo criterio que
  // MailProcessor.aplicarFallosRegistrados — ver AGENTS.md §5 y §7).
  if (typeof obtenerFallosDelMensaje === "function") {
    const fallosPrevios = obtenerFallosDelMensaje();
    if (fallosPrevios.length > 0) {
      const motivos = fallosPrevios.map(function (f) { return `${f.origen}: ${f.detalle}`; }).join(" | ");
      Logger.log(`⏸ NO se cierra la tarea programada "${taskNameBase}" (proyecto ${projectKey}): el correo tiene ${fallosPrevios.length} paso(s) fallido(s), así que el reporte todavía no está completo. La tarea queda ABIERTA para que el reintento pueda cerrarla. Detalle: ${motivos}`);
      return { status: 'DEFERRED' };
    }
  }

  Logger.log(`Buscando Tarea Programada para el reporte de "${taskNameBase}"...`);
  Logger.log(` -> Nombre del Ticket: "${fullTaskName}"`);
  Logger.log(` -> Dentro del Proyecto de Jira: "${projectKey}"`);
  
  const taskKeyToClose = findExistingJiraTicket(fullTaskName, projectKey, "Tarea Programada");
  
  if (taskKeyToClose) {
    Logger.log(`✔ Tarea encontrada: ${taskKeyToClose}. Procediendo a cerrarla.`);
    const resultadoCierre = resolveJiraTicket(taskKeyToClose, JIRA_STATUS_TO_CLOSE);

    // La búsqueda la dio por abierta, pero al ir a cerrarla resultó que ya estaba en un estado
    // final: es el mismo reporte duplicado del caso de abajo, solo que detectado un paso más
    // tarde porque el índice de búsqueda de Jira venía atrasado (ver resolveJiraTicket).
    if (resultadoCierre && resultadoCierre.status === 'YA_CERRADO') {
      const estadoTarea = (resultadoCierre.detail && resultadoCierre.detail.estado) || "cerrada";
      return _resolverComoReporteDuplicado(taskKeyToClose, estadoTarea, fullTaskName, clientConfig);
    }

    return resultadoCierre;
  } else {
    Logger.log(`ℹ No se encontró una tarea programada ABIERTA con ese nombre en el proyecto ${projectKey}.`);

    // Antes de darlo por error hay que distinguir dos situaciones que se ven igual desde acá:
    //
    //   a) REPORTE DUPLICADO: el cliente mandó dos veces el reporte del día (o un segundo
    //      correo con un adjunto extra, que es habitual en los reportes de Veeam: primero
    //      llega el PDF y después el mismo correo con PDF + XLSX). El primero ya cerró la
    //      tarea, así que el segundo no encuentra nada abierto. El trabajo del día ESTÁ hecho
    //      y los adjuntos nuevos igual se archivaron en Drive: no es un fallo, es un aviso.
    //
    //   b) PROBLEMA DE CONFIGURACIÓN: no existe NINGUNA tarea con ese nombre hoy. Ahí sí hay
    //      algo que corregir (la tarea no se creó, o el nombre no coincide exactamente).
    //
    // Antes los dos casos terminaban en [OPS-ERROR], así que un duplicado perfectamente normal
    // quedaba apartado como si necesitara intervención manual.
    const tareaDeHoy = buscarTareaProgramadaDelDia(fullTaskName, projectKey);

    if (tareaDeHoy) {
      return _resolverComoReporteDuplicado(tareaDeHoy.key, tareaDeHoy.status, fullTaskName, clientConfig);
    }

    // Decisión del equipo (27/07/2026): NOT_FOUND cuenta como NO procesado, así que se
    // registra como fallo y el correo se reintenta en vez de darse por terminado.
    // Terminal: reintentar no la va a hacer aparecer. O la tarea no existe, o el nombre no
    // coincide, o ya fue cerrada a mano. Necesita que una persona lo revise.
    registrarFalloDePaso("buscarYCerrarTareaProgramada", `No existe ninguna tarea programada "${fullTaskName}" creada hoy en el proyecto ${projectKey} (cliente ${clientConfig.clientName}), en ningún estado. Verificar que la tarea se haya creado y que el nombre coincida exactamente.`, true);
    return { status: 'NOT_FOUND' };
  }
}

/**
 * Lee el estado ACTUAL de un ticket consultándolo directo (no por búsqueda JQL).
 *
 * La distinción importa: el buscador de Jira responde desde un índice que se actualiza de forma
 * asíncrona y puede devolver datos de hace unos segundos; pedir el issue por su clave devuelve
 * siempre el estado real. Por eso esta función es la fuente de verdad cuando hay que decidir si
 * un ticket ya está cerrado.
 *
 * @param {string} issueKey Clave del ticket.
 * @returns {{nombre: string, cerrado: boolean}|null} null si no se pudo consultar.
 */
function obtenerEstadoDeTicket(issueKey) {
  const options = { "method": "get", "headers": getJiraHeaders(), "muteHttpExceptions": true };
  try {
    const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}?fields=status`, options);
    if (respuesta.getResponseCode() !== 200) return null;

    const campos = JSON.parse(respuesta.getContentText()).fields;
    if (!campos || !campos.status) return null;

    return {
      nombre: campos.status.name,
      cerrado: !!(campos.status.statusCategory && campos.status.statusCategory.key === 'done')
    };
  } catch (e) {
    Logger.log(`[JIRA] No se pudo leer el estado de ${issueKey}: ${e.message}`);
    return null;
  }
}

/**
 * Resuelve el caso "el reporte del día ya se había procesado": deja el aviso en la tarea y
 * devuelve el estado DUPLICADO. Centralizado porque se llega acá por dos caminos distintos
 * (la tarea ya no aparece abierta, o aparece pero ya estaba cerrada por el índice desactualizado)
 * y el aviso tiene que ser el mismo en los dos (AGENTS.md §5).
 */
function _resolverComoReporteDuplicado(taskKey, estadoTarea, fullTaskName, clientConfig) {
  Logger.log(`📩 Reporte DUPLICADO de "${fullTaskName}" (cliente ${clientConfig.clientName}): la tarea ${taskKey} ya está en estado "${estadoTarea}". No se reabre y NO se reporta como error.`);
  addCommentToJiraTicket(
    taskKey,
    `📩 Llegó otro correo con el reporte "${fullTaskName}" el mismo día, cuando esta tarea ya estaba en estado "${estadoTarea}".\nSe procesó igual: si el correo traía adjuntos nuevos, se archivaron en Drive. No hace falta reabrir esta tarea.`,
    false // Informativo: si no se puede comentar, no debe mandar el correo a reintento.
  );
  return { status: 'DUPLICADO', taskKey: taskKey, estadoTarea: estadoTarea };
}

/**
 * Busca una Tarea Programada con ese nombre creada HOY, sin importar su estado (incluidas las
 * ya finalizadas). Es lo que permite distinguir un reporte duplicado de una tarea inexistente:
 * findExistingJiraTicket() solo mira las abiertas, así que una tarea ya cerrada por el primer
 * correo del día es invisible para él.
 *
 * @param {string} fullTaskName Nombre exacto de la tarea.
 * @param {string} projectKey Clave del proyecto de Jira.
 * @returns {{key: string, summary: string, status: string}|null}
 */
function buscarTareaProgramadaDelDia(fullTaskName, projectKey) {
  // startOfDay() lo resuelve Jira con su propia zona horaria, así que no depende de que la del
  // script coincida ni de formatear la fecha a mano.
  const jql = `project = "${projectKey}" AND issuetype = "Tarea Programada" AND summary ~ "${String(fullTaskName).replace(/"/g, '\\"')}" AND created >= startOfDay() ORDER BY created DESC`;
  const options = {
    "method": "post", "contentType": "application/json",
    "headers": getJiraHeaders(),
    "payload": JSON.stringify({ "jql": jql, "maxResults": 10, "fields": ["key", "summary", "status"] }),
    "muteHttpExceptions": true
  };

  try {
    const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/search/jql`, options);
    if (respuesta.getResponseCode() !== 200) {
      Logger.log(`[JIRA] No se pudo verificar si "${fullTaskName}" ya existía hoy en ${projectKey} (HTTP ${respuesta.getResponseCode()}). Se asume que no, para no dar por procesado un reporte que quizá no lo está.`);
      return null;
    }

    // El operador ~ de JQL es difuso ("Idle VMs" matchea "Idle VMs Prod"), así que se exige
    // coincidencia exacta en memoria — igual que findExistingJiraTicket.
    const objetivo = String(fullTaskName).trim().toLowerCase();
    const issues = JSON.parse(respuesta.getContentText()).issues || [];
    const exacta = issues.find(function (i) {
      return i.fields.summary && i.fields.summary.trim().toLowerCase() === objetivo;
    });

    if (!exacta) return null;
    return {
      key: exacta.key,
      summary: exacta.fields.summary,
      status: exacta.fields.status ? exacta.fields.status.name : "?"
    };
  } catch (e) {
    Logger.log(`[JIRA] Excepción verificando si "${fullTaskName}" ya existía hoy en ${projectKey}: ${e.message}. Se asume que no.`);
    return null;
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

/**
 * HOTFIX (29/07/2026) — Clientes cuyos reportes NUNCA generan tickets de alerta.
 *
 * Caso Gire: sus reportes se archivan en Drive y cierran su Tarea Programada como los de
 * cualquier otro cliente, pero no abren ni actualizan tickets de anomalía. Un proceso aparte
 * (custom/CasoGire.js) relee esos mismos archivos de Drive para armar el resumen filtrado que
 * se le manda por correo, así que los tickets de Jira serían ruido puro.
 *
 * Está hardcodeado A PROPÓSITO y no leído del Índice Maestro: se desplegó sin ventana de
 * pruebas y una lista en código es verificable de un vistazo, mientras que una columna nueva
 * en la hoja puede quedar mal alineada y apagar los tickets del cliente equivocado en silencio
 * (ver el intento previo con COL_SIN_TICKETS, que apuntaba a "Mail Tanzu Enviado"). Cuando haya
 * tiempo de probarlo, moverlo al Índice Maestro con su propia columna y un test que la valide.
 *
 * El guard vive acá, en las TRES funciones que crean tickets, y no en los processors: los 30
 * puntos del código que crean tickets pasan sí o sí por alguna de ellas, incluidos los 9
 * processors que sobrescriben processSingleMessage() y que un guard en la clase base no
 * alcanzaría.
 */
const CLIENTES_SIN_TICKETS_DE_ALERTA = ["operaciones gire"];

/**
 * @param {Object} clientConfig Configuración del cliente (normal o de soporte).
 * @returns {boolean} true si a este cliente no se le deben crear tickets de alerta.
 */
function esClienteSinTicketsDeAlerta(clientConfig) {
  if (!clientConfig) return false;
  const nombre = String(clientConfig.clientName || clientConfig.clientNameSop || "").trim().toLowerCase();
  if (!nombre) return false;
  return CLIENTES_SIN_TICKETS_DE_ALERTA.indexOf(nombre) !== -1;
}

/** Respuesta uniforme del guard: se reporta como éxito para no ensuciar el hilo ni el resumen. */
function _omitirTicketPorClienteSinTickets(summary, clientConfig) {
  const nombre = (clientConfig && (clientConfig.clientName || clientConfig.clientNameSop)) || "?";
  Logger.log(`[Jira] Cliente "${nombre}" está marcado sin tickets de alerta: NO se crea ni actualiza ticket para "${summary}". El reporte igual se archiva en Drive y su Tarea Programada se cierra normalmente.`);
  return { status: 'SUCCESS', detail: { mensaje: `Cliente "${nombre}": ticket de alerta omitido a propósito (sin tickets de alerta).` } };
}

function createTicketAndNotify(summary, description, attachmentBlob, clientConfig, operationName) {
  if (esClienteSinTicketsDeAlerta(clientConfig)) {
    return _omitirTicketPorClienteSinTickets(summary, clientConfig);
  }

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

    // Si no es informativa, el ticket queda SIN ASIGNAR a propósito: la asignación automática
    // es exclusiva de las tareas informativas (por Informante ID, columna D de la pestaña
    // "Informativas" del Índice Maestro — ver chequearSiEsInformativa()). Antes se le asignaba
    // igual un "dueño por defecto" (JIRA_DEFAULT_ASSIGNEE_ID) a TODO ticket nuevo, real o de
    // testing, lo que lo hacía parecer atendido sin que nadie lo hubiera tomado. Sin asignar es
    // más visible en la cola de trabajo real.

    // 3. SI NO ES INFORMATIVO, SIGUE EL FLUJO NORMAL
    if (attachmentStatus) return attachmentStatus; // Retornamos el error si hubo fallo
    return { status: 'SUCCESS', detail: { mensaje: `Se creó el ticket <${JIRA_DOMAIN}/browse/${issue.issueKey}|${issue.issueKey}>.` } };
  } else {
    return { status: 'ERROR', detail: { error: "No se pudo crear el ticket en Jira.", detalle: `Resumen: "${summary}"` } };
  }
}

function createTicketCOMAFI(summary, description, attachmentBlob, clientConfig) {
  if (esClienteSinTicketsDeAlerta(clientConfig)) {
    return _omitirTicketPorClienteSinTickets(summary, clientConfig);
  }

  const issue = createJiraTicketForCOM(summary, description, clientConfig);
  if (issue && issue.issueKey) {
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(issue.issueKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        // A-02: un 500 de Jira no siempre significa que el archivo no llegó. Confirmamos
        // contra la API real antes de rendirnos, para no re-subir el mismo adjunto en el
        // reintento (idempotencia), igual que createTicketAndNotify.
        if (!buscarAdjuntoEnTicket(issue.issueKey, attachmentBlob.getName())) {
          addCommentToJiraTicket(issue.issueKey, `🚨 **¡Atención!** Se creó este ticket pero **falló la subida del reporte adjunto**. El sistema reintentará adjuntarlo automáticamente.`);
          return attachmentResult;
        }
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
  if (esClienteSinTicketsDeAlerta(clientConfig)) {
    return _omitirTicketPorClienteSinTickets(summary, clientConfig);
  }

  // --- NUEVO: evita crear tickets duplicados en reintentos ---
  const existingTicketKey = findExistingJiraTicket(summary, clientConfig.jiraProjectKeySop);
  if (existingTicketKey) {
    addCommentToJiraTicket(existingTicketKey, "La anomalía persiste.");
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        if (!buscarAdjuntoEnTicket(existingTicketKey, attachmentBlob.getName())) {
          return attachmentResult;
        }
      }
    }
    return { status: 'SUCCESS', detail: { mensaje: `Se actualizó el ticket ya existente <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}>.` } };
  }
  // --- FIN NUEVO ---

  const issue = createJiraTicketForSoporte(summary, description, clientConfig);
  if (issue && issue.issueKey) {
    if (attachmentBlob) {
      const attachmentResult = addAttachmentToJiraTicket(issue.issueKey, attachmentBlob);
      if (attachmentResult.status !== 'SUCCESS') {
        if (!buscarAdjuntoEnTicket(issue.issueKey, attachmentBlob.getName())) {
          addCommentToJiraTicket(issue.issueKey, `🚨 **¡Atención!** Se creó este ticket pero **falló la subida del reporte adjunto**. El sistema reintentará adjuntarlo automáticamente.`);
          return attachmentResult;
        }
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
    // A-03: unificado a través de addCommentToJiraTicket (v3 + ADF + interno) para no
    // duplicar la construcción manual de ADF y mantener una sola vía de comentarios.
    addCommentToJiraTicket(issueKey, "Ticket cerrado automáticamente por regla informativa.");

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

/**
 * Transiciona un ticket al estado indicado.
 *
 * Los llamadores suelen descartar el resultado, así que cada fallo se loguea con
 * su motivo concreto. Antes devolvía 'FAILURE' sin dejar rastro y un cierre que
 * nunca ocurría era indistinguible de uno exitoso: las tareas programadas
 * quedaban abiertas sin que nada lo reportara.
 *
 * @param {string} issueKey Clave del ticket.
 * @param {string} statusToClose Nombre EXACTO del estado destino (ej. "Finalizado").
 * @returns {{status: string, detail?: Object}}
 */
function resolveJiraTicket(issueKey, statusToClose) {
  try {
    const transitionsUrl = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/transitions`;
    const optionsGet = { "method": "get", "headers": getJiraHeaders(), "muteHttpExceptions": true };
    const responseGet = fetchWithRetries(transitionsUrl, optionsGet);
    if (responseGet.getResponseCode() !== 200) {
      Logger.log(`[JIRA] No se pudieron leer las transiciones de ${issueKey} (HTTP ${responseGet.getResponseCode()}). El ticket queda abierto.`);
      registrarFalloDePaso("resolveJiraTicket", `Ticket ${issueKey}: HTTP ${responseGet.getResponseCode()} al leer las transiciones; no se pudo cerrar.`);
      return { status: 'FAILURE' };
    }

    const data = JSON.parse(responseGet.getContentText());
    const closeTransition = data.transitions.find(t => t.to.name === statusToClose);

    if (!closeTransition) {
      // Antes de darlo por error: un ticket que YA está en un estado final no ofrece ninguna
      // transición, así que "no hay transición a Finalizado" puede significar simplemente que
      // ya está cerrado. Pasa de verdad cuando dos correos del mismo reporte se procesan casi
      // juntos: el índice de búsqueda de Jira se actualiza de forma ASÍNCRONA y sigue
      // devolviendo el ticket como abierto unos segundos después de cerrarlo, mientras que la
      // API de transiciones ya ve el estado real. No es un fallo: el trabajo ya está hecho.
      const estado = obtenerEstadoDeTicket(issueKey);
      if (estado && estado.cerrado) {
        Logger.log(`[JIRA] ${issueKey} ya estaba en un estado final ("${estado.nombre}"): no hay nada que cerrar.`);
        return { status: 'YA_CERRADO', detail: { ticketKey: issueKey, estado: estado.nombre } };
      }

      const disponibles = data.transitions.map(t => t.to.name).join(", ");
      Logger.log(`[JIRA] ${issueKey} NO se cerró: no existe una transición hacia "${statusToClose}". Destinos disponibles: [${disponibles}]. Revisar JIRA_STATUS_TO_CLOSE en core/ConfiguracionGlobal.js.`);
      registrarFalloDePaso("resolveJiraTicket", `Ticket ${issueKey}: no existe transición hacia "${statusToClose}". Disponibles: [${disponibles}]. Revisar JIRA_STATUS_TO_CLOSE.`);
      return { status: 'FAILURE', detail: { ticketKey: issueKey, problema: `No existe transición a "${statusToClose}"`, disponibles } };
    }

    const payload = { "transition": { "id": closeTransition.id } };
    const optionsPost = { "method": "post", "contentType": "application/json", "headers": getJiraHeaders(), "payload": JSON.stringify(payload), "muteHttpExceptions": true };
    const responsePost = fetchWithRetries(transitionsUrl, optionsPost);

    if (responsePost.getResponseCode() === 204) {
      return { status: 'SUCCESS' };
    }

    Logger.log(`[JIRA] Falló la transición de ${issueKey} a "${statusToClose}" (HTTP ${responsePost.getResponseCode()}): ${responsePost.getContentText()}`);
    registrarFalloDePaso("resolveJiraTicket", `Ticket ${issueKey}: la transición a "${statusToClose}" devolvió HTTP ${responsePost.getResponseCode()}.`);
    return { status: 'FAILURE', detail: { ticketKey: issueKey, problema: `La transición devolvió HTTP ${responsePost.getResponseCode()}` } };
  } catch (e) {
    Logger.log(`[JIRA] Excepción al cerrar ${issueKey}: ${e.message}`);
    registrarFalloDePaso("resolveJiraTicket", `Ticket ${issueKey}: excepción al cerrar (${e.message}).`);
    return { status: 'ERROR', detail: { error: e.message } };
  }
}

/**
 * Convierte texto plano (con saltos de línea) al formato ADF (Atlassian Document Format)
 * que exige la API v3 de Jira. Cada línea se convierte en un nodo de texto separado por
 * hardBreak, de modo que un marcador de una sola línea (ej. "[AUTO-UPDATE:fecha] tarea")
 * queda íntegro en un único nodo de texto y es detectable al hacer JSON.stringify() del body.
 * @param {string} texto Texto plano del comentario.
 * @returns {Object} Documento ADF válido para el campo "body".
 */
function construirAdfDesdeTexto(texto) {
  const lineas = String(texto == null ? "" : texto).split("\n");
  const content = [];
  lineas.forEach((linea, idx) => {
    if (idx > 0) content.push({ "type": "hardBreak" });
    if (linea !== "") content.push({ "type": "text", "text": linea });
  });
  if (content.length === 0) content.push({ "type": "text", "text": " " });
  return { "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": content }] };
}

/**
 * Agrega un comentario INTERNO a un ticket de Jira.
 *
 * A-03: Unificado a la API de plataforma v3 (/rest/api/3/issue/.../comment) con cuerpo ADF.
 * Antes usaba /rest/servicedeskapi con body string, mientras que haSidoActualizadoHoy LEE los
 * comentarios vía v3 (ADF). Esa mezcla de APIs hacía frágil la detección del marcador
 * anti-duplicado [AUTO-UPDATE:fecha]. Con escritor y lector en la misma API/formato, el
 * marcador siempre coincide. La propiedad sd.public.comment=internal preserva el
 * comportamiento anterior (public:false → comentario interno, no visible al cliente).
 *
 * @param {string} issueKey Clave del ticket.
 * @param {string} commentText Texto plano del comentario.
 * @param {boolean} [esCritico=true] Si el comentario es parte del trabajo del correo, un fallo
 *   se registra y el correo se reintenta. Poner en false para comentarios meramente
 *   informativos (ej. avisar un reporte duplicado en una tarea YA cerrada): ahí un fallo solo
 *   se loguea, porque no poder dejar el aviso no significa que el reporte no se haya procesado
 *   — y registrarlo mandaría el correo a un reintento eterno por algo accesorio.
 */
function addCommentToJiraTicket(issueKey, commentText, esCritico = true) {
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/comment`;
  const payload = {
    "body": construirAdfDesdeTexto(commentText),
    "properties": [{ "key": "sd.public.comment", "value": { "internal": true } }]
  };
  const options = { "method": "post", "contentType": "application/json", "headers": getJiraHeaders(), "payload": JSON.stringify(payload), "muteHttpExceptions": true };
  try {
    const respuesta = fetchWithRetries(endpoint, options);
    const codigo = respuesta.getResponseCode();
    if (codigo < 200 || codigo >= 300) {
      const detalle = `Ticket ${issueKey}: HTTP ${codigo} al comentar. Respuesta: ${respuesta.getContentText()}`;
      if (esCritico) {
        registrarFalloDePaso("addCommentToJiraTicket", detalle);
      } else {
        Logger.log(`[JiraService] No se pudo dejar el comentario informativo. ${detalle}`);
      }
    }
  } catch (e) {
    Logger.log(`[JiraService] Fallo al comentar en ${issueKey}: ${e.message}`);
    if (esCritico) {
      registrarFalloDePaso("addCommentToJiraTicket", `Ticket ${issueKey}: excepción al comentar (${e.message}).`);
    }
  }
}

function addAttachmentToJiraTicket(issueKey, fileBlob) {
  // Guarda defensiva: un blob nulo (ej. convertDataToXlsxBlob() que falló) reventaba acá
  // con "Cannot read properties of null (reading 'getName')" y abortaba toda la operación.
  // Devolvemos un resultado de error manejable en vez de lanzar.
  if (!fileBlob) {
    Logger.log(`[JIRA ATTACH] Se omitió el adjunto en ${issueKey}: el blob es nulo.`);
    registrarFalloDePaso("addAttachmentToJiraTicket", `Ticket ${issueKey}: no se generó el archivo a adjuntar (blob nulo).`);
    return { status: 'ERROR', detail: { ticketKey: issueKey, error: "Adjunto nulo: no se generó el archivo a subir.", accion: "Revisar la generación del Excel (convertDataToXlsxBlob)." } };
  }

  // --- IDEMPOTENCIA CENTRAL ---
  // Un HTTP 500 espurio de Jira (el archivo sí llegó) deja el correo pendiente y el próximo
  // ciclo lo reprocesa: sin esta verificación se adjuntaba una segunda copia. Estaba resuelto
  // solo en MailProcessor.handleAlerts, pero 21 processors sobrescriben ese método y llaman
  // acá directo, así que la verificación vive donde ocurre el adjunto (AGENTS.md §5).
  // IMPORTANTE: depende de que los nombres incluyan la fecha del reporte; si un archivo se
  // llamara igual todos los días, la actualización diaria se omitiría por error.
  const nombreArchivo = fileBlob.getName();
  if (buscarAdjuntoEnTicket(issueKey, nombreArchivo)) {
    Logger.log(`[JIRA ATTACH] "${nombreArchivo}" ya estaba adjunto en ${issueKey}: se omite para no duplicarlo.`);
    return { status: 'SUCCESS', detail: { ticketKey: issueKey, omitido: true } };
  }

  const endpoint = `${JIRA_DOMAIN}/rest/api/2/issue/${issueKey}/attachments`;
  // El boundary debe ser un "token" RFC 2045 válido: va sin comillas dentro del Content-Type.
  // Antes se usaba base64(Math.random()), cuyo alfabeto incluye "/" y "=" — ambos son tspecials
  // y NO pueden ir en un token sin comillas. Como el "=" de padding aparece según la longitud
  // del número (que varía en cada llamada) y el "/" cae al azar dentro del encoding, el mismo
  // adjunto subía bien a veces y otras devolvía HTTP 500 (Jira no lograba parsear el multipart).
  // Se vio el 27/07/2026: 200 a las 18:33 y 500 en tres corridas seguidas después.
  // Un UUID en hexadecimal solo tiene [0-9a-f], siempre válido.
  const boundary = `----OpsScriptBoundary${Utilities.getUuid().replace(/-/g, '')}`;
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

    if (responseCode === 500) {
      registrarFalloDePaso("addAttachmentToJiraTicket", `Ticket ${issueKey}: Jira devolvió HTTP 500 al adjuntar "${nombreArchivo}". El correo queda pendiente para reintentar.`);
      return { status: 'HTTP_500', detail: { ticketKey: issueKey, problema: `Error 500 de Jira al adjuntar "${nombreArchivo}".`, accion: 'Se reintentará en el próximo ciclo.' } };
    }
    registrarFalloDePaso("addAttachmentToJiraTicket", `Ticket ${issueKey}: HTTP ${responseCode} al adjuntar "${nombreArchivo}". Respuesta: ${responseText}`);
    return { status: 'WARNING', detail: { ticketKey: issueKey, problema: `HTTP ${responseCode} al adjuntar "${nombreArchivo}".`, accion: 'Revisar manualmente.' } };
  } catch (e) {
    Logger.log(`[JIRA ATTACH ERROR] Excepción al adjuntar en ${issueKey}: ${e.message}`);
    registrarFalloDePaso("addAttachmentToJiraTicket", `Ticket ${issueKey}: excepción al adjuntar (${e.message}).`);
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


