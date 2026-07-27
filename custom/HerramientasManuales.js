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
 * Tareas Programadas que la automatización cierra al procesar el correo del reporte.
 * Se cierra ÚNICAMENTE lo que esté en esta lista: todo lo demás (pedidos de clientes,
 * tickets [INTERNO], mantenimientos manuales como "Rotacion Credenciales") lo hace una
 * persona, y darlo por cerrado sería marcar como hecho algo que nadie hizo.
 *
 * Quedan afuera a propósito los reportes que cierra organizarReportesEnDrive
 * ("VMs protegidas", "Replicas protegidas", "Hosts y VMs con contencion de CPU",
 * "Capacity Planning", "VM Daily Protection Status", "Inventario de VMs"): esos se
 * cierran solos al correr esa función, que sí verifica que el archivo haya llegado.
 */
const TAREAS_QUE_CIERRA_LA_AUTOMATIZACION = [
  "Affinity Rules",
  "Alertas de vROps",
  "Alertas de vSphere",
  "Backup por tag",
  "Capacidad de particiones",
  "Cluster DRS",
  "Componentes de View",
  "Dashboard View",
  "Discos Montados en Proxy",
  "Espacio en datastores",
  "Estado de Agentes View",
  "Idle VMs",
  "Jobs de Veeam",
  "Oversized VMs",
  "Storage DRS",
  "Undersized VMs",
  "VMs apagadas por periodo de tiempo significativo",
  "VMs con Preguntas",
  "VMs con snapshots",
  "VMs en datastores locales",
  "VMs inaccesibles",
  "VMs operativas"
];

// Solo se cierran tareas en este estado. Una "En Ejecución" puede ser trabajo real en curso.
const ESTADO_TAREA_CERRABLE = "Pendiente de Ejecución";

/**
 * Devuelve los clientes del Índice Maestro con su proyecto de Jira y sus remitentes.
 * @returns {Array<{clientName: string, projectKey: string, remitentes: Array<string>}>}
 */
function _obtenerProyectosDelIndice() {
  const proyectos = [];
  const vistos = {};
  MasterSheetSingleton.getMasterData().slice(1).forEach(fila => {
    const remitentesRaw = fila[0] ? String(fila[0]) : "";
    const clientName = fila[1] ? String(fila[1]).trim() : "";
    const projectKey = fila[3] ? String(fila[3]).trim().toUpperCase() : "";
    if (!projectKey) return;

    const remitentes = remitentesRaw.split(',').map(r => r.trim().toLowerCase()).filter(r => r !== "");

    if (vistos[projectKey]) {
      // Un mismo proyecto puede tener varias filas/remitentes: los acumulamos.
      vistos[projectKey].remitentes = vistos[projectKey].remitentes.concat(remitentes);
      return;
    }
    const entrada = { clientName, projectKey, remitentes };
    vistos[projectKey] = entrada;
    proyectos.push(entrada);
  });
  return proyectos;
}

/**
 * Trae la EVIDENCIA de qué reportes se procesaron efectivamente hoy.
 *
 * Una Tarea Programada solo debería cerrarse si su reporte llegó y se proceso. La
 * prueba de eso es el hilo de Gmail con la etiqueta [OPS-PROCESADO], que el propio
 * flujo aplica al terminar. Se hace UNA sola búsqueda y se filtra en memoria para
 * no gastar cuota de Gmail.
 *
 * @returns {Array<{from: string, subject: string}>}
 */
function _obtenerReportesProcesadosHoy() {
  const hilos = GmailApp.search(`label:${OPS_LABEL_PROCESADO} newer_than:1d`, 0, 300);
  Logger.log(`[Evidencia] ${hilos.length} hilos con ${OPS_LABEL_PROCESADO} en las últimas 24 h.`);
  return hilos.map(hilo => {
    const msg = hilo.getMessages()[hilo.getMessageCount() - 1];
    return { from: msg.getFrom().toLowerCase(), subject: msg.getSubject().toLowerCase() };
  });
}

/**
 * Indica si hay evidencia de que el reporte de esa tarea, para ese cliente, se procesó hoy.
 * @param {Array<{from: string, subject: string}>} evidencia Salida de _obtenerReportesProcesadosHoy().
 * @param {Array<string>} remitentes Remitentes del cliente según el Índice Maestro.
 * @param {string} nombreTarea Nombre de la Tarea Programada (coincide con el asunto del reporte).
 * @returns {boolean}
 */
function _hayEvidenciaDeReporte(evidencia, remitentes, nombreTarea) {
  const asuntoBuscado = nombreTarea.trim().toLowerCase();
  return evidencia.some(e =>
    e.subject.indexOf(asuntoBuscado) !== -1 &&
    remitentes.some(r => e.from.indexOf(r) !== -1)
  );
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

// Acota el cierre a una sola tarea (nombre EXACTO como figura en Jira). Vacío = todas
// las que pasen las validaciones.
const MANUAL_CIERRE_NOMBRE_TAREA = "";

// Seguridad: en true solo simula. Poné false recién después de revisar la simulación.
const MANUAL_CIERRE_SIMULACION = true;

/**
 * Cierra Tareas Programadas cuyo reporte se procesó efectivamente hoy.
 *
 * ⚠️ Con MANUAL_CIERRE_SIMULACION = false modifica tickets en Jira.
 *
 * Para cerrar una tarea deben cumplirse las TRES condiciones:
 *   1. Estar en TAREAS_QUE_CIERRA_LA_AUTOMATIZACION (nunca toca pedidos de clientes,
 *      tickets [INTERNO] ni mantenimientos manuales).
 *   2. Estar en estado "Pendiente de Ejecución" (una "En Ejecución" puede ser trabajo real).
 *   3. Tener EVIDENCIA de que el reporte llegó y se procesó hoy: un hilo de Gmail
 *      etiquetado [OPS-PROCESADO] de un remitente de ese cliente y con ese asunto.
 *
 * Sin la condición 3 esto sería solo un "marcar todo como hecho", que es exactamente
 * lo que no queremos: daría por cumplidas operaciones que nunca corrieron.
 */
function manual_cerrarTareasProgramadas() {
  const filtroNombre = MANUAL_CIERRE_NOMBRE_TAREA.trim().toLowerCase();
  const modo = MANUAL_CIERRE_SIMULACION ? "SIMULACIÓN (no se modifica nada)" : "CIERRE REAL";
  Logger.log(`=== CIERRE DE TAREAS PROGRAMADAS — modo: ${modo} ===`);
  if (filtroNombre) Logger.log(`Filtro de nombre: "${MANUAL_CIERRE_NOMBRE_TAREA}"`);

  const evidencia = _obtenerReportesProcesadosHoy();
  const automatizadas = TAREAS_QUE_CIERRA_LA_AUTOMATIZACION.map(t => t.toLowerCase());

  let cerradas = 0, fallidas = 0;
  const omitidas = { noAutomatizada: [], enEjecucion: [], sinEvidencia: [] };

  _obtenerProyectosDelIndice().forEach(({ clientName, projectKey, remitentes }) => {
    _buscarTareasProgramadasAbiertas(projectKey).forEach(tarea => {
      const nombre = tarea.summary.trim();
      const etiqueta = `${tarea.key} — ${clientName} — ${nombre}`;

      if (filtroNombre && nombre.toLowerCase() !== filtroNombre) return;

      if (automatizadas.indexOf(nombre.toLowerCase()) === -1) {
        omitidas.noAutomatizada.push(etiqueta);
        return;
      }
      if (tarea.status !== ESTADO_TAREA_CERRABLE) {
        omitidas.enEjecucion.push(`${etiqueta} [${tarea.status}]`);
        return;
      }
      if (!_hayEvidenciaDeReporte(evidencia, remitentes, nombre)) {
        omitidas.sinEvidencia.push(etiqueta);
        return;
      }

      if (MANUAL_CIERRE_SIMULACION) {
        Logger.log(`   [simulado] ${etiqueta}`);
        cerradas++;
        return;
      }

      const resultado = resolveJiraTicket(tarea.key, JIRA_STATUS_TO_CLOSE);
      if (resultado && resultado.status === 'SUCCESS') {
        Logger.log(`   ✅ ${etiqueta}`);
        cerradas++;
      } else {
        Logger.log(`   ❌ No se pudo cerrar ${etiqueta}`);
        fallidas++;
      }
    });
  });

  Logger.log(`\n=== RESULTADO: ${cerradas} ${MANUAL_CIERRE_SIMULACION ? "se cerrarían" : "cerradas"}, ${fallidas} fallidas ===`);
  Logger.log(`Omitidas por seguridad:`);
  Logger.log(`   ${omitidas.noAutomatizada.length} no las maneja la automatización (las cierra una persona)`);
  Logger.log(`   ${omitidas.enEjecucion.length} en un estado distinto de "${ESTADO_TAREA_CERRABLE}"`);
  Logger.log(`   ${omitidas.sinEvidencia.length} SIN evidencia de que el reporte se haya procesado hoy`);

  if (omitidas.sinEvidencia.length > 0) {
    Logger.log(`\n--- Sin evidencia (el reporte no llegó o no se procesó; revisar antes de cerrar a mano) ---`);
    omitidas.sinEvidencia.forEach(t => Logger.log(`   ${t}`));
  }

  return { cerradas, fallidas, omitidas };
}
