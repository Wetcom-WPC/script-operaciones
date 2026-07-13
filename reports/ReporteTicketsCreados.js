/**
 * =================================================================
 * SCRIPT DE REPORTE DIARIO DE TICKETS (CORRECCIÓN DE LINKS)
 * =================================================================
 */

/**
 * Función auxiliar para leer el Súper Índice.
 * Mapea Clave (Col D y Col N) -> Portal ID (Col E y Col O) para armar los links de Ops y Soporte.
 */
function obtenerDatosDelIndice() {
  const mapaProyectos = {};
  const mapaPortales = {}; 

  try {
    const sheet = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0];
    
    // CAMBIO 1: Ampliamos la lectura desde la columna B hasta la O (Letra O)
    const datos = sheet.getRange("B2:O" + sheet.getLastRow()).getValues();
    
    datos.forEach(fila => {
      // Índices del array: B=0, C=1, D=2, E=3 ... I=7 ... N=12, O=13
      const nombreProyecto = fila[0] ? String(fila[0]).trim() : null;  // Col B
      const claveOps = fila[2] ? String(fila[2]).trim() : null;        // Col D
      const portalOps = fila[3] ? String(fila[3]).trim() : null;       // Col E
      const equipoCliente = fila[7] ? String(fila[7]).trim() : null;   // Col I
      const claveSoporte = fila[12] ? String(fila[12]).trim() : null;  // Col N
      const portalSoporte = fila[13] ? String(fila[13]).trim() : null; // Col O
      
      if (nombreProyecto) {
        mapaProyectos[nombreProyecto] = equipoCliente || "Sin Equipo Asignado";
      }

      // CAMBIO 2: Guardamos el portal de Operaciones si existe
      if (claveOps && portalOps) {
        mapaPortales[claveOps] = portalOps;
      }

      // CAMBIO 3: Guardamos TAMBIÉN el portal de Soporte si existe
      if (claveSoporte && portalSoporte) {
        mapaPortales[claveSoporte] = portalSoporte;
      }
    });
    Logger.log("Mapas de referencia (Ops y Soporte) creados con éxito.");
  } catch (e) {
    Logger.log(`Error al crear los mapas de referencia: ${e.message}`);
  }
  return { mapaProyectos, mapaPortales };
}

/**
 * Función que busca tickets en Jira y arma el link correcto.
 */
function generarReporteDiarioDeTickets(filtroId) {
  const CAMPO_TECNOLOGIA_ID = "customfield_12316"; 

  try {
    const { mapaProyectos, mapaPortales } = obtenerDatosDelIndice();
    const idAUsar = filtroId || JIRA_FILTER_ID_REPORTE_DIARIO;

    if (!idAUsar) {
      Logger.log("ERROR: No se proporcionó un ID de filtro.");
      return {};
    }
    
    let todosLosTickets = [];
    let inicio = 0;
    let total = -1;

    do {
      const baseUrl = `https://wetcom.atlassian.net/rest/api/3/search/jql`;
      const jql = `filter = ${idAUsar}`;
      const fields = `summary,project,key,${CAMPO_TECNOLOGIA_ID}`;
      const endpoint = `${baseUrl}?jql=${encodeURIComponent(jql)}&startAt=${inicio}&maxResults=100&fields=${encodeURIComponent(fields)}`;

      const options = {
        "method": "get",
        "contentType": "application/json",
        "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
        "muteHttpExceptions": true
      };
      
      const response = UrlFetchApp.fetch(endpoint, options);
      const data = JSON.parse(response.getContentText());

      if (data.issues) {
        todosLosTickets = todosLosTickets.concat(data.issues);
      }
      
      if (total === -1) { total = data.total; }
      inicio += (data.issues ? data.issues.length : 0);
    } while (inicio < total);

    const ticketsAgrupados = {};
    todosLosTickets.forEach(issue => {
      const proyectoKey = issue.fields.project.key;
      const nombreProyectoJira = issue.fields.project.name;
      const equipo = mapaProyectos[nombreProyectoJira] || "Sin Equipo Asignado";
      const campoTecnologia = issue.fields[CAMPO_TECNOLOGIA_ID];
      const tecnologia = campoTecnologia ? (campoTecnologia.value || campoTecnologia) : "Sin Tecnología";
      
      // --- CORRECCIÓN DEL LINK ---
      // Buscamos el ID en el mapa usando la KEY de Jira
      const serviceDeskId = mapaPortales[proyectoKey];
      
      // Si por alguna razón no está en el Excel, usamos un valor por defecto o evitamos el undefined
      const portalPath = serviceDeskId ? serviceDeskId : "portal-no-encontrado";
      const link = `https://wetcom.atlassian.net/servicedesk/customer/portal/${portalPath}/${issue.key}`;
      
      if (!ticketsAgrupados[equipo]) ticketsAgrupados[equipo] = {};
      if (!ticketsAgrupados[equipo][nombreProyectoJira]) ticketsAgrupados[equipo][nombreProyectoJira] = {};
      if (!ticketsAgrupados[equipo][nombreProyectoJira][tecnologia]) ticketsAgrupados[equipo][nombreProyectoJira][tecnologia] = [];
      
      ticketsAgrupados[equipo][nombreProyectoJira][tecnologia].push({
        key: issue.key,
        summary: issue.fields.summary, 
        link: link,
        projectKey: proyectoKey // <-- ¡Dato clave agregado acá!
      });
    });

    return ticketsAgrupados; 

  } catch (e) {
    Logger.log(`Error crítico: ${e.message}`);
    return {};
  }
}