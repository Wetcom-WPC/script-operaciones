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
 * âš ï¸ IMPORTANTE: varias de estas funciones ejecutan acciones reales (Jira/Gmail/Drive).
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
 * Ejecuta el processor de Nutanix manualmente desde el editor de Apps Script.
 *
 * Útil para:
 *   - Verificar que llegan correos del script nutanix_ops_check.ps1.
 *   - Probar el flujo completo (parseo JSON → evaluación → ticket Jira) sin esperar el trigger.
 *   - Diagnosticar por qué un correo quedó en [OPS-PENDIENTE].
 *
 * âš ï¸ Asegurarse de que ENVIRONMENT = "TESTING" en Script Properties si no se quiere
 *    impactar clientes reales.
 *
 * Para simular sin un correo real, usar manual_simularNutanixOps() más abajo.
 */
function manual_testNutanixOps() {
  Logger.log('[manual_testNutanixOps] Iniciando NutanixOpsProcessor en modo manual...');
  new NutanixOpsProcessor().processEmails();
  Logger.log('[manual_testNutanixOps] Finalizado. Revisar logs y bandeja de entrada.');
}

/**
 * Simula el procesamiento de un reporte Nutanix directamente, sin necesitar un correo real.
 *
 * Útil en Fase 1 de testing: permite probar la lógica GAS (processData + handleAlerts)
 * antes de tener el script PS funcionando.
 *
 * Cómo usar:
 *   1. Ajustar el objeto `payloadSimulado` con los estados que querés probar.
 *   2. Asegurarse de que `clientName` coincide con un cliente en el Índice Maestro.
 *   3. Correr la función desde el desplegable del editor.
 *   4. Revisar los logs (Ctrl+Enter) para ver el resultado.
 */
function manual_simularNutanixOps() {
  // --- Ajustar este payload para simular distintos escenarios ---
  const payloadSimulado = {
    fecha:      Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd"),
    origen:     "10.0.0.1 (simulado)",
    clientName: "WPC - Operaciones Testing", // Debe existir en el Índice Maestro
    validaciones: [
      { id: "OPS-NTX-001", nombre: "Estado del Cluster",  estado: "Chequeado", detalle: "Todos los clusters accesibles y operativos. (SIMULADO)" },
      { id: "OPS-NTX-002", nombre: "Alertas Activas",     estado: "Derivado",  detalle: "2 alerta(s) activa(s): 1 Critical, 1 Warning. (SIMULADO)" },
      { id: "OPS-NTX-003", nombre: "Data Resiliency",     estado: "Chequeado", detalle: "Data Resiliency OK en todos los clusters. (SIMULADO)" },
      { id: "OPS-NTX-004", nombre: "Salud de Discos",     estado: "Chequeado", detalle: "Discos OK. Sin alertas de disco. (SIMULADO)" }
    ]
  };

  Logger.log('[manual_simularNutanixOps] Payload de prueba:');
  Logger.log(JSON.stringify(payloadSimulado, null, 2));

  const processor     = new NutanixOpsProcessor();
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };

  // Simular parseAttachment() pasando el JSON directamente
  const parsedData = payloadSimulado;

  // Buscar el clientConfig del cliente de testing
  const clientName    = payloadSimulado.clientName;
  const clientConfig  = getClientConfigByName(clientName, NTX_OPERATION_NAME);

  if (!clientConfig) {
    Logger.log(`[manual_simularNutanixOps] âš ï¸ No se encontró config para "${clientName}" en el Índice Maestro.`);
    Logger.log('Verificar que el cliente existe y que la operación "Operaciones Nutanix" está configurada.');
    return;
  }

  Logger.log(`[manual_simularNutanixOps] Config resuelta: ${clientConfig.clientName} (${clientConfig.jiraProjectKey})`);

  const processed = processor.processData(parsedData, clientConfig, summaryReport);
  Logger.log(`[manual_simularNutanixOps] processData() → ${processed.finalAlerts.length} alerta(s) derivada(s).`);
  Logger.log(`[manual_simularNutanixOps] reasonsText: ${processed.reasonsText}`);

  if (processed.finalAlerts.length === 0) {
    Logger.log('[manual_simularNutanixOps] Sin alertas → handleNoAlerts() (no crea ticket).');
  } else {
    Logger.log('[manual_simularNutanixOps] Con alertas → handleAlerts() → crearía ticket en Jira.');
  }

  Logger.log('[manual_simularNutanixOps] Este helper solo ejercita processData() con un JSON');
  Logger.log('suelto (formato legacy, sin manifiesto). Para ver el ticket creado de verdad y');
  Logger.log('probar el formato consolidado (varios clusters + cierre de tareas), usar');
  Logger.log('manual_simularNutanixOpsConsolidado() más abajo.');

  Logger.log('[manual_simularNutanixOps] Resumen:');
  Logger.log(`  Éxitos: ${summaryReport.exitos.length}`);
  Logger.log(`  Advertencias: ${summaryReport.advertencias.length}`);
  Logger.log(`  Errores: ${summaryReport.errores.length}`);
}

/**
 * Crea (o reutiliza, si ya existen hoy) las 4 Tarea Programada de Nutanix en el proyecto de
 * WPC - Operaciones Testing. Es un prerequisito de manual_simularNutanixOpsConsolidado(): sin
 * estas 4 tareas creadas HOY, el cierre va a devolver NOT_FOUND (no rompe nada — desde el
 * 18/08/2026 eso solo deja una advertencia — pero no vas a poder confirmar que el cierre
 * funciona).
 *
 * Reutiliza _e2eCrearTareaProgramada() de tests/E2ETestHarness.js en vez de reinventar la
 * llamada a Jira.
 */
function manual_prepararTareasProgramadasNutanixDePrueba() {
  const clientConfig = getClientConfigByName(MANUAL_TEST_CLIENT_NAME, NTX_OPERATION_NAME);
  if (!clientConfig) {
    Logger.log(`❌ No se encontró configuración para "${MANUAL_TEST_CLIENT_NAME}" en el Índice Maestro.`);
    return;
  }

  Logger.log(`[manual_prepararTareasProgramadasNutanixDePrueba] Proyecto: ${clientConfig.jiraProjectKey}`);

  NTX_TASKS.forEach(function (nombreTarea) {
    const existente = buscarTareaProgramadaDelDia(nombreTarea, clientConfig.jiraProjectKey);
    if (existente) {
      Logger.log(`  = "${nombreTarea}" ya existe hoy: ${existente.key} (${existente.status}). No se crea otra.`);
      return;
    }
    const key = _e2eCrearTareaProgramada(
      nombreTarea,
      clientConfig.jiraProjectKey,
      "Tarea Programada de prueba para testear el cierre consolidado de Nutanix (manual_simularNutanixOpsConsolidado)."
    );
    if (key) Logger.log(`  + "${nombreTarea}" creada: ${key}`);
    Utilities.sleep(300); // No saturar la API de Jira.
  });
}

/**
 * Borra (DELETE real, no transición de estado) las 4 Tarea Programada de prueba de Nutanix del
 * proyecto de WPC - Operaciones Testing, sin importar si están abiertas o cerradas.
 *
 * Para qué sirve: manual_prepararTareasProgramadasNutanixDePrueba() no crea una tarea nueva si
 * ya existe una con ese nombre creada hoy, sin importar su estado — así que una vez que
 * manual_simularNutanixOpsConsolidado() las cierra, no hay forma de volver a tener las 4
 * ABIERTAS para probar el caso "falta un cluster" sin, o bien reabrirlas a mano en Jira, o
 * borrarlas y recrearlas. Esto hace lo segundo.
 *
 * Correr esta función y después manual_prepararTareasProgramadasNutanixDePrueba() de nuevo para
 * volver a tener las 4 tareas limpias y abiertas.
 */
function manual_borrarTareasProgramadasNutanixDePrueba() {
  const clientConfig = getClientConfigByName(MANUAL_TEST_CLIENT_NAME, NTX_OPERATION_NAME);
  if (!clientConfig) {
    Logger.log(`❌ No se encontró configuración para "${MANUAL_TEST_CLIENT_NAME}" en el Índice Maestro.`);
    return;
  }

  NTX_TASKS.forEach(function (nombreTarea) {
    const existente = buscarTareaProgramadaDelDia(nombreTarea, clientConfig.jiraProjectKey);
    if (!existente) {
      Logger.log(`  (sin cambios) "${nombreTarea}": no hay ninguna creada hoy.`);
      return;
    }
    const options = { "method": "delete", "headers": getJiraHeaders(), "muteHttpExceptions": true };
    const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/issue/${existente.key}`, options);
    const codigo = respuesta.getResponseCode();
    if (codigo === 204) {
      Logger.log(`  - "${nombreTarea}" (${existente.key}) borrada.`);
    } else {
      Logger.log(`  ❌ No se pudo borrar "${nombreTarea}" (${existente.key}): HTTP ${codigo} — ${respuesta.getContentText()}`);
    }
    Utilities.sleep(300); // No saturar la API de Jira.
  });
}

/**
 * Simula un correo CONSOLIDADO de Nutanix (manifiesto + varios clusters) y lo procesa con la
 * lógica real (processSingleMessage), SIN pasar por Gmail: arma los adjuntos en memoria con
 * Utilities.newBlob() y un objeto de correo simulado con la misma interfaz que usa el processor
 * (getFrom/getSubject/getAttachments).
 *
 * Es la forma correcta de probar el flujo nuevo de un-correo-por-cliente sin tocar la casilla
 * real de operaciones ni ningún cliente real:
 *
 *   - El clientName que viaja en el manifiesto (abajo, "Transener") NO importa: en TESTING,
 *     getClientConfigByName() lo redirige igual a MANUAL_TEST_CLIENT_NAME (ver el comentario en
 *     ClientConfigService.js). El ticket y el cierre de tareas van a WPC - Operaciones Testing.
 *   - No depende de que exista ninguna CVM real ni de que corra nutanix_ops_sender.ps1.
 *
 * Antes de correrla, para poder ver el cierre de tareas funcionando, correr una vez
 * manual_prepararTareasProgramadasNutanixDePrueba().
 *
 * Cómo usar:
 *   1. Ajustar el array `escenario` de abajo para probar el caso que quieras: los 3 clusters
 *      OK, uno caído (cambiar su entrada a estado "ERROR"), o ninguno.
 *   2. Correr la función. Revisar los logs: qué ticket(s) se crearon/comentaron y si las 4
 *      tareas se cerraron o quedaron abiertas.
 *   3. Confirmar a mano en Jira, en el proyecto que loguea la función.
 */
function manual_simularNutanixOpsConsolidado() {
  const FECHA = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
  const HORA  = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "HHmmss");

  // --- Ajustar este escenario para probar distintos casos ---
  // Para simular un cluster caído, reemplazar su entrada por:
  //   { nombre: "Sede", estado: "ERROR", detalle: "SIMULADO: fallo la conexion SSH." }
  const escenario = [
    { nombre: "Ezeiza", estado: "OK", validaciones: [
        { id: "OPS-NTX-001", nombre: "Estado del Cluster", estado: "Chequeado", detalle: "SIMULADO: todo UP." },
        { id: "OPS-NTX-002", nombre: "Alertas Activas",    estado: "Derivado",  detalle: "SIMULADO: 1 alerta Critical, 1 Warning." },
        { id: "OPS-NTX-003", nombre: "Data Resiliency",    estado: "Chequeado", detalle: "SIMULADO: OK." },
        { id: "OPS-NTX-004", nombre: "Salud de Discos",    estado: "Chequeado", detalle: "SIMULADO: OK." }
      ] },
    { nombre: "Rosario", estado: "OK", validaciones: [
        { id: "OPS-NTX-001", nombre: "Estado del Cluster", estado: "Chequeado", detalle: "SIMULADO: todo UP." },
        { id: "OPS-NTX-002", nombre: "Alertas Activas",    estado: "Chequeado", detalle: "SIMULADO: OK." },
        { id: "OPS-NTX-003", nombre: "Data Resiliency",    estado: "Chequeado", detalle: "SIMULADO: OK." },
        { id: "OPS-NTX-004", nombre: "Salud de Discos",    estado: "Chequeado", detalle: "SIMULADO: OK." }
      ] },
    { nombre: "Sede", estado: "OK", validaciones: [
        { id: "OPS-NTX-001", nombre: "Estado del Cluster", estado: "Chequeado", detalle: "SIMULADO: todo UP." },
        { id: "OPS-NTX-002", nombre: "Alertas Activas",    estado: "Chequeado", detalle: "SIMULADO: OK." },
        { id: "OPS-NTX-003", nombre: "Data Resiliency",    estado: "Chequeado", detalle: "SIMULADO: OK." },
        { id: "OPS-NTX-004", nombre: "Salud de Discos",    estado: "Chequeado", detalle: "SIMULADO: OK." }
      ] }
  ];

  const clusters = [];
  const adjuntos = [];

  escenario.forEach(function (c) {
    if (c.estado !== "OK") {
      clusters.push({ nombre: c.nombre, host: c.nombre.toLowerCase() + ".simulado", estado: "ERROR", detalle: c.detalle });
      return;
    }
    const archivo = `nutanix_ops_${FECHA}_${HORA}_${c.nombre.toLowerCase()}.json`;
    const reporte = {
      fecha: FECHA, origen: "10.0.0.1 (simulado)",
      clusterName: c.nombre.toUpperCase(),
      clusterFqdn: `ntnx-prism-${c.nombre.toLowerCase()}.transx.net (simulado)`,
      clientName: "Transener", // No importa en TESTING: se redirige igual. Ver docstring arriba.
      validaciones: c.validaciones
    };
    clusters.push({ nombre: c.nombre, host: `ntnx-prism-${c.nombre.toLowerCase()}.transx.net`, estado: "OK", archivo: archivo });
    adjuntos.push(Utilities.newBlob(JSON.stringify(reporte), "application/json", archivo));
  });

  const manifiesto = {
    tipo: "nutanix_ops_manifest", version: 1, fecha: FECHA, clientName: "Transener",
    generado: new Date().toISOString(), clusters: clusters
  };
  const blobManifiesto = Utilities.newBlob(JSON.stringify(manifiesto), "application/json", `nutanix_manifest_${FECHA}_${HORA}.json`);

  // Objeto con la misma interfaz que MailProcessor espera de un GmailMessage real
  // (getFrom/getSubject/getAttachments): los Blob de Utilities.newBlob() ya implementan
  // getName/getContentType/getDataAsString/copyBlob nativamente, así que no hace falta
  // simularlos también.
  const correoSimulado = {
    getFrom: function () { return "alarmas@wetcom.com (SIMULADO — no se envía ni se lee ningún correo real)"; },
    getSubject: function () { return "Operaciones Nutanix [SIMULADO]"; },
    getAttachments: function () { return [blobManifiesto].concat(adjuntos); }
  };

  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0, tareasCerradasDetalle: [] };

  Logger.log('[manual_simularNutanixOpsConsolidado] Procesando correo simulado (esto SÍ va a crear/comentar tickets reales en Jira de testing)...');
  const resultado = new NutanixOpsProcessor().processSingleMessage(correoSimulado, summaryReport);

  Logger.log(`[manual_simularNutanixOpsConsolidado] Resultado del correo: ${resultado.status}`);
  Logger.log(`  Éxitos (${summaryReport.exitos.length}):`);
  summaryReport.exitos.forEach(function (e) { Logger.log(`    - ${e.mensaje}`); });
  Logger.log(`  Advertencias (${summaryReport.advertencias.length}):`);
  summaryReport.advertencias.forEach(function (a) { Logger.log(`    - ${a.problema} → ${a.accion}`); });
  Logger.log(`  Errores (${summaryReport.errores.length}):`);
  summaryReport.errores.forEach(function (e) { Logger.log(`    - ${e.error}: ${e.detalle}`); });
  Logger.log(`  Tareas cerradas: ${summaryReport.tareasCerradas}`);
}



/**
 * AUDITORÍA (solo lectura): lista los activadores del proyecto y a qué hora arranca el día.
 *
 * Los activadores NO viven en el código sino en la configuración del proyecto de Apps Script,
 * así que esta es la única forma de responder "¿a qué hora empieza a procesar?" sin abrir el
 * panel de Activadores a mano.
 */
function manual_auditarActivadores() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log(`=== ACTIVADORES DEL PROYECTO (${triggers.length}) ===`);

  triggers.forEach(function (t) {
    Logger.log(`   ${t.getHandlerFunction()}  |  tipo: ${t.getEventType()}  |  id: ${t.getUniqueId()}`);
  });

  const diarios = triggers.filter(function (t) { return t.getHandlerFunction() === 'iniciarDiaOperativo'; });
  Logger.log(`\n--- Arranque del día ---`);
  if (diarios.length === 0) {
    Logger.log(`   🚨 NO hay ningún activador para iniciarDiaOperativo: el ciclo diario NO arranca solo.`);
    Logger.log(`      Ejecutá manual_configurarActivadorDiario() para crearlo.`);
  } else if (diarios.length > 1) {
    Logger.log(`   âš ï¸ Hay ${diarios.length} activadores de iniciarDiaOperativo: se pisan entre sí. Ejecutá manual_configurarActivadorDiario() para dejar uno solo.`);
  } else {
    Logger.log(`   ✅ Hay 1 activador de iniciarDiaOperativo.`);
  }
  Logger.log(`   La API no expone la hora configurada de un activador: verificala en el panel`);
  Logger.log(`   "Activadores" del editor. Debe estar en las ${HORA_INICIO - 1}hs — la franja de una hora de`);
  Logger.log(`   Google termina así antes de HORA_INICIO (${HORA_INICIO}hs), y iniciarDiaOperativo agenda`);
  Logger.log(`   el arranque exacto a las ${HORA_INICIO}:00.`);

  return { total: triggers.length, diarios: diarios.length };
}

/**
 * Deja UN solo activador diario para iniciarDiaOperativo, en la franja previa a HORA_INICIO.
 *
 * âš ï¸ Modifica los activadores del proyecto. Correr una sola vez (o cuando haya que reparar la
 * configuración), no en cada despliegue.
 *
 * Se configura una hora ANTES de HORA_INICIO a propósito: los activadores diarios de Google se
 * disparan en algún momento de una franja de una hora, así que uno puesto a las 6 puede caer
 * 6:55. Poniéndolo a las 5, la franja 5-6 termina siempre antes de la hora deseada y es
 * iniciarDiaOperativo() quien agenda el arranque exacto a las 6:00 (ver core/Main.js).
 */
function manual_configurarActivadorDiario() {
  const horaActivador = HORA_INICIO - 1;

  let borrados = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'iniciarDiaOperativo') {
      ScriptApp.deleteTrigger(t);
      borrados++;
    }
  });
  if (borrados > 0) Logger.log(`Se eliminaron ${borrados} activador(es) previo(s) de iniciarDiaOperativo.`);

  ScriptApp.newTrigger('iniciarDiaOperativo')
    .timeBased()
    .everyDays(1)
    .atHour(horaActivador)
    .create();

  Logger.log(`✅ Activador diario creado: iniciarDiaOperativo en la franja de las ${horaActivador}hs.`);
  Logger.log(`   El procesamiento real arranca a las ${HORA_INICIO}:00 en punto.`);
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
 * Archiva en Drive los reportes que ningún processor reclamó (el catch-all del pipeline).
 *
 * Reemplaza a `manual_organizarReportesAhora`, que llamaba a `guardarYConvertirAdjuntosEnDrive`:
 * esa función desapareció en la Etapa 2, cuando el archivado pasó a ser un paso de cada
 * processor. Para archivar el reporte de una operación puntual, ejecutar esa operación.
 */
function manual_archivarReportesSinProcessor() {
  Logger.log("[manual_archivarReportesSinProcessor] Buscando correos que ningún processor reclama...");
  processReportesSinProcessorEmails();
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
// REINTENTO DE CORREOS [OPS-ERROR]
// =================================================================

// Acota el reintento a los correos cuyo asunto contenga este texto (no distingue
// mayúsculas). Vacío = todos los correos en [OPS-ERROR]. Útil para debuggear un reporte
// puntual sin disparar de nuevo el resto de los correos apartados.
//
// Es `let` y no `const` a propósito: tests/E2EReintentoErrorTest.js lo pisa temporalmente
// para acotar manual_reintentarCorreosConError() a un único correo de prueba (por runId) sin
// tocar ningún otro correo real que pueda estar en [OPS-ERROR], y lo restaura al terminar. El
// uso manual de siempre (editar este valor a mano antes de correr) sigue funcionando igual.
let MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO = "";

/**
 * Encuentra, entre los processors registrados en obtenerRegistroDeProcesadores() (Main.js),
 * el que reclama este asunto — mismo criterio que fetchAndFilterGlobalThreads: el asunto del
 * correo CONTIENE el emailSubject del processor. Se excluye el catch-all
 * (ReportesSinProcessor, emailSubject "") porque un correo que llegó a [OPS-ERROR] ya fue
 * reclamado por su processor real; enrutarlo al catch-all sería reprocesarlo con la lógica
 * equivocada.
 * @param {string} asunto Asunto del correo (tal cual, sin normalizar).
 * @returns {MailProcessor|null}
 */
function _resolverProcessorDelAsunto(asunto) {
  const asuntoLower = asunto.toLowerCase();
  for (const entrada of obtenerRegistroDeProcesadores()) {
    let instancia;
    try {
      instancia = entrada.crear();
    } catch (e) {
      continue;
    }
    if (instancia.emailSubject && asuntoLower.includes(instancia.emailSubject.toLowerCase())) {
      return instancia;
    }
  }
  return null;
}

/**
 * Reprocesa YA MISMO, en esta misma ejecución, los correos apartados en [OPS-ERROR]:
 * identifica el processor que reclama cada uno (por asunto) y le corre processSingleMessage()
 * de nuevo sobre el thread real. Pensada para debuggear en el momento, después de corregir la
 * causa del error (config de Jira, nombre de tarea programada, etc.) — el Log de esta corrida
 * muestra el resultado real de cada intento, igual que vería el ciclo automático.
 *
 * El destino final de cada correo lo decide etiquetarYMarcarProcesado() (core/MailUtils.js),
 * la MISMA función que usa el ciclo automático, para que el comportamiento sea idéntico:
 * - SUCCESS o NO_OP -> [OPS-PROCESADO].
 * - Un fallo que amerita reintentar (ERROR, FAILURE, HTTP_500) -> vuelve a [OPS-PENDIENTE],
 *   así el ciclo automático lo retoma solo. Cuenta como un reintento más: si ya venía
 *   acumulando intentos de antes (del ciclo automático, previo a caer en [OPS-ERROR]) y
 *   supera el tope de obtenerMaxReintentosPendiente() (configurable vía la Script Property
 *   "OPS_MAX_REINTENTOS_PENDIENTE"), se apartará de nuevo a [OPS-ERROR] en vez de quedar
 *   reintentando para siempre.
 * - Un fallo terminal (config incorrecta, tarea programada inexistente, etc.) -> se mantiene
 *   en [OPS-ERROR].
 *
 * âš ï¸ Ejecuta el pipeline real: puede crear/actualizar tickets de Jira, mandar avisos a Slack
 * y archivar en Drive (esos avisos salen en el momento, desde dentro de processSingleMessage,
 * no al final). Correr solo después de haber corregido el problema, o para confirmar en el
 * momento que la corrección funcionó.
 */
function manual_reintentarCorreosConError() {
  const filtro = MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO.trim().toLowerCase();
  Logger.log(`=== REPROCESAMIENTO EN VIVO DE ${OPS_LABEL_ERROR} ===`);
  if (filtro) Logger.log(`Filtro de asunto: "${MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO}"`);

  const hilos = GmailApp.search(`label:${OPS_LABEL_ERROR}`, 0, 500);
  Logger.log(`${hilos.length} hilo(s) encontrados en ${OPS_LABEL_ERROR}.`);
  if (hilos.length >= 500) {
    Logger.log(`âš ï¸ Se alcanzó el tope de 500 hilos: puede haber más en ${OPS_LABEL_ERROR} que esta corrida no vio.`);
  }

  const timeGuard = new TimeGuard({ operationName: "Reintento manual OPS-ERROR" });
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0, timeGuard: timeGuard };

  let procesados = 0, resueltos = 0, vuelvenAPendiente = 0, siguenEnError = 0, sinProcessor = 0;
  const omitidosPorFiltro = [];

  for (const hilo of hilos) {
    if (hilo.getMessageCount() === 0) continue;
    const message = hilo.getMessages()[hilo.getMessageCount() - 1];
    const asunto = message.getSubject();

    if (filtro && asunto.toLowerCase().indexOf(filtro) === -1) {
      omitidosPorFiltro.push(asunto);
      continue;
    }

    if (!timeGuard.check(`Reintento OPS-ERROR: ${hilo.getId()}`)) {
      Logger.log(`⏸️ Límite de tiempo alcanzado. El resto de los correos en ${OPS_LABEL_ERROR} queda para la próxima corrida.`);
      break;
    }

    const processor = _resolverProcessorDelAsunto(asunto);
    if (!processor) {
      Logger.log(`   âš ï¸ Ningún processor registrado reclama el asunto "${asunto}". Se deja en ${OPS_LABEL_ERROR}.`);
      sinProcessor++;
      continue;
    }

    Logger.log(`   ▶ Reprocesando "${asunto}" con ${processor.constructor.name}...`);
    procesados++;

    let resultado;
    try {
      resultado = processor.processSingleMessage(message, summaryReport);
    } catch (e) {
      Logger.log(`   âŒ Error crítico reprocesando "${asunto}": ${e.message} | Stack: ${e.stack}`);
      resultado = { status: 'ERROR' };
    }

    const status = resultado ? resultado.status : 'ERROR';
    const aplicado = etiquetarYMarcarProcesado(hilo, status);

    if (aplicado.label === 'PROCESADO') {
      Logger.log(`   ✅ "${asunto}" resuelto (${status}) -> pasa a ${OPS_LABEL_PROCESADO}.`);
      resueltos++;
    } else if (aplicado.label === 'PENDIENTE') {
      Logger.log(`   ðŸ” "${asunto}" falló con un error reintentable (${status}) -> vuelve a ${OPS_LABEL_PENDIENTE} (intento ${aplicado.intentos}/${obtenerMaxReintentosPendiente()}). Lo retoma el ciclo automático.`);
      vuelvenAPendiente++;
    } else {
      const motivo = aplicado.motivo === 'TOPE_REINTENTOS'
        ? `agotó ${obtenerMaxReintentosPendiente()} reintentos`
        : `fallo terminal (${status})`;
      Logger.log(`   âŒ "${asunto}" se mantiene en ${OPS_LABEL_ERROR}: ${motivo}.`);
      siguenEnError++;
    }
  }

  if (typeof flushLogs === "function") flushLogs();

  Logger.log(`\n=== RESULTADO: ${procesados} reprocesado(s) — ${resueltos} -> ${OPS_LABEL_PROCESADO}, ${vuelvenAPendiente} -> ${OPS_LABEL_PENDIENTE} (los retoma el ciclo automático), ${siguenEnError} siguen en ${OPS_LABEL_ERROR}, ${sinProcessor} sin processor identificado, ${omitidosPorFiltro.length} omitidos por filtro ===`);
  if (summaryReport.errores.length > 0) {
    Logger.log(`\n--- Detalle de errores/advertencias de esta corrida ---`);
    summaryReport.errores.forEach(e => Logger.log(`   ${e.cliente || ""} | ${e.error} | ${e.detalle || ""}`));
  }

  return { procesados, resueltos, vuelvenAPendiente, siguenEnError, sinProcessor, omitidosPorFiltro };
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
 *
 * También queda afuera "Backup por tag": no se dispara con un correo entrante sino
 * que ENVÍA un mail con archivos de Drive (enviarMailBackupPorTagDiarios), así que
 * nunca puede tener evidencia de "reporte procesado" y la validación la marcaría
 * como faltante para siempre.
 */
const TAREAS_QUE_CIERRA_LA_AUTOMATIZACION = [
  "Affinity Rules",
  "Alertas de vROps",
  "Alertas de vSphere",
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
      Logger.log(`  âš ï¸ No se pudo consultar el proyecto ${projectKey} (HTTP ${response.getResponseCode()}).`);
      return [];
    }
    const data = JSON.parse(response.getContentText());
    return (data.issues || []).map(i => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status ? i.fields.status.name : "?"
    }));
  } catch (e) {
    Logger.log(`  âš ï¸ Error consultando ${projectKey}: ${e.message}`);
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
 * âš ï¸ Con MANUAL_CIERRE_SIMULACION = false modifica tickets en Jira.
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
  // Cuántos reportes procesados hoy hay por cliente. Sirve para distinguir dos casos muy
  // distintos: "a este cliente no le llegó/procesó NINGÚN reporte" (problema del cliente o
  // del ciclo) vs "llegaron varios pero justo ese no" (el reporte puntual falta).
  const reportesPorCliente = {};

  _obtenerProyectosDelIndice().forEach(({ clientName, projectKey, remitentes }) => {
    reportesPorCliente[clientName] = evidencia.filter(e =>
      remitentes.some(r => e.from.indexOf(r) !== -1)
    ).length;

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
        omitidas.sinEvidencia.push({ etiqueta, clientName });
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
        Logger.log(`   âŒ No se pudo cerrar ${etiqueta}`);
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

    // Agrupamos por cliente e informamos cuántos reportes SÍ se procesaron de cada uno.
    const porCliente = {};
    omitidas.sinEvidencia.forEach(({ etiqueta, clientName }) => {
      if (!porCliente[clientName]) porCliente[clientName] = [];
      porCliente[clientName].push(etiqueta);
    });

    Object.keys(porCliente).forEach(cliente => {
      const procesados = reportesPorCliente[cliente] || 0;
      const veredicto = procesados === 0
        ? "🚨 NINGÚN reporte de este cliente se procesó hoy: el problema es del cliente o del ciclo, no de estas tareas puntuales."
        : `${procesados} reporte(s) de este cliente SÍ se procesaron hoy: solo faltan estos.`;
      Logger.log(`\n   ${cliente} — ${veredicto}`);
      porCliente[cliente].forEach(t => Logger.log(`      ${t}`));
    });
  }

  return { cerradas, fallidas, omitidas, reportesPorCliente };
}

/**
 * Cierra masivamente todos los tickets abiertos en los proyectos de Testing (WPC y WST).
 * Ejecuta las transiciones obligatorias en orden.
 */
function manual_CerrarTicketsTesting() {
  const proyectos = ["WPC", "WST"];

  const rutaWPC = ["In Progress", "Closed"];
  const rutaWST = ["En Ánalisis", "Esperando confirmación  del cliente", "Closed"];

  // Helper para hacer las transiciones en cadena
  function transicionarTicket(issueKey, rutas) {
    for (let estado of rutas) {
      const transitionsUrl = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/transitions`;
      const optionsGet = { "method": "get", "headers": getJiraHeaders(), "muteHttpExceptions": true };
      const responseGet = fetchWithRetries(transitionsUrl, optionsGet);
      if (responseGet.getResponseCode() !== 200) continue;
      
      const data = JSON.parse(responseGet.getContentText());
      const transicion = data.transitions.find(t => t.to.name === estado);
      
      if (transicion) {
        Logger.log(`  -> Transicionando a: ${estado}`);
        const payloadPost = { "transition": { "id": transicion.id } };
        const optionsPost = {
          "method": "post", "contentType": "application/json",
          "headers": getJiraHeaders(), "payload": JSON.stringify(payloadPost), "muteHttpExceptions": true
        };
        fetchWithRetries(transitionsUrl, optionsPost);
      }
    }
  }

  proyectos.forEach(projectKey => {
    Logger.log(`\n==============================================`);
    Logger.log(`Buscando tickets abiertos en el proyecto ${projectKey}...`);
    
    const endpoint = `${JIRA_DOMAIN}/rest/api/3/search/jql`;
    const jql = `project = "${projectKey}" AND statusCategory != "Done"`;
    
    // Pedimos hasta 100 resultados
    const payload = { "jql": jql, "maxResults": 100, "fields": ["key", "summary"] };
    const options = {
      "method": "post", "contentType": "application/json",
      "headers": getJiraHeaders(),
      "payload": JSON.stringify(payload), "muteHttpExceptions": true
    };
    
    try {
      const response = fetchWithRetries(endpoint, options);
      if (response.getResponseCode() !== 200) {
        Logger.log(`Error al buscar en ${projectKey}: HTTP ${response.getResponseCode()}`);
        return;
      }
      
      const data = JSON.parse(response.getContentText());
      const issues = data.issues || [];
      
      Logger.log(`Se encontraron ${issues.length} tickets abiertos en ${projectKey}.`);
      
      let procesados = 0;
      
      issues.forEach(issue => {
        Logger.log(`- Procesando ticket ${issue.key} ("${issue.fields.summary}")...`);
        const rutas = projectKey === "WPC" ? rutaWPC : rutaWST;
        transicionarTicket(issue.key, rutas);
        procesados++;
      });
      
      Logger.log(`Resumen para ${projectKey}: ${procesados} procesados.`);
      
    } catch (e) {
      Logger.log(`Error al procesar proyecto ${projectKey}: ${e.message}`);
    }
  });
  
  Logger.log(`\nLimpieza de tickets de Testing finalizada.`);
}

// =================================================================
// HERRAMIENTA: Crear pestaña "VMs con Snapshots SOP" en planillas de excepciones
// =================================================================
/**
 * Recorre todas las filas del Índice Maestro y, para cada cliente que tenga un
 * spreadsheet de excepciones configurado (columna C = row[2]), crea la pestaña
 * "VMs con Snapshots SOP" si aún no existe.
 *
 * Estructura de la pestaña creada:
 *   A: ID de Excepción
 *   B: Columna del Reporte
 *   C: Tipo de Coincidencia  (dropdown: exacta / contiene / comienza con / termina con)
 *   D: Valores a Ignorar
 *   E: Válida hasta
 *   F: Excepción Activa      (dropdown: SI / NO)
 *   G: AGE (días)
 *   H: SIZE (GB)
 *   I: QTY (cantidad)
 *   J: TIPO TAMAÑO           (dropdown: Absoluto / Relativo)
 *   K: CRITERIO              (dropdown: Ignorar / Considerar)
 *
 * Ejecutar desde el editor de Apps Script: sin parámetros, impacta todas las
 * planillas del Índice Maestro. Revisar los logs para ver el resumen.
 */
function manual_CrearPestanasSopSnapshots() {
  const TAB_NAME = "VMs con Snapshots SOP";
  const HEADERS  = [
    "ID de Excepción",
    "Columna del Reporte",
    "Tipo de Coincidencia",
    "Valores a Ignorar",
    "Válida hasta",
    "Excepción Activa",
    "AGE",
    "SIZE",
    "QTY",
    "TIPO TAMAÑO",
    "CRITERIO"
  ];

  const masterData = MasterSheetSingleton.getMasterData();
  if (!masterData || masterData.length === 0) {
    Logger.log("[manual_CrearPestanasSopSnapshots] ERROR: No se pudo cargar el Índice Maestro.");
    return;
  }

  let creadas   = 0;
  let existian  = 0;
  let errores   = 0;
  let sinPlanilla = 0;

  masterData.forEach((row, idx) => {
    const clientName      = row[1] != null ? String(row[1]).trim() : "";
    const exceptionFileId = row[2] != null ? String(row[2]).trim() : "";

    if (!exceptionFileId) {
      Logger.log(`[Fila ${idx + 1}] "${clientName}" — sin planilla de excepciones configurada. Se omite.`);
      sinPlanilla++;
      return;
    }

    try {
      const ss    = SpreadsheetApp.openById(exceptionFileId);
      let sheet   = ss.getSheetByName(TAB_NAME);

      if (sheet) {
        Logger.log(`[Fila ${idx + 1}] "${clientName}" — la pestaña "${TAB_NAME}" ya existe. Se omite.`);
        existian++;
        return;
      }

      // Crear la pestaña al final del spreadsheet
      sheet = ss.insertSheet(TAB_NAME);

      // --- Encabezados ---
      const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
      headerRange.setValues([HEADERS]);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#34A853");      // verde Wetcom
      headerRange.setFontColor("#FFFFFF");

      // --- Anchos de columna aproximados ---
      const colWidths = [160, 160, 140, 200, 100, 120, 60, 60, 60, 110, 110];
      colWidths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

      // --- Data Validations ---
      const LAST_ROW = 1000; // hasta donde se aplican los dropdowns

      // C: Tipo de Coincidencia
      sheet.getRange(2, 3, LAST_ROW, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["exacta", "contiene", "comienza con", "termina con"], true)
          .setAllowInvalid(false)
          .build()
      );

      // F: Excepción Activa
      sheet.getRange(2, 6, LAST_ROW, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["SI", "NO"], true)
          .setAllowInvalid(false)
          .build()
      );

      // J: TIPO TAMAÑO
      sheet.getRange(2, 10, LAST_ROW, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["Absoluto", "Relativo"], true)
          .setAllowInvalid(false)
          .build()
      );

      // K: CRITERIO
      sheet.getRange(2, 11, LAST_ROW, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["Exceptuar", "Considerar"], true)
          .setAllowInvalid(false)
          .build()
      );

      // Fijar la fila de encabezados
      sheet.setFrozenRows(1);

      Logger.log(`[Fila ${idx + 1}] "${clientName}" — pestaña "${TAB_NAME}" CREADA exitosamente.`);
      creadas++;

    } catch (e) {
      Logger.log(`[Fila ${idx + 1}] "${clientName}" — ERROR: ${e.message}`);
      errores++;
    }
  });

  Logger.log(
    `\n=== RESUMEN ===\n` +
    `Pestañas creadas   : ${creadas}\n` +
    `Ya existían        : ${existian}\n` +
    `Sin planilla       : ${sinPlanilla}\n` +
    `Con error          : ${errores}`
  );
}

// =================================================================
// HERRAMIENTA: Actualizar pestaña "VMs con snapshots" en planillas de excepciones para agregar columnas de umbrales
// =================================================================
/**
 * Recorre todas las filas del Índice Maestro y actualiza la pestaña "VMs con snapshots"
 * para que tenga el formato exacto de la pestaña SOP (11 columnas).
 * Elimina cualquier dato basura de la columna G en adelante.
 */
function manual_ActualizarPestanaOpsSnapshots() {
  const TAB_NAME = "VMs con snapshots";
  
  const masterData = MasterSheetSingleton.getMasterData();
  if (!masterData || masterData.length === 0) {
    Logger.log("[manual_ActualizarPestanaOpsSnapshots] ERROR: No se pudo cargar el Índice Maestro.");
    return;
  }

  let actualizadas = 0;
  let sinPestana = 0;
  let errores = 0;
  let sinPlanilla = 0;

  masterData.forEach((row, idx) => {
    const clientName      = row[1] != null ? String(row[1]).trim() : "";
    const exceptionFileId = row[2] != null ? String(row[2]).trim() : "";

    if (!exceptionFileId) {
      Logger.log(`[Fila ${idx + 1}] "${clientName}" — sin planilla de excepciones configurada. Se omite.`);
      sinPlanilla++;
      return;
    }

    try {
      const ss    = SpreadsheetApp.openById(exceptionFileId);
      let sheet   = ss.getSheetByName(TAB_NAME);

      if (!sheet) sheet = ss.getSheetByName("VMs con Snapshots");

      if (!sheet) {
        Logger.log(`[Fila ${idx + 1}] "${clientName}" — la pestaña NO EXISTE. Se omite.`);
        sinPestana++;
        return;
      }

      // Limpiar TODO desde la columna 7 (G) en adelante
      const lastRow = sheet.getLastRow() > 0 ? sheet.getLastRow() : 1000;
      const maxCols = sheet.getMaxColumns();
      if (maxCols >= 7) {
         sheet.getRange(1, 7, lastRow, maxCols - 6).clear();
         sheet.getRange(1, 7, lastRow, maxCols - 6).clearDataValidations();
         sheet.getRange(1, 7, lastRow, maxCols - 6).clearFormat();
      }

      // Escribir nuevos encabezados en G-K (igual que SOP)
      const newHeaders = ["AGE", "SIZE", "QTY", "TIPO TAMAÑO", "CRITERIO"];
      const headerRange = sheet.getRange(1, 7, 1, 5);
      headerRange.setValues([newHeaders]);
      headerRange.setFontWeight("bold");
      
      headerRange.setBackground("#34A853");
      headerRange.setFontColor("#FFFFFF");
      
      const colWidths = { 7: 60, 8: 60, 9: 60, 10: 110, 11: 110 };
      for (const col in colWidths) {
        sheet.setColumnWidth(parseInt(col), colWidths[col]);
      }

      const LAST_ROW_VAL = 1000;
      sheet.getRange(2, 10, LAST_ROW_VAL, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["Absoluto", "Relativo"], true)
          .setAllowInvalid(false)
          .build()
      );

      sheet.getRange(2, 11, LAST_ROW_VAL, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["Exceptuar", "Considerar"], true)
          .setAllowInvalid(false)
          .build()
      );

      Logger.log(`[Fila ${idx + 1}] "${clientName}" — pestaña ACTUALIZADA exitosamente a formato SOP.`);
      actualizadas++;

    } catch (e) {
      Logger.log(`[Fila ${idx + 1}] "${clientName}" — ERROR: ${e.message}`);
      errores++;
    }
  });

  Logger.log(
    `
=== RESUMEN ===
` +
    `Pestañas arregladas   : ${actualizadas}
` +
    `Sin pestaña (no existe) : ${sinPestana}
` +
    `Sin planilla          : ${sinPlanilla}
` +
    `Con error             : ${errores}`
  );
}
// =================================================================
// HERRAMIENTA: Unificar "Exceptuar" en ambas pestañas
// =================================================================
function manual_UnificarCriterioExceptuar() {
  const masterData = MasterSheetSingleton.getMasterData();
  let arregladas = 0;
  
  masterData.forEach((row, idx) => {
    const clientName = row[1] ? String(row[1]).trim() : "";
    const exceptionFileId = row[2] ? String(row[2]).trim() : "";
    if (!exceptionFileId) return;

    try {
      const ss = SpreadsheetApp.openById(exceptionFileId);
      
      // Actualizar SOP
      const sheetSop = ss.getSheetByName("VMs con Snapshots SOP");
      if (sheetSop) {
        sheetSop.getRange(2, 11, 1000, 1).setDataValidation(
          SpreadsheetApp.newDataValidation()
            .requireValueInList(["Exceptuar", "Considerar"], true)
            .setAllowInvalid(false)
            .build()
        );
      }
      
      // Actualizar OPS
      let sheetOps = ss.getSheetByName("VMs con snapshots") || ss.getSheetByName("VMs con Snapshots");
      if (sheetOps) {
        sheetOps.getRange(2, 11, 1000, 1).setDataValidation(
          SpreadsheetApp.newDataValidation()
            .requireValueInList(["Exceptuar", "Considerar"], true)
            .setAllowInvalid(false)
            .build()
        );
        
        // Reemplazar la palabra "Ignorar" por "Exceptuar" si ya habían elegido Ignorar
        const opsData = sheetOps.getRange(2, 11, 1000, 1).getValues();
        let changed = false;
        for (let i = 0; i < opsData.length; i++) {
          if (String(opsData[i][0]).trim().toLowerCase() === "ignorar") {
            opsData[i][0] = "Exceptuar";
            changed = true;
          }
        }
        if (changed) {
          sheetOps.getRange(2, 11, 1000, 1).setValues(opsData);
        }
      }
      
      Logger.log(`[Fila ${idx + 1}] "${clientName}" — Dropdowns actualizados a Exceptuar/Considerar.`);
      arregladas++;
    } catch (e) {
      Logger.log(`[Fila ${idx + 1}] ERROR en "${clientName}": ${e.message}`);
    }
  });
  Logger.log(`Total actualizado: ${arregladas}`);
}

// =================================================================
// GESTIÓN MANUAL DE FERIADOS / FALLBACK
// =================================================================

/**
 * Destraba los frenos de feriado forzando la fecha actual como día hábil.
 * Útil cuando fallaron la API pública y Google Calendar y el sistema asumió feriado por precaución.
 * La marca vence sola al terminar el día.
 */
function manual_forzarDiaHabil() {
  const ahora = new Date();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const dia = String(ahora.getDate()).padStart(2, '0');
  const hoyStr = `${ahora.getFullYear()}-${mes}-${dia}`;

  PropertiesService.getScriptProperties().setProperty("FORZAR_DIA_HABIL", hoyStr);
  Logger.log(`✅ [Día Hábil Forzado] Se marcó la fecha ${hoyStr} como día hábil.`);
  Logger.log(`   Ahora podés ejecutar "iniciarDiaOperativo()" o "ejecutarCicloDeOperaciones()" y todos los auditores operarán con normalidad.`);
}

/**
 * Elimina la marca de día hábil forzado.
 */
function manual_desactivarForzarDiaHabil() {
  PropertiesService.getScriptProperties().deleteProperty("FORZAR_DIA_HABIL");
  Logger.log("🗑️ [Día Hábil Forzado] Marca eliminada. El sistema vuelve a la detección normal de feriados.");
}

/**
 * Envía el mensaje de prueba de "falla de feriados" directamente al canal mock de Slack
 * (SLACK_WEBHOOK_MOCK_TAREAS_PROGRAMADAS o SLACK_WEBHOOK_GENERAL) para validar cómo lo ve el equipo.
 */
function manual_probarAvisoFeriadoEnMockSlack() {
  const props = PropertiesService.getScriptProperties();
  const webhookMock = props.getProperty("SLACK_WEBHOOK_MOCK_TAREAS_PROGRAMADAS")
    || props.getProperty("SLACK_WEBHOOK_GENERAL");

  if (!webhookMock) {
    Logger.log("❌ Error: No se encontró webhook configurado en SLACK_WEBHOOK_MOCK_TAREAS_PROGRAMADAS ni SLACK_WEBHOOK_GENERAL.");
    return false;
  }

  const aviso =
    `🧪 *[PRUEBA / SIMULACIÓN] Alerta de Operaciones: No se pudo identificar si hoy es feriado o no.*\n` +
    `• *Causa:* Falló la consulta a la API pública de feriados y falló la lectura del Google Calendar de respaldo.\n` +
    `• *Acción preventiva:* Se asume por precaución que *HOY ES FERIADO* para no procesar tareas en un día no laborable por error.\n\n` +
    `👉 *¿Hoy es un día hábil normal?*\n` +
    `Para desbloquear los frenos y procesar el día, ejecutá desde el editor de Apps Script:\n` +
    `1️⃣ \`manual_forzarDiaHabil()\` (destraba los frenos de feriados para toda la jornada)\n` +
    `2️⃣ \`iniciarDiaOperativo()\` (o \`ejecutarCicloDeOperaciones()\` para lanzar el procesamiento de correos ya mismo)`;

  Logger.log("Enviando mensaje de prueba a mock-tareas-programadas...");
  const resultado = sendSlackMessage(webhookMock, aviso);
  Logger.log("Resultado envío: " + (resultado ? "Éxito (200)" : "Revisar logs"));
  return resultado;
}

// =================================================================
// AUDITORÍA DE VENCIMIENTO DE EXCEPCIONES
// =================================================================

/**
 * Ejecuta la auditoría de excepciones en modo manual (forzando ejecución
 * sin importar el día de la semana) y emite los resultados por Logger.
 */
function manual_auditarVencimientoExcepciones() {
  Logger.log("=== EJECUTANDO AUDITORÍA MANUAL DE EXCEPCIONES ===");
  const res = auditarVencimientoExcepciones({ forzar: true, soloLog: false });
  Logger.log("=== RESULTADO AUDITORÍA ===");
  Logger.log(`Planillas auditadas: ${res.totalPlanillas}`);
  Logger.log(`Pestañas auditadas: ${res.totalPestanas}`);
  Logger.log(`Excepciones analizadas: ${res.totalExcepciones}`);
  Logger.log(`Ya vencidas: ${res.vencidas ? res.vencidas.length : 0}`);
  Logger.log(`Próximas a vencer (7 días): ${res.proximasAVencer ? res.proximasAVencer.length : 0}`);
  return res;
}

/**
 * Ejecuta la auditoría de excepciones forzada y envía el aviso al canal de pruebas (Slack mock).
 */
function manual_probarAuditorExcepcionesEnSlack() {
  return probarAuditorExcepcionesEnSlack();
}

/**
 * Configura el activador para que la auditoría corra automáticamente
 * todos los viernes a las 09:00 AM.
 */
function manual_configurarActivadorVencimientoExcepciones() {
  configurarActivadorAuditorExcepciones();
}

/**
 * Elimina el activador semanal de auditoría de excepciones si ya no se requiere.
 */
function manual_eliminarActivadorVencimientoExcepciones() {
  eliminarActivadorAuditorExcepciones();
}

/**
 * Diagnóstico del estado semanal de RVTools que muestra "Envíos de Hoy": por cada cliente,
 * qué resolvió (ok / pendiente / falta / sin dato) y por qué. Mismo cálculo que el dashboard
 * (webapp_obtenerEstadoRVTools), sin caché. No escribe nada ni manda nada.
 */
function manual_diagnosticarRVToolsSemanal() {
  const estado = webapp_obtenerEstadoRVTools(true);
  Logger.log('=== RVTools semanal — calculado ' + estado.calculadoA + ' ===');
  if (estado.error) Logger.log('🔥 ' + estado.error);
  const iconos = { ok: '✅', pendiente: '⏳', falta: '❌', sin_dato: '❔' };
  Object.keys(estado.clientes).sort().forEach(function (cliente) {
    const c = estado.clientes[cliente];
    Logger.log((iconos[c.estado] || '?') + ' ' + cliente + ' -> ' + c.estado + ' | ' + c.detalle);
  });
}

/**
 * Diagnóstico de "Operador" y de los envíos a mano en el dashboard. Muestra los datos reales
 * en vez de suponer: con qué cuenta corre, qué hay hoy en la columna K del log, qué mails de
 * operaciones con alarmas@ en copia encuentra Gmail y por qué toma o descarta cada uno.
 *
 * Correrlo logueado con la MISMA cuenta que el web app (la de arriba a la derecha del
 * dashboard): la búsqueda de Gmail mira la casilla de quien ejecuta.
 *
 * Solo lee, salvo el último paso: fuerza la misma sincronización de envíos a mano que hace el
 * dashboard al tocar Actualizar (agrega a "Envíos Manuales" lo que falte).
 */
function manual_diagnosticarOperadorYEnviosManuales() {
  const tz = HORARIO_OPERATIVO_TZ;
  const hoyISO = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  Logger.log('=== Cuenta que ejecuta: ' + Session.getEffectiveUser().getEmail() + ' | hoy ' + hoyISO + ' ===');

  // 1) Columna K del log de producción
  const ss = SpreadsheetApp.openById(WEBAPP_LOGS_PROD_ID);
  const log = ss.getSheetByName(LOG_MAILS_TAB_NAME);
  const ultCol = log.getLastColumn();
  Logger.log('\n--- "Envío de Mails": ' + ultCol + ' columnas; encabezado K = "' + (ultCol >= 11 ? log.getRange(1, 11).getValue() : '(no existe)') + '"');
  const n = log.getLastRow() - 1;
  if (n > 0) {
    const desde = Math.max(2, log.getLastRow() - 300);
    const filas = log.getRange(desde, 1, log.getLastRow() - desde + 1, Math.max(ultCol, 6)).getValues();
    const horas = log.getRange(desde, 2, log.getLastRow() - desde + 1, 1).getDisplayValues();
    let hoy = 0;
    filas.forEach(function (r, i) {
      if (_webappFechaISO(r[0]) !== hoyISO) return;
      hoy++;
      Logger.log('   ' + horas[i][0] + ' | ' + r[3] + ' | ' + r[4] + ' | operador(K): "' + (ultCol >= 11 ? r[10] : '') + '"');
    });
    Logger.log('   -> ' + hoy + ' fila(s) de hoy.');
  }

  // 2) Lo que ve Gmail
  const desdeBusqueda = Utilities.formatDate(new Date(Date.now() - 3 * 86400000), tz, 'yyyy/MM/dd');
  const consulta = 'cc:' + WEBAPP_CASILLA_CC_MANUALES + ' from:' + WEBAPP_DOMINIO_OPERADORES.substring(1) +
    ' subject:Operaciones subject:Wetcom after:' + desdeBusqueda;
  const tab = ss.getSheetByName(WEBAPP_TAB_ENVIOS_MANUALES);
  const ids = {};
  if (tab && tab.getLastRow() > 1) tab.getRange(2, 9, tab.getLastRow() - 1, 1).getValues().forEach(function (r) { ids[String(r[0])] = true; });
  Logger.log('\n--- Gmail: ' + consulta);
  Logger.log('   Pestaña "' + WEBAPP_TAB_ENVIOS_MANUALES + '": ' + (tab ? (tab.getLastRow() - 1) + ' fila(s)' : 'NO EXISTE'));
  const hilos = GmailApp.search(consulta, 0, 50);
  Logger.log('   ' + hilos.length + ' hilo(s) encontrados.');
  hilos.forEach(function (h) {
    h.getMessages().forEach(function (m) {
      const de = _webappEmailDe(m.getFrom());
      const destinos = (String(m.getCc() || '') + ',' + String(m.getTo() || '')).toLowerCase();
      const p = _webappParsearAsuntoOperaciones(m.getSubject());
      let motivo = 'SE TOMA';
      if (!de.endsWith(WEBAPP_DOMINIO_OPERADORES) || de === WEBAPP_CASILLA_CC_MANUALES) motivo = 'descartado: remitente ' + de;
      else if (destinos.indexOf(WEBAPP_CASILLA_CC_MANUALES) === -1) motivo = 'descartado: alarmas@ no está en Para/CC';
      else if (!p) motivo = 'descartado: el asunto no se reconoce';
      Logger.log('   ' + Utilities.formatDate(m.getDate(), tz, 'dd/MM HH:mm') + ' | ' + de + ' | "' + m.getSubject() + '"' +
        '\n      -> ' + motivo + (p ? ' [' + p.empresa + ' / ' + p.tecnologia + ' / ' + p.estado + ']' : '') +
        (ids[m.getId()] ? ' (ya registrado)' : ''));
    });
  });

  // 3) La sincronización real, forzada
  try {
    const r = _webappSincronizarEnviosManuales(WEBAPP_LOGS_PROD_ID, true);
    Logger.log('\n--- Sincronización forzada: ' + JSON.stringify(r));
  } catch (e) {
    Logger.log('\n--- Sincronización forzada FALLÓ: ' + e.message + '\n' + e.stack);
  }
}

/**
 * Por qué un envío quedó sin operador. Solo lee: no escribe ni manda nada.
 *
 * Muestra la pestaña oculta "_Operadores" del Índice real (lo que anota el activador
 * registrarOperadorAlTildar y el dashboard al tildar) y la cruza con las casillas R/S/T/U que
 * hoy están tildadas. Si la casilla está tildada y no hay fila en "_Operadores", el problema
 * está en el activador del Índice (e.user vacío o el activador no corrió), no en el dashboard.
 */
function manual_diagnosticarTildesSinOperador() {
  const tz = HORARIO_OPERATIVO_TZ;
  const COLS = { 18: "R vSphere", 19: "S Veeam", 20: "T Nutanix", 21: "U RVTools" };
  const ss = SpreadsheetApp.openById(WEBAPP_INDICE_SPREADSHEET_ID);
  const hoja = ss.getSheetByName("Sheet1") || ss.getSheets()[0];
  Logger.log('=== Índice: "' + ss.getName() + '" | ejecuta ' + Session.getEffectiveUser().getEmail() + " ===");

  // 1) La pestaña oculta con los tildes anotados
  const tabOp = ss.getSheetByName("_Operadores");
  Logger.log('\n--- Pestaña "_Operadores": ' + (tabOp ? (tabOp.getLastRow() - 1) + " fila(s)" : "NO EXISTE (nunca se anotó ningún tilde)"));
  const anotados = {};
  if (tabOp && tabOp.getLastRow() > 1) {
    tabOp.getRange(2, 1, tabOp.getLastRow() - 1, 5).getValues().forEach(function (r) {
      anotados[r[0] + "|" + r[1]] = r;
      Logger.log("   fila " + r[0] + " · " + (COLS[r[1]] || "col " + r[1]) + " · " + r[2] +
        " -> " + r[3] + " (" + (r[4] instanceof Date ? Utilities.formatDate(r[4], tz, "dd/MM HH:mm:ss") : r[4]) + ")");
    });
  }

  // 2) Las casillas que están tildadas ahora mismo
  Logger.log("\n--- Casillas tildadas en este momento:");
  const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, 25).getValues();
  let tildadas = 0;
  let sinAnotar = 0;
  datos.forEach(function (fila, i) {
    const nroFila = i + 2;
    Object.keys(COLS).forEach(function (col) {
      if (fila[Number(col) - 1] !== true) return;
      tildadas++;
      const r = anotados[nroFila + "|" + col];
      if (!r) sinAnotar++;
      Logger.log("   fila " + nroFila + " · " + COLS[col] + " · " + fila[11] +
        (r ? " -> operador " + r[3] : "  ⚠️ SIN OPERADOR ANOTADO"));
    });
  });
  Logger.log("   -> " + tildadas + " casilla(s) tildada(s), " + sinAnotar + " sin operador anotado.");

  // 3) El activador que tiene que anotarlos vive en el proyecto del Índice, no acá: desde este
  //    lado solo se puede ver el resultado. Si hay tildes sin anotar, revisar sus ejecuciones.
  Logger.log('\nSi hay casillas tildadas sin operador, mirar las ejecuciones de "registrarOperadorAlTildar"' +
    ' en el proyecto BotonCheckBox: el log dice "[Operador] El evento no trae usuario" cuando e.user viene vacío.');
}

// El botón "Run" del editor no deja pasar parámetros: para mirar un reporte en detalle se
// escribe acá el remitente (ej. "vro@bancosantacruz.com") y se corre
// manual_diagnosticarUnidadesSnapshots. Vacío = resumen de los últimos 20 reportes.
let MANUAL_UNIDADES_SNAPSHOTS_REMITENTE = "vRealize@bancosantafe.com.ar";

// Con un remitente cargado arriba, acá va el nombre (o parte) de una VM para ver TODAS sus
// columnas y contrastarlas contra vCenter. Vacío = no se busca ninguna VM en particular.
let MANUAL_UNIDADES_SNAPSHOTS_VM = "NBSFVEEAMPXY04";

/**
 * Qué trae realmente la columna de tamaño del reporte de "VMs con snapshots". Solo lee: no
 * manda mails, no toca Jira ni escribe en ninguna planilla.
 *
 * Hace falta porque parseSpaceToGB (VMsConSnapshots.js) decide la unidad mirando el texto: si
 * el valor dice TB/MB/KB convierte, y si no dice nada lo toma como GB. Si el reporte viniera
 * en MB sin aclararlo, los umbrales se estarían comparando contra un número ~1024 veces más
 * grande. Esto muestra los valores crudos para saber cuál de los dos casos es.
 *
 * Sin parámetros recorre los últimos reportes de todos los clientes y deja un resumen de una
 * línea por cada uno, para ubicar cuál es el que viene raro sin saber de antemano el cliente.
 * Con un remitente muestra además los valores fila por fila de ese reporte.
 *
 * @param {string} [remitente] Opcional, ej. "@bancomacro.com.ar".
 */
function manual_diagnosticarUnidadesSnapshots(remitente) {
  remitente = remitente || MANUAL_UNIDADES_SNAPSHOTS_REMITENTE;
  const consulta = 'subject:"' + SNAPSHOTS_EMAIL_SUBJECT + '" has:attachment' +
    (remitente ? ' from:' + remitente : '');
  // 20 no alcanzaba para ver a todos los clientes: algunos (Banco de Entre Ríos) mandan menos
  // seguido y quedaban fuera de la ventana.
  const cuantos = remitente ? 1 : 60;
  Logger.log("--- Buscando: " + consulta);
  const hilos = GmailApp.search(consulta, 0, cuantos);
  if (hilos.length === 0) {
    Logger.log("No se encontró ningún correo con ese asunto.");
    return;
  }
  Logger.log(hilos.length + " reporte(s) a revisar.\n");

  const resumen = [];
  hilos.forEach(function (hilo) {
    const mensajes = hilo.getMessages();
    const mensaje = mensajes[mensajes.length - 1];
    const adjunto = mensaje.getAttachments().filter(function (a) {
      return a.getName().toLowerCase().indexOf(SNAPSHOTS_FILENAME_MATCH.toLowerCase()) !== -1;
    })[0] || mensaje.getAttachments()[0];
    const de = mensaje.getFrom();
    if (!adjunto) {
      resumen.push(de + " -> el correo no tiene adjuntos");
      return;
    }

    // Mismo parseo que usa el processor (parseCsvDeReporte, centralizado en
    // DataProcessingService.js): así lo que se ve acá es exactamente lo que ve la operación.
    let filas;
    try {
      filas = parseCsvDeReporte(adjunto.getDataAsString("UTF-8"));
    } catch (e) {
      resumen.push(de + " -> no se pudo parsear: " + e.message);
      return;
    }
    if (!filas || filas.length < 2) {
      resumen.push(de + ' -> "' + adjunto.getName() + '" vino vacío o no es CSV');
      return;
    }

    const encabezados = filas[0].map(function (h) { return String(h).trim(); });
    const buscar = function (parte) {
      return encabezados.findIndex(function (h) { return h.toLowerCase().indexOf(parte.toLowerCase()) !== -1; });
    };
    const iNombre = buscar("Name");
    const iEspacio = buscar("Snapshot_Space") !== -1 ? buscar("Snapshot_Space") : buscar("Space");
    const iTotal = buscar("Total_Capacity") !== -1 ? buscar("Total_Capacity") : buscar("Capacity");

    if (iEspacio === -1) {
      resumen.push(de + " -> sin columna de tamaño. Encabezados: " + encabezados.join(" | "));
      return;
    }

    // La última fila suele ser el total del reporte: no es una VM, no se cuenta.
    const datos = filas.slice(1, filas.length - 1).filter(function (f) {
      return String(f[iEspacio] === undefined ? "" : f[iEspacio]).trim() !== "";
    });
    let conUnidad = 0;
    const unidades = {};
    datos.forEach(function (f) {
      const crudo = String(f[iEspacio]);
      const u = crudo.match(/(TB|GB|MB|KB)/i);
      if (u) { conUnidad++; unidades[u[1].toUpperCase()] = (unidades[u[1].toUpperCase()] || 0) + 1; }
    });
    const sinUnidad = datos.length - conUnidad;
    const detalle = Object.keys(unidades).map(function (u) { return unidades[u] + " en " + u; }).join(", ");

    // La unidad no viene escrita en el valor, pero a veces sí en el nombre de la columna
    // ("Snapshot Space (GB)"). Y el tamaño de un snapshot no puede superar la capacidad del
    // disco: si lo supera, el número no está en la misma unidad que la capacidad.
    const unidadEnEncabezado = (encabezados[iEspacio].match(/\((TB|GB|MB|KB)\)/i) || [])[1];
    // parseTamanoAGB (core/DataProcessingService.js) es la MISMA función con la que la
    // operación decide si alerta. Antes acá había una cuenta propia que leía "10,239.75" como
    // 10.239 y marcaba un problema inexistente (AGENTS.md §5: una sola implementación).
    let mayor = -1;
    let capacidadDelMayor = "";
    datos.forEach(function (f) {
      const n = parseTamanoAGB(f[iEspacio]);
      if (n > mayor) {
        mayor = n;
        capacidadDelMayor = iTotal !== -1 ? String(f[iTotal]) : "";
      }
    });
    const capNum = parseTamanoAGB(capacidadDelMayor);
    let alerta = "";
    if (capNum > 0 && mayor > capNum) {
      alerta = "  ⚠️ el mayor (" + mayor + ") supera la capacidad total (" + capNum + "): no están en la misma unidad";
    }

    resumen.push(de + ' | col "' + encabezados[iEspacio] + '"' +
      (unidadEnEncabezado ? " [el encabezado dice " + unidadEnEncabezado.toUpperCase() + "]" : " [el encabezado no dice la unidad]") +
      " | " + datos.length + " fila(s): " +
      (conUnidad ? detalle : "") + (conUnidad && sinUnidad ? " y " : "") +
      (sinUnidad ? sinUnidad + " SIN unidad (se toman como GB)" : "") +
      ' | ejemplo: "' + (datos.length ? datos[0][iEspacio] : "-") + '" | mayor: ' + mayor +
      (capacidadDelMayor ? " (capacidad total de esa VM: " + capacidadDelMayor + ")" : "") + alerta);

    if (remitente) {
      Logger.log('De: ' + de + '\nAsunto: "' + mensaje.getSubject() + '"\nAdjunto: "' + adjunto.getName() + '"');
      Logger.log("\n--- Encabezados ---");
      encabezados.forEach(function (h, i) { Logger.log("   [" + i + '] "' + h + '"'); });

      // Con una VM elegida se muestran TODAS sus columnas. Sirve para contrastar contra lo que
      // muestra vCenter: si el tamaño real aparece en otra columna, el script está leyendo la
      // equivocada; si no aparece en ninguna, el dato ya viene mal del cliente.
      const vm = String(MANUAL_UNIDADES_SNAPSHOTS_VM || "").trim().toLowerCase();
      if (vm && iNombre !== -1) {
        const encontradas = datos.filter(function (f) {
          return String(f[iNombre]).toLowerCase().indexOf(vm) !== -1;
        });
        Logger.log('\n--- Fila(s) completas de "' + MANUAL_UNIDADES_SNAPSHOTS_VM + '": ' + encontradas.length + " encontrada(s) ---");
        encontradas.slice(0, 5).forEach(function (f, n) {
          Logger.log("   --- coincidencia " + (n + 1) + " ---");
          encabezados.forEach(function (h, i) {
            Logger.log('      "' + h + '" = "' + (f[i] === undefined ? "" : f[i]) + '"');
          });
        });
        if (!encontradas.length) Logger.log("   (esa VM no está en este reporte)");
      }

      Logger.log('\n--- Valores crudos de "' + encabezados[iEspacio] + '" (hasta 20 filas) ---');
      datos.slice(0, 20).forEach(function (f) {
        const crudo = String(f[iEspacio]);
        Logger.log('   ' + (iNombre !== -1 ? String(f[iNombre]).substring(0, 30) : "?") +
          ' | tamaño: "' + crudo + '"' + (/[a-z]/i.test(crudo) ? "  (trae unidad)" : "  (SIN unidad -> se toma como GB)") +
          (iTotal !== -1 ? ' | capacidad total: "' + f[iTotal] + '"' : ""));
      });
    }
  });

  Logger.log("\n=== RESUMEN POR REPORTE ===");
  resumen.forEach(function (l) { Logger.log("   " + l); });
  Logger.log('\nLos que digan "SIN unidad" se están comparando contra los umbrales como si fueran GB.' +
    "\nSi alguno de esos en realidad viene en MB, sus alertas de tamaño están mal.");
}

// Cliente a simular: remitente del reporte. Ej. "vRealize@bancosantafe.com.ar".
let MANUAL_SIMULAR_SNAPSHOTS_REMITENTE = "vRealize@bancosantafe.com.ar";

/**
 * Corre la evaluación de "VMs con snapshots" sobre el último reporte real de un cliente y
 * muestra la tabla que iría al ticket, SIN crear ni comentar nada en Jira y sin mandar
 * ningún correo.
 *
 * Es seguro por construcción: llama únicamente a processData(), que solo lee la planilla de
 * excepciones y calcula. Todo lo que escribe en Jira vive en handleAlerts(), que acá no se
 * invoca. Tampoco marca correos como leídos ni los mueve de etiqueta.
 */
function manual_simularTicketSnapshots() {
  const remitente = String(MANUAL_SIMULAR_SNAPSHOTS_REMITENTE || "").trim();
  if (!remitente) {
    Logger.log("Cargá un remitente en MANUAL_SIMULAR_SNAPSHOTS_REMITENTE.");
    return;
  }

  const hilos = GmailApp.search('subject:"' + SNAPSHOTS_EMAIL_SUBJECT + '" has:attachment from:' + remitente, 0, 1);
  if (!hilos.length) {
    Logger.log("No se encontró ningún reporte de " + remitente);
    return;
  }
  const mensajes = hilos[0].getMessages();
  const mensaje = mensajes[mensajes.length - 1];
  const adjunto = mensaje.getAttachments().filter(function (a) {
    return a.getName().toLowerCase().indexOf(SNAPSHOTS_FILENAME_MATCH.toLowerCase()) !== -1;
  })[0] || mensaje.getAttachments()[0];
  if (!adjunto) {
    Logger.log("El correo no tiene adjuntos.");
    return;
  }
  Logger.log('De: ' + mensaje.getFrom() + ' | ' + Utilities.formatDate(mensaje.getDate(), HORARIO_OPERATIVO_TZ, "dd/MM/yyyy HH:mm") +
    '\nAdjunto: "' + adjunto.getName() + '"');

  const filas = parseCsvDeReporte(adjunto.getDataAsString("UTF-8"));
  if (!filas || filas.length < 2) {
    Logger.log("El reporte vino sin filas (ninguna VM con snapshots).");
    return;
  }

  const remitenteReal = _webappEmailDe ? _webappEmailDe(mensaje.getFrom()) : remitente;
  const config = getClientConfig(remitenteReal, SNAPSHOTS_OPERATION_NAME) ||
    getClientConfig(remitente, SNAPSHOTS_OPERATION_NAME);
  if (!config) {
    Logger.log("No se encontró configuración de cliente para " + remitenteReal);
    return;
  }
  config.senderEmail = remitenteReal;
  Logger.log("Cliente: " + config.clientName + " | Proyecto Jira: " + config.jiraProjectKey);

  const procesador = new VMsConSnapshotsProcessor();
  procesador._currentSenderEmail = remitenteReal;
  const reporte = { errores: [], advertencias: [], exitos: [] };
  const r = procesador.processData(filas, config, reporte);
  if (!r) {
    Logger.log("processData no devolvió nada. Errores: " + JSON.stringify(reporte.errores));
    return;
  }

  Logger.log("\n=== LO QUE IRÍA AL TICKET (simulación, no se creó nada) ===");
  Logger.log("Encabezados: " + r.headers.join(" | "));
  Logger.log("\nOperaciones: " + (procesador.opsAlerts || []).length + " VM(s)");
  if (procesador.opsReasonsText) Logger.log(procesador.opsReasonsText);
  (procesador.opsAlerts || []).slice(0, 10).forEach(function (f) { Logger.log("   " + f.join(" | ")); });

  Logger.log("\nSoporte: " + (procesador.soporteAlerts || []).length + " VM(s)");
  if (procesador.soporteReasonsText) Logger.log(procesador.soporteReasonsText);
  (procesador.soporteAlerts || []).slice(0, 10).forEach(function (f) { Logger.log("   " + f.join(" | ")); });

  const iTam = r.headers.indexOf(SNAPSHOTS_COLUMNA_TAMANO);
  Logger.log('\nColumna "' + SNAPSHOTS_COLUMNA_TAMANO + '" en la posición ' + iTam +
    (iTam === -1 ? "  ⚠️ NO SE AGREGÓ" : ""));
  Logger.log("\nNo se creó ni se comentó ningún ticket, y no se envió ningún correo.");
}

// =================================================================
// RVTools: salud de los archivos subidos a Drive
// =================================================================

// Cliente a revisar a fondo (nombre o parte, como figura en el Índice). Vacío = solo el
// listado rápido de todos, sin abrir ningún archivo.
let MANUAL_RVTOOLS_CLIENTE_A_ABRIR = "";

/**
 * Cómo están los archivos de RVTools que hay hoy en Drive. Solo lee.
 *
 * Recorre la carpeta más reciente de cada cliente y lista los archivos con su tamaño y tipo.
 * Sirve para dos cosas: ver si alguno quedó roto, y medir cuánto pesa un RVTools sano para
 * poder fijar después un umbral con fundamento en vez de inventarlo.
 *
 * Con MANUAL_RVTOOLS_CLIENTE_A_ABRIR cargado, además ABRE los archivos de ese cliente
 * (copia temporal a Google Sheets, igual que procesarRVToolsManual) y verifica que estén las
 * pestañas que la automatización necesita. La copia temporal se borra siempre.
 */
function manual_diagnosticarArchivosRVTools() {
  const filas = _rvtoolsLeerFilasIndice(WEBAPP_INDICE_SPREADSHEET_ID);
  if (!filas) {
    Logger.log("No se pudo leer el Índice.");
    return;
  }
  const aAbrir = String(MANUAL_RVTOOLS_CLIENTE_A_ABRIR || "").trim().toLowerCase();
  Logger.log("=== Archivos de RVTools por cliente (" + filas.length + " clientes en el Índice) ===");
  if (aAbrir) Logger.log('Se van a ABRIR los archivos de los clientes que contengan "' + MANUAL_RVTOOLS_CLIENTE_A_ABRIR + '".\n');

  const resumen = [];
  filas.forEach(function (fila) {
    if (!fila.folderId) {
      resumen.push(fila.cliente + " -> sin link de carpeta en el Índice");
      return;
    }
    let carpeta;
    try {
      carpeta = encontrarCarpetaMasReciente(DriveApp.getFolderById(fila.folderId));
    } catch (e) {
      resumen.push(fila.cliente + " -> no se pudo abrir la carpeta: " + e.message);
      return;
    }
    if (!carpeta) {
      resumen.push(fila.cliente + " -> sin subcarpetas con formato de fecha");
      return;
    }

    const archivos = [];
    const it = carpeta.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      archivos.push({
        nombre: f.getName(),
        bytes: f.getSize(),
        tipo: f.getMimeType(),
        actualizado: Utilities.formatDate(f.getLastUpdated(), HORARIO_OPERATIVO_TZ, "dd/MM/yyyy HH:mm"),
        id: f.getId()
      });
    }
    const planillas = archivos.filter(function (a) {
      return /\.(xlsx|xlsm)$/i.test(a.nombre);
    });

    Logger.log("\n--- " + fila.cliente + " | carpeta: " + carpeta.getName() + " ---");
    if (!archivos.length) {
      Logger.log("   (la carpeta está VACÍA)");
      resumen.push(fila.cliente + " -> ⚠️ carpeta " + carpeta.getName() + " VACÍA");
      return;
    }
    archivos.forEach(function (a) {
      Logger.log("   " + a.nombre + "  |  " + rvtoolsTamanoLegible(a.bytes) + "  |  " + a.tipo + "  |  " + a.actualizado);
    });
    if (!planillas.length) {
      resumen.push(fila.cliente + " -> ⚠️ carpeta " + carpeta.getName() + " sin .xlsx/.xlsm (" + archivos.length + " archivo(s))");
      return;
    }
    const menor = planillas.reduce(function (a, b) { return a.bytes <= b.bytes ? a : b; });
    resumen.push(fila.cliente + " -> " + planillas.length + " planilla(s), la más chica " +
      rvtoolsTamanoLegible(menor.bytes) + " (" + menor.nombre + ")" + (menor.bytes === 0 ? "  ⚠️ 0 BYTES" : ""));

    // Verificación profunda, solo para el cliente elegido.
    if (aAbrir && fila.cliente.toLowerCase().indexOf(aAbrir) !== -1) {
      planillas.forEach(function (a) {
        Logger.log("   >>> Abriendo " + a.nombre + "...");
        Logger.log("       " + rvtoolsVerificarPlanilla(a.id, a.nombre).detalle);
      });
    }
  });

  Logger.log("\n=== RESUMEN ===");
  resumen.forEach(function (l) { Logger.log("   " + l); });
}


// Remitente del correo de Malware Detection a simular, cuando hay mas de un cliente mandando
// y se quiere mirar uno puntual (ej. "veeam@cliente.com"). Vacio = el correo mas reciente,
// venga de quien venga.
let MANUAL_MALWARE_REMITENTE = "";

/**
 * Muestra el ticket que se crearia con el ultimo correo de Malware Detection, SIN crear ni
 * comentar nada en Jira y sin mandar correos.
 *
 * Solo llama a processData(), que lee la planilla de excepciones y calcula. Todo lo que
 * escribe en Jira vive en handleAlerts(), que aca no se invoca.
 */
function manual_simularTicketMalware() {
  const remitente = String(MANUAL_MALWARE_REMITENTE || "").trim();
  const hilos = GmailApp.search('subject:"' + MALWARE_EMAIL_SUBJECT + '" has:attachment' +
    (remitente ? ' from:' + remitente : ''), 0, 1);
  if (!hilos.length) {
    Logger.log('No se encontro ningun correo con asunto "' + MALWARE_EMAIL_SUBJECT + '".');
    return;
  }
  const mensajes = hilos[0].getMessages();
  const mensaje = mensajes[mensajes.length - 1];
  Logger.log('De: ' + mensaje.getFrom() + ' | ' + Utilities.formatDate(mensaje.getDate(), HORARIO_OPERATIVO_TZ, "dd/MM/yyyy HH:mm"));
  Logger.log('Asunto: "' + mensaje.getSubject() + '"');

  const procesador = new MalwareDetectionProcessor();
  const reporte = { errores: [], advertencias: [], exitos: [] };

  const adjunto = procesador.findAttachment(mensaje);
  if (!adjunto) {
    Logger.log("El correo no trae ningun .log adjunto.");
    return;
  }
  Logger.log("Adjuntos .log: " + procesador.logsDelCorreo.map(function (b) { return b.getName(); }).join(", "));

  // Sin depender de _webappEmailDe: esa funcion vive en la carpeta webapp, que existe en
  // Playground pero NO en Operativo, y alla esta linea tiraba ReferenceError.
  const emailRemitente = (String(mensaje.getFrom()).match(/[\w.+-]+@[\w.-]+/) || [remitente])[0];
  const config = getClientConfig(emailRemitente, MALWARE_OPERATION_NAME);
  if (!config) {
    Logger.log("No se encontro configuracion de cliente para " + emailRemitente +
      '. Revisar que exista la pestaña "' + MALWARE_OPERATION_NAME + '" en la planilla de excepciones.');
    return;
  }
  config.senderEmail = emailRemitente;
  Logger.log("Cliente: " + config.clientName + " | Proyecto Jira: " + config.jiraProjectKey);
  Logger.log("Excepciones cargadas: " + Object.keys(config.exceptions || {}).length + " regla(s)");

  const detecciones = procesador.parseAttachment(adjunto, reporte);
  const r = procesador.processData(detecciones, config, reporte);
  if (!r) {
    Logger.log("processData no devolvio nada. Errores: " + JSON.stringify(reporte.errores));
    return;
  }

  Logger.log("\n=== DESCRIPCION DEL TICKET (si se creara hoy) ===");
  Logger.log(procesador.descripcionDelTicket(r.finalAlerts.length, config, r.headers, r.finalAlerts));

  Logger.log("\n=== COMENTARIO (si el ticket ya existiera) ===");
  Logger.log(procesador.textoProblemaPersiste(r.finalAlerts.length, config, r.headers, r.finalAlerts));

  Logger.log("\n=== ADJUNTO: " + r.finalAlerts.length + " fila(s) ===");
  Logger.log(r.headers.join(" | "));
  r.finalAlerts.slice(0, 15).forEach(function (f) { Logger.log("   " + f.join(" | ")); });
  if (r.finalAlerts.length > 15) Logger.log("   ... y " + (r.finalAlerts.length - 15) + " mas");

  Logger.log("\nNo se creo ni se comento ningun ticket, y no se envio ningun correo.");
}

// =================================================================
// Puntualidad de los reportes que mandan los vRO / vROps de los clientes
// =================================================================

// Cuantos dias hacia atras mirar. Con 7 alcanza para ver un patron y entra comodo en el
// limite de 6 minutos de Apps Script.
let MANUAL_PUNTUALIDAD_DIAS = 7;

// A partir de esta hora un reporte se considera tarde. Es el acuerdo con el equipo: todos los
// reportes tienen que llegar automaticamente antes de las 8:30.
const PUNTUALIDAD_HORA_LIMITE_DECIMAL = 8.5;

// Cuantos asuntos entran en una misma consulta de Gmail. Buscar los 32 de a uno tardaba mas de
// los 6 minutos que da Apps Script; agrupados con OR son 4 consultas en vez de 32.
const PUNTUALIDAD_ASUNTOS_POR_CONSULTA = 8;

// Margen para cortar antes de que Apps Script mate la ejecucion a los 6 minutos. Cortar por
// las nuestras deja un resultado parcial util; que nos corte Google deja la nada.
const PUNTUALIDAD_SEGUNDOS_MAX = 260;

/**
 * A que hora llego cada reporte de cada cliente, dia por dia. Solo lee Gmail.
 *
 * El dashboard hoy solo sabe de los reportes que FALTARON (pestaña "Logs Reportes Faltantes"):
 * cuando el reporte llega bien no queda registro de a que hora. Asi no se puede detectar el
 * caso que mas importa, que es el reporte que sigue llegando pero cada vez mas tarde, porque
 * el script del cliente se degrada antes de romperse del todo.
 *
 * La hora sale del correo y no del archivo en Drive a proposito: la fecha del archivo es
 * cuando NOSOTROS lo archivamos, asi que una demora de nuestro ciclo apareceria como un
 * retraso del cliente, y mandariamos a revisar una tecnologia que esta bien.
 *
 * Agrupa por REMITENTE y no por nombre de cliente: el nombre sale del Indice Maestro, que en
 * Playground es uno de prueba con 3 clientes. El remitente identifica igual al cliente y
 * funciona en los dos proyectos.
 */
function manual_medirPuntualidadDeReportes() {
  const comenzoEn = Date.now();
  const dias = Number(MANUAL_PUNTUALIDAD_DIAS) || 7;
  const desde = new Date(Date.now() - dias * 86400000);
  const desdeStr = Utilities.formatDate(desde, HORARIO_OPERATIVO_TZ, "yyyy/MM/dd");
  const asuntos = obtenerAsuntosConProcessor();

  Logger.log("=== Puntualidad de los ultimos " + dias + " dias (desde " + desdeStr + ") ===");
  Logger.log(asuntos.length + " tipo(s) de reporte con processor propio.");

  const llegadas = {};   // "remitente | asunto" -> { dia -> hora }
  const diasVistos = {};
  let mensajes = 0;
  let cortadoPorTiempo = false;

  for (let i = 0; i < asuntos.length; i += PUNTUALIDAD_ASUNTOS_POR_CONSULTA) {
    if ((Date.now() - comenzoEn) / 1000 > PUNTUALIDAD_SEGUNDOS_MAX) {
      cortadoPorTiempo = true;
      Logger.log("⏱️ Se corto por tiempo: faltaron " + (asuntos.length - i) + " tipo(s) de reporte.");
      break;
    }
    const grupo = asuntos.slice(i, i + PUNTUALIDAD_ASUNTOS_POR_CONSULTA);
    const consulta = "(" + grupo.map(function (a) { return 'subject:"' + a + '"'; }).join(" OR ") +
      ") has:attachment after:" + desdeStr;

    let hilos;
    try {
      hilos = GmailApp.search(consulta, 0, 300);
    } catch (e) {
      Logger.log("No se pudo buscar el grupo " + (i / PUNTUALIDAD_ASUNTOS_POR_CONSULTA + 1) + ": " + e.message);
      continue;
    }
    // getMessagesForThreads trae los mensajes de TODOS los hilos de una, en vez de una llamada
    // por hilo. Es la diferencia entre entrar en los 6 minutos y no entrar.
    const porHilo = GmailApp.getMessagesForThreads(hilos);
    Logger.log("   grupo " + (i / PUNTUALIDAD_ASUNTOS_POR_CONSULTA + 1) + ": " + hilos.length + " hilo(s)");

    porHilo.forEach(function (mensajesDelHilo) {
      mensajesDelHilo.forEach(function (m) {
        const fecha = m.getDate();
        if (fecha < desde) return;
        const asuntoMsg = String(m.getSubject() || "");
        const cual = grupo.filter(function (a) { return asuntoMsg.indexOf(a) !== -1; })[0];
        if (!cual) return;   // vino en el hilo pero no es uno de los reportes de este grupo

        mensajes++;
        // 'Nombre <mail@dominio>' -> 'mail@dominio'
        const de = String(m.getFrom() || "");
        const remitente = (de.match(/<(.+)>/) || [null, de])[1].trim();
        const dia = Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, "yyyy-MM-dd");
        const hora = Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, "HH:mm");
        diasVistos[dia] = true;

        const clave = String(remitente).toLowerCase() + " | " + cual;
        if (!llegadas[clave]) llegadas[clave] = {};
        // Si el mismo reporte llega dos veces el mismo dia vale el PRIMERO: es cuando el
        // cliente cumplio. Un reenvio posterior no lo vuelve tardio.
        if (!llegadas[clave][dia] || hora < llegadas[clave][dia]) llegadas[clave][dia] = hora;
      });
    });
  }

  const claves = Object.keys(llegadas).sort();
  const diasOrdenados = Object.keys(diasVistos).sort();
  Logger.log("\n" + mensajes + " correo(s) | " + claves.length + " combinacion(es) remitente+reporte | " +
    diasOrdenados.length + " dia(s) con datos | " + ((Date.now() - comenzoEn) / 1000).toFixed(0) + " s");

  const tarde = function (h) {
    const p = String(h).split(":");
    return Number(p[0]) + Number(p[1]) / 60 > PUNTUALIDAD_HORA_LIMITE_DECIMAL;
  };

  Logger.log("\n=== HORA DE LLEGADA POR DIA ===");
  Logger.log('Limite 08:30. "!" = llego despues. "--" = no llego ese dia.');
  Logger.log("Dias: " + diasOrdenados.map(function (d) { return d.substring(5); }).join("   "));

  const tardios = [];
  const faltantes = [];
  claves.forEach(function (clave) {
    const porDia = llegadas[clave];
    const celdas = diasOrdenados.map(function (d) {
      return porDia[d] ? (tarde(porDia[d]) ? "!" : " ") + porDia[d] : " --:-- ";
    });
    Logger.log(clave + "\n   " + celdas.join("|"));

    const nTarde = diasOrdenados.filter(function (d) { return porDia[d] && tarde(porDia[d]); }).length;
    const nSin = diasOrdenados.filter(function (d) { return !porDia[d]; }).length;
    if (nTarde) tardios.push(clave + ": " + nTarde + "/" + diasOrdenados.length + " dias despues de las 8:30");
    if (nSin) faltantes.push(clave + ": no llego " + nSin + "/" + diasOrdenados.length + " dias");
  });

  Logger.log("\n=== LLEGAN TARDE ===");
  tardios.length ? tardios.forEach(function (l) { Logger.log("   " + l); }) : Logger.log("   Ninguno.");
  Logger.log("\n=== DIAS SIN LLEGAR ===");
  faltantes.length ? faltantes.slice(0, 25).forEach(function (l) { Logger.log("   " + l); }) : Logger.log("   Ninguno.");
  if (faltantes.length > 25) Logger.log("   ... y " + (faltantes.length - 25) + " mas");

  Logger.log("\nOjo: los dias incluyen sabados y domingos, en los que varios reportes no se esperan.");
  if (cortadoPorTiempo) Logger.log("⚠️ RESULTADO PARCIAL: bajar MANUAL_PUNTUALIDAD_DIAS y volver a correr.");
}
