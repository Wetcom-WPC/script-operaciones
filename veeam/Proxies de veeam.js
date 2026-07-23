/**
 * ==========================================================
 * SCRIPT: Proxies de Veeam
 * ==========================================================
 * @fileoverview Consolida alertas de proxy.
 * Refactorizado utilizando la clase base MailProcessor.
 */

// --- CONFIGURACIÓN ---
const PROXY_ALARM_OPERATION_NAME = "Proxies de Veeam";
const PROXY_ALARM_SEARCH_QUERY = 'subject:("Backup proxy connection failure") is:unread';
const PROXY_ALARM_JIRA_SUMMARY_PREFIX = "Se detectaron proxies en estado unavailable";

class ProxiesVeeamProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: PROXY_ALARM_OPERATION_NAME,
      emailSubject: PROXY_ALARM_SEARCH_QUERY
    });
  }

  processEmails() {
    const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };

    const allAlerts = getAllAlertsSortedByDate();
    
    if (allAlerts.length === 0) {
      Logger.log('No se encontraron nuevas alertas de proxy.');
      return;
    }

    const esHorarioDeAccion = esDiaHabil();

    const alertsByClient = groupAlertsByProperty(allAlerts, 'sender');
    
    for (const sender in alertsByClient) {
      const clientAlerts = alertsByClient[sender];
      const clientConfig = getClientConfig(sender, this.operationName);
      
      const markClientAlertsRead = () => {
        clientAlerts.forEach(alert => alert.originalMessage.getThread().markRead());
      };

      if (!clientConfig) {
        summaryReport.errores.push({
          error: "Cliente no configurado",
          detalle: `Remitente: ${sender}`
        });
        markClientAlertsRead();
        continue;
      }

      clientConfig.tecnologia = "Veeam Backup & Replication";

      const finalStatesByProxy = getFinalStateForProxies(clientAlerts);

      for (const proxy in finalStatesByProxy) {
        if (isProxyExcepted(proxy, clientConfig.exceptions)) {
          Logger.log(`Proxy "${proxy}" ignorado por regla de excepción para el cliente ${clientConfig.clientName}.`);
          delete finalStatesByProxy[proxy];
        }
      }

      if (Object.keys(finalStatesByProxy).length === 0) {
        Logger.log(`Alertas para ${clientConfig.clientName} ignoradas por excepción.`);
        markClientAlertsRead();
        continue;
      }

      if (esHorarioDeAccion) {
        Logger.log(`HORARIO HÁBIL: Procesando acciones de Jira para ${clientConfig.clientName}.`);

        const ticketSummary = PROXY_ALARM_JIRA_SUMMARY_PREFIX;
        const existingTicketKey = findExistingJiraTicket(ticketSummary, clientConfig.jiraProjectKey);

        if (existingTicketKey) {
          const commentLines = Object.values(finalStatesByProxy).map(state => state.comment);

          if (commentLines.length > 0) {
            const consolidatedComment = "🔄 **Resumen de Estado de Proxies:**\n\n" + commentLines.join('\n\n');
            addCommentToJiraTicket(existingTicketKey, consolidatedComment);

            const alertCount = commentLines.length;
            summaryReport.exitos.push({
              mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con ${alertCount} alertas.`
            });
          }
        } else {
          const errorStates = Object.values(finalStatesByProxy).filter(state => state.isError);

          if (errorStates.length > 0) {
            const descriptionLines = errorStates.map(state => state.comment);
            const description = "Se han detectado los siguientes proxies en estado de falla:\n\n" + descriptionLines.join('\n\n');

            const creationResult = createTicketAndNotify(ticketSummary, description, null, clientConfig, this.operationName);

            if (creationResult.status === 'SUCCESS') {
              summaryReport.exitos.push(creationResult.detail);
            } else {
              summaryReport.errores.push(creationResult.detail);
            }
          } else {
            Logger.log(`Se ignoraron alertas de solo resolución para ${clientConfig.clientName} (no existe ticket).`);
          }
        }
      } else {
        Logger.log(`FUERA DE HORARIO: Acciones de Jira omitidas para ${clientConfig.clientName}.`);
      }

      markClientAlertsRead();
    }

    enviarResumenSlack(this.operationName, summaryReport);
  }
}

function processProxyAlarms() {
  new ProxiesVeeamProcessor().processEmails();
}

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

function isProxyExcepted(proxyIdentifier, exceptions) {
  const proxyLower = proxyIdentifier.toLowerCase().trim();

  for (const exceptionId in exceptions) {
    const ruleGroup = exceptions[exceptionId];
    
    const allConditionsMet = ruleGroup.every(condition => {
      if (condition.column.toLowerCase().trim() === 'proxy') {
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
      return true; 
    });

    if (allConditionsMet) {
      return true; 
    }
  }

  return false; 
}

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
  Logger.log('------------------------------------------------------');
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

function esDiaHabil() {
  const zonaHoraria = "America/Argentina/Buenos_Aires";
  const ahora = new Date();
  
  const hora = parseInt(Utilities.formatDate(ahora, zonaHoraria, "H"));
  const dia = parseInt(Utilities.formatDate(ahora, zonaHoraria, "u"));

  const esDiaLaborable = (dia >= 1 && dia <= 5);
  const esHoraLaborable = (hora >= 7 && hora < 18); 

  Logger.log(`Verificación de horario: Día (Argentina) = ${dia}, Hora (Argentina) = ${hora}. ¿Es hábil? ${esDiaLaborable && esHoraLaborable}`);

  return esDiaLaborable && esHoraLaborable;
}
