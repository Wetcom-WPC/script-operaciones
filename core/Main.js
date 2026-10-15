/**
 * =================================================================
 * DESPACHADOR INTELIGENTE POR LOTES - VERSIÓN LIMPIA (SIN TRACKER)
 * =================================================================
 */

/**
 * REGISTRO DE PROCESSORS — fuente única de verdad del pipeline.
 *
 * Para agregar un reporte nuevo alcanza con sumar una entrada acá: de este registro se derivan
 * tanto el orden de ejecución del ciclo como los asuntos "reclamados" que usa el catch-all
 * (`ReportesSinProcessor`) para saber qué NO le corresponde. Antes eran dos listas separadas y
 * mantenerlas sincronizadas a mano era un bug esperando a pasar (AGENTS.md §5).
 *
 * Es una función y no una constante a propósito: en Apps Script todos los archivos comparten
 * un scope global y las clases/constantes de otros archivos pueden no estar inicializadas
 * todavía al evaluar el nivel superior. Instanciar recién al ejecutar evita ese problema.
 *
 * `crear` devuelve la instancia; `tarea` es el nombre de la función de entrada equivalente,
 * que se sigue usando desde HerramientasManuales y para ejecutar una operación suelta.
 *
 * @returns {Array<{tarea: string, crear: Function}>}
 */
function obtenerRegistroDeProcesadores() {
  return [
    { tarea: 'processAffinityRulesEmails',        crear: () => new AffinityRulesProcessor() },
    { tarea: 'processVsphereEmails',              crear: () => new VsphereAlertsProcessor() },
    { tarea: 'processVropsEmails',                crear: () => new VROpsProcessor() },
    { tarea: 'processPartitionEmails',            crear: () => new PartitionProcessor() },
    { tarea: 'processClusterDRSEmails',           crear: () => new ClusterDRSProcessor() },
    { tarea: 'processStorageDRSEmails',           crear: () => new StorageDRSProcessor() },
    { tarea: 'processViewEmails',                 crear: () => new ComponentesDeViewProcessor() },
    { tarea: 'processDISCOSMONTADOSRulesEmails',  crear: () => new DiscosMontadosProcessor() },
    { tarea: 'processDatastoreSpaceEmails',       crear: () => new EspacioEnDatastoresProcessor() },
    { tarea: 'processIdleVMsEmails',              crear: () => new IdleVMsProcessor() },
    { tarea: 'processUndersizedVMsEmails',        crear: () => new UndersizedVMsProcessor() },
    { tarea: 'processOversizedVMsEmails',         crear: () => new OversizedVMsProcessor() },
    { tarea: 'processVmsWithQuestionsEmails',     crear: () => new VMsConPreguntasProcessor() },
    { tarea: 'processDATASTORESLOCALESVMsEmails', crear: () => new VMsDatastoresLocalesProcessor() },
    { tarea: 'processInaccessibleVMsEmails',      crear: () => new VMsInaccesiblesProcessor() },
    { tarea: 'processVMsOperativasEmails',        crear: () => new VMsOperativasProcessor() },
    { tarea: 'processSnapshotsEmails',            crear: () => new VMsConSnapshotsProcessor() },
    { tarea: 'processApagadasVMsEmails',          crear: () => new VMsApagadasProcessor() },
    { tarea: 'processOrphanedVMsEmails',          crear: () => new OrphanedVMsProcessor() },
    { tarea: 'processDuplicateJobEmails',         crear: () => new VMsEnMasDeUnJobProcessor() },
    { tarea: 'processRepositorySpaceEmails',      crear: () => new EspacioEnRepositoriosProcessor() },
    { tarea: 'processHorizonDashboardEmails',     crear: () => new HorizonDashboardProcessor() },
    { tarea: 'processHorizonProblemMachinesEmails', crear: () => new HorizonProblemMachinesProcessor() },
    { tarea: 'processTanzuEmails',                crear: () => new TanzuMailProcessor() },

    // --- Veeam Malware Detection (logs que manda la tarea programada de VEEAM13) ---
    { tarea: 'processMalwareDetectionEmails',     crear: () => new MalwareDetectionProcessor() },

    // --- Reportes de Nutanix (OPS-NTX-001 al 004) ---
    { tarea: 'processNutanixOpsEmails',           crear: () => new NutanixOpsProcessor() },

    // --- Reportes de Veeam ONE (solo se archivan y cierran su tarea programada) ---
    { tarea: 'processVeeamVMsProtegidasEmails',       crear: () => new VeeamOneReporteProcessor("VMs protegidas") },
    { tarea: 'processVeeamReplicasProtegidasEmails',  crear: () => new VeeamOneReporteProcessor("Replicas protegidas") },
    { tarea: 'processVeeamCapacityPlanningEmails',    crear: () => new VeeamOneReporteProcessor("Capacity Planning") },
    { tarea: 'processVeeamDailyProtectionStatusEmails', crear: () => new VeeamOneReporteProcessor("VM Daily Protection Status") },
    { tarea: 'processVeeamContencionCPUEmails',       crear: () => new VeeamOneReporteProcessor("Hosts y VMs con contencion de CPU") },
    { tarea: 'processVeeamInventarioVMsEmails',       crear: () => new VeeamOneReporteProcessor("Inventario de VMs") },

    // --- Catch-all: SIEMPRE al final, agarra lo que ningún processor de arriba reclamó ---
    { tarea: 'processReportesSinProcessorEmails',  crear: () => new ReportesSinProcessorProcessor() },
  ];
}

/**
 * Asuntos que ya tienen processor propio. Lo usa el catch-all para saber qué NO es suyo.
 * Se excluye el propio catch-all (su emailSubject es "", que matchearía con todo).
 * @returns {Array<string>}
 */
function obtenerAsuntosConProcessor() {
  return obtenerRegistroDeProcesadores()
    .map(entrada => {
      try {
        return entrada.crear().emailSubject;
      } catch (e) {
        Logger.log(`[Main] No se pudo instanciar el processor de "${entrada.tarea}" para leer su asunto: ${e.message}`);
        return "";
      }
    })
    .filter(asunto => asunto && String(asunto).trim() !== "");
}

// --- CONFIGURACIÓN DE LA VENTANA DE EJECUCIÓN ---
const HORA_INICIO = 6;  // 6 AM arranca
const HORA_FIN = 15    // 12 AM termina definitivamente -- hasta las 15 PM

/**
 * Script Property que marca la corrida en curso como MANUAL (la lanzó una persona desde el
 * panel web, no el activador diario).
 *
 * Una corrida manual hace el ciclo completo y se detiene. No reabre el bucle de sondeo de 5
 * minutos ni dispara los reportes de cierre del día: quien apretó el botón pidió un ciclo, no
 * que el proyecto se quedara trabajando el resto de la jornada.
 *
 * La escribe webapp_lanzarCiclo() antes de crear el activador; la consume y la borra esta
 * misma función. Se guarda en Properties y no en una variable porque el ciclo se encadena
 * entre ejecuciones distintas y la marca tiene que sobrevivir a ese salto.
 *
 * NO BORRAR sin sacar también sus usos en webapp/WebApp.js: la constante se declara acá y se
 * usa allá, así que si desaparece de este archivo el panel deja de funcionar con un
 * ReferenceError en vez de un error de compilación visible. Ya pasó una vez (02/09/2026).
 */
const PROP_EJECUCION_MANUAL = 'EJECUCION_MANUAL';

/** Borra la marca de corrida manual. Se llama en toda salida temprana del ciclo. */
function limpiarMarcaEjecucionManual() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_EJECUCION_MANUAL);
}

/**
 * Punto de entrada del día. Lo dispara el activador diario (ver manual_configurarActivadorDiario).
 *
 * Los activadores diarios de Google NO se ejecutan a una hora exacta: se disparan en algún
 * momento de una franja de UNA HORA. Por eso el activador se configura una hora ANTES de
 * HORA_INICIO y es esta función la que decide el arranque real.
 *
 * Antes esto agendaba el ciclo 5 minutos más tarde, siempre. Sumado a la franja difusa, el
 * primer procesamiento del día podía llegar casi una hora tarde: el 28/07/2026 el activador
 * de las 7 disparó cerca de las 7:55 y el primer aviso a Slack salió recién 8:00.
 */
function iniciarDiaOperativo() {
  const ahora = new Date();
  const horaActual = ahora.getHours();

  if (horaActual >= HORA_INICIO) {
    // Ya estamos en ventana: arranca YA, sin esperar.
    Logger.log(`Iniciando el ciclo diario de operaciones AHORA (${horaActual}hs, ventana ${HORA_INICIO}-${HORA_FIN}hs).`);
    ejecutarCicloDeOperaciones();
    return;
  }

  // El activador cayó temprano dentro de su franja: en vez de procesar antes de tiempo, se
  // agenda el arranque a la hora exacta. Un activador .at() sí respeta el horario pedido.
  const arranque = new Date(ahora);
  arranque.setHours(HORA_INICIO, 0, 0, 0);
  ScriptApp.newTrigger('ejecutarCicloDeOperaciones').timeBased().at(arranque).create();
  Logger.log(`Son las ${horaActual}hs: el ciclo queda agendado para las ${HORA_INICIO}:00 en punto.`);
}

/**
 * Función principal de ejecución por lotes.
 */
function ejecutarCicloDeOperaciones() {
  const ahora = new Date();
  const diaDeLaSemana = ahora.getDay();
  const horaActual = ahora.getHours();

  // 1 & 2. Validar Día Laborable (Lunes a Viernes) y Feriados
  if (diaDeLaSemana < 1 || diaDeLaSemana > 5 || esFeriadoHoy()) { 
    globalThis.ES_DIA_NO_LABORABLE = true;
  } else {
    globalThis.ES_DIA_NO_LABORABLE = false;
  }

  // 3. Control de Concurrencia (Lock)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("EJECUCIÓN OMITIDA: Ya hay un proceso corriendo.");
    // Si esta corrida venía marcada como manual, la marca se descarta: ya hay un ciclo en
    // curso, que es lo que quería quien apretó el botón. Dejarla puesta haría que la próxima
    // corrida AUTOMÁTICA se tomara por manual y no se reprogramara.
    limpiarMarcaEjecucionManual();
    return;
  }

  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const esManual = scriptProperties.getProperty(PROP_EJECUCION_MANUAL) === 'true';
    borrarActivadorTemporal();
    
    latirCiclo();
    let indiceActual = parseInt(scriptProperties.getProperty('INDICE_SIGUIENTE_TAREA') || '0');
    if (indiceActual === 0) Logger.log("--- Obtenido el candado. Iniciando cadena de tareas. ---");

    // El orden y la cantidad de tareas salen del registro (fuente única de verdad).
    const registro = obtenerRegistroDeProcesadores();
    const tiempoInicioLote = new Date();

    // 4. Bucle de ejecución de tareas
    while (indiceActual < registro.length) {
      const entrada = registro[indiceActual];
      try {
        Logger.log(`==> Ejecutando [${indiceActual + 1}/${registro.length}]: ${entrada.tarea}`);
        // Cada tarea arranca con el registro de cierres vacio. No todos los processors pasan
        // por enviarResumenSlack() (Tanzu y EnvioMailTecnologias cierran tareas y no lo
        // llaman), y sin esto sus cierres los contaria la operacion siguiente, atribuidos al
        // reporte equivocado en la planilla de log.
        if (typeof consumirCierresDeTareas === "function") consumirCierresDeTareas();
        entrada.crear().processEmails();
        Logger.log(`<== Finalizado: ${entrada.tarea}`);
      } catch (e) {
        Logger.log(`### ERROR en ${entrada.tarea}: ${e.message} | Stack: ${e.stack} ###`);
      }
      indiceActual++;
      // Un latido por tarea, no uno por ejecucion: si el ciclo se cuelga en medio de una
      // llamada a Jira, el vigilante tiene que notarlo en minutos y no recien cuando venza
      // toda la ejecucion.
      latirCiclo();

      // Control de tiempo para no exceder los 30 min de Google
      const tiempoTranscurrido = (new Date() - tiempoInicioLote) / 1000 / 60;
      if (tiempoTranscurrido > 15) {
        Logger.log("Límite de tiempo alcanzado. Re-programando continuación...");
        break;
      }
    }

    // 5. Gestión del siguiente paso
    if (indiceActual < registro.length) {
      // Quedan tareas del MISMO ciclo: se retoma en 1 minuto, no en 5. Acá el trabajo está a
      // medio hacer y cada minuto de espera se suma al tiempo total del día; los 5 minutos
      // originales eran tiempo muerto puro. El intervalo de 5 se mantiene abajo, para volver a
      // barrer la bandeja cuando el ciclo ya terminó completo (ahí sí es un sondeo, no una
      // continuación).
      scriptProperties.setProperty('INDICE_SIGUIENTE_TAREA', indiceActual);
      crearNuevoActivador('ejecutarCicloDeOperaciones', 1);
    } else {
      // Ciclo completado
      Logger.log("--- ¡CICLO COMPLETO DE TAREAS FINALIZADO! ---");
      scriptProperties.deleteProperty('INDICE_SIGUIENTE_TAREA');

      if (esManual) {
        // Corrida lanzada a mano: el ciclo se hizo entero y acá termina. Ni bucle de sondeo ni
        // reportes de cierre — esos pertenecen al final de la jornada automática, y dispararlos
        // desde un botón duplicaría el resumen diario en Slack.
        scriptProperties.deleteProperty(PROP_EJECUCION_MANUAL);

        // Salvedad importante: al arrancar, borrarActivadorTemporal() borró TODOS los
        // activadores del ciclo, incluido el del bucle automático si estábamos dentro de la
        // ventana. Si no se repone acá, un clic en el botón a media mañana dejaría la
        // automatización muerta hasta el activador diario del día siguiente.
        if (horaActual >= HORA_INICIO && horaActual < HORA_FIN) {
          Logger.log(`Ciclo manual completado dentro de la ventana (${horaActual}hs): se repone el bucle automático en 5 min.`);
          crearNuevoActivador('ejecutarCicloDeOperaciones', 5);
        } else {
          Logger.log(`Ciclo manual completado fuera de la ventana (${horaActual}hs). No se reprograma nada: si hace falta otra pasada, se lanza a mano de nuevo.`);
        }

        lock.releaseLock();
        return;
      }
      
      if (horaActual < HORA_FIN) {
        Logger.log(`Aún en ventana (${horaActual}hs). Reiniciando bucle en 5 min.`);
        crearNuevoActivador('ejecutarCicloDeOperaciones', 5);
      } else {
        Logger.log("Fin de ventana operativa. Ejecutando reportes finales de cierre...");
        
        if (!globalThis.ES_DIA_NO_LABORABLE) {
          try { generarReporteDiarioDeTickets(); } catch (e) {}
          try { generarReporteTareasCerradas(); } catch (e) {}
        }
        // A-04: se eliminó la llamada a generarReporteConsumoVsphere() sin argumento.
        // Esa función requiere un opsKey (es por-cliente) y sin él salía de inmediato
        // logueando "Key: undefined" sin hacer nada; además su retorno se descartaba.
        // El reporte de consumo se envía por cliente desde ejecutarReporteVsphere() (EnvioMailTecnologias.js).
        // Acá se llamaba a registrarResumenDiario(), que NO EXISTE en el proyecto: la
        // migración al ExecutionLogger la dio de baja y dejó anotado el paso pendiente
        // ("En Main.gs: eliminar registrarResumenDiario() (ya no existe)", ver el
        // encabezado de core/ExecutionLogger.js), pero la llamada quedó. Envuelta en un
        // try/catch vacío, tiraba ReferenceError todos los días al cerrar la ventana y
        // nadie se enteraba. El resumen diario ya lo registra _registrarEnLog() desde
        // enviarResumenSlack(), así que no hay nada que reemplazar: se elimina.
        
        lock.releaseLock();
        Logger.log("--- Proceso finalizado por hoy. ---");
      }
    }
  } catch (e) {
    Logger.log(`Error crítico: ${e.message}`);
    // Acá la cadena queda cortada (no se llegó a crear el activador siguiente), así que la
    // marca de corrida manual ya no aplica a nada. Si se dejara puesta, la próxima corrida
    // automática la consumiría y se comportaría como manual.
    limpiarMarcaEjecucionManual();
    lock.releaseLock();
  }
}

// ─── VIGILANTE DEL CICLO ──────────────────────────────────────────────────────
//
// El ciclo se reprograma a si mismo: cada ejecucion crea el activador de la siguiente. Si una
// ejecucion muere SIN llegar a crearlo, la cadena queda cortada hasta el activador diario del
// dia siguiente, y nadie se entera.
//
// Paso el 15/10/2026: una llamada a Jira para cerrar OBC-38735 nunca volvio. UrlFetchApp no
// tiene timeout configurable, asi que la ejecucion quedo colgada, Apps Script la siguio
// mostrando como "Running" casi dos horas, y produccion no proceso un solo correo hasta que
// alguien lo noto a mano. Los correos del dia se acumularon de 74 a 148 hilos.
//
// Por que el try/catch de ejecutarCicloDeOperaciones() NO alcanza para esto: un cuelgue no
// lanza excepcion. El catch nunca corre. Hace falta algo que mire DESDE AFUERA.
const PROP_LATIDO_CICLO    = 'CICLO_ULTIMO_LATIDO';   // epoch ms de la ultima senal de vida
const PROP_REANIMACIONES   = 'CICLO_REANIMACIONES';   // "yyyy-MM-dd|n" del dia en curso

// Cuanto silencio se tolera antes de dar el ciclo por colgado. El presupuesto propio del ciclo
// es de 15 minutos, asi que 20 deja margen para una tarea lenta sin confundirla con un cuelgue.
const CICLO_MINUTOS_SIN_LATIDO = 20;

// Tope de reanimaciones por dia. Si algo se cuelga siempre en el mismo punto, reanimar cada 10
// minutos para siempre no arregla nada: solo tapa el problema y llena Jira de reintentos. Al
// llegar al tope se avisa y se deja de insistir, que es lo que hace que alguien lo mire.
const CICLO_MAX_REANIMACIONES = 5;

/** Deja constancia de que el ciclo sigue vivo. Barato: una sola Script Property. */
function latirCiclo() {
  try {
    PropertiesService.getScriptProperties().setProperty(PROP_LATIDO_CICLO, String(Date.now()));
  } catch (e) { /* el latido nunca puede hacer fallar al ciclo */ }
}

/**
 * Revisa si el ciclo dio senales de vida y, si no, lo reanima.
 *
 * Va en su PROPIO activador, independiente del ciclo: si viviera dentro del ciclo se colgaria
 * junto con el.
 *
 * NO toma el candado a proposito. Si la ejecucion colgada todavia lo tiene, el activador que
 * se crea aca va a salir con "EJECUCION OMITIDA" y el proximo pase del vigilante va a volver a
 * intentar. Google termina matando la ejecucion colgada por limite de tiempo y ahi entra.
 *
 * Tampoco toca INDICE_SIGUIENTE_TAREA: el ciclo retoma donde quedo en vez de reprocesar desde
 * la primera tarea.
 */
function vigilarCicloDeOperaciones() {
  const ahora = new Date();
  const horaActual = ahora.getHours();

  // Fuera de la ventana operativa el ciclo NO tiene que estar corriendo: que no haya latido es
  // lo normal, no un cuelgue.
  if (horaActual < HORA_INICIO || horaActual >= HORA_FIN) return;
  if (esDiaNoLaborable()) return;

  const props = PropertiesService.getScriptProperties();
  const latido = parseInt(props.getProperty(PROP_LATIDO_CICLO) || '0', 10);

  // Sin latido nunca corrio: puede ser el primer dia con el vigilante puesto, o que el
  // activador diario no exista. No es trabajo del vigilante arrancar el dia.
  if (!latido) {
    Logger.log("[Vigilante] Todavia no hay ningun latido registrado. No se hace nada.");
    return;
  }

  const minutosSinLatido = Math.floor((Date.now() - latido) / 60000);
  if (minutosSinLatido < CICLO_MINUTOS_SIN_LATIDO) {
    Logger.log(`[Vigilante] El ciclo esta vivo (ultimo latido hace ${minutosSinLatido} min).`);
    return;
  }

  // Tope diario.
  const hoy = Utilities.formatDate(ahora, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const crudo = (props.getProperty(PROP_REANIMACIONES) || "").split("|");
  const reanimaciones = (crudo[0] === hoy) ? (parseInt(crudo[1], 10) || 0) : 0;

  if (reanimaciones >= CICLO_MAX_REANIMACIONES) {
    Logger.log(`[Vigilante] El ciclo lleva ${minutosSinLatido} min sin latir, pero ya se reanimo ${reanimaciones} veces hoy. No se insiste mas.`);
    return;
  }

  Logger.log(`[Vigilante] 🚨 El ciclo lleva ${minutosSinLatido} min sin dar senales de vida. Reanimando (intento ${reanimaciones + 1} de ${CICLO_MAX_REANIMACIONES}).`);

  try {
    borrarActivadorTemporal();              // limpia los activadores huerfanos del ciclo muerto
    crearNuevoActivador('ejecutarCicloDeOperaciones', 1);
    props.setProperty(PROP_REANIMACIONES, `${hoy}|${reanimaciones + 1}`);

    // El latido se refresca aca para no reanimar otra vez antes de que el activador nuevo
    // llegue a correr: si no, cada pase del vigilante crearia un activador mas.
    latirCiclo();

    if (typeof enviarAlertaCriticaSlack === "function") {
      enviarAlertaCriticaSlack(
        "El ciclo de operaciones se colgo y se reanimo solo",
        `Estuvo ${minutosSinLatido} minutos sin dar senales de vida y se reprogramo para dentro de 1 minuto (reanimacion ${reanimaciones + 1} de ${CICLO_MAX_REANIMACIONES} de hoy). Causa tipica: una llamada a Jira o a Drive que no vuelve; UrlFetchApp no tiene timeout. Si se repite varias veces en el dia, mirar en que tarea se cuelga.`);
    }
  } catch (e) {
    Logger.log(`[Vigilante] No se pudo reanimar el ciclo: ${e.message}`);
    if (typeof enviarAlertaCriticaSlack === "function") {
      enviarAlertaCriticaSlack("El ciclo esta colgado y el vigilante NO pudo reanimarlo",
        `${minutosSinLatido} minutos sin latido. Error al reprogramar: ${e.message}. Hay que entrar a mano.`);
    }
  }
}

// --- FUNCIONES AUXILIARES ---

function crearNuevoActivador(nombreFuncion, minutosDesdeAhora) {
  const trigger = ScriptApp.newTrigger(nombreFuncion)
    .timeBased()
    .after(minutosDesdeAhora * 60 * 1000)
    .create();
  PropertiesService.getScriptProperties().setProperty('ID_TRIGGER_TEMPORAL', trigger.getUniqueId());
}

function borrarActivadorTemporal() {
  const functionName = 'ejecutarCicloDeOperaciones';
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const trigger of allTriggers) {
    if (trigger.getHandlerFunction() === functionName) ScriptApp.deleteTrigger(trigger);
  }
  PropertiesService.getScriptProperties().deleteProperty('ID_TRIGGER_TEMPORAL');
}

function resetearEjecucion() {
  PropertiesService.getScriptProperties().deleteProperty('INDICE_SIGUIENTE_TAREA');
  borrarActivadorTemporal();
  LockService.getScriptLock().releaseLock();
}

