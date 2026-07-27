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
const HORA_INICIO = 7;  // 7 AM arranca
const HORA_FIN = 15    // 12 AM termina definitivamente -- hasta las 15 PM

function iniciarDiaOperativo() {
  Logger.log("Iniciando el ciclo diario de operaciones...");
  crearNuevoActivador('ejecutarCicloDeOperaciones', 5); 
}

/**
 * Función principal de ejecución por lotes.
 */
function ejecutarCicloDeOperaciones() {
  const ahora = new Date();
  const diaDeLaSemana = ahora.getDay();
  const horaActual = ahora.getHours();

  // 1. Validar Día Laborable (Lunes a Viernes)
  if (diaDeLaSemana < 1 || diaDeLaSemana > 5) { 
    Logger.log("EJECUCIÓN OMITIDA: Fin de semana.");
    borrarActivadorTemporal();
    return;
  }

  // 2. Validar Feriado
  if (esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado.");
    borrarActivadorTemporal();
    return;
  }

  // 3. Control de Concurrencia (Lock)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("EJECUCIÓN OMITIDA: Ya hay un proceso corriendo.");
    return;
  }

  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    borrarActivadorTemporal();
    
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
        entrada.crear().processEmails();
        Logger.log(`<== Finalizado: ${entrada.tarea}`);
      } catch (e) {
        Logger.log(`### ERROR en ${entrada.tarea}: ${e.message} | Stack: ${e.stack} ###`);
      }
      indiceActual++;

      // Control de tiempo para no exceder los 30 min de Google
      const tiempoTranscurrido = (new Date() - tiempoInicioLote) / 1000 / 60;
      if (tiempoTranscurrido > 15) {
        Logger.log("Límite de tiempo alcanzado. Re-programando continuación...");
        break;
      }
    }

    // 5. Gestión del siguiente paso
    if (indiceActual < registro.length) {
      // Quedan tareas: guardar índice y re-programar en 5 min
      scriptProperties.setProperty('INDICE_SIGUIENTE_TAREA', indiceActual);
      crearNuevoActivador('ejecutarCicloDeOperaciones', 5);
    } else {
      // Ciclo completado
      Logger.log("--- ¡CICLO COMPLETO DE TAREAS FINALIZADO! ---");
      scriptProperties.deleteProperty('INDICE_SIGUIENTE_TAREA');
      
      if (horaActual < HORA_FIN) {
        Logger.log(`Aún en ventana (${horaActual}hs). Reiniciando bucle en 5 min.`);
        crearNuevoActivador('ejecutarCicloDeOperaciones', 5);
      } else {
        Logger.log("Fin de ventana operativa. Ejecutando reportes finales de cierre...");
        
        try { generarReporteDiarioDeTickets(); } catch (e) {}
        try { generarReporteTareasCerradas(); } catch (e) {}
        // A-04: se eliminó la llamada a generarReporteConsumoVsphere() sin argumento.
        // Esa función requiere un opsKey (es por-cliente) y sin él salía de inmediato
        // logueando "Key: undefined" sin hacer nada; además su retorno se descartaba.
        // El reporte de consumo se envía por cliente desde ejecutarReporteVsphere() (EnvioMailTecnologias.js).
        try { registrarResumenDiario(); } catch(e) {}
        
        lock.releaseLock();
        Logger.log("--- Proceso finalizado por hoy. ---");
      }
    }
  } catch (e) {
    Logger.log(`Error crítico: ${e.message}`);
    lock.releaseLock();
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

function esFeriadoHoy() {
  const calendarId = PropertiesService.getScriptProperties().getProperty("HOLIDAYS_CALENDAR_ID"); 
  try {
    const calendario = CalendarApp.getCalendarById(calendarId);
    if (!calendario) return false;
    return calendario.getEventsForDay(new Date()).length > 0;
  } catch (error) { return false; }
}
