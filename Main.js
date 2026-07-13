/**
 * =================================================================
 * DESPACHADOR INTELIGENTE POR LOTES - VERSIÓN LIMPIA (SIN TRACKER)
 * =================================================================
 */

// Define la lista de todas las funciones de operaciones que deben ejecutarse.
const LISTA_DE_TAREAS = [
  'processAffinityRulesEmails',
  'processVsphereEmails',
  'processVropsEmails',
  'processPartitionEmails',
  'processClusterDRSEmails',
  'processStorageDRSEmails',
  'processViewEmails',
  'processDISCOSMONTADOSRulesEmails',
  'processDatastoreSpaceEmails',
  'processIdleVMsEmails',
  'processUndersizedVMsEmails',
  'processOversizedVMsEmails',
  'processVmsWithQuestionsEmails',
  'processDATASTORESLOCALESVMsEmails',
  'processInaccessibleVMsEmails',
  'processVMsOperativasEmails',
  'processSnapshotsEmails',
  'processApagadasVMsEmails',
  'processOrphanedVMsEmails',
  'processDuplicateJobEmails',
  'processRepositorySpaceEmails',
  'processHorizonDashboardEmails',
  'processHorizonProblemMachinesEmails'
];

// --- CONFIGURACIÓN DE LA VENTANA DE EJECUCIÓN ---
const HORA_INICIO = 7;  // 7 AM arranca
const HORA_FIN = 15    // 12 AM termina definitivamente -- hasta las 15 PM

function iniciarDiaOperativo() {
  Logger.log("Iniciando el ciclo diario de operaciones...");
  crearNuevoActivador('ejecutarCicloDeOperaciones', 1); 
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
    
    const tiempoInicioLote = new Date();
    
    // 4. Bucle de ejecución de tareas
    while (indiceActual < LISTA_DE_TAREAS.length) {
      const nombreFuncion = LISTA_DE_TAREAS[indiceActual];
      try {
        Logger.log(`==> Ejecutando [${indiceActual + 1}/${LISTA_DE_TAREAS.length}]: ${nombreFuncion}`);
        this[nombreFuncion](); // Llama a la función dinámicamente
        Logger.log(`<== Finalizado: ${nombreFuncion}`);
      } catch (e) {
        Logger.log(`### ERROR en ${nombreFuncion}: ${e.message} ###`);
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
    if (indiceActual < LISTA_DE_TAREAS.length) {
      // Quedan tareas: guardar índice y re-programar en 2 min
      scriptProperties.setProperty('INDICE_SIGUIENTE_TAREA', indiceActual);
      crearNuevoActivador('ejecutarCicloDeOperaciones', 2);
    } else {
      // Ciclo completado
      Logger.log("--- ¡CICLO COMPLETO DE TAREAS FINALIZADO! ---");
      scriptProperties.deleteProperty('INDICE_SIGUIENTE_TAREA');
      
      if (horaActual < HORA_FIN) {
        Logger.log(`Aún en ventana (${horaActual}hs). Reiniciando bucle en 2 min.`);
        crearNuevoActivador('ejecutarCicloDeOperaciones', 2);
      } else {
        Logger.log("Fin de ventana operativa. Ejecutando reportes finales de cierre...");
        
        try { generarReporteDiarioDeTickets(); } catch (e) {}
        try { generarReporteTareasCerradas(); } catch (e) {}
        try { generarReporteConsumoVsphere(); } catch (e) {}
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
  const calendarId = 'alarmas@wetcom.com'; 
  try {
    const calendario = CalendarApp.getCalendarById(calendarId);
    if (!calendario) return false;
    return calendario.getEventsForDay(new Date()).length > 0;
  } catch (error) { return false; }
}