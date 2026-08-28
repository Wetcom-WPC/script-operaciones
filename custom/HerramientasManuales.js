/**
 * =================================================================
 * HERRAMIENTAS MANUALES / DE TESTING (acceso rÃ¡pido desde el editor)
 * =================================================================
 * Funciones para ejecutar manualmente procesos desde el editor de Apps Script.
 * NO estÃ¡n conectadas a ningÃºn trigger: son para pruebas y ejecuciones puntuales.
 *
 * ConvenciÃ³n de nombres: prefijo `manual_` para que sean fÃ¡ciles de encontrar en
 * el desplegable de funciones del editor.
 *
 * âš ï¸ IMPORTANTE: varias de estas funciones ejecutan acciones reales (Jira/Gmail/Drive).
 * VerificÃ¡ que la Script Property ENVIRONMENT estÃ© en "TESTING" si no querÃ©s impactar
 * clientes reales (los envÃ­os de correo se redirigen en TESTING, ver NotificationService.js).
 * =================================================================
 */

// Cliente y carpeta de Drive usados para probar el flujo de RVTools.
// (Reemplaza al viejo hola() que estaba en RVTools_Main.js â€” C-01).
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
 * Ãštil para:
 *   - Verificar que llegan correos del script nutanix_ops_check.ps1.
 *   - Probar el flujo completo (parseo JSON â†’ evaluaciÃ³n â†’ ticket Jira) sin esperar el trigger.
 *   - Diagnosticar por quÃ© un correo quedÃ³ en [OPS-PENDIENTE].
 *
 * âš ï¸ Asegurarse de que ENVIRONMENT = "TESTING" en Script Properties si no se quiere
 *    impactar clientes reales.
 *
 * Para simular sin un correo real, usar manual_simularNutanixOps() mÃ¡s abajo.
 */
function manual_testNutanixOps() {
  Logger.log('[manual_testNutanixOps] Iniciando NutanixOpsProcessor en modo manual...');
  new NutanixOpsProcessor().processEmails();
  Logger.log('[manual_testNutanixOps] Finalizado. Revisar logs y bandeja de entrada.');
}

/**
 * Simula el procesamiento de un reporte Nutanix directamente, sin necesitar un correo real.
 *
 * Ãštil en Fase 1 de testing: permite probar la lÃ³gica GAS (processData + handleAlerts)
 * antes de tener el script PS funcionando.
 *
 * CÃ³mo usar:
 *   1. Ajustar el objeto `payloadSimulado` con los estados que querÃ©s probar.
 *   2. Asegurarse de que `clientName` coincide con un cliente en el Ãndice Maestro.
 *   3. Correr la funciÃ³n desde el desplegable del editor.
 *   4. Revisar los logs (Ctrl+Enter) para ver el resultado.
 */
function manual_simularNutanixOps() {
  // --- Ajustar este payload para simular distintos escenarios ---
  const payloadSimulado = {
    fecha:      Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd"),
    origen:     "10.0.0.1 (simulado)",
    clientName: "WPC - Operaciones Testing", // Debe existir en el Ãndice Maestro
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
    Logger.log(`[manual_simularNutanixOps] âš ï¸ No se encontrÃ³ config para "${clientName}" en el Ãndice Maestro.`);
    Logger.log('Verificar que el cliente existe y que la operaciÃ³n "Operaciones Nutanix" estÃ¡ configurada.');
    return;
  }

  Logger.log(`[manual_simularNutanixOps] Config resuelta: ${clientConfig.clientName} (${clientConfig.jiraProjectKey})`);

  const processed = processor.processData(parsedData, clientConfig, summaryReport);
  Logger.log(`[manual_simularNutanixOps] processData() â†’ ${processed.finalAlerts.length} alerta(s) derivada(s).`);
  Logger.log(`[manual_simularNutanixOps] reasonsText: ${processed.reasonsText}`);

  if (processed.finalAlerts.length === 0) {
    Logger.log('[manual_simularNutanixOps] Sin alertas â†’ handleNoAlerts() (no crea ticket).');
  } else {
    Logger.log('[manual_simularNutanixOps] Con alertas â†’ handleAlerts() â†’ crearÃ­a ticket en Jira.');
    Logger.log('âš ï¸ Para ver el ticket creado, quitar el comentario de la lÃ­nea handleAlerts() abajo.');
    // Descomentar para ejecutar el flujo completo contra Jira:
    // const existingKey = processor.findExistingTicket(clientConfig);
    // const r = processor.handleAlerts(existingKey, clientConfig, summaryReport, processed.headers, processed.finalAlerts, processed.rowsForExport, processed.reasonsText, "simulacion.json");
    // Logger.log(`handleAlerts() â†’ status: ${r.status}`);
  }

  Logger.log('[manual_simularNutanixOps] Resumen:');
  Logger.log(`  Ã‰xitos: ${summaryReport.exitos.length}`);
  Logger.log(`  Advertencias: ${summaryReport.advertencias.length}`);
  Logger.log(`  Errores: ${summaryReport.errores.length}`);
}


/**
 * AUDITORÃA (solo lectura): lista los activadores del proyecto y a quÃ© hora arranca el dÃ­a.
 *
 * Los activadores NO viven en el cÃ³digo sino en la configuraciÃ³n del proyecto de Apps Script,
 * asÃ­ que esta es la Ãºnica forma de responder "Â¿a quÃ© hora empieza a procesar?" sin abrir el
 * panel de Activadores a mano.
 */
function manual_auditarActivadores() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log(`=== ACTIVADORES DEL PROYECTO (${triggers.length}) ===`);

  triggers.forEach(function (t) {
    Logger.log(`   ${t.getHandlerFunction()}  |  tipo: ${t.getEventType()}  |  id: ${t.getUniqueId()}`);
  });

  const diarios = triggers.filter(function (t) { return t.getHandlerFunction() === 'iniciarDiaOperativo'; });
  Logger.log(`\n--- Arranque del dÃ­a ---`);
  if (diarios.length === 0) {
    Logger.log(`   ðŸš¨ NO hay ningÃºn activador para iniciarDiaOperativo: el ciclo diario NO arranca solo.`);
    Logger.log(`      EjecutÃ¡ manual_configurarActivadorDiario() para crearlo.`);
  } else if (diarios.length > 1) {
    Logger.log(`   âš ï¸ Hay ${diarios.length} activadores de iniciarDiaOperativo: se pisan entre sÃ­. EjecutÃ¡ manual_configurarActivadorDiario() para dejar uno solo.`);
  } else {
    Logger.log(`   âœ… Hay 1 activador de iniciarDiaOperativo.`);
  }
  Logger.log(`   La API no expone la hora configurada de un activador: verificala en el panel`);
  Logger.log(`   "Activadores" del editor. Debe estar en las ${HORA_INICIO - 1}hs â€” la franja de una hora de`);
  Logger.log(`   Google termina asÃ­ antes de HORA_INICIO (${HORA_INICIO}hs), y iniciarDiaOperativo agenda`);
  Logger.log(`   el arranque exacto a las ${HORA_INICIO}:00.`);

  return { total: triggers.length, diarios: diarios.length };
}

/**
 * Deja UN solo activador diario para iniciarDiaOperativo, en la franja previa a HORA_INICIO.
 *
 * âš ï¸ Modifica los activadores del proyecto. Correr una sola vez (o cuando haya que reparar la
 * configuraciÃ³n), no en cada despliegue.
 *
 * Se configura una hora ANTES de HORA_INICIO a propÃ³sito: los activadores diarios de Google se
 * disparan en algÃºn momento de una franja de una hora, asÃ­ que uno puesto a las 7 puede caer
 * 7:55. PoniÃ©ndolo a las 6, la franja 6-7 termina siempre antes de la hora deseada y es
 * iniciarDiaOperativo() quien agenda el arranque exacto a las 7:00 (ver core/Main.js).
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

  Logger.log(`âœ… Activador diario creado: iniciarDiaOperativo en la franja de las ${horaActivador}hs.`);
  Logger.log(`   El procesamiento real arranca a las ${HORA_INICIO}:00 en punto.`);
}

/**
 * Muestra si estamos dentro de la ventana operativa (05-15hs AR) y la hora detectada.
 * Ãštil para validar la guarda horaria de los triggers 24/7 (BUG-03).
 */
function manual_probarHorarioOperativo() {
  const hora = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd HH:mm:ss");
  Logger.log(`[manual_probarHorarioOperativo] Hora AR: ${hora} | Â¿Dentro de ventana operativa (${HORARIO_OPERATIVO_INICIO}-${HORARIO_OPERATIVO_FIN})? ${estaEnHorarioOperativo()}`);
}

/**
 * Archiva en Drive los reportes que ningÃºn processor reclamÃ³ (el catch-all del pipeline).
 *
 * Reemplaza a `manual_organizarReportesAhora`, que llamaba a `guardarYConvertirAdjuntosEnDrive`:
 * esa funciÃ³n desapareciÃ³ en la Etapa 2, cuando el archivado pasÃ³ a ser un paso de cada
 * processor. Para archivar el reporte de una operaciÃ³n puntual, ejecutar esa operaciÃ³n.
 */
function manual_archivarReportesSinProcessor() {
  Logger.log("[manual_archivarReportesSinProcessor] Buscando correos que ningÃºn processor reclama...");
  processReportesSinProcessorEmails();
}

/**
 * Ejecuta el procesamiento de alarmas de proxies de Veeam IGNORANDO la guarda horaria.
 */
function manual_procesarProxiesAhora() {
  Logger.log("[manual_procesarProxiesAhora] Ejecutando ProxiesVeeamProcessor (bypass de horario)...");
  new ProxiesVeeamProcessor().processEmails();
}

// Nombre de operaciÃ³n usado por defecto en manual_diagnosticarEncabezados. CambiÃ¡ este valor
// (o llamÃ¡ directo a diagnosticarEncabezadosDeReporte("Otro Nombre") desde el editor) segÃºn
// quÃ© reporte quieras inspeccionar. Debe ser el asunto EXACTO del correo (ej. "VMs operativas").
const MANUAL_DIAGNOSTICO_OPERATION_NAME = "VMs operativas";

/**
 * DiagnÃ³stico de encabezados de un reporte (envuelve diagnosticarEncabezadosDeReporte de Utils.js).
 * SpreadsheetApp.getUi() no funciona al correr con el botÃ³n "Run" del editor (requiere un
 * contexto de UI real, ej. un menÃº de hoja), por eso acÃ¡ se pasa el nombre de la operaciÃ³n
 * directamente como parÃ¡metro en vez de depender del prompt.
 */
function manual_diagnosticarEncabezados() {
  return diagnosticarEncabezadosDeReporte(MANUAL_DIAGNOSTICO_OPERATION_NAME);
}

// =================================================================
// REINTENTO DE CORREOS [OPS-ERROR]
// =================================================================

// Acota el reintento a los correos cuyo asunto contenga este texto (no distingue
// mayÃºsculas). VacÃ­o = todos los correos en [OPS-ERROR]. Ãštil para debuggear un reporte
// puntual sin disparar de nuevo el resto de los correos apartados.
//
// Es `let` y no `const` a propÃ³sito: tests/E2EReintentoErrorTest.js lo pisa temporalmente
// para acotar manual_reintentarCorreosConError() a un Ãºnico correo de prueba (por runId) sin
// tocar ningÃºn otro correo real que pueda estar en [OPS-ERROR], y lo restaura al terminar. El
// uso manual de siempre (editar este valor a mano antes de correr) sigue funcionando igual.
let MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO = "";

/**
 * Encuentra, entre los processors registrados en obtenerRegistroDeProcesadores() (Main.js),
 * el que reclama este asunto â€” mismo criterio que fetchAndFilterGlobalThreads: el asunto del
 * correo CONTIENE el emailSubject del processor. Se excluye el catch-all
 * (ReportesSinProcessor, emailSubject "") porque un correo que llegÃ³ a [OPS-ERROR] ya fue
 * reclamado por su processor real; enrutarlo al catch-all serÃ­a reprocesarlo con la lÃ³gica
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
 * Reprocesa YA MISMO, en esta misma ejecuciÃ³n, los correos apartados en [OPS-ERROR]:
 * identifica el processor que reclama cada uno (por asunto) y le corre processSingleMessage()
 * de nuevo sobre el thread real. Pensada para debuggear en el momento, despuÃ©s de corregir la
 * causa del error (config de Jira, nombre de tarea programada, etc.) â€” el Log de esta corrida
 * muestra el resultado real de cada intento, igual que verÃ­a el ciclo automÃ¡tico.
 *
 * El destino final de cada correo lo decide etiquetarYMarcarProcesado() (core/MailUtils.js),
 * la MISMA funciÃ³n que usa el ciclo automÃ¡tico, para que el comportamiento sea idÃ©ntico:
 * - SUCCESS o NO_OP -> [OPS-PROCESADO].
 * - Un fallo que amerita reintentar (ERROR, FAILURE, HTTP_500) -> vuelve a [OPS-PENDIENTE],
 *   asÃ­ el ciclo automÃ¡tico lo retoma solo. Cuenta como un reintento mÃ¡s: si ya venÃ­a
 *   acumulando intentos de antes (del ciclo automÃ¡tico, previo a caer en [OPS-ERROR]) y
 *   supera el tope de obtenerMaxReintentosPendiente() (configurable vÃ­a la Script Property
 *   "OPS_MAX_REINTENTOS_PENDIENTE"), se apartarÃ¡ de nuevo a [OPS-ERROR] en vez de quedar
 *   reintentando para siempre.
 * - Un fallo terminal (config incorrecta, tarea programada inexistente, etc.) -> se mantiene
 *   en [OPS-ERROR].
 *
 * âš ï¸ Ejecuta el pipeline real: puede crear/actualizar tickets de Jira, mandar avisos a Slack
 * y archivar en Drive (esos avisos salen en el momento, desde dentro de processSingleMessage,
 * no al final). Correr solo despuÃ©s de haber corregido el problema, o para confirmar en el
 * momento que la correcciÃ³n funcionÃ³.
 */
function manual_reintentarCorreosConError() {
  const filtro = MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO.trim().toLowerCase();
  Logger.log(`=== REPROCESAMIENTO EN VIVO DE ${OPS_LABEL_ERROR} ===`);
  if (filtro) Logger.log(`Filtro de asunto: "${MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO}"`);

  const hilos = GmailApp.search(`label:${OPS_LABEL_ERROR}`, 0, 500);
  Logger.log(`${hilos.length} hilo(s) encontrados en ${OPS_LABEL_ERROR}.`);
  if (hilos.length >= 500) {
    Logger.log(`âš ï¸ Se alcanzÃ³ el tope de 500 hilos: puede haber mÃ¡s en ${OPS_LABEL_ERROR} que esta corrida no vio.`);
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
      Logger.log(`â¸ï¸ LÃ­mite de tiempo alcanzado. El resto de los correos en ${OPS_LABEL_ERROR} queda para la prÃ³xima corrida.`);
      break;
    }

    const processor = _resolverProcessorDelAsunto(asunto);
    if (!processor) {
      Logger.log(`   âš ï¸ NingÃºn processor registrado reclama el asunto "${asunto}". Se deja en ${OPS_LABEL_ERROR}.`);
      sinProcessor++;
      continue;
    }

    Logger.log(`   â–¶ Reprocesando "${asunto}" con ${processor.constructor.name}...`);
    procesados++;

    let resultado;
    try {
      resultado = processor.processSingleMessage(message, summaryReport);
    } catch (e) {
      Logger.log(`   âŒ Error crÃ­tico reprocesando "${asunto}": ${e.message} | Stack: ${e.stack}`);
      resultado = { status: 'ERROR' };
    }

    const status = resultado ? resultado.status : 'ERROR';
    const aplicado = etiquetarYMarcarProcesado(hilo, status);

    if (aplicado.label === 'PROCESADO') {
      Logger.log(`   âœ… "${asunto}" resuelto (${status}) -> pasa a ${OPS_LABEL_PROCESADO}.`);
      resueltos++;
    } else if (aplicado.label === 'PENDIENTE') {
      Logger.log(`   ðŸ” "${asunto}" fallÃ³ con un error reintentable (${status}) -> vuelve a ${OPS_LABEL_PENDIENTE} (intento ${aplicado.intentos}/${obtenerMaxReintentosPendiente()}). Lo retoma el ciclo automÃ¡tico.`);
      vuelvenAPendiente++;
    } else {
      const motivo = aplicado.motivo === 'TOPE_REINTENTOS'
        ? `agotÃ³ ${obtenerMaxReintentosPendiente()} reintentos`
        : `fallo terminal (${status})`;
      Logger.log(`   âŒ "${asunto}" se mantiene en ${OPS_LABEL_ERROR}: ${motivo}.`);
      siguenEnError++;
    }
  }

  if (typeof flushLogs === "function") flushLogs();

  Logger.log(`\n=== RESULTADO: ${procesados} reprocesado(s) â€” ${resueltos} -> ${OPS_LABEL_PROCESADO}, ${vuelvenAPendiente} -> ${OPS_LABEL_PENDIENTE} (los retoma el ciclo automÃ¡tico), ${siguenEnError} siguen en ${OPS_LABEL_ERROR}, ${sinProcessor} sin processor identificado, ${omitidosPorFiltro.length} omitidos por filtro ===`);
  if (summaryReport.errores.length > 0) {
    Logger.log(`\n--- Detalle de errores/advertencias de esta corrida ---`);
    summaryReport.errores.forEach(e => Logger.log(`   ${e.cliente || ""} | ${e.error} | ${e.detalle || ""}`));
  }

  return { procesados, resueltos, vuelvenAPendiente, siguenEnError, sinProcessor, omitidosPorFiltro };
}

// =================================================================
// AUDITORÃA Y CIERRE DE TAREAS PROGRAMADAS
// =================================================================

/**
 * Tareas Programadas que la automatizaciÃ³n cierra al procesar el correo del reporte.
 * Se cierra ÃšNICAMENTE lo que estÃ© en esta lista: todo lo demÃ¡s (pedidos de clientes,
 * tickets [INTERNO], mantenimientos manuales como "Rotacion Credenciales") lo hace una
 * persona, y darlo por cerrado serÃ­a marcar como hecho algo que nadie hizo.
 *
 * Quedan afuera a propÃ³sito los reportes que cierra organizarReportesEnDrive
 * ("VMs protegidas", "Replicas protegidas", "Hosts y VMs con contencion de CPU",
 * "Capacity Planning", "VM Daily Protection Status", "Inventario de VMs"): esos se
 * cierran solos al correr esa funciÃ³n, que sÃ­ verifica que el archivo haya llegado.
 *
 * TambiÃ©n queda afuera "Backup por tag": no se dispara con un correo entrante sino
 * que ENVÃA un mail con archivos de Drive (enviarMailBackupPorTagDiarios), asÃ­ que
 * nunca puede tener evidencia de "reporte procesado" y la validaciÃ³n la marcarÃ­a
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

// Solo se cierran tareas en este estado. Una "En EjecuciÃ³n" puede ser trabajo real en curso.
const ESTADO_TAREA_CERRABLE = "Pendiente de EjecuciÃ³n";

/**
 * Devuelve los clientes del Ãndice Maestro con su proyecto de Jira y sus remitentes.
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
 * Trae la EVIDENCIA de quÃ© reportes se procesaron efectivamente hoy.
 *
 * Una Tarea Programada solo deberÃ­a cerrarse si su reporte llegÃ³ y se proceso. La
 * prueba de eso es el hilo de Gmail con la etiqueta [OPS-PROCESADO], que el propio
 * flujo aplica al terminar. Se hace UNA sola bÃºsqueda y se filtra en memoria para
 * no gastar cuota de Gmail.
 *
 * @returns {Array<{from: string, subject: string}>}
 */
function _obtenerReportesProcesadosHoy() {
  const hilos = GmailApp.search(`label:${OPS_LABEL_PROCESADO} newer_than:1d`, 0, 300);
  Logger.log(`[Evidencia] ${hilos.length} hilos con ${OPS_LABEL_PROCESADO} en las Ãºltimas 24 h.`);
  return hilos.map(hilo => {
    const msg = hilo.getMessages()[hilo.getMessageCount() - 1];
    return { from: msg.getFrom().toLowerCase(), subject: msg.getSubject().toLowerCase() };
  });
}

/**
 * Indica si hay evidencia de que el reporte de esa tarea, para ese cliente, se procesÃ³ hoy.
 * @param {Array<{from: string, subject: string}>} evidencia Salida de _obtenerReportesProcesadosHoy().
 * @param {Array<string>} remitentes Remitentes del cliente segÃºn el Ãndice Maestro.
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
 * Sirve para saber por quÃ© un cierre automÃ¡tico no funciona: resolveJiraTicket()
 * busca una transiciÃ³n cuyo destino se llame exactamente JIRA_STATUS_TO_CLOSE
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
 * AUDITORÃA (solo lectura, no modifica nada).
 *
 * Lista las Tareas Programadas que siguen abiertas en cada proyecto del Ãndice
 * Maestro y verifica si existe la transiciÃ³n hacia JIRA_STATUS_TO_CLOSE. Es la
 * forma rÃ¡pida de responder dos preguntas: quÃ© quedÃ³ sin cerrar, y si el cierre
 * automÃ¡tico estÃ¡ fallando porque el estado destino no se llama como esperamos.
 */
function manual_auditarTareasProgramadas() {
  const proyectos = _obtenerProyectosDelIndice();
  Logger.log(`=== AUDITORÃA DE TAREAS PROGRAMADAS ABIERTAS (${proyectos.length} proyectos) ===`);
  Logger.log(`Estado de cierre configurado (JIRA_STATUS_TO_CLOSE): "${JIRA_STATUS_TO_CLOSE}"`);

  let totalAbiertas = 0;
  const conteoPorNombre = {};
  let transicionVerificada = false;

  proyectos.forEach(({ clientName, projectKey }) => {
    const tareas = _buscarTareasProgramadasAbiertas(projectKey);
    if (tareas.length === 0) return;

    totalAbiertas += tareas.length;
    Logger.log(`\n--- ${clientName} [${projectKey}] â€” ${tareas.length} abiertas ---`);
    tareas.forEach(t => {
      Logger.log(`   ${t.key}  (${t.status})  ${t.summary}`);
      conteoPorNombre[t.summary] = (conteoPorNombre[t.summary] || 0) + 1;
    });

    // Verificamos las transiciones una sola vez, sobre la primera tarea encontrada.
    if (!transicionVerificada) {
      transicionVerificada = true;
      const destinos = _obtenerTransicionesDisponibles(tareas[0].key);
      Logger.log(`\n   [DIAGNÃ“STICO] Transiciones disponibles en ${tareas[0].key}: [${destinos.join(", ")}]`);
      if (destinos.indexOf(JIRA_STATUS_TO_CLOSE) === -1) {
        Logger.log(`   ðŸš¨ "${JIRA_STATUS_TO_CLOSE}" NO estÃ¡ entre los destinos disponibles.`);
        Logger.log(`      Por eso el cierre automÃ¡tico falla en silencio. Hay que ajustar`);
        Logger.log(`      JIRA_STATUS_TO_CLOSE (core/ConfiguracionGlobal.js) al nombre real.`);
      } else {
        Logger.log(`   âœ… La transiciÃ³n a "${JIRA_STATUS_TO_CLOSE}" existe: el cierre automÃ¡tico puede funcionar.`);
      }
    }
  });

  Logger.log(`\n=== RESUMEN: ${totalAbiertas} tareas programadas abiertas ===`);
  Object.keys(conteoPorNombre)
    .sort((a, b) => conteoPorNombre[b] - conteoPorNombre[a])
    .forEach(nombre => Logger.log(`   ${conteoPorNombre[nombre]}x  ${nombre}`));

  return { totalAbiertas, conteoPorNombre };
}

// Acota el cierre a una sola tarea (nombre EXACTO como figura en Jira). VacÃ­o = todas
// las que pasen las validaciones.
const MANUAL_CIERRE_NOMBRE_TAREA = "";

// Seguridad: en true solo simula. PonÃ© false reciÃ©n despuÃ©s de revisar la simulaciÃ³n.
const MANUAL_CIERRE_SIMULACION = true;

/**
 * Cierra Tareas Programadas cuyo reporte se procesÃ³ efectivamente hoy.
 *
 * âš ï¸ Con MANUAL_CIERRE_SIMULACION = false modifica tickets en Jira.
 *
 * Para cerrar una tarea deben cumplirse las TRES condiciones:
 *   1. Estar en TAREAS_QUE_CIERRA_LA_AUTOMATIZACION (nunca toca pedidos de clientes,
 *      tickets [INTERNO] ni mantenimientos manuales).
 *   2. Estar en estado "Pendiente de EjecuciÃ³n" (una "En EjecuciÃ³n" puede ser trabajo real).
 *   3. Tener EVIDENCIA de que el reporte llegÃ³ y se procesÃ³ hoy: un hilo de Gmail
 *      etiquetado [OPS-PROCESADO] de un remitente de ese cliente y con ese asunto.
 *
 * Sin la condiciÃ³n 3 esto serÃ­a solo un "marcar todo como hecho", que es exactamente
 * lo que no queremos: darÃ­a por cumplidas operaciones que nunca corrieron.
 */
function manual_cerrarTareasProgramadas() {
  const filtroNombre = MANUAL_CIERRE_NOMBRE_TAREA.trim().toLowerCase();
  const modo = MANUAL_CIERRE_SIMULACION ? "SIMULACIÃ“N (no se modifica nada)" : "CIERRE REAL";
  Logger.log(`=== CIERRE DE TAREAS PROGRAMADAS â€” modo: ${modo} ===`);
  if (filtroNombre) Logger.log(`Filtro de nombre: "${MANUAL_CIERRE_NOMBRE_TAREA}"`);

  const evidencia = _obtenerReportesProcesadosHoy();
  const automatizadas = TAREAS_QUE_CIERRA_LA_AUTOMATIZACION.map(t => t.toLowerCase());

  let cerradas = 0, fallidas = 0;
  const omitidas = { noAutomatizada: [], enEjecucion: [], sinEvidencia: [] };
  // CuÃ¡ntos reportes procesados hoy hay por cliente. Sirve para distinguir dos casos muy
  // distintos: "a este cliente no le llegÃ³/procesÃ³ NINGÃšN reporte" (problema del cliente o
  // del ciclo) vs "llegaron varios pero justo ese no" (el reporte puntual falta).
  const reportesPorCliente = {};

  _obtenerProyectosDelIndice().forEach(({ clientName, projectKey, remitentes }) => {
    reportesPorCliente[clientName] = evidencia.filter(e =>
      remitentes.some(r => e.from.indexOf(r) !== -1)
    ).length;

    _buscarTareasProgramadasAbiertas(projectKey).forEach(tarea => {
      const nombre = tarea.summary.trim();
      const etiqueta = `${tarea.key} â€” ${clientName} â€” ${nombre}`;

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
        Logger.log(`   âœ… ${etiqueta}`);
        cerradas++;
      } else {
        Logger.log(`   âŒ No se pudo cerrar ${etiqueta}`);
        fallidas++;
      }
    });
  });

  Logger.log(`\n=== RESULTADO: ${cerradas} ${MANUAL_CIERRE_SIMULACION ? "se cerrarÃ­an" : "cerradas"}, ${fallidas} fallidas ===`);
  Logger.log(`Omitidas por seguridad:`);
  Logger.log(`   ${omitidas.noAutomatizada.length} no las maneja la automatizaciÃ³n (las cierra una persona)`);
  Logger.log(`   ${omitidas.enEjecucion.length} en un estado distinto de "${ESTADO_TAREA_CERRABLE}"`);
  Logger.log(`   ${omitidas.sinEvidencia.length} SIN evidencia de que el reporte se haya procesado hoy`);

  if (omitidas.sinEvidencia.length > 0) {
    Logger.log(`\n--- Sin evidencia (el reporte no llegÃ³ o no se procesÃ³; revisar antes de cerrar a mano) ---`);

    // Agrupamos por cliente e informamos cuÃ¡ntos reportes SÃ se procesaron de cada uno.
    const porCliente = {};
    omitidas.sinEvidencia.forEach(({ etiqueta, clientName }) => {
      if (!porCliente[clientName]) porCliente[clientName] = [];
      porCliente[clientName].push(etiqueta);
    });

    Object.keys(porCliente).forEach(cliente => {
      const procesados = reportesPorCliente[cliente] || 0;
      const veredicto = procesados === 0
        ? "ðŸš¨ NINGÃšN reporte de este cliente se procesÃ³ hoy: el problema es del cliente o del ciclo, no de estas tareas puntuales."
        : `${procesados} reporte(s) de este cliente SÃ se procesaron hoy: solo faltan estos.`;
      Logger.log(`\n   ${cliente} â€” ${veredicto}`);
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
  const rutaWST = ["En Ãnalisis", "Esperando confirmaciÃ³n  del cliente", "Closed"];

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
// HERRAMIENTA: Crear pestaÃ±a "VMs con Snapshots SOP" en planillas de excepciones
// =================================================================
/**
 * Recorre todas las filas del Ãndice Maestro y, para cada cliente que tenga un
 * spreadsheet de excepciones configurado (columna C = row[2]), crea la pestaÃ±a
 * "VMs con Snapshots SOP" si aÃºn no existe.
 *
 * Estructura de la pestaÃ±a creada:
 *   A: ID de ExcepciÃ³n
 *   B: Columna del Reporte
 *   C: Tipo de Coincidencia  (dropdown: exacta / contiene / comienza con / termina con)
 *   D: Valores a Ignorar
 *   E: VÃ¡lida hasta
 *   F: ExcepciÃ³n Activa      (dropdown: SI / NO)
 *   G: AGE (dÃ­as)
 *   H: SIZE (GB)
 *   I: QTY (cantidad)
 *   J: TIPO TAMAÃ‘O           (dropdown: Absoluto / Relativo)
 *   K: CRITERIO              (dropdown: Ignorar / Considerar)
 *
 * Ejecutar desde el editor de Apps Script: sin parÃ¡metros, impacta todas las
 * planillas del Ãndice Maestro. Revisar los logs para ver el resumen.
 */
function manual_CrearPestanasSopSnapshots() {
  const TAB_NAME = "VMs con Snapshots SOP";
  const HEADERS  = [
    "ID de ExcepciÃ³n",
    "Columna del Reporte",
    "Tipo de Coincidencia",
    "Valores a Ignorar",
    "VÃ¡lida hasta",
    "ExcepciÃ³n Activa",
    "AGE",
    "SIZE",
    "QTY",
    "TIPO TAMAÃ‘O",
    "CRITERIO"
  ];

  const masterData = MasterSheetSingleton.getMasterData();
  if (!masterData || masterData.length === 0) {
    Logger.log("[manual_CrearPestanasSopSnapshots] ERROR: No se pudo cargar el Ãndice Maestro.");
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
      Logger.log(`[Fila ${idx + 1}] "${clientName}" â€” sin planilla de excepciones configurada. Se omite.`);
      sinPlanilla++;
      return;
    }

    try {
      const ss    = SpreadsheetApp.openById(exceptionFileId);
      let sheet   = ss.getSheetByName(TAB_NAME);

      if (sheet) {
        Logger.log(`[Fila ${idx + 1}] "${clientName}" â€” la pestaÃ±a "${TAB_NAME}" ya existe. Se omite.`);
        existian++;
        return;
      }

      // Crear la pestaÃ±a al final del spreadsheet
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

      // F: ExcepciÃ³n Activa
      sheet.getRange(2, 6, LAST_ROW, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["SI", "NO"], true)
          .setAllowInvalid(false)
          .build()
      );

      // J: TIPO TAMAÃ‘O
      sheet.getRange(2, 10, LAST_ROW, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["Absoluto", "Relativo"], true)
          .setAllowInvalid(false)
          .build()
      );

      // K: CRITERIO
      sheet.getRange(2, 11, LAST_ROW, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["Ignorar", "Considerar"], true)
          .setAllowInvalid(false)
          .build()
      );

      // Fijar la fila de encabezados
      sheet.setFrozenRows(1);

      Logger.log(`[Fila ${idx + 1}] "${clientName}" â€” pestaÃ±a "${TAB_NAME}" CREADA exitosamente.`);
      creadas++;

    } catch (e) {
      Logger.log(`[Fila ${idx + 1}] "${clientName}" â€” ERROR: ${e.message}`);
      errores++;
    }
  });

  Logger.log(
    `\n=== RESUMEN ===\n` +
    `PestaÃ±as creadas   : ${creadas}\n` +
    `Ya existÃ­an        : ${existian}\n` +
    `Sin planilla       : ${sinPlanilla}\n` +
    `Con error          : ${errores}`
  );
}

// =================================================================
// HERRAMIENTA: Actualizar pestaÃ±a "VMs con snapshots" en planillas de excepciones para agregar columnas de umbrales
// =================================================================
/**
 * Recorre todas las filas del Ãndice Maestro y actualiza la pestaÃ±a "VMs con snapshots"
 * para que tenga el formato exacto de la pestaÃ±a SOP (11 columnas).
 * Elimina cualquier dato basura de la columna G en adelante.
 */
function manual_ActualizarPestanaOpsSnapshots() {
  const TAB_NAME = "VMs con snapshots";
  
  const masterData = MasterSheetSingleton.getMasterData();
  if (!masterData || masterData.length === 0) {
    Logger.log("[manual_ActualizarPestanaOpsSnapshots] ERROR: No se pudo cargar el Ãndice Maestro.");
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
      Logger.log(`[Fila ${idx + 1}] "${clientName}" â€” sin planilla de excepciones configurada. Se omite.`);
      sinPlanilla++;
      return;
    }

    try {
      const ss    = SpreadsheetApp.openById(exceptionFileId);
      let sheet   = ss.getSheetByName(TAB_NAME);

      if (!sheet) sheet = ss.getSheetByName("VMs con Snapshots");

      if (!sheet) {
        Logger.log(`[Fila ${idx + 1}] "${clientName}" â€” la pestaÃ±a NO EXISTE. Se omite.`);
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
      const newHeaders = ["AGE", "SIZE", "QTY", "TIPO TAMAÃ‘O", "CRITERIO"];
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

      Logger.log(`[Fila ${idx + 1}] "${clientName}" â€” pestaÃ±a ACTUALIZADA exitosamente a formato SOP.`);
      actualizadas++;

    } catch (e) {
      Logger.log(`[Fila ${idx + 1}] "${clientName}" â€” ERROR: ${e.message}`);
      errores++;
    }
  });

  Logger.log(
    `
=== RESUMEN ===
` +
    `PestaÃ±as arregladas   : ${actualizadas}
` +
    `Sin pestaÃ±a (no existe) : ${sinPestana}
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