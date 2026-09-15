/**
 * @fileoverview Test END-TO-END del campo "Tecnología" de los tickets de Soporte, contra Jira
 * real, en la misma línea que tests/E2ETestHarness.js pero con su propio flujo de 3 pasos.
 *
 * ⚠️ TODAS estas funciones ejecutan acciones REALES. Igual que el resto del harness, arrancan
 * verificando ENVIRONMENT=TESTING (ver _e2eEntornoEsSeguro() en E2ETestHarness.js), así que es
 * imposible tocar el proyecto de Jira o la carpeta de Drive de un cliente real.
 *
 * QUÉ REPRODUCE
 * El 02/09/2026 los tickets de Soporte de "VMs con snapshots" se estaban creando con Tecnología
 * "Veeam Backup & Replication" siendo reportes de vSphere (ticket real: SCB-403). La causa era
 * un literal hardcodeado en createJiraTicketForSoporte() (core/JiraService.js) más las cuatro
 * ramas de "soporte" de core/ClientConfigService.js, que descartaban la Tecnología del Índice
 * Maestro y devolvían siempre la de Veeam.
 *
 * Los unitarios de tests/TestRunner.js ya cubren el armado del payload interceptando
 * fetchWithRetries. Lo que NO pueden cubrir es lo que este test sí: que el ticket que queda
 * CREADO EN JIRA tenga efectivamente el valor correcto en el campo, después de pasar por
 * getClientConfig(), el processor, la API de Service Desk y las validaciones de Jira.
 *
 * POR QUÉ SE PUEDE DISPARAR DE FORMA DETERMINISTA
 * VMsConSnapshots manda una fila a Soporte por dos vías: una regla "considerar" cargada en la
 * planilla de excepciones del cliente, o los umbrales hardcodeados de seguridad
 * (SOP_AGE_MAX=14 días, SOP_SIZE_MAX=1024 GB, SOP_CANTIDAD_MAX=7 — ver
 * vsphere/VMsConSnapshots.js). Este test usa los umbrales hardcodeados, así que NO depende de
 * cómo esté cargada la planilla del cliente de pruebas.
 *
 * Flujo de uso desde el editor de Apps Script (los 3 pasos, en orden, con el botón "Run"):
 *   1. manual_e2e_tecnologia_1_prepararEntorno()    -> deja Jira/Gmail listos y manda el reporte
 *   2. manual_e2e_tecnologia_2_dispararYVerificar() -> corre el processor y lee el campo en Jira
 *   3. manual_e2e_tecnologia_3_limpiar()            -> recién cuando termines de mirar
 */

/** Tarea del registro que se ejercita. Es la que tenía el bug. */
const E2E_TEC_TAREA = "processSnapshotsEmails";

/** Script Property con el runId de esta corrida (separada de las otras dos suites E2E). */
const E2E_TEC_PROP_RUN_ID = "E2E_TEC_ULTIMO_RUN_ID";

/** Script Property con las keys de los tickets que creó ESTE test, para poder cerrarlos al limpiar. */
const E2E_TEC_PROP_TICKETS = "E2E_TEC_TICKETS_CREADOS";

/**
 * El valor que el código mandaba hardcodeado antes del fix. El test lo usa para dar un veredicto
 * explícito sobre la regresión, no solo un "el valor coincide".
 */
const E2E_TEC_LITERAL_DEL_BUG = "Veeam Backup & Replication";

/**
 * Reporte de prueba.
 *
 * - Fila SOPORTE: 30 días, 2048 GB y 10 snapshots — cruza los TRES umbrales hardcodeados, así
 *   que va a Soporte aunque la planilla de excepciones del cliente de pruebas esté vacía.
 * - Fila OPS: valores por debajo de todos los umbrales de Soporte, para que el reporte también
 *   ejercite la rama de Ops y sirva de control.
 *
 * Los nombres de columna son los que busca processData(): "Name", "Number_Days_Old",
 * "Snapshot_Space" y "Number_Snapshots". "Snapshot_Name" va porque el processor descarta las
 * filas cuyo snapshot sea un "restore point", y conviene ser explícito en que estas no lo son.
 */
const E2E_TEC_FIXTURE = {
  extension: "csv",
  cuerpo: "Name,Snapshot_Name,Number_Days_Old,Snapshot_Space,Number_Snapshots\r\n"
    + "vm-e2e-tec-soporte,SNAPSHOT E2E TECNOLOGIA,30,2048,10\r\n"
    + "vm-e2e-tec-ops,SNAPSHOT E2E TECNOLOGIA,2,3,1"
};

/** @returns {string|null} runId de la corrida en curso, o null si no hay ninguna. */
function _e2eTecRunIdActual() {
  const guardado = PropertiesService.getScriptProperties().getProperty(E2E_TEC_PROP_RUN_ID);
  if (!guardado) {
    Logger.log("[E2E-Tecnologia] No hay ninguna corrida en preparación. Ejecutá primero manual_e2e_tecnologia_1_prepararEntorno().");
    return null;
  }
  return guardado;
}

/**
 * Configuración del cliente de pruebas, en sus dos variantes (Ops y Soporte).
 * @returns {{ops: Object, sop: Object}|null}
 */
function _e2eTecConfigDeTesting() {
  const processor = obtenerProcessorDeTarea(E2E_TEC_TAREA);
  if (!processor) {
    Logger.log(`[E2E-Tecnologia] "${E2E_TEC_TAREA}" no existe en el registro de core/Main.js.`);
    return null;
  }
  const ops = getClientConfigByName(TESTING_SAFETY_CLIENT_NAME, processor.operationName);
  const sop = getClientConfigByName(TESTING_SAFETY_CLIENT_NAME, processor.operationName, true);
  if (!ops || !sop) {
    Logger.log(`[E2E-Tecnologia] No se pudo resolver la configuración de "${TESTING_SAFETY_CLIENT_NAME}" en el Índice Maestro.`);
    return null;
  }
  return { ops: ops, sop: sop };
}

/**
 * Lee el campo Tecnología de un ticket ya creado.
 *
 * Es la parte end-to-end de verdad: no mira lo que el código quiso mandar, mira lo que Jira
 * efectivamente guardó después de sus propias validaciones.
 *
 * @param {string} issueKey
 * @returns {string|null} El valor del campo, o null si no se pudo leer.
 */
function _e2eTecTecnologiaDeTicket(issueKey) {
  if (!issueKey) return null;
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}?fields=${TECNOLOGIA_FIELD_ID}`;
  const options = { method: "get", headers: getJiraHeaders(), muteHttpExceptions: true };
  try {
    const respuesta = fetchWithRetries(endpoint, options);
    if (respuesta.getResponseCode() !== 200) {
      Logger.log(`[E2E-Tecnologia] No se pudo leer ${issueKey} (HTTP ${respuesta.getResponseCode()}).`);
      return null;
    }
    const campo = (JSON.parse(respuesta.getContentText()).fields || {})[TECNOLOGIA_FIELD_ID];
    if (!campo) return null;
    return campo.value !== undefined ? campo.value : String(campo);
  } catch (e) {
    Logger.log(`[E2E-Tecnologia] Excepción leyendo ${issueKey}: ${e.message}`);
    return null;
  }
}

/** Guarda la key de un ticket tocado por este test, para cerrarlo en el paso 3. */
function _e2eTecRecordarTicket(issueKey) {
  if (!issueKey) return;
  const props = PropertiesService.getScriptProperties();
  let keys = [];
  try { keys = JSON.parse(props.getProperty(E2E_TEC_PROP_TICKETS) || "[]"); } catch (e) { keys = []; }
  if (keys.indexOf(issueKey) === -1) keys.push(issueKey);
  props.setProperty(E2E_TEC_PROP_TICKETS, JSON.stringify(keys));
}

// =================================================================
// PASO 1 — PREPARAR (arrange)
// =================================================================

/**
 * Deja el entorno listo y manda el reporte de prueba.
 *
 * Aborta si ya hay un ticket de Soporte abierto con el summary que este test espera crear: en
 * ese caso el processor comentaría el ticket existente en vez de crear uno nuevo, y no habría
 * nada nuevo cuyo campo Tecnología mirar.
 *
 * @returns {string|null} El runId de esta corrida, o null si no se pudo preparar.
 */
function manual_e2e_tecnologia_1_prepararEntorno() {
  if (!_e2eEntornoEsSeguro()) return null;

  const processor = obtenerProcessorDeTarea(E2E_TEC_TAREA);
  if (!processor) return null;

  const config = _e2eTecConfigDeTesting();
  if (!config) return null;

  const tecnologiaEsperada = config.ops.tecnologia;
  const projectKeySop = config.sop.jiraProjectKeySop;

  Logger.log("=== [E2E-Tecnologia] PASO 1/3 — preparando ===");
  Logger.log(`Cliente de pruebas : ${TESTING_SAFETY_CLIENT_NAME}`);
  Logger.log(`Tecnología esperada: "${tecnologiaEsperada}" (columna G del Índice Maestro)`);

  if (!projectKeySop || !config.sop.requestTypeIdSop) {
    Logger.log(`🛑 ABORTADO: "${TESTING_SAFETY_CLIENT_NAME}" no tiene cargadas sus columnas de Soporte (N a Q) en el Índice Maestro.`);
    Logger.log(`   Falta: ${!projectKeySop ? "jiraProjectKeySop " : ""}${!config.sop.requestTypeIdSop ? "requestTypeIdSop" : ""}`);
    Logger.log("   Sin eso el processor no puede crear el ticket de Soporte y este test no tiene qué verificar.");
    return null;
  }
  Logger.log(`Proyecto Soporte   : ${projectKeySop}`);

  if (!tecnologiaEsperada) {
    Logger.log("🛑 ABORTADO: el cliente de pruebas no tiene Tecnología cargada en el Índice Maestro.");
    return null;
  }

  if (tecnologiaEsperada === E2E_TEC_LITERAL_DEL_BUG) {
    Logger.log(`⚠️  ATENCIÓN: la Tecnología del cliente de pruebas es justamente "${E2E_TEC_LITERAL_DEL_BUG}",`);
    Logger.log("   que es el valor que el código mandaba hardcodeado antes del fix. Con este cliente el test");
    Logger.log("   NO puede distinguir \"sale de la configuración\" de \"sale del literal viejo\": daría PASS en");
    Logger.log("   los dos casos. Para que sirva de verdad, el cliente de pruebas tiene que tener otra");
    Logger.log("   Tecnología cargada (ej. \"VMware vSphere\").");
  }

  const summarySoporte = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE + " (Soporte)";
  const yaAbierto = findExistingJiraTicket(summarySoporte, projectKeySop);
  if (yaAbierto) {
    Logger.log(`🛑 ABORTADO: ya hay un ticket de Soporte abierto con ese summary (${yaAbierto}) en ${projectKeySop}.`);
    Logger.log("   El processor lo comentaría en vez de crear uno nuevo. Cerralo, o corré manual_e2e_tecnologia_3_limpiar() si quedó de una corrida anterior.");
    return null;
  }

  const runId = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  const props = PropertiesService.getScriptProperties();
  props.setProperty(E2E_TEC_PROP_RUN_ID, runId);
  props.deleteProperty(E2E_TEC_PROP_TICKETS);

  Logger.log(`\nCorrida "${runId}"`);

  _e2eBorrarCarpetaDelDia();

  // La Tarea Programada no es lo que se está probando, pero sin ella el correo terminaría en
  // [OPS-ERROR] por NOT_FOUND y ese ruido taparía el resultado que sí importa.
  const projectKeyOps = config.ops.jiraProjectKey;
  if (processor.scheduledTaskName && projectKeyOps) {
    const tarea = buscarTareaProgramadaDelDia(processor.scheduledTaskName, projectKeyOps);
    if (tarea) {
      Logger.log(`Tarea Programada "${processor.scheduledTaskName}" ya existe hoy: ${tarea.key} (estado "${tarea.status}").`);
    } else {
      const key = _e2eCrearTareaProgramada(processor.scheduledTaskName, projectKeyOps,
        `Tarea Programada generada por el test E2E de Tecnología (tests/E2ETecnologiaSoporteTest.js) [E2E-TEC:${runId}].`);
      if (key) {
        _e2eTecRecordarTicket(key);
        Logger.log(`Tarea Programada "${processor.scheduledTaskName}" creada: ${key}`);
      }
    }
  }

  const correo = construirCorreoDeFixture(E2E_TEC_TAREA, E2E_TEC_FIXTURE, runId, "tecnologia");
  if (!correo) {
    Logger.log("[E2E-Tecnologia] No se pudo construir el correo de prueba.");
    return null;
  }

  const destinatario = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(destinatario, correo.asunto,
    "Reporte simulado del test E2E de Tecnología. La fila \"vm-e2e-tec-soporte\" cruza los tres umbrales hardcodeados de Soporte.",
    { attachments: [correo.blob] });

  Logger.log(`Correo enviado a ${destinatario}: "${correo.asunto}"`);
  Logger.log("\nGmail tarda unos segundos en entregar. Siguiente paso: manual_e2e_tecnologia_2_dispararYVerificar().");

  return runId;
}

// =================================================================
// PASO 2 — DISPARAR (act) y VERIFICAR (assert)
// =================================================================

/**
 * Corre el processor real una vez y después lee, contra Jira, el campo Tecnología del ticket de
 * Soporte recién creado.
 *
 * La verificación es de solo lectura: si algo no da lo esperado no se toca nada, para poder
 * diagnosticar con el estado real intacto.
 */
function manual_e2e_tecnologia_2_dispararYVerificar() {
  if (!_e2eEntornoEsSeguro()) return null;
  const runId = _e2eTecRunIdActual();
  if (!runId) return null;

  const processor = obtenerProcessorDeTarea(E2E_TEC_TAREA);
  const config = _e2eTecConfigDeTesting();
  if (!processor || !config) return null;

  Logger.log(`=== [E2E-Tecnologia] PASO 2/3 — disparando el processor (corrida "${runId}") ===`);
  processor.processEmails();

  let pasaron = 0, fallaron = 0;
  function chequear(condicion, descripcion) {
    if (condicion) { pasaron++; return true; }
    fallaron++;
    Logger.log(`   ❌ ${descripcion}`);
    return false;
  }

  const tecnologiaEsperada = config.ops.tecnologia;
  const projectKeySop = config.sop.jiraProjectKeySop;
  const projectKeyOps = config.ops.jiraProjectKey;

  Logger.log("\n--- Gmail ---");
  const hilos = _e2eHilosDeLaCorrida(runId);
  if (chequear(hilos.length === 1, `Se esperaba 1 correo para la corrida "${runId}" y se encontraron ${hilos.length}`)) {
    const etiquetas = hilos[0].etiquetas;
    chequear(etiquetas.indexOf(OPS_LABEL_ERROR) === -1,
      `El correo quedó en ${OPS_LABEL_ERROR}: el reporte no llegó a procesarse, así que no hay ticket cuyo campo mirar. Etiquetas: [${etiquetas.join(", ") || "ninguna"}]`);
  }

  Logger.log("\n--- Jira: ticket de SOPORTE (el que tenía el bug) ---");
  const summarySoporte = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE + " (Soporte)";
  const ticketsSop = _e2eTicketsDeAlertaPorSummary(projectKeySop, summarySoporte);

  if (chequear(ticketsSop.length > 0,
      `No se creó ningún ticket de Soporte "${summarySoporte}" en ${projectKeySop}. Revisá el log del processor: si no aparece "[DEBUG EVAL] -> VM asignada a SOPORTE", la fila de prueba no cruzó los umbrales.`)) {
    const keySop = ticketsSop[0].key;
    _e2eTecRecordarTicket(keySop);
    const tecnologiaReal = _e2eTecTecnologiaDeTicket(keySop);
    Logger.log(`   Ticket de Soporte : ${keySop}`);
    Logger.log(`   Tecnología en Jira: "${tecnologiaReal}"  |  esperada: "${tecnologiaEsperada}"`);

    chequear(tecnologiaReal === tecnologiaEsperada,
      `El ticket de Soporte ${keySop} quedó con Tecnología "${tecnologiaReal}" y se esperaba "${tecnologiaEsperada}"`);

    if (tecnologiaEsperada !== E2E_TEC_LITERAL_DEL_BUG) {
      chequear(tecnologiaReal !== E2E_TEC_LITERAL_DEL_BUG,
        `REGRESIÓN: el ticket de Soporte volvió a salir con "${E2E_TEC_LITERAL_DEL_BUG}" hardcodeado (es el bug de SCB-403)`);
    } else {
      Logger.log(`   ⚠️  El cliente de pruebas tiene "${E2E_TEC_LITERAL_DEL_BUG}" como Tecnología, así que este chequeo no distingue la regresión.`);
    }
  }

  Logger.log("\n--- Jira: ticket de OPS (control) ---");
  const ticketsOps = _e2eTicketsDeAlertaPorSummary(projectKeyOps, SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE);
  const soloOps = ticketsOps.filter(function (t) { return t.summary.indexOf("(Soporte)") === -1; });
  if (soloOps.length === 0) {
    Logger.log("   (No se creó ticket de Ops en esta corrida. No es un fallo: depende de las reglas de excepción");
    Logger.log("    del cliente de pruebas. El caso que importa para este test es el de Soporte.)");
  } else {
    const keyOps = soloOps[0].key;
    _e2eTecRecordarTicket(keyOps);
    const tecnologiaOps = _e2eTecTecnologiaDeTicket(keyOps);
    Logger.log(`   Ticket de Ops: ${keyOps} — Tecnología "${tecnologiaOps}"`);
    chequear(tecnologiaOps === tecnologiaEsperada,
      `El ticket de Ops ${keyOps} quedó con Tecnología "${tecnologiaOps}" y se esperaba "${tecnologiaEsperada}"`);
  }

  Logger.log(`\n=== RESULTADO: ${pasaron} OK, ${fallaron} fallidos ===`);
  if (fallaron === 0) {
    Logger.log("✅ El ticket de Soporte se creó con la Tecnología de la configuración del cliente, no con un literal.");
  }
  Logger.log("\nCuando termines de revisar: manual_e2e_tecnologia_3_limpiar().");

  return { pasaron: pasaron, fallaron: fallaron };
}

// =================================================================
// PASO 3 — LIMPIAR — manual y explícito, nunca automático
// =================================================================

/**
 * Deja Gmail, Jira y Drive como estaban. Igual que las otras suites E2E: archiva los hilos en
 * vez de borrarlos (siguen siendo evidencia si algo salió mal) y cierra únicamente los tickets
 * que ESTE test creó o verificó.
 */
function manual_e2e_tecnologia_3_limpiar() {
  if (!_e2eEntornoEsSeguro()) return;
  const runId = _e2eTecRunIdActual();
  if (!runId) return;

  Logger.log(`=== [E2E-Tecnologia] PASO 3/3 — limpieza (corrida "${runId}") ===`);

  const hilos = _e2eHilosDeLaCorrida(runId);
  hilos.forEach(function (h) {
    try {
      h.hilo.markRead();
      h.hilo.moveToArchive();
    } catch (e) {
      Logger.log(`   No se pudo archivar un hilo: ${e.message}`);
    }
  });
  Logger.log(`   ${hilos.length} hilo(s) de Gmail archivados.`);

  const props = PropertiesService.getScriptProperties();
  let keys = [];
  try { keys = JSON.parse(props.getProperty(E2E_TEC_PROP_TICKETS) || "[]"); } catch (e) { keys = []; }

  keys.forEach(function (key) {
    const estado = obtenerEstadoDeTicket(key);
    if (estado && estado.cerrado) {
      Logger.log(`   ${key} ya estaba cerrado.`);
      return;
    }
    const resultado = resolveJiraTicket(key, JIRA_STATUS_TO_CLOSE);
    Logger.log(`   ${key}: ${resultado && resultado.status === "SUCCESS" ? "cerrado" : "⚠️ no se pudo cerrar, revisar a mano"}.`);
  });
  if (keys.length === 0) Logger.log("   No había tickets registrados para esta corrida.");

  _e2eBorrarCarpetaDelDia();

  props.deleteProperty(E2E_TEC_PROP_RUN_ID);
  props.deleteProperty(E2E_TEC_PROP_TICKETS);
  Logger.log("\n=== LIMPIEZA TERMINADA ===");
}
