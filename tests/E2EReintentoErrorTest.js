/**
 * @fileoverview Test END-TO-END de manual_reintentarCorreosConError() (custom/HerramientasManuales.js)
 * contra el pipeline real (Gmail -> Jira -> Drive), en la misma línea que tests/E2ETestHarness.js
 * pero con su propio flujo de 5 pasos, porque este escenario es de DOS fases (falla, se corrige,
 * se reintenta) y no encaja en el "un fixture -> un resultado" del harness principal.
 *
 * ⚠️ TODAS estas funciones ejecutan acciones REALES. Igual que el harness principal, arrancan
 * verificando ENVIRONMENT=TESTING (ver _e2eEntornoEsSeguro() en E2ETestHarness.js), así que es
 * imposible tocar el proyecto de Jira o la carpeta de Drive de un cliente real.
 *
 * Qué reproduce: el incidente real que originó [OPS-ERROR] (core/MailUtils.js) — un reporte
 * llega bien, pero su Tarea Programada no existe en Jira (falta crearla, o el nombre no
 * coincide). buscarYCerrarTareaProgramada() devuelve NOT_FOUND (terminal), el correo se aparta
 * a [OPS-ERROR], y NO se reintenta solo. Este test crea esa situación a propósito, corrige el
 * "incidente" (crea la tarea) y confirma que manual_reintentarCorreosConError() deja el correo
 * en [OPS-PROCESADO], la tarea cerrada y el adjunto archivado en Drive — de punta a punta.
 *
 * Flujo de uso desde el editor de Apps Script (los 5 pasos, en orden, con el botón "Run"):
 *   1. manual_e2e_reintento_1_prepararEntorno()               -> manda el correo SIN su Tarea Programada
 *   2. manual_e2e_reintento_2_dispararPrimerCicloYVerificarError() -> corre el processor real una vez;
 *      debe fallar con NOT_FOUND y quedar en [OPS-ERROR]
 *   3. manual_e2e_reintento_3_corregirIncidenteYReintentar()   -> crea la tarea y corre
 *      manual_reintentarCorreosConError() (acotada a este correo)
 *   4. manual_e2e_reintento_4_verificarResultadoFinal()        -> informe PASS/FAIL, sin modificar nada
 *   5. manual_e2e_reintento_5_limpiar()                        -> recién cuando termines de mirar los resultados
 *
 * El runId de la corrida en curso queda en Script Properties (separado del que usa
 * E2ETestHarness.js), así que los pasos 2-5 se pueden correr con el botón "Run" del editor,
 * que no permite pasar argumentos.
 */

// Configurable, mismo patrón que E2E_FILTRO_TAREA (E2ETestHarness.js): se edita a mano antes de
// correr. Tiene que ser un reporte de Veeam ONE (pasos: ['drive'], sin paso de tickets — ver
// veeam/VeeamOneReportes.js): así el único motivo por el que el correo puede fallar es el cierre
// de la Tarea Programada, que es justamente lo que este test necesita forzar a NOT_FOUND. Un
// processor con paso 'tickets' serviría igual, pero de paso generaría un ticket de alerta real
// en el proyecto de testing — ruido que este test no necesita.
const E2E_REINTENTO_TAREA = "processVeeamVMsProtegidasEmails";

/** Script Property con el runId de esta corrida (separada de E2E_PROPIEDAD_RUN_ID del harness principal). */
const E2E_REINTENTO_PROPIEDAD_RUN_ID = "E2E_REINTENTO_ULTIMO_RUN_ID";

/** Script Property con la key de la Tarea Programada creada en el paso 3, para poder cerrarla/verificarla después. */
const E2E_REINTENTO_PROPIEDAD_TICKET_TAREA = "E2E_REINTENTO_ULTIMO_TICKET_TAREA";

/** @returns {string|null} runId de la corrida en preparación, o null si no hay ninguna. */
function _e2eReintentoRunIdActual() {
  const guardado = PropertiesService.getScriptProperties().getProperty(E2E_REINTENTO_PROPIEDAD_RUN_ID);
  if (!guardado) {
    Logger.log(`[E2E-Reintento] No hay ninguna corrida en preparación. Ejecutá primero manual_e2e_reintento_1_prepararEntorno().`);
    return null;
  }
  return guardado;
}

// =================================================================
// PASO 1 — PREPARAR (arrange): manda el correo SIN su Tarea Programada
// =================================================================

/**
 * Manda el correo de prueba de E2E_REINTENTO_TAREA sin crear su Tarea Programada en Jira —
 * la causa exacta del incidente que este test reproduce.
 *
 * Antes de mandar nada verifica que HOY no exista ya, en NINGÚN estado, una Tarea Programada
 * con ese nombre: si existiera (por trabajo real en el proyecto de testing, o por otra corrida
 * de este mismo test sin limpiar), buscarYCerrarTareaProgramada() la encontraría (o la
 * resolvería como DUPLICADO) y el correo NO terminaría en [OPS-ERROR], invalidando el test. En
 * ese caso se aborta sin mandar nada.
 *
 * @returns {string|null} El runId de esta corrida, o null si no se pudo preparar.
 */
function manual_e2e_reintento_1_prepararEntorno() {
  if (!_e2eEntornoEsSeguro()) return null;

  const processor = obtenerProcessorDeTarea(E2E_REINTENTO_TAREA);
  if (!processor || !processor.scheduledTaskName) {
    Logger.log(`[E2E-Reintento] "${E2E_REINTENTO_TAREA}" no existe en el registro o no tiene scheduledTaskName. Este test necesita un processor que cierre Tarea Programada.`);
    return null;
  }

  const fixture = E2E_FIXTURES[E2E_REINTENTO_TAREA];
  if (!fixture) {
    Logger.log(`[E2E-Reintento] No hay fixture en E2E_FIXTURES para "${E2E_REINTENTO_TAREA}".`);
    return null;
  }

  const projectKey = _e2eProjectKeyDeTesting();
  if (!projectKey) return null;

  const yaExiste = buscarTareaProgramadaDelDia(processor.scheduledTaskName, projectKey);
  if (yaExiste) {
    Logger.log(`[E2E-Reintento] 🛑 ABORTADO: ya existe hoy una Tarea Programada "${processor.scheduledTaskName}" (${yaExiste.key}, estado "${yaExiste.status}") en el proyecto de testing.`);
    Logger.log(`   Este test necesita que NO exista ninguna, para forzar un NOT_FOUND real. Probá con otro reporte de Veeam ONE en E2E_REINTENTO_TAREA (ver REPORTES_VEEAM_ONE en veeam/VeeamOneReportes.js), o esperá a mañana.`);
    return null;
  }

  const runId = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  PropertiesService.getScriptProperties().setProperty(E2E_REINTENTO_PROPIEDAD_RUN_ID, runId);
  PropertiesService.getScriptProperties().deleteProperty(E2E_REINTENTO_PROPIEDAD_TICKET_TAREA);

  Logger.log(`=== [E2E-Reintento] PASO 1/5 — preparando corrida "${runId}" (tarea: ${E2E_REINTENTO_TAREA}) ===`);

  _e2eBorrarCarpetaDelDia();

  const correo = construirCorreoDeFixture(E2E_REINTENTO_TAREA, fixture, runId, "reintento");
  if (!correo) {
    Logger.log(`[E2E-Reintento] No se pudo construir el correo de prueba.`);
    return null;
  }

  const destinatario = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(destinatario, correo.asunto, `Reporte simulado del test E2E de reintento (a propósito, SIN Tarea Programada).`, {
    attachments: [correo.blob]
  });

  Logger.log(`[E2E-Reintento] Correo enviado a ${destinatario}: "${correo.asunto}"`);
  Logger.log(`Confirmado: NO existe Tarea Programada "${processor.scheduledTaskName}" creada hoy — el primer ciclo debería fallar con NOT_FOUND.`);
  Logger.log(`\nGmail tarda unos segundos en entregar el correo. Siguiente paso: manual_e2e_reintento_2_dispararPrimerCicloYVerificarError().`);

  return runId;
}

// =================================================================
// PASO 2 — DISPARAR el primer ciclo (debe fallar) y verificar el fallo
// =================================================================

/**
 * Corre el processor real UNA vez (sin las guardas de horario/feriado/lock, igual que
 * manual_e2e_dispararRapido en E2ETestHarness.js) y verifica en el mismo paso que el correo
 * terminó apartado en [OPS-ERROR]: la Tarea Programada no existe, así que
 * buscarYCerrarTareaProgramada() (core/JiraService.js) debe devolver NOT_FOUND.
 *
 * La verificación es de solo lectura: si algo no da lo esperado, se loguea el fallo pero no se
 * modifica nada, para poder diagnosticar con el estado real todavía intacto.
 */
function manual_e2e_reintento_2_dispararPrimerCicloYVerificarError() {
  if (!_e2eEntornoEsSeguro()) return null;
  const runId = _e2eReintentoRunIdActual();
  if (!runId) return null;

  Logger.log(`=== [E2E-Reintento] PASO 2/5 — disparando el processor real (corrida "${runId}") ===`);

  const processor = obtenerProcessorDeTarea(E2E_REINTENTO_TAREA);
  if (!processor) return null;
  processor.processEmails();

  Logger.log(`\n--- Verificando que el correo haya quedado en ${OPS_LABEL_ERROR} ---`);

  let pasaron = 0, fallaron = 0;
  function chequear(condicion, descripcion) {
    if (condicion) { pasaron++; return true; }
    fallaron++;
    Logger.log(`   ❌ ${descripcion}`);
    return false;
  }

  const hilos = _e2eHilosDeLaCorrida(runId);
  if (!chequear(hilos.length === 1, `Se esperaba 1 correo en Gmail para la corrida "${runId}" y se encontraron ${hilos.length}`)) {
    Logger.log(`\n=== RESULTADO PASO 2: ${pasaron} OK, ${fallaron} fallidos ===`);
    return { pasaron, fallaron };
  }

  const etiquetas = hilos[0].etiquetas;
  chequear(etiquetas.indexOf(OPS_LABEL_ERROR) !== -1, `Se esperaba la etiqueta ${OPS_LABEL_ERROR} y el hilo quedó en [${etiquetas.join(", ") || "sin etiqueta"}]`);
  chequear(etiquetas.indexOf(OPS_LABEL_PENDIENTE) === -1, `El hilo no debería tener ${OPS_LABEL_PENDIENTE} al mismo tiempo que ${OPS_LABEL_ERROR}`);

  const projectKey = _e2eProjectKeyDeTesting();
  if (projectKey && processor.scheduledTaskName) {
    const existe = buscarTareaProgramadaDelDia(processor.scheduledTaskName, projectKey);
    chequear(!existe, `No debería existir todavía ninguna Tarea Programada "${processor.scheduledTaskName}", y se encontró ${existe ? existe.key : ""}`);
  }

  Logger.log(`\n=== RESULTADO PASO 2: ${pasaron} OK, ${fallaron} fallidos ===`);
  if (fallaron === 0) {
    Logger.log(`✅ El correo quedó correctamente apartado en ${OPS_LABEL_ERROR} por falta de Tarea Programada — el mismo escenario que manual_reintentarCorreosConError() tiene que poder resolver.`);
    Logger.log(`\nSiguiente paso: manual_e2e_reintento_3_corregirIncidenteYReintentar().`);
  }
  return { pasaron, fallaron };
}

// =================================================================
// PASO 3 — CORREGIR el incidente y disparar el reintento manual (act)
// =================================================================

/**
 * Simula que alguien corrigió el incidente (crea la Tarea Programada que faltaba) y corre
 * manual_reintentarCorreosConError() — la función bajo prueba — acotada A ESTE correo puntual
 * vía MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO (custom/HerramientasManuales.js), para no tocar
 * ningún otro correo que pueda estar en [OPS-ERROR] por otro motivo. El filtro se restaura al
 * terminar, se haya usado el valor que se haya usado antes de correr esto.
 */
function manual_e2e_reintento_3_corregirIncidenteYReintentar() {
  if (!_e2eEntornoEsSeguro()) return null;
  const runId = _e2eReintentoRunIdActual();
  if (!runId) return null;

  const processor = obtenerProcessorDeTarea(E2E_REINTENTO_TAREA);
  if (!processor || !processor.scheduledTaskName) return null;

  const projectKey = _e2eProjectKeyDeTesting();
  if (!projectKey) return null;

  Logger.log(`=== [E2E-Reintento] PASO 3/5 — corrigiendo el incidente (corrida "${runId}") ===`);

  const yaExiste = buscarTareaProgramadaDelDia(processor.scheduledTaskName, projectKey);
  let ticketKey;
  if (yaExiste) {
    Logger.log(`[E2E-Reintento] La Tarea Programada "${processor.scheduledTaskName}" ya existe (${yaExiste.key}, estado "${yaExiste.status}") — se reutiliza en vez de crear otra.`);
    ticketKey = yaExiste.key;
  } else {
    const descripcion = `Tarea Programada generada por el test E2E de reintento (tests/E2EReintentoErrorTest.js) [E2E-REINTENTO:${runId}]. Se cierra con manual_e2e_reintento_5_limpiar().`;
    ticketKey = _e2eCrearTareaProgramada(processor.scheduledTaskName, projectKey, descripcion);
    if (!ticketKey) {
      Logger.log(`[E2E-Reintento] No se pudo crear la Tarea Programada "${processor.scheduledTaskName}".`);
      return null;
    }
    Logger.log(`[E2E-Reintento] Tarea Programada "${processor.scheduledTaskName}" creada: ${ticketKey} (simula la corrección del incidente).`);
  }
  PropertiesService.getScriptProperties().setProperty(E2E_REINTENTO_PROPIEDAD_TICKET_TAREA, ticketKey);

  Logger.log(`\n--- Corriendo manual_reintentarCorreosConError(), acotada a esta corrida ---`);
  const filtroAnterior = MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO;
  MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO = runId;
  let resultado;
  try {
    resultado = manual_reintentarCorreosConError();
  } finally {
    MANUAL_REINTENTO_ERROR_FILTRO_ASUNTO = filtroAnterior;
  }

  Logger.log(`\n=== [E2E-Reintento] manual_reintentarCorreosConError() devolvió: ${JSON.stringify(resultado)} ===`);
  Logger.log(`\nSiguiente paso: manual_e2e_reintento_4_verificarResultadoFinal().`);
  return resultado;
}

// =================================================================
// PASO 4 — VERIFICAR (assert) — solo lectura, no modifica nada
// =================================================================

/**
 * Verificación final: confirma que manual_reintentarCorreosConError() resolvió el correo de
 * punta a punta — Gmail, Jira y Drive — igual que haría el ciclo automático si la Tarea
 * Programada hubiera existido desde el principio.
 */
function manual_e2e_reintento_4_verificarResultadoFinal() {
  if (!_e2eEntornoEsSeguro()) return null;
  const runId = _e2eReintentoRunIdActual();
  if (!runId) return null;

  Logger.log(`=== [E2E-Reintento] PASO 4/5 — verificando resultado final (corrida "${runId}") ===`);

  let pasaron = 0, fallaron = 0;
  function chequear(condicion, descripcion) {
    if (condicion) { pasaron++; return true; }
    fallaron++;
    Logger.log(`   ❌ ${descripcion}`);
    return false;
  }

  // 1. Gmail: el hilo tiene que haber pasado a [OPS-PROCESADO], y ya no tener [OPS-ERROR].
  const hilos = _e2eHilosDeLaCorrida(runId);
  if (chequear(hilos.length === 1, `Se esperaba 1 correo en Gmail para la corrida "${runId}" y se encontraron ${hilos.length}`)) {
    const etiquetas = hilos[0].etiquetas;
    chequear(etiquetas.indexOf(OPS_LABEL_PROCESADO) !== -1, `Se esperaba ${OPS_LABEL_PROCESADO} y el hilo quedó en [${etiquetas.join(", ") || "sin etiqueta"}]`);
    chequear(etiquetas.indexOf(OPS_LABEL_ERROR) === -1, `El hilo no debería seguir teniendo ${OPS_LABEL_ERROR}`);
  }

  // 2. Jira: la Tarea Programada creada/reutilizada en el paso 3 tiene que haber quedado cerrada.
  const ticketKey = PropertiesService.getScriptProperties().getProperty(E2E_REINTENTO_PROPIEDAD_TICKET_TAREA);
  if (chequear(!!ticketKey, `No se encontró la Tarea Programada del paso 3 — ¿corriste manual_e2e_reintento_3_corregirIncidenteYReintentar()?`)) {
    const estado = obtenerEstadoDeTicket(ticketKey);
    chequear(!!estado && estado.cerrado, `Se esperaba que la Tarea Programada ${ticketKey} quedara cerrada y su estado es "${estado ? estado.nombre : "desconocido"}"`);
  }

  // 3. Drive: el adjunto tiene que haberse archivado en la carpeta del día.
  const processor = obtenerProcessorDeTarea(E2E_REINTENTO_TAREA);
  const fixture = E2E_FIXTURES[E2E_REINTENTO_TAREA];
  if (processor && fixture) {
    const correo = construirCorreoDeFixture(E2E_REINTENTO_TAREA, fixture, runId, "reintento");
    const archivosEnDrive = _e2eArchivosDeLaCarpetaDelDia();
    const baseEsperada = _e2eSinExtension(correo.nombreArchivo);
    const estaEnDrive = archivosEnDrive.some(function (n) { return _e2eSinExtension(n) === baseEsperada; });
    chequear(estaEnDrive, `Se esperaba encontrar "${baseEsperada}" en la carpeta del día de Drive`);
  }

  Logger.log(`\n=== RESULTADO PASO 4: ${pasaron} OK, ${fallaron} fallidos ===`);
  if (fallaron === 0) {
    Logger.log(`✅ manual_reintentarCorreosConError() resolvió correctamente, de punta a punta, un correo apartado en ${OPS_LABEL_ERROR}.`);
  }
  Logger.log(`\nCuando termines de revisar: manual_e2e_reintento_5_limpiar().`);

  return { pasaron, fallaron };
}

// =================================================================
// PASO 5 — LIMPIAR — manual y explícito, nunca automático
// =================================================================

/**
 * Deja Gmail, Jira y Drive como estaban antes de esta corrida. Igual que manual_e2e_limpiar()
 * del harness principal: archiva el hilo en vez de borrarlo (sigue siendo evidencia si algo
 * salió mal) y solo cierra el ticket que ESTE test creó.
 */
function manual_e2e_reintento_5_limpiar() {
  if (!_e2eEntornoEsSeguro()) return;
  const runId = _e2eReintentoRunIdActual();
  if (!runId) return;

  Logger.log(`=== [E2E-Reintento] PASO 5/5 — limpieza (corrida "${runId}") ===`);

  const hilos = _e2eHilosDeLaCorrida(runId);
  hilos.forEach(function (h) {
    try {
      h.hilo.markRead();
      h.hilo.moveToArchive();
    } catch (e) {
      Logger.log(`[E2E-Reintento] No se pudo archivar un hilo: ${e.message}`);
    }
  });
  Logger.log(`   ${hilos.length} hilo(s) de Gmail archivados.`);

  const ticketKey = PropertiesService.getScriptProperties().getProperty(E2E_REINTENTO_PROPIEDAD_TICKET_TAREA);
  if (ticketKey) {
    const estado = obtenerEstadoDeTicket(ticketKey);
    if (estado && estado.cerrado) {
      Logger.log(`   Tarea Programada ${ticketKey} ya estaba cerrada.`);
    } else {
      const resultado = resolveJiraTicket(ticketKey, JIRA_STATUS_TO_CLOSE);
      Logger.log(`   Tarea Programada ${ticketKey}: ${resultado && resultado.status === 'SUCCESS' ? "cerrada" : "⚠️ no se pudo cerrar, revisar a mano"}.`);
    }
  } else {
    Logger.log(`   No había ninguna Tarea Programada registrada para esta corrida.`);
  }

  const projectKey = _e2eProjectKeyDeTesting();
  if (projectKey) _e2eAvisarTicketsDeAlerta(projectKey);

  _e2eBorrarCarpetaDelDia();

  PropertiesService.getScriptProperties().deleteProperty(E2E_REINTENTO_PROPIEDAD_RUN_ID);
  PropertiesService.getScriptProperties().deleteProperty(E2E_REINTENTO_PROPIEDAD_TICKET_TAREA);
  Logger.log(`\n=== LIMPIEZA TERMINADA ===`);
}
