/**
 * @fileoverview Harness de pruebas END-TO-END: ejercita el pipeline real (Gmail -> Jira -> Drive)
 * en vez de mockearlo, que es lo que hacen los unitarios de tests/TestRunner.js.
 *
 * Automatiza lo que hasta ahora se hacía a mano antes de cada release: mandarse los reportes
 * de prueba por correo, crear las Tareas Programadas en Jira, borrar la carpeta del día en
 * Drive, correr el ciclo y revisar a ojo qué pasó en cada uno de los tres sistemas.
 *
 * ⚠️ TODAS estas funciones ejecutan acciones REALES. Por eso todas empiezan verificando que
 * el proyecto esté en ENVIRONMENT=TESTING: en ese modo, getClientConfig() y el archivado en
 * Drive redirigen todo a TESTING_SAFETY_CLIENT_NAME, así que es imposible tocar el proyecto
 * de Jira o la carpeta de Drive de un cliente real (ver core/ConfiguracionGlobal.js).
 *
 * Flujo de uso desde el editor de Apps Script:
 *   0. (opcional) Poné un valor en E2E_FILTRO_TAREA para acotar la corrida a un solo processor
 *      — recomendado la primera vez, antes de lanzar el plan completo.
 *   1. manual_e2e_prepararEntorno()   -> deja Gmail/Jira/Drive listos y devuelve el runId
 *   2. manual_e2e_dispararRapido()    (iteración) o manual_e2e_dispararCicloReal() (pre-release)
 *   3. manual_e2e_verificar()         -> informe PASS/FAIL, sin modificar nada
 *   4. manual_e2e_limpiar()           -> recién cuando terminaste de mirar los resultados
 *
 * El runId de la última corrida queda guardado en Script Properties, así que los pasos 2-4
 * se pueden ejecutar con el botón "Run" del editor, que no permite pasar argumentos.
 *
 * ⚠️ CASOS BORDE — de a UNO por corrida (E2E_FILTRO_CASO).
 * Todos los casos borde de un mismo processor (normal, vacío, separador, entrecomillado...)
 * apuntan a la MISMA Tarea Programada en Jira, y solo puede haber una abierta a la vez: el
 * primer correo que se procese la cierra, y el resto legítimamente encuentra "no hay tarea
 * abierta" (NOT_FOUND), que es el comportamiento REAL y correcto del pipeline, no un fallo del
 * harness. Por eso los casos borde no se pueden batchear entre sí — se corren de a uno, cada
 * uno con su propio prepararEntorno -> disparar -> verificar -> limpiar.
 */

/** Script Property donde se recuerda el runId de la última corrida preparada. */
const E2E_PROPIEDAD_RUN_ID = "E2E_ULTIMO_RUN_ID";

/**
 * Tareas cuyo processor sobrescribe processSingleMessage() por completo y NUNCA llama a
 * ejecutarPasoDrive() — así que legítimamente no archivan nada en Drive. Descubierto corriendo
 * el harness: no es un bug de estos dos processors, es su diseño actual (ver
 * vsphere/Capacidad de Particiones.js y tanzu/Tanzu_Main.js). Si algún día empiezan a
 * archivar, sacarlos de acá.
 */
const E2E_TAREAS_SIN_PASO_DRIVE = {
  processPartitionEmails: true,
  processTanzuEmails: true
};

/**
 * Acota la corrida a una sola tarea del registro (ej. "processInaccessibleVMsEmails").
 * Vacío = corre el plan completo (~30 processors + 6 casos borde).
 *
 * Mismo patrón que MANUAL_CIERRE_NOMBRE_TAREA en custom/HerramientasManuales.js: se edita
 * acá antes de correr, porque el botón "Run" del editor de Apps Script no permite pasar
 * argumentos. Usar esto para la corrida de humo antes de ampliar a todo el plan.
 */
const E2E_FILTRO_TAREA = "";

/**
 * Acota la corrida a UN solo caso borde (ej. "vacio"). Vacío = corre los fixtures "normales"
 * (uno por processor, sin colisión de Tarea Programada entre sí).
 *
 * Incompatible con dejar varios casos borde del mismo processor en la misma corrida — ver la
 * nota "CASOS BORDE" al principio del archivo. Si se completa esto, E2E_FILTRO_TAREA además
 * acota A CUÁL processor aplicarlo (por si el caso borde aplicara a más de uno).
 */
const E2E_FILTRO_CASO = "sinAnomaliasReales";

/**
 * Corta la ejecución si el proyecto no es de pruebas.
 * Es la única garantía de que el harness no puede correr contra Operativo.
 * @returns {boolean} true si se puede seguir.
 */
function _e2eEntornoEsSeguro() {
  if (esEntornoTesting()) return true;
  Logger.log("🛑 ABORTADO: el harness E2E solo corre con la Script Property ENVIRONMENT en \"TESTING\".");
  Logger.log("   Este proyecto NO está en TESTING, así que crear tickets o subir archivos impactaría clientes reales.");
  return false;
}

/** Devuelve el runId de la última corrida preparada, o null. */
function _e2eRunIdActual(runId) {
  if (runId) return String(runId);
  const guardado = PropertiesService.getScriptProperties().getProperty(E2E_PROPIEDAD_RUN_ID);
  if (!guardado) {
    Logger.log(`[E2E] No hay ninguna corrida registrada. Ejecutá primero manual_e2e_prepararEntorno().`);
    return null;
  }
  return guardado;
}

/**
 * Arma el plan de la corrida. Dos modos MUTUAMENTE EXCLUYENTES (ver la nota "CASOS BORDE" al
 * principio del archivo — no se pueden mezclar porque colisionan en la misma Tarea Programada):
 *
 *  - E2E_FILTRO_CASO vacío (default): un fixture "normal" por processor (30 en total, o 1 si
 *    E2E_FILTRO_TAREA está seteado). Cada uno tiene su propia Tarea Programada: sin colisión.
 *  - E2E_FILTRO_CASO con un valor: UN solo caso borde, sobre la(s) tarea(s) que le
 *    correspondan (acotado además por E2E_FILTRO_TAREA si también está seteado).
 */
function _e2ePlanDeCorrida() {
  const filtroTarea = String(E2E_FILTRO_TAREA || "").trim();
  const filtroCaso = String(E2E_FILTRO_CASO || "").trim();

  if (filtroCaso) {
    const casosBorde = obtenerCasosBorde();
    const fixture = casosBorde[filtroCaso];
    if (!fixture) {
      Logger.log(`[E2E] ⚠️ E2E_FILTRO_CASO="${filtroCaso}" no existe en obtenerCasosBorde() (tests/E2EFixtures.js).`);
      return [];
    }
    const tareas = (E2E_CASOS_BORDE_APLICAN_A[filtroCaso] || []).filter(function (t) {
      return !filtroTarea || t === filtroTarea;
    });
    if (tareas.length === 0) {
      Logger.log(`[E2E] ⚠️ El caso "${filtroCaso}" no aplica a la tarea "${filtroTarea}" (revisá E2E_CASOS_BORDE_APLICAN_A).`);
    }
    return tareas.map(function (tarea) {
      return { id: `${tarea}::${filtroCaso}`, tarea: tarea, caso: filtroCaso, fixture: fixture, esperado: fixture.esperado };
    });
  }

  const plan = [];
  Object.keys(E2E_FIXTURES).forEach(function (tarea) {
    if (filtroTarea && tarea !== filtroTarea) return;
    plan.push({
      id: tarea,
      tarea: tarea,
      caso: "normal",
      fixture: E2E_FIXTURES[tarea],
      esperado: { etiqueta: OPS_LABEL_PROCESADO, cierraTarea: true, subeADrive: !E2E_TAREAS_SIN_PASO_DRIVE[tarea] }
    });
  });

  if (filtroTarea && plan.length === 0) {
    Logger.log(`[E2E] ⚠️ E2E_FILTRO_TAREA="${filtroTarea}" no coincide con ninguna fixture: revisá el nombre exacto en E2EFixtures.js.`);
  }

  return plan;
}

// =================================================================
// 1. PREPARAR (arrange)
// =================================================================

/**
 * Deja el entorno listo para una corrida E2E:
 *   - borra la carpeta de Drive del día del cliente de testing (para poder verificar la subida),
 *   - se asegura de que exista la Tarea Programada de cada reporte en Jira,
 *   - manda los correos de prueba con sus adjuntos.
 *
 * @param {string} [runId] Identificador de la corrida. Si se omite se genera uno con la hora.
 * @returns {string|null} El runId usado, o null si no se pudo preparar.
 */
function manual_e2e_prepararEntorno(runId) {
  if (!_e2eEntornoEsSeguro()) return null;

  const id = runId || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  PropertiesService.getScriptProperties().setProperty(E2E_PROPIEDAD_RUN_ID, id);

  Logger.log(`=== PREPARANDO ENTORNO E2E — corrida "${id}" ===`);
  Logger.log(`Cliente de seguridad: "${TESTING_SAFETY_CLIENT_NAME}" (todo se redirige ahí)`);

  const plan = _e2ePlanDeCorrida();

  _e2eBorrarCarpetaDelDia();
  const tareasCreadas = _e2eAsegurarTareasProgramadas(plan);
  const enviados = _e2eEnviarCorreos(plan, id);

  Logger.log(`\n=== ENTORNO LISTO ===`);
  Logger.log(`   Tareas Programadas: ${tareasCreadas.creadas} creadas, ${tareasCreadas.reutilizadas} ya existían`);
  Logger.log(`   Correos enviados: ${enviados}`);
  Logger.log(`\nSiguiente paso: manual_e2e_dispararRapido() o manual_e2e_dispararCicloReal().`);
  Logger.log(`Gmail tarda unos segundos en entregar los correos: si el disparo no ve nada, esperá y repetilo.`);

  return id;
}

/**
 * Manda a la papelera la carpeta del día dentro del cliente de testing.
 *
 * Sin esto no se puede verificar la subida: crearArchivoSiNoExiste() es idempotente, así que
 * si el archivo de una corrida anterior sigue ahí, esta corrida lo omite y el test no
 * distingue "se subió bien" de "ya estaba".
 */
function _e2eBorrarCarpetaDelDia() {
  const nombreCarpeta = formatearFechaParaNombre(new Date());
  try {
    const indice = DriveClientIndexSingleton.get();
    const entrada = DriveClientIndexSingleton.resolverEntradaDeTesting();
    if (!indice.carpetaBase || !entrada) {
      Logger.log(`[E2E] No se pudo resolver la carpeta de "${TESTING_SAFETY_CLIENT_NAME}": se omite el borrado de la carpeta del día.`);
      return;
    }

    const carpetaCliente = entrada.tipo === 'adjunto'
      ? DriveApp.getFolderById(entrada.carpetaId)
      : obtenerOCrearCarpeta(indice.carpetaBase, entrada.nombreCliente);

    const carpetas = carpetaCliente.getFoldersByName(nombreCarpeta);
    if (!carpetas.hasNext()) {
      Logger.log(`[E2E] La carpeta del día "${nombreCarpeta}" no existía: nada que borrar.`);
      return;
    }
    while (carpetas.hasNext()) {
      carpetas.next().setTrashed(true);
    }
    Logger.log(`[E2E] Carpeta del día "${nombreCarpeta}" enviada a la papelera (se recrea al archivar).`);
  } catch (e) {
    Logger.log(`[E2E] No se pudo borrar la carpeta del día "${nombreCarpeta}": ${e.message}`);
  }
}

/**
 * Se asegura de que exista, abierta, la Tarea Programada de cada reporte del plan.
 *
 * El summary del ticket queda EXACTAMENTE igual al scheduledTaskName del processor, sin el
 * runId: buscarYCerrarTareaProgramada() busca por nombre exacto y no la encontraría. El runId
 * viaja en la descripción, que es lo que después usa la limpieza para identificarlas.
 */
function _e2eAsegurarTareasProgramadas(plan) {
  const resultado = { creadas: 0, reutilizadas: 0 };
  const projectKey = _e2eProjectKeyDeTesting();
  if (!projectKey) return resultado;

  const abiertas = _buscarTareasProgramadasAbiertas(projectKey);
  const nombresAbiertos = abiertas.map(function (t) { return t.summary.trim().toLowerCase(); });

  const necesarias = {};
  plan.forEach(function (item) {
    // Los casos que no deben cerrar tarea igual la necesitan abierta: es justamente lo que
    // se verifica después (que siga abierta).
    const processor = obtenerProcessorDeTarea(item.tarea);
    if (processor && processor.scheduledTaskName) necesarias[processor.scheduledTaskName] = true;
  });

  Object.keys(necesarias).forEach(function (nombreTarea) {
    if (nombresAbiertos.indexOf(nombreTarea.trim().toLowerCase()) !== -1) {
      Logger.log(`[E2E] Tarea Programada "${nombreTarea}" ya estaba abierta: se reutiliza.`);
      resultado.reutilizadas++;
      return;
    }
    const descripcion = `Tarea Programada generada por el harness E2E ${E2E_PREFIJO_MARCADOR(PropertiesService.getScriptProperties().getProperty(E2E_PROPIEDAD_RUN_ID))}]. Se cierra con manual_e2e_limpiar().`;
    const key = _e2eCrearTareaProgramada(nombreTarea, projectKey, descripcion);
    if (key) {
      Logger.log(`[E2E] Tarea Programada "${nombreTarea}" creada: ${key}`);
      resultado.creadas++;
    }
    Utilities.sleep(300); // No saturar la API de Jira.
  });

  return resultado;
}

/**
 * Crea una Tarea Programada de prueba en el proyecto de testing.
 * Reemplaza a crearTareaProgramadaDePrueba() de custom/Debug.js, que apuntaba a un projectKey
 * hardcodeado y no dejaba rastro del runId.
 *
 * La descripción se recibe por parámetro (en vez de armarse acá adentro) para que otros tests
 * E2E puedan reusar esta función con su propio runId/marcador — ver
 * tests/E2EReintentoErrorTest.js, que no comparte E2E_PROPIEDAD_RUN_ID con este harness.
 *
 * @returns {string|null} Clave del ticket creado.
 */
function _e2eCrearTareaProgramada(summary, projectKey, descripcion) {
  const payload = {
    "fields": {
      "project": { "key": projectKey },
      "summary": summary,
      "description": descripcion,
      "issuetype": { "name": "Tarea Programada" },
      "customfield_12316": { "value": "VMware vSphere" }
    }
  };
  const options = {
    "method": "post", "contentType": "application/json",
    "headers": getJiraHeaders(),
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  };
  try {
    const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/2/issue`, options);
    const codigo = respuesta.getResponseCode();
    if (codigo >= 200 && codigo < 300) {
      return JSON.parse(respuesta.getContentText()).key;
    }
    Logger.log(`[E2E] Jira rechazó la creación de "${summary}" (HTTP ${codigo}): ${respuesta.getContentText()}`);
    return null;
  } catch (e) {
    Logger.log(`[E2E] Excepción al crear la Tarea Programada "${summary}": ${e.message}`);
    return null;
  }
}

/** Envía los correos de prueba del plan a la casilla del usuario activo. */
function _e2eEnviarCorreos(plan, runId) {
  const destinatario = Session.getActiveUser().getEmail();
  Logger.log(`[E2E] Enviando ${plan.length} correo(s) de prueba a ${destinatario}...`);

  let enviados = 0;
  plan.forEach(function (item) {
    // Caso con envíos distintos entre sí (ej. adjuntoNuevoEnSegundoEnvio): un correo por
    // envío, cada uno con sus propios adjuntos — no es "repetir el mismo correo N veces".
    if (item.fixture.envios) {
      const correos = construirEnviosDeFixture(item.tarea, item.fixture, runId, item.caso);
      correos.forEach(function (correo) {
        try {
          GmailApp.sendEmail(destinatario, correo.asunto, `Reporte simulado del harness E2E (caso "${item.caso}").`, {
            attachments: correo.blobs
          });
          enviados++;
        } catch (e) {
          Logger.log(`[E2E] ❌ No se pudo enviar un envío de "${item.id}": ${e.message}`);
        }
        Utilities.sleep(600);
      });
      return;
    }

    const correo = construirCorreoDeFixture(item.tarea, item.fixture, runId, item.caso);
    if (!correo) return;

    const veces = item.fixture.repeticiones || 1;
    for (let i = 0; i < veces; i++) {
      try {
        // Se usa GmailApp directo y NO sendEmail(): sendEmail() redirige el destinatario en
        // TESTING, y acá el correo tiene que llegar a la propia casilla para que el pipeline
        // lo levante. El destinatario ya es el usuario que ejecuta, así que no hay riesgo.
        GmailApp.sendEmail(destinatario, correo.asunto, `Reporte simulado del harness E2E (caso "${item.caso}").`, {
          attachments: [correo.blob]
        });
        enviados++;
      } catch (e) {
        Logger.log(`[E2E] ❌ No se pudo enviar "${item.id}": ${e.message}`);
      }
      Utilities.sleep(600);
    }
  });

  return enviados;
}

/**
 * Tareas Programadas ABIERTAS que creó esta corrida, identificadas por el marcador que el
 * harness deja en la descripción del ticket. El summary no sirve para esto: tiene que ser el
 * nombre exacto del reporte para que buscarYCerrarTareaProgramada() lo encuentre, así que no
 * puede llevar el runId.
 * @returns {Array<{key: string, summary: string}>}
 */
function _e2eTareasDeLaCorrida(projectKey, runId) {
  const payload = {
    jql: `project = "${projectKey}" AND issuetype = "Tarea Programada" AND statusCategory != Done AND description ~ "${runId}" ORDER BY created DESC`,
    maxResults: 100,
    fields: ["key", "summary"]
  };
  const options = {
    method: "post", contentType: "application/json", headers: getJiraHeaders(),
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  try {
    const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/search/jql`, options);
    if (respuesta.getResponseCode() !== 200) {
      Logger.log(`[E2E] No se pudieron buscar las tareas de la corrida "${runId}" (HTTP ${respuesta.getResponseCode()}). No se cierra nada por las dudas.`);
      return [];
    }
    const data = JSON.parse(respuesta.getContentText());
    return (data.issues || []).map(function (i) { return { key: i.key, summary: i.fields.summary }; });
  } catch (e) {
    Logger.log(`[E2E] Excepción buscando las tareas de la corrida "${runId}": ${e.message}. No se cierra nada.`);
    return [];
  }
}

/**
 * Lista (solo lectura) los tickets abiertos del proyecto de testing que NO son Tareas
 * Programadas y se tocaron hoy — candidatos a ser tickets de alerta generados por una corrida
 * del harness. Es un aviso, no un cierre: ver el comentario en manual_e2e_limpiar().
 */
function _e2eAvisarTicketsDeAlerta(projectKey) {
  const hoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const payload = {
    jql: `project = "${projectKey}" AND issuetype != "Tarea Programada" AND statusCategory != Done AND updated >= "${hoy}" ORDER BY created DESC`,
    maxResults: 50,
    fields: ["key", "summary"]
  };
  const options = {
    method: "post", contentType: "application/json", headers: getJiraHeaders(),
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  try {
    const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/search/jql`, options);
    if (respuesta.getResponseCode() !== 200) {
      Logger.log(`[E2E] No se pudo consultar tickets de alerta abiertos hoy (HTTP ${respuesta.getResponseCode()}).`);
      return;
    }
    const issues = (JSON.parse(respuesta.getContentText()).issues || []);
    if (issues.length === 0) {
      Logger.log(`   No hay tickets de alerta (no-Tarea Programada) abiertos hoy en el proyecto de testing.`);
      return;
    }
    Logger.log(`   ⚠️ ${issues.length} ticket(s) de alerta abierto(s) hoy en "${projectKey}" — probablemente generados por corridas del harness. Revisar y cerrar A MANO si corresponde (no se tocan solos):`);
    issues.forEach(function (i) { Logger.log(`      ${i.key} — ${i.fields.summary}`); });
  } catch (e) {
    Logger.log(`[E2E] Excepción consultando tickets de alerta: ${e.message}`);
  }
}

/**
 * Busca tickets de ALERTA (no Tareas Programadas) creados HOY cuyo summary coincida con el que
 * genera un processor. Es la contraparte verificable de `esperado.creaTicket`: hasta ahora el
 * harness sabía comprobar la etiqueta, Drive y el cierre de la Tarea Programada, pero no si se
 * había creado un ticket de más — que es justo la forma que tomó PTRNSNR-12069.
 *
 * Se acota por `created >= hoy` porque el summary es fijo por processor y no lleva el runId: un
 * ticket que quedó abierto de una corrida anterior del MISMO día se cuenta igual. Si eso pasa,
 * cerralos antes de correr (manual_e2e_limpiar() los lista, y manual_CerrarTicketsTesting() de
 * custom/HerramientasManuales.js los cierra en bloque).
 *
 * @param {string} projectKey Proyecto de Jira del cliente de testing.
 * @param {string} summary Summary exacto que usaría el processor al crear el ticket.
 * @returns {Array<{key: string, summary: string}>} Tickets encontrados (vacío si ninguno).
 */
function _e2eTicketsDeAlertaPorSummary(projectKey, summary) {
  if (!projectKey || !summary) return [];

  const hoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const jql = `project = "${projectKey}" AND issuetype != "Tarea Programada" `
    + `AND summary ~ "${String(summary).replace(/"/g, '\\"')}" AND created >= "${hoy}" ORDER BY created DESC`;

  const options = {
    method: "post", contentType: "application/json", headers: getJiraHeaders(),
    payload: JSON.stringify({ jql: jql, maxResults: 50, fields: ["key", "summary"] }),
    muteHttpExceptions: true
  };

  try {
    const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/search/jql`, options);
    if (respuesta.getResponseCode() !== 200) {
      Logger.log(`[E2E] No se pudo consultar tickets con summary "${summary}" (HTTP ${respuesta.getResponseCode()}).`);
      return [];
    }
    return (JSON.parse(respuesta.getContentText()).issues || []).map(function (i) {
      return { key: i.key, summary: i.fields.summary };
    });
  } catch (e) {
    Logger.log(`[E2E] Excepción consultando tickets con summary "${summary}": ${e.message}`);
    return [];
  }
}

/**
 * Chequea `esperado.creaTicket` contra Jira. No hace nada si la fixture no lo declara, así que
 * los casos a los que no les importa el ticket quedan igual que antes.
 */
function _e2eChequearTicketDeAlerta(item, projectKey, chequear) {
  const esperado = item.esperado || {};
  if (esperado.creaTicket === undefined || esperado.creaTicket === null) return;

  const summary = esperado.ticketSummary;
  if (!summary) {
    chequear(false, `${item.id}: la fixture declara creaTicket pero no 'ticketSummary', así que no hay nada que buscar en Jira`);
    return;
  }

  const encontrados = _e2eTicketsDeAlertaPorSummary(projectKey, summary);
  const detalle = encontrados.map(function (t) { return t.key; }).join(", ") || "ninguno";

  chequear(
    (encontrados.length > 0) === !!esperado.creaTicket,
    `${item.id}: se esperaba que ${esperado.creaTicket ? "SÍ" : "NO"} se creara un ticket "${summary}" y se encontraron ${encontrados.length} (${detalle})`
  );
}

/** Project key de Jira del cliente de testing, según el Índice Maestro. */
function _e2eProjectKeyDeTesting() {
  const config = getClientConfigByName(TESTING_SAFETY_CLIENT_NAME, "E2E");
  if (config && config.jiraProjectKey) return config.jiraProjectKey;
  Logger.log(`[E2E] No se pudo resolver el proyecto de Jira de "${TESTING_SAFETY_CLIENT_NAME}" en el Índice Maestro.`);
  return null;
}

// =================================================================
// 2. DISPARAR (act)
// =================================================================

/**
 * Corre cada processor del registro directamente, salteando las guardas del ciclo
 * (día laborable, feriado, ventana horaria, lock). Es el modo para iterar mientras se codea:
 * anda a cualquier hora y termina en una sola ejecución.
 */
function manual_e2e_dispararRapido() {
  if (!_e2eEntornoEsSeguro()) return;

  const filtro = String(E2E_FILTRO_TAREA || "").trim();
  // El catch-all ("Reportes sin processor") no filtra por asunto: se queda con TODO lo que
  // esté pendiente y nadie reclamó, incluidos correos reales sin relación con este harness
  // (ej. copias de reportes operativos que reciba la bandeja). El blindaje de TESTING evita
  // que toquen la carpeta de un cliente real, pero igual los archivaría y marcaría procesados
  // como si fueran parte del test. Se excluye acá; dispararCicloReal() SÍ lo incluye, porque
  // ese modo corre el entrypoint real tal cual es a propósito.
  const registro = obtenerRegistroDeProcesadores()
    .filter(function (e) { return e.tarea !== 'processReportesSinProcessorEmails'; })
    .filter(function (e) { return !filtro || e.tarea === filtro; });

  if (filtro && registro.length === 0) {
    Logger.log(`[E2E] ⚠️ E2E_FILTRO_TAREA="${filtro}" no coincide con ninguna tarea del registro (core/Main.js).`);
    return;
  }

  Logger.log(`=== DISPARO RÁPIDO — ${registro.length} processor(s)${filtro ? ` (acotado a "${filtro}")` : ""} (sin guardas de horario/feriado/lock) ===`);

  registro.forEach(function (entrada, i) {
    try {
      Logger.log(`==> [${i + 1}/${registro.length}] ${entrada.tarea}`);
      entrada.crear().processEmails();
    } catch (e) {
      Logger.log(`### ERROR en ${entrada.tarea}: ${e.message} | Stack: ${e.stack}`);
    }
  });

  Logger.log(`\n=== DISPARO RÁPIDO TERMINADO — siguiente: manual_e2e_verificar() ===`);
}

/**
 * Dispara el ciclo real de producción, tal cual lo ejecuta el trigger.
 *
 * A diferencia del disparo rápido, respeta TODAS las guardas: no hace nada un fin de semana
 * ni un feriado, y si el lote se pasa de 15 minutos se re-agenda solo con un trigger y sigue
 * en otra ejecución (mirar los logs de las ejecuciones siguientes, no solo el de esta).
 * Es el modo fiel para usar como gate antes de un release.
 */
function manual_e2e_dispararCicloReal() {
  if (!_e2eEntornoEsSeguro()) return;

  const ahora = new Date();
  const diaDeLaSemana = ahora.getDay();
  if (diaDeLaSemana < 1 || diaDeLaSemana > 5) {
    Logger.log(`⚠️ Hoy es fin de semana: ejecutarCicloDeOperaciones() va a salir sin procesar nada.`);
    Logger.log(`   Para probar igual, usá manual_e2e_dispararRapido().`);
  }

  Logger.log(`=== DISPARO DEL CICLO REAL (ejecutarCicloDeOperaciones) ===`);
  Logger.log(`   Ventana operativa configurada: ${HORA_INICIO}-${HORA_FIN}hs | Hora actual: ${ahora.getHours()}hs`);
  Logger.log(`   Si el lote corta por tiempo, el ciclo se re-agenda solo: revisá las ejecuciones siguientes.`);
  Logger.log(`   ⚠️ Este modo corre el ciclo real completo, incluido el catch-all "Reportes sin`);
  Logger.log(`   processor": va a archivar TAMBIÉN cualquier correo real pendiente sin relación con`);
  Logger.log(`   este harness (el blindaje de TESTING evita tocar la carpeta de un cliente real,`);
  Logger.log(`   pero igual los marca procesados). Es intencional — es el entrypoint real tal cual.`);

  ejecutarCicloDeOperaciones();

  Logger.log(`\n=== CICLO DISPARADO — siguiente: manual_e2e_verificar() ===`);
  Logger.log(`⚠️ Antes de verificar, confirmá en el panel de Ejecuciones que no quedaron corridas encadenadas pendientes.`);
  Logger.log(`   Para cortar las que hayan quedado agendadas: detenerTodosLosActivadores().`);
}

// =================================================================
// 3. VERIFICAR (assert) — solo lectura, no modifica nada
// =================================================================

/**
 * Verifica un caso borde de múltiples envíos (fixture.envios): confirma que llegaron TODOS los
 * correos esperados, que TODOS los archivos de TODOS los envíos terminaron en Drive exactamente
 * una vez (sin duplicar los que se repiten entre envíos, ej. el PDF que va en los dos), y el
 * cierre de la Tarea Programada — mismos tres chequeos que el camino normal, pero sumando
 * varios envíos en vez de uno solo.
 */
function _e2eVerificarEnvios(item, runId, hilos, archivosEnDrive, nombresAbiertos, chequear, projectKey) {
  // soloMetadatos: acá alcanza con los nombres, no hace falta volver a generar los adjuntos.
  const correos = construirEnviosDeFixture(item.tarea, item.fixture, runId, item.caso, true);
  if (correos.length === 0) return;

  Logger.log(`\n--- ${item.id} (caso "${item.caso}", ${correos.length} envío(s)) ---`);

  const asunto = correos[0].asunto;
  const hilosDelCaso = hilos.filter(function (h) {
    return h.asunto.indexOf(String(asunto).toLowerCase()) !== -1;
  });

  if (!chequear(hilosDelCaso.length === correos.length,
    `${item.id}: se esperaban ${correos.length} correo(s) en Gmail y se encontraron ${hilosDelCaso.length}`)) {
    return;
  }

  if (item.esperado.etiqueta !== null) {
    const todosConLaEtiqueta = hilosDelCaso.every(function (h) { return h.etiquetas.indexOf(item.esperado.etiqueta) !== -1; });
    const vistas = hilosDelCaso.map(function (h) { return h.etiquetas.join("+") || "sin etiqueta"; }).join(", ");
    chequear(todosConLaEtiqueta, `${item.id}: no todos los correos terminaron en [${item.esperado.etiqueta}] (se vio: [${vistas}])`);
  }

  // El mismo adjunto puede repetirse entre envíos (ej. el PDF que va en los dos): se
  // deduplica por nombre antes de pedir "exactamente 1 copia en Drive" para cada uno.
  const nombresEsperados = Array.from(new Set(correos.reduce(function (acc, c) { return acc.concat(c.nombresArchivo); }, [])));
  nombresEsperados.forEach(function (nombreArchivo) {
    const baseEsperada = _e2eSinExtension(nombreArchivo);
    const copias = archivosEnDrive.filter(function (n) { return _e2eSinExtension(n) === baseEsperada; }).length;
    if (item.esperado.subeADrive) {
      chequear(copias === 1, `${item.id}: "${baseEsperada}" debería estar en Drive exactamente 1 vez y aparece ${copias}`);
    } else {
      chequear(copias === 0, `${item.id}: "${baseEsperada}" NO debería estar en Drive y aparece ${copias} vez/veces`);
    }
  });

  const scheduledTaskName = correos[0].scheduledTaskName;
  if (scheduledTaskName && item.esperado.cierraTarea !== null) {
    const sigueAbierta = nombresAbiertos.indexOf(scheduledTaskName.trim().toLowerCase()) !== -1;
    chequear(
      sigueAbierta === !item.esperado.cierraTarea,
      `${item.id}: la Tarea Programada "${scheduledTaskName}" ${sigueAbierta ? "sigue abierta" : "se cerró"} y se esperaba lo contrario`
    );
  }

  _e2eChequearTicketDeAlerta(item, projectKey, chequear);
}

/**
 * Compara el estado real de Gmail, Jira y Drive contra lo que cada fixture esperaba.
 * No modifica ni borra nada: para eso está manual_e2e_limpiar().
 *
 * @param {string} [runId] Corrida a verificar. Por defecto, la última preparada.
 */
function manual_e2e_verificar(runId) {
  if (!_e2eEntornoEsSeguro()) return null;

  const id = _e2eRunIdActual(runId);
  if (!id) return null;

  Logger.log(`=== VERIFICACIÓN E2E — corrida "${id}" ===`);

  const plan = _e2ePlanDeCorrida();
  const hilos = _e2eHilosDeLaCorrida(id);
  const archivosEnDrive = _e2eArchivosDeLaCarpetaDelDia();
  const projectKey = _e2eProjectKeyDeTesting();
  const tareasAbiertas = projectKey ? _buscarTareasProgramadasAbiertas(projectKey) : [];
  const nombresAbiertos = tareasAbiertas.map(function (t) { return t.summary.trim().toLowerCase(); });

  let pasaron = 0, fallaron = 0;
  const fallos = [];

  function chequear(condicion, descripcion) {
    if (condicion) {
      pasaron++;
      return true;
    }
    fallaron++;
    fallos.push(descripcion);
    Logger.log(`   ❌ ${descripcion}`);
    return false;
  }

  plan.forEach(function (item) {
    if (item.fixture.envios) {
      _e2eVerificarEnvios(item, id, hilos, archivosEnDrive, nombresAbiertos, chequear, projectKey);
      return;
    }

    const correo = construirCorreoDeFixture(item.tarea, item.fixture, id, item.caso);
    if (!correo) return;

    Logger.log(`\n--- ${item.id} (caso "${item.caso}") ---`);

    // 1. Gmail: ¿en qué etiqueta terminó el hilo?
    const hilosDelCaso = hilos.filter(function (h) {
      return h.asunto.indexOf(String(correo.asunto).toLowerCase()) !== -1;
    });

    if (!chequear(hilosDelCaso.length > 0, `${item.id}: no se encontró el correo en Gmail (¿se envió? ¿ya se procesó el ciclo?)`)) {
      return;
    }

    // etiqueta === null es un opt-out explícito: casos como "duplicado" mandan el mismo
    // asunto dos veces y cada copia puede terminar en una etiqueta distinta y legítima
    // (la primera cierra la tarea, la segunda da NOT_FOUND), así que no hay una única
    // etiqueta "correcta" que verificar acá.
    if (item.esperado.etiqueta !== null) {
      const etiquetas = hilosDelCaso[0].etiquetas;
      chequear(
        etiquetas.indexOf(item.esperado.etiqueta) !== -1,
        `${item.id}: se esperaba la etiqueta ${item.esperado.etiqueta} y quedó en [${etiquetas.join(", ") || "sin etiqueta"}]`
      );
    }

    // 2. Drive: ¿se archivó el adjunto?
    // El pipeline convierte CSV/JSON a XLSX al archivar, así que se compara sin extensión.
    const baseEsperada = _e2eSinExtension(correo.nombreArchivo);
    const estaEnDrive = archivosEnDrive.some(function (n) { return _e2eSinExtension(n) === baseEsperada; });
    chequear(
      estaEnDrive === !!item.esperado.subeADrive,
      `${item.id}: se esperaba ${item.esperado.subeADrive ? "" : "NO "}encontrar "${baseEsperada}" en la carpeta del día de Drive`
    );

    if (item.esperado.sinDuplicadosEnDrive) {
      const copias = archivosEnDrive.filter(function (n) { return _e2eSinExtension(n) === baseEsperada; }).length;
      chequear(copias <= 1, `${item.id}: el reporte se archivó ${copias} veces en Drive (debería ser idempotente y quedar una sola copia)`);
    }

    // 3. Jira: ¿la Tarea Programada quedó cerrada? (null = opt-out, ver nota de "etiqueta" arriba)
    if (correo.scheduledTaskName && item.esperado.cierraTarea !== null) {
      const sigueAbierta = nombresAbiertos.indexOf(correo.scheduledTaskName.trim().toLowerCase()) !== -1;
      chequear(
        sigueAbierta === !item.esperado.cierraTarea,
        `${item.id}: la Tarea Programada "${correo.scheduledTaskName}" ${sigueAbierta ? "sigue abierta" : "se cerró"} y se esperaba lo contrario`
      );
    }

    // 4. Jira: ¿se creó un ticket de alerta que no correspondía (o falta el que sí)?
    _e2eChequearTicketDeAlerta(item, projectKey, chequear);
  });

  Logger.log(`\n=== RESULTADO: ${pasaron} chequeos OK, ${fallaron} fallidos ===`);
  if (fallaron > 0) {
    Logger.log(`\n--- Fallos ---`);
    fallos.forEach(function (f) { Logger.log(`   ❌ ${f}`); });
  }
  Logger.log(`\nCuando termines de revisar: manual_e2e_limpiar().`);

  return { pasaron, fallaron, fallos };
}

/**
 * Hilos de Gmail de una corrida, con sus etiquetas.
 * @returns {Array<{asunto: string, etiquetas: Array<string>, hilo: Object}>}
 */
function _e2eHilosDeLaCorrida(runId) {
  const prefijo = E2E_PREFIJO_MARCADOR(runId).toLowerCase();
  // El marcador va entre corchetes y con ':', que Gmail trata como separadores, así que se
  // busca por el runId (suficientemente único) y se filtra en memoria por el marcador exacto.
  const hilos = GmailApp.search(`subject:"${runId}"`, 0, 300);
  Logger.log(`[E2E] ${hilos.length} hilo(s) encontrados para la corrida "${runId}".`);

  return hilos
    .map(function (hilo) {
      const msg = hilo.getMessages()[hilo.getMessageCount() - 1];
      return {
        asunto: msg.getSubject().toLowerCase(),
        etiquetas: hilo.getLabels().map(function (l) { return l.getName(); }),
        hilo: hilo
      };
    })
    .filter(function (h) { return h.asunto.indexOf(prefijo) !== -1; });
}

/** Nombres de los archivos que hay hoy en la carpeta del día del cliente de testing. */
function _e2eArchivosDeLaCarpetaDelDia() {
  const nombres = [];
  const nombreCarpeta = formatearFechaParaNombre(new Date());
  try {
    const indice = DriveClientIndexSingleton.get();
    const entrada = DriveClientIndexSingleton.resolverEntradaDeTesting();
    if (!indice.carpetaBase || !entrada) return nombres;

    const carpetaCliente = entrada.tipo === 'adjunto'
      ? DriveApp.getFolderById(entrada.carpetaId)
      : obtenerOCrearCarpeta(indice.carpetaBase, entrada.nombreCliente);

    const carpetas = carpetaCliente.getFoldersByName(nombreCarpeta);
    if (!carpetas.hasNext()) {
      Logger.log(`[E2E] La carpeta del día "${nombreCarpeta}" no existe: no se archivó nada.`);
      return nombres;
    }

    const archivos = carpetas.next().getFiles();
    while (archivos.hasNext()) nombres.push(archivos.next().getName());
    Logger.log(`[E2E] ${nombres.length} archivo(s) en la carpeta del día "${nombreCarpeta}".`);
  } catch (e) {
    Logger.log(`[E2E] No se pudo leer la carpeta del día: ${e.message}`);
  }
  return nombres;
}

/** Quita la extensión de un nombre de archivo (el pipeline convierte CSV/JSON a XLSX al archivar). */
function _e2eSinExtension(nombre) {
  return String(nombre).replace(/\.[^.]+$/, "").trim().toLowerCase();
}

// =================================================================
// 4. LIMPIAR — manual y explícito, nunca automático
// =================================================================

/**
 * Deja Gmail, Jira y Drive como estaban antes de la corrida.
 *
 * Es una función aparte y NO se llama sola desde manual_e2e_verificar(): después de una
 * corrida fallida el estado es justamente la evidencia para diagnosticar, y borrarlo
 * automáticamente sería tirar la información que se necesita.
 *
 * @param {string} [runId] Corrida a limpiar. Por defecto, la última preparada.
 */
function manual_e2e_limpiar(runId) {
  if (!_e2eEntornoEsSeguro()) return;

  const id = _e2eRunIdActual(runId);
  if (!id) return;

  Logger.log(`=== LIMPIEZA E2E — corrida "${id}" ===`);

  // 1. Gmail: se archivan los hilos (no se borran: si algo salió mal, siguen siendo evidencia).
  const hilos = _e2eHilosDeLaCorrida(id);
  let archivados = 0;
  hilos.forEach(function (h) {
    try {
      h.hilo.markRead();
      h.hilo.moveToArchive();
      archivados++;
    } catch (e) {
      Logger.log(`[E2E] No se pudo archivar un hilo: ${e.message}`);
    }
  });
  Logger.log(`   ${archivados} hilo(s) de Gmail archivados.`);

  // 2. Jira: se cierran SOLO las Tareas Programadas creadas por esta corrida.
  // Se identifican por el marcador que el harness dejó en su descripción, nunca por "todo lo
  // que esté abierto": aunque esto sea el proyecto de testing, cerrar en bloque es el patrón
  // que AGENTS.md §8 prohíbe, y ahí también puede haber tickets de trabajo real de alguien.
  const projectKey = _e2eProjectKeyDeTesting();
  let cerradas = 0, noCerradas = 0;
  if (projectKey) {
    const propias = _e2eTareasDeLaCorrida(projectKey, id);
    Logger.log(`   ${propias.length} Tarea(s) Programada(s) de esta corrida siguen abiertas.`);
    propias.forEach(function (tarea) {
      const resultado = resolveJiraTicket(tarea.key, JIRA_STATUS_TO_CLOSE);
      if (resultado && resultado.status === 'SUCCESS') {
        cerradas++;
      } else {
        noCerradas++;
        Logger.log(`   ⚠️ No se pudo cerrar ${tarea.key} — ${tarea.summary}`);
      }
      Utilities.sleep(300);
    });
  }
  Logger.log(`   Tareas Programadas: ${cerradas} cerradas, ${noCerradas} sin cerrar.`);

  // 3. Jira: AVISO (no auto-cierra) sobre tickets de alerta reales que haya creado el pipeline
  // (ej. "Se detectaron VMs Inaccesibles"). A diferencia de las Tareas Programadas, el harness
  // no controla su creación y cada processor arma el summary distinto (algunos vía
  // ticketSummary, otros lo hardcodean en su propio handleAlerts()), así que no hay forma
  // confiable de identificar cuáles son "de esta corrida". Cerrarlos en bloque por estar
  // abiertos en el proyecto de testing es exactamente el patrón que prohíbe AGENTS.md §8:
  // se listan para revisión manual, nunca se tocan solos.
  if (projectKey) _e2eAvisarTicketsDeAlerta(projectKey);

  // 4. Drive: se borra la carpeta del día para que la próxima corrida arranque limpia.
  _e2eBorrarCarpetaDelDia();

  PropertiesService.getScriptProperties().deleteProperty(E2E_PROPIEDAD_RUN_ID);
  Logger.log(`\n=== LIMPIEZA TERMINADA ===`);
}
