/**
 * ==========================================================
 * SCRIPT: Proxies de Veeam
 * ==========================================================
 * @fileoverview Consolida alertas de proxy.
 * CREA tickets y AÑADE comentarios SOLO durante el horario hábil.
 * @version 2.5 - Elimina funciones de soporte duplicadas (existen en 'funciones compartidas').
 */

// --- CONFIGURACIÓN ---
const PROXY_ALARM_OPERATION_NAME = "Proxies de Veeam";
const PROXY_ALARM_SEARCH_QUERY = 'subject:("Backup proxy connection failure") is:unread';
const PROXY_ALARM_JIRA_SUMMARY_PREFIX = "Se detectaron proxies en estado unavailable";


// --- LÓGICA PRINCIPAL ---

/**
 * Función principal que se debe ejecutar con un activador de tiempo.
 */
function processProxyAlarms() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };

  // 1. Recolectar y ordenar todas las alertas.
  const allAlerts = getAllAlertsSortedByDate();
  
  if (allAlerts.length === 0) {
    Logger.log('No se encontraron nuevas alertas de proxy.');
    return;
  }

  // --- NUEVO: Verificación de horario ANTES de procesar ---
  const esHorarioDeAccion = esDiaHabil(); // Comprueba la hora UNA SOLA VEZ

  // 2. Agrupar alertas por cliente.
  const alertsByClient = groupAlertsByProperty(allAlerts, 'sender');
  
 for (const sender in alertsByClient) {
  const clientAlerts = alertsByClient[sender];
  const clientConfig = getClientConfig(sender, PROXY_ALARM_OPERATION_NAME);

  // --- FORZADO DE PARÁMETROS ---
  clientConfig.tecnologia = "Veeam Backup & Replication"; // Siempre Veeam
  
  // Helper para no repetir código
  const markClientAlertsRead = () => {
    clientAlerts.forEach(alert => alert.originalMessage.getThread().markRead());
  };

  if (!clientConfig) {
    summaryReport.errores.push({
      error: "Cliente no configurado",
      detalle: `Remitente: ${sender}`
    });
    // Si no hay config, marcamos como leído para no reprocesar.
    markClientAlertsRead();
    continue;
  }

  // 1) Estados finales por proxy
  const finalStatesByProxy = getFinalStateForProxies(clientAlerts);

  // 2) Aplicar excepciones
  for (const proxy in finalStatesByProxy) {
    if (isProxyExcepted(proxy, clientConfig.exceptions)) {
      Logger.log(
        `Proxy "${proxy}" ignorado por regla de excepción para el cliente ${clientConfig.clientName}.`
      );
      delete finalStatesByProxy[proxy];
    }
  }

  // 3) Si todo quedó exceptuado, log + marcar leído + seguir con el siguiente cliente
  if (Object.keys(finalStatesByProxy).length === 0) {
    Logger.log(`Alertas para ${clientConfig.clientName} ignoradas por excepción.`);
    markClientAlertsRead();
    continue;
  }

  // 4) Lógica de horario hábil SOLO para Jira
  if (esHorarioDeAccion) {
    Logger.log(`HORARIO HÁBIL: Procesando acciones de Jira para ${clientConfig.clientName}.`);

    const ticketSummary = `${PROXY_ALARM_JIRA_SUMMARY_PREFIX}`;
    const existingTicketKey = findExistingJiraTicket(
      ticketSummary,
      clientConfig.jiraProjectKey
    );

    if (existingTicketKey) {
      // --- LÓGICA DE COMENTARIO ---
      const commentLines = Object.values(finalStatesByProxy).map(state => state.comment);

      if (commentLines.length > 0) {
        const consolidatedComment =
          "🔄 **Resumen de Estado de Proxies:**\n\n" + commentLines.join('\n\n');

        addCommentToJiraTicket(existingTicketKey, consolidatedComment);

        const alertCount = commentLines.length;

        summaryReport.exitos.push({
          mensaje: `Se actualizó el ticket <https://wetcom.atlassian.net/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.`
        });
      }
    } else {
      // --- LÓGICA DE CREACIÓN ---
      const errorStates = Object.values(finalStatesByProxy).filter(state => state.isError);

      if (errorStates.length > 0) {
        const descriptionLines = errorStates.map(state => state.comment);

        const description =
          "Se han detectado los siguientes proxies en estado de falla:\n\n" +
          descriptionLines.join('\n\n');

        const creationResult = createTicketAndNotify(
          ticketSummary,
          description,
          null,
          clientConfig,
          PROXY_ALARM_OPERATION_NAME
        );

        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push(creationResult.detail);
        } else {
          summaryReport.errores.push(creationResult.detail);
        }
      } else {
        Logger.log(
          `Se ignoraron alertas de solo resolución para ${clientConfig.clientName} (no existe ticket).`
        );
      }
    }
  } else {
    Logger.log(
      `FUERA DE HORARIO: Acciones de Jira omitidas para ${clientConfig.clientName}.`
    );
  }

  // 5) ✅ SIEMPRE, al final del cliente, marcamos todos los correos como leídos
  markClientAlertsRead();
}


  enviarResumenSlack(PROXY_ALARM_OPERATION_NAME, summaryReport);
}

// --- FUNCIONES AUXILIARES DE PROCESAMIENTO ---

/**
 * Obtiene todas las alertas de proxy no leídas y las ordena por fecha.
 * Utiliza un método híbrido para detectar el estado de la alarma de forma precisa.
 */
function getAllAlertsSortedByDate() {
  const threads = GmailApp.search(PROXY_ALARM_SEARCH_QUERY);
  const allMessages = [];

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      if (message.isUnread()) {
        const subject = message.getSubject();
        
        const proxyMatch = subject.match(/for\s(.*?)(?:-|\shas\sbeen|$)/i);
        let proxyIdentifier = proxyMatch ? proxyMatch[1].trim() : "Desconocido";
        
        if (proxyIdentifier.includes('"')) {
          const quotedPartMatch = proxyIdentifier.match(/\"(.*?)\"/);
          if (quotedPartMatch && quotedPartMatch[1]) {
            proxyIdentifier = quotedPartMatch[1];
          }
        }
        
        let state = null;
        
        // --- LÓGICA DE DETECCIÓN INTELIGENTE ---
        const stateMatch = subject.match(/changed to\s(.*?)\s\(previous/i);
        
        if (stateMatch && stateMatch[1]) {
          const currentState = stateMatch[1].trim().toLowerCase();
          if (currentState.includes('error')) {
            state = 'Error';
          } else if (currentState.includes('reset/resolved')) {
            state = 'Resuelto';
          }
        } else {
          if (subject.toLowerCase().includes("error")) {
            state = "Error";
          } else if (subject.toLowerCase().includes("reset/resolved")) {
            state = "Resuelto";
          }
        }
        // --- FIN DE LA LÓGICA DE DETECCIÓN ---

        if (state && proxyIdentifier !== "Desconocido") {
          allMessages.push({
            date: message.getDate(),
            sender: message.getFrom(),
            proxy: proxyIdentifier,
            state: state,
            originalMessage: message
          });
        } else {
            Logger.log(`Correo descartado. Asunto: "${subject}". Proxy detectado: "${proxyIdentifier}". Estado detectado: "${state}".`);
        }
      }
    });
  });
  return allMessages.sort((a, b) => a.date - b.date);
}

/**
 * Agrupa un array de objetos por una propiedad específica.
 */
function groupAlertsByProperty(array, property) {
  return array.reduce((acc, obj) => {
    const key = obj[property];
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(obj);
    return acc;
  }, {});
}

/**
 * Obtiene el estado final (el más reciente) para cada proxy en un lote de alertas.
 */
function getFinalStateForProxies(clientAlerts) {
  const alertsByProxy = groupAlertsByProperty(clientAlerts, 'proxy');
  const finalStates = {};

  for (const proxy in alertsByProxy) {
    const proxyAlerts = alertsByProxy[proxy];
    const latestAlert = proxyAlerts[proxyAlerts.length - 1];
    
    const timestamp = Utilities.formatDate(latestAlert.date, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
    let comment = "";
    
    if (latestAlert.state === "Error") {
      comment = `🔴 **Falla Detectada:** Se perdió la conexión con el proxy *${proxy}*.\n(Evento recibido a las ${timestamp})`;
    } else {
      comment = `✅ **Conexión Restablecida:** Se recuperó la conexión con el proxy *${proxy}*.\n(Evento recibido a las ${timestamp})`;
    }

    finalStates[proxy] = {
      isError: latestAlert.state === "Error",
      comment: comment
    };
  }
  return finalStates;
}


/**
 * Verifica si un identificador de proxy específico está cubierto por una regla de excepción.
 */
function isProxyExcepted(proxyIdentifier, exceptions) {
  const proxyLower = proxyIdentifier.toLowerCase().trim();

  for (const exceptionId in exceptions) {
    const ruleGroup = exceptions[exceptionId];
    
    // 'every' significa que TODAS las condiciones con el mismo ID deben cumplirse.
    const allConditionsMet = ruleGroup.every(condition => {
      // Solo nos importan las reglas cuya columna sea "Proxy".
      if (condition.column.toLowerCase().trim() === 'proxy') {
        // 'some' significa que el proxy debe coincidir con AL MENOS UNO de los valores.
        return condition.values.some(exceptionValue => {
          switch (condition.matchType.toLowerCase().trim()) {
            case 'exacta': return (proxyLower === exceptionValue);
            case 'contiene': return proxyLower.includes(exceptionValue);
            case 'empieza con': return proxyLower.startsWith(exceptionValue);
            case 'termina con': return proxyLower.endsWith(exceptionValue);
            default: return false;
          }
        });
      }
      // Si la regla es para una columna que no es "Proxy", la ignoramos (no invalida el grupo).
      return true; 
    });

    if (allConditionsMet) {
      return true; // Si un grupo de reglas coincide, el proxy está exceptuado.
    }
  }

  return false; // Si ningún grupo de reglas coincide.
}

/**
 * Función de depuración para probar las búsquedas de Gmail.
 */
function debugSearchQuery() {
  const currentQuery = 'subject:("Backup proxy connection failure") is:unread';
  Logger.log(`--- Iniciando prueba con la búsqueda exacta ---`);
  Logger.log(`Buscando con: ${currentQuery}`);
  try {
    const threads = GmailApp.search(currentQuery);
    Logger.log(`Resultado: Se encontraron ${threads.length} hilos de correo.`);
    if (threads.length > 0) {
      Logger.log('--- Asuntos de los correos encontrados ---');
      threads.forEach((thread, index) => {
        const firstMessage = thread.getMessages()[0];
        Logger.log(`Hilo ${index + 1}: "${firstMessage.getSubject()}"`);
      });
    }
  } catch (e) {
    Logger.log(`ERROR al ejecutar la búsqueda: ${e.toString()}`);
  }
  Logger.log('REDACTED_LONG_STRING');
  const broadQuery = 'subject:(Backup proxy connection) is:unread';
  Logger.log(`\n--- Iniciando prueba con una búsqueda más amplia ---`);
  Logger.log(`Buscando con: ${broadQuery}`);
  try {
    const threadsBroad = GmailApp.search(broadQuery);
    Logger.log(`Resultado: Se encontraron ${threadsBroad.length} hilos de correo.`);
    if (threadsBroad.length > 0) {
      Logger.log('--- Asuntos de los correos encontrados (búsqueda amplia) ---');
      threadsBroad.forEach((thread, index) => {
        const firstMessage = thread.getMessages()[0];
        Logger.log(`Hilo ${index + 1}: "${firstMessage.getSubject()}"`);
      });
    }
  } catch (e) {
    Logger.log(`ERROR al ejecutar la búsqueda amplia: ${e.toString()}`);
  }
}

/**
 * Función guardiana para verificar si estamos en horario hábil.
 * CORREGIDA para usar explícitamente la zona horaria de Argentina (GMT-3).
 */
function esDiaHabil() {
  const zonaHoraria = "America/Argentina/Buenos_Aires";
  const ahora = new Date();
  
  // Obtenemos la HORA actual (0-23) en la zona horaria de Argentina.
  const hora = parseInt(Utilities.formatDate(ahora, zonaHoraria, "H"));
  
  // Obtenemos el DÍA de la semana (1=Lunes, 7=Domingo) en la zona horaria de Argentina.
  const dia = parseInt(Utilities.formatDate(ahora, zonaHoraria, "u"));

  // --- CONFIGURA TU HORARIO AQUÍ ---
  // Verifica si es día laborable (Lunes=1 a Viernes=5)
  const esDiaLaborable = (dia >= 1 && dia <= 5);
  
  // Verifica si es hora laborable (de 7:00 AM a 5:59 PM)
  const esHoraLaborable = (hora >= 7 && hora < 18); 
  // --- FIN DE LA CONFIGURACIÓN ---

  // Log para depuración
  Logger.log(`Verificación de horario: Día (Argentina) = ${dia}, Hora (Argentina) = ${hora}. ¿Es hábil? ${esDiaLaborable && esHoraLaborable}`);

  return esDiaLaborable && esHoraLaborable;
}
