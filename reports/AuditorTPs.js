/** * ================================================================
 * SCRIPT AUDITOR DE TAREAS PROGRAMADAS NO CERRADAS EN JIRA
 * ================================================================
 */

// --- CONFIGURACIÓN DE JIRA ---
const JIRA_DOMAIN = "https://wetcom.atlassian.net"; // Reemplazar con tu dominio de Jira
const JIRA_EMAIL = "thiago.chinabro@wetcom.com"; // Reemplazar con el email del usuario de Jira
const JIRA_API_TOKEN = "REDACTED"; // 
const JIRA_FILTER_ID = "29682";

// --- CONFIGURACIÓN DE SLACK ---
// Reemplazar con el webhook del canal donde querés que llegue el aviso
const SLACK_WEBHOOK_TP = "https://hooks.slack.com/services/REDACTED"; 

function alertarTareasNoCerradasJira() {
  const hoy = new Date();
  const diaDeLaSemana = hoy.getDay();

  // 1. FRENO DE FIN DE SEMANA
  if (diaDeLaSemana === 0 || diaDeLaSemana === 6) {
    Logger.log("Hoy es fin de semana. El auditor de Jira no trabajará hoy.");
    return; 
  }

  // 2. FRENO DE FERIADOS
  if (esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado en el calendario de Alarmas Wetcom.");
    return;
  }

  Logger.log("--- INICIANDO AUDITORÍA DE TAREAS NO CERRADAS EN JIRA ---");

  // 3. BUSCAR TICKETS EN JIRA USANDO EL FILTRO
  const ticketsEncontrados = buscarTicketsPorFiltroJira();

  // 4. PREPARAR Y ENVIAR MENSAJE A SLACK
  if (ticketsEncontrados === null) {
      Logger.log("Hubo un error al consultar Jira. No se envía mensaje.");
      return;
  }

  // ---> ACÁ ESTÁ EL CAMBIO PARA ENVIAR EL MENSAJE DE "TODO OK" <---
  if (ticketsEncontrados.length === 0) {
      Logger.log("¡Excelente! No hay tareas pendientes sin cerrar en el filtro. Avisando a Slack...");
      enviarMensajeSlack(SLACK_WEBHOOK_TP, "✨ *¡Todo al día!* Excelente trabajo equipo, no hay tareas programadas pendientes de cierre.");
      return;
  }

  Logger.log(`Se encontraron ${ticketsEncontrados.length} tareas sin cerrar. Armando mensaje...`);
  const mensajeFormateado = armarMensajeSlackAesthetic(ticketsEncontrados);
  enviarMensajeSlack(SLACK_WEBHOOK_TP, mensajeFormateado);
  Logger.log("Mensaje enviado a Slack con éxito.");
}

/**
 * Consulta la API de Jira v3 para obtener los resultados de un filtro específico.
 */
function buscarTicketsPorFiltroJira() {
  // 1. Actualizamos a la nueva URL (API v3) que nos pide Jira
  const url = `${JIRA_DOMAIN}/rest/api/3/search/jql`;
  
  // 2. Armamos el "paquete" (payload) con los datos de la búsqueda
  const payload = {
    "jql": `filter=${JIRA_FILTER_ID}`,
    "maxResults": 50,
    "fields": ["summary", "assignee", "status", "issuetype"]
  };
  
  // Codificar las credenciales en Base64
  const credenciales = Utilities.base64Encode(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`);
  
  const opciones = {
    method: "POST", // 3. Cambiamos de GET a POST
    contentType: "application/json",
    headers: {
      "Authorization": `Basic ${credenciales}`,
      "Accept": "application/json"
    },
    payload: JSON.stringify(payload), // Adjuntamos el paquete de datos
    muteHttpExceptions: true
  };

  try {
    const respuesta = UrlFetchApp.fetch(url, opciones);
    const codigoRespuesta = respuesta.getResponseCode();
    
    if (codigoRespuesta !== 200) {
        Logger.log(`❌ Error de la API de Jira (Código ${codigoRespuesta}): ${respuesta.getContentText()}`);
        return null;
    }

    const data = JSON.parse(respuesta.getContentText());
    return data.issues; // Devuelve el array de tickets encontrados

  } catch (error) {
    Logger.log(`❌ Error al conectar con Jira: ${error.message}`);
    return null;
  }
}

/**
 * Toma el array de tickets de Jira y lo formatea lindo para Slack.
 */
function armarMensajeSlackAesthetic(tickets) {
  let mensaje = `🚨 *¡Atención Equipo!* 🚨\n`;
  mensaje += `<!channel> Se encontraron *${tickets.length}* Tareas Programadas que aún *no han sido cerradas*:\n\n`;

  tickets.forEach(ticket => {
    const key = ticket.key;
    const link = `${JIRA_DOMAIN}/browse/${key}`;
    const resumen = ticket.fields.summary;
    // Extrae el nombre del asignado (si no hay, pone "Sin asignar")
    const assignee = ticket.fields.assignee ? ticket.fields.assignee.displayName : "_Sin asignar_";
    const status = ticket.fields.status.name;

    // Formato por ticket: [Icono] <Link|Clave> - Resumen | Asignado | Estado actual
    mensaje += `> 📝 <${link}|*${key}*> - ${resumen}\n`;
    mensaje += `>      👤 *Asignado:* ${assignee}  |  🏷️ *Estado:* \`${status}\`\n\n`;
  });

  mensaje += `\n🔗 <${JIRA_DOMAIN}/issues/?filter=${JIRA_FILTER_ID}|*Ver filtro completo en Jira*>\n`;
  mensaje += `_Por favor, revisen y cierren estas tareas lo antes posible._ 💪`;

  return mensaje;
}

/**
 * Función genérica para enviar el payload a Slack.
 */
function enviarMensajeSlack(webhookUrl, texto) {
  const payload = { text: texto };
  const opciones = {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(payload)
  };

  try {
    UrlFetchApp.fetch(webhookUrl, opciones);
  } catch (e) {
    Logger.log("Error al enviar el mensaje a Slack: " + e.message);
  }
}

function esFeriadoHoy() {
  const calendarId = 'alarmas@wetcom.com'; 
  try {
    const calendario = CalendarApp.getCalendarById(calendarId);
    if (!calendario) return false;
    const hoy = new Date();
    const eventosDeHoy = calendario.getEventsForDay(hoy);
    return eventosDeHoy.length > 0;
  } catch (error) {
    return false;
  }
}

