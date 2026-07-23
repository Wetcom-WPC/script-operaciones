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
    const fullData = typeof MasterSheetSingleton !== 'undefined' ? MasterSheetSingleton.getMasterData() : SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0].getDataRange().getValues();
    
    // Omitimos encabezado (índice 0)
    for (let i = 1; i < fullData.length; i++) {
      const fila = fullData[i];
      // Índices del array con getDataRange: A=0, B=1, C=2, D=3, E=4 ... I=8 ... N=13, O=14
      const nombreProyecto = fila[1] ? String(fila[1]).trim() : null;  // Col B
      const claveOps = fila[3] ? String(fila[3]).trim() : null;        // Col D
      const portalOps = fila[4] ? String(fila[4]).trim() : null;       // Col E
      const equipoCliente = fila[8] ? String(fila[8]).trim() : null;   // Col I
      const claveSoporte = fila[13] ? String(fila[13]).trim() : null;  // Col N
      const portalSoporte = fila[14] ? String(fila[14]).trim() : null; // Col O
      
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
    }
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
      const baseUrl = `${JIRA_DOMAIN}/rest/api/3/search/jql`;
      const jql = `filter = ${idAUsar}`;
      const fields = `summary,project,key,${CAMPO_TECNOLOGIA_ID}`;
      const endpoint = `${baseUrl}?jql=${encodeURIComponent(jql)}&startAt=${inicio}&maxResults=100&fields=${encodeURIComponent(fields)}`;

      const options = {
        "method": "get",
        "contentType": "application/json",
        "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
        "muteHttpExceptions": true
      };
      
      const response = fetchWithRetries(endpoint, options);
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
      const link = `${JIRA_DOMAIN}/servicedesk/customer/portal/${portalPath}/${issue.key}`;
      
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
