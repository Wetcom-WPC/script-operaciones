/**
 * =================================================================
 * HERRAMIENTAS MANUALES / DE TESTING (acceso rápido desde el editor)
 * =================================================================
 * Funciones para ejecutar manualmente procesos desde el editor de Apps Script.
 * NO están conectadas a ningún trigger: son para pruebas y ejecuciones puntuales.
 *
 * Convención de nombres: prefijo `manual_` para que sean fáciles de encontrar en
 * el desplegable de funciones del editor.
 *
 * ⚠️ IMPORTANTE: varias de estas funciones ejecutan acciones reales (Jira/Gmail/Drive).
 * Verificá que la Script Property ENVIRONMENT esté en "TESTING" si no querés impactar
 * clientes reales (los envíos de correo se redirigen en TESTING, ver NotificationService.js).
 * =================================================================
 */

// Cliente y carpeta de Drive usados para probar el flujo de RVTools.
// (Reemplaza al viejo hola() que estaba en RVTools_Main.js — C-01).
const MANUAL_TEST_CLIENT_NAME = "WPC - Operaciones Testing";
const MANUAL_TEST_RVTOOLS_FOLDER_ID = "1REqgcvp0q0nDFHYuULKhzb2Yc-Hdnw7h";

/**
 * Ejecuta el flujo completo de RVTools (Zombies + ConnectAtPowerOn) contra el
 * cliente/carpeta de testing. Antes se llamaba hola().
 */
function manual_RVToolsTesting() {
  const resultado = procesarRVToolsManual(MANUAL_TEST_CLIENT_NAME, MANUAL_TEST_RVTOOLS_FOLDER_ID);
  Logger.log(`[manual_RVToolsTesting] Resultado: ${JSON.stringify(resultado)}`);
  return resultado;
}

/**
 * Corre toda la suite de pruebas unitarias (tests/TestRunner.js).
 */
function manual_runAllTests() {
  return runAllTests();
}

/**
 * Muestra si estamos dentro de la ventana operativa (05-15hs AR) y la hora detectada.
 * Útil para validar la guarda horaria de los triggers 24/7 (BUG-03).
 */
function manual_probarHorarioOperativo() {
  const hora = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd HH:mm:ss");
  Logger.log(`[manual_probarHorarioOperativo] Hora AR: ${hora} | ¿Dentro de ventana operativa (${HORARIO_OPERATIVO_INICIO}-${HORARIO_OPERATIVO_FIN})? ${estaEnHorarioOperativo()}`);
}

/**
 * Ejecuta organizarReportesEnDrive IGNORANDO la guarda horaria (para pruebas fuera de horario).
 * Llama directamente a la lógica interna con una ventana de búsqueda de 2h.
 */
function manual_organizarReportesAhora() {
  const props = PropertiesService.getScriptProperties();
  const idCarpetaPrincipal = props.getProperty("DRIVE_AVISO_BASE_FOLDER_ID");
  const idHojaCalculo = props.getProperty("MASTER_INDEX_SHEET_ID");
  Logger.log("[manual_organizarReportesAhora] Ejecutando guardarYConvertirAdjuntosEnDrive (bypass de horario, ventana 2h)...");
  guardarYConvertirAdjuntosEnDrive(idCarpetaPrincipal, idHojaCalculo, 2);
}

/**
 * Ejecuta el procesamiento de alarmas de proxies de Veeam IGNORANDO la guarda horaria.
 */
function manual_procesarProxiesAhora() {
  Logger.log("[manual_procesarProxiesAhora] Ejecutando ProxiesVeeamProcessor (bypass de horario)...");
  new ProxiesVeeamProcessor().processEmails();
}

// Nombre de operación usado por defecto en manual_diagnosticarEncabezados. Cambiá este valor
// (o llamá directo a diagnosticarEncabezadosDeReporte("Otro Nombre") desde el editor) según
// qué reporte quieras inspeccionar. Debe ser el asunto EXACTO del correo (ej. "VMs operativas").
const MANUAL_DIAGNOSTICO_OPERATION_NAME = "VMs operativas";

/**
 * Diagnóstico de encabezados de un reporte (envuelve diagnosticarEncabezadosDeReporte de Utils.js).
 * SpreadsheetApp.getUi() no funciona al correr con el botón "Run" del editor (requiere un
 * contexto de UI real, ej. un menú de hoja), por eso acá se pasa el nombre de la operación
 * directamente como parámetro en vez de depender del prompt.
 */
function manual_diagnosticarEncabezados() {
  return diagnosticarEncabezadosDeReporte(MANUAL_DIAGNOSTICO_OPERATION_NAME);
}

// =================================================================
// AUDITORÍA Y CIERRE DE TAREAS PROGRAMADAS
// =================================================================

/**
 * Devuelve los proyectos de Jira del Índice Maestro, sin repetir.
 * @returns {Array<{clientName: string, projectKey: string}>}
 */
function _obtenerProyectosDelIndice() {
  const proyectos = [];
  const vistos = {};
  MasterSheetSingleton.getMasterData().slice(1).forEach(fila => {
    const clientName = fila[1] ? String(fila[1]).trim() : "";
    const projectKey = fila[3] ? String(fila[3]).trim().toUpperCase() : "";
    if (projectKey && !vistos[projectKey]) {
      vistos[projectKey] = true;
      proyectos.push({ clientName, projectKey });
    }
  });
  return proyectos;
}

/**
 * Busca las Tareas Programadas abiertas de un proyecto.
 * @param {string} projectKey Clave del proyecto de Jira.
 * @returns {Array<{key: string, summary: string, status: string}>}
 */
function _buscarTareasProgramadasAbiertas(projectKey) {
  const payload = {
    jql: `project = "${projectKey}" AND issuetype = "Tarea Programada" AND statusCategory != Done ORDER BY created DESC`,
    maxResults: 100,
    fields: ["key", "summary", "status"]
  };
  const options = {
    method: "post", contentType: "application/json", headers: getJiraHeaders(),
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  try {
    const response = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/search/jql`, options);
    if (response.getResponseCode() !== 200) {
      Logger.log(`  ⚠️ No se pudo consultar el proyecto ${projectKey} (HTTP ${response.getResponseCode()}).`);
      return [];
    }
    const data = JSON.parse(response.getContentText());
    return (data.issues || []).map(i => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status ? i.fields.status.name : "?"
    }));
  } catch (e) {
    Logger.log(`  ⚠️ Error consultando ${projectKey}: ${e.message}`);
    return [];
  }
}

/**
 * Devuelve los nombres de las transiciones disponibles para un ticket.
 * Sirve para saber por qué un cierre automático no funciona: resolveJiraTicket()
 * busca una transición cuyo destino se llame exactamente JIRA_STATUS_TO_CLOSE
 * y, si no existe, falla en silencio.
 * @param {string} issueKey Clave del ticket.
 * @returns {Array<string>} Nombres de los estados destino disponibles.
 */
function _obtenerTransicionesDisponibles(issueKey) {
  const options = { method: "get", headers: getJiraHeaders(), muteHttpExceptions: true };
  try {
    const response = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/transitions`, options);
    if (response.getResponseCode() !== 200) return [];
    const data = JSON.parse(response.getContentText());
    return (data.transitions || []).map(t => t.to.name);
  } catch (e) {
    return [];
  }
}

/**
 * AUDITORÍA (solo lectura, no modifica nada).
 *
 * Lista las Tareas Programadas que siguen abiertas en cada proyecto del Índice
 * Maestro y verifica si existe la transición hacia JIRA_STATUS_TO_CLOSE. Es la
 * forma rápida de responder dos preguntas: qué quedó sin cerrar, y si el cierre
 * automático está fallando porque el estado destino no se llama como esperamos.
 */
function manual_auditarTareasProgramadas() {
  const proyectos = _obtenerProyectosDelIndice();
  Logger.log(`=== AUDITORÍA DE TAREAS PROGRAMADAS ABIERTAS (${proyectos.length} proyectos) ===`);
  Logger.log(`Estado de cierre configurado (JIRA_STATUS_TO_CLOSE): "${JIRA_STATUS_TO_CLOSE}"`);

  let totalAbiertas = 0;
  const conteoPorNombre = {};
  let transicionVerificada = false;

  proyectos.forEach(({ clientName, projectKey }) => {
    const tareas = _buscarTareasProgramadasAbiertas(projectKey);
    if (tareas.length === 0) return;

    totalAbiertas += tareas.length;
    Logger.log(`\n--- ${clientName} [${projectKey}] — ${tareas.length} abiertas ---`);
    tareas.forEach(t => {
      Logger.log(`   ${t.key}  (${t.status})  ${t.summary}`);
      conteoPorNombre[t.summary] = (conteoPorNombre[t.summary] || 0) + 1;
    });

    // Verificamos las transiciones una sola vez, sobre la primera tarea encontrada.
    if (!transicionVerificada) {
      transicionVerificada = true;
      const destinos = _obtenerTransicionesDisponibles(tareas[0].key);
      Logger.log(`\n   [DIAGNÓSTICO] Transiciones disponibles en ${tareas[0].key}: [${destinos.join(", ")}]`);
      if (destinos.indexOf(JIRA_STATUS_TO_CLOSE) === -1) {
        Logger.log(`   🚨 "${JIRA_STATUS_TO_CLOSE}" NO está entre los destinos disponibles.`);
        Logger.log(`      Por eso el cierre automático falla en silencio. Hay que ajustar`);
        Logger.log(`      JIRA_STATUS_TO_CLOSE (core/ConfiguracionGlobal.js) al nombre real.`);
      } else {
        Logger.log(`   ✅ La transición a "${JIRA_STATUS_TO_CLOSE}" existe: el cierre automático puede funcionar.`);
      }
    }
  });

  Logger.log(`\n=== RESUMEN: ${totalAbiertas} tareas programadas abiertas ===`);
  Object.keys(conteoPorNombre)
    .sort((a, b) => conteoPorNombre[b] - conteoPorNombre[a])
    .forEach(nombre => Logger.log(`   ${conteoPorNombre[nombre]}x  ${nombre}`));

  return { totalAbiertas, conteoPorNombre };
}

// Poné acá el nombre EXACTO de la tarea a cerrar con manual_cerrarTareasProgramadas
// (tal como figura en el campo Actividad/summary de Jira). Vacío = todas las abiertas.
const MANUAL_CIERRE_NOMBRE_TAREA = "";

// Seguridad: en true solo simula y muestra qué cerraría. Poné false para cerrar de verdad.
const MANUAL_CIERRE_SIMULACION = true;

/**
 * CIERRE MASIVO de Tareas Programadas.
 *
 * ⚠️ Modifica tickets en Jira. Arranca en modo simulación: revisá primero la salida
 * con MANUAL_CIERRE_SIMULACION = true y recién después ponelo en false.
 *
 * Filtra por MANUAL_CIERRE_NOMBRE_TAREA si está definido; si queda vacío, alcanza a
 * TODAS las tareas programadas abiertas, así que usalo con criterio.
 */
function manual_cerrarTareasProgramadas() {
  const filtroNombre = MANUAL_CIERRE_NOMBRE_TAREA.trim().toLowerCase();
  const modo = MANUAL_CIERRE_SIMULACION ? "SIMULACIÓN (no se modifica nada)" : "CIERRE REAL";
  Logger.log(`=== CIERRE DE TAREAS PROGRAMADAS — modo: ${modo} ===`);
  Logger.log(filtroNombre ? `Filtro de nombre: "${MANUAL_CIERRE_NOMBRE_TAREA}"` : "Sin filtro: alcanza a TODAS las abiertas.");

  let cerradas = 0;
  let fallidas = 0;

  _obtenerProyectosDelIndice().forEach(({ clientName, projectKey }) => {
    _buscarTareasProgramadasAbiertas(projectKey).forEach(tarea => {
      if (filtroNombre && tarea.summary.trim().toLowerCase() !== filtroNombre) return;

      if (MANUAL_CIERRE_SIMULACION) {
        Logger.log(`   [simulado] ${tarea.key} — ${clientName} — ${tarea.summary}`);
        cerradas++;
        return;
      }

      const resultado = resolveJiraTicket(tarea.key, JIRA_STATUS_TO_CLOSE);
      if (resultado && resultado.status === 'SUCCESS') {
        Logger.log(`   ✅ ${tarea.key} cerrada — ${clientName} — ${tarea.summary}`);
        cerradas++;
      } else {
        const destinos = _obtenerTransicionesDisponibles(tarea.key);
        Logger.log(`   ❌ ${tarea.key} NO se pudo cerrar — ${tarea.summary}. Destinos disponibles: [${destinos.join(", ")}]`);
        fallidas++;
      }
    });
  });

  Logger.log(`\n=== RESULTADO: ${cerradas} ${MANUAL_CIERRE_SIMULACION ? "se cerrarían" : "cerradas"}, ${fallidas} fallidas ===`);
  return { cerradas, fallidas };
}
