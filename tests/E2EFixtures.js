/**
 * @fileoverview Catálogo de reportes de prueba para el harness end-to-end (tests/E2ETestHarness.js).
 *
 * Datos puros: acá NO se envía nada ni se toca Gmail/Jira/Drive. Cada fixture describe qué
 * contenido tiene el adjunto de prueba y qué se espera que pase con ese correo.
 *
 * El ASUNTO y el NOMBRE DE ARCHIVO no se escriben a mano: se derivan del propio processor
 * (`emailSubject` / `attachmentMatch`) en construirCorreoDeFixture(). Si mañana alguien
 * renombra un reporte, las fixtures lo siguen solas en vez de quedar apuntando a un asunto
 * que ya nadie escucha (AGENTS.md §5: una sola fuente de verdad).
 */

/**
 * Contenido de los reportes "caso normal": traen al menos una fila con anomalía, así que
 * deben crear/actualizar el ticket, cerrar la tarea programada y archivarse en Drive.
 *
 * La clave es el `tarea` del registro de core/Main.js (obtenerRegistroDeProcesadores).
 *
 * - `extension`: define el MIME del adjunto y, salvo override, la extensión del nombre.
 * - `nombreArchivo`: override completo del nombre (sin prefijo de fecha). Solo hace falta
 *   para los processors que sobrescriben findAttachment() con reglas propias.
 * - `filasXlsx`: en vez de texto plano, se genera un .xlsx real con convertDataToXlsxBlob().
 */
const E2E_FIXTURES = {
  processAffinityRulesEmails: {
    extension: "json",
    cuerpo: '[{"Rule Name": "Rule-AntiAffinity-DB", "Status": "Violated", "Details": "Both critical VMs running on the same host"}]'
  },
  processVsphereEmails: {
    extension: "json",
    cuerpo: '[{"Object": "Host-E2E-01", "Alarm": "Host Connection State", "Time": "16/07/2026", "Severity": "Red"}]'
  },
  processVropsEmails: {
    // VROpsProcessor.processData() agrupa por VROPS_GROUPING_COLUMN_NAME="Name" y necesita
    // VROPS_OBJECT_NAME_COLUMN="Object Name" (vrops/AlertasDevROps.js) — sin esas dos columnas
    // exactas devuelve null y el correo queda [OPS-PENDIENTE] para reintentar.
    extension: "csv",
    cuerpo: "Name,Object Name,Criticality,Status\r\nVirtual machine has CPU contention,vm-e2e-vrops-01,Critical,Active"
  },
  processPartitionEmails: {
    extension: "csv",
    cuerpo: "Virtual Machine,Partition,Porcentaje de uso (%)\r\nvm-e2e-full-01,C:\\,85.2"
  },
  processClusterDRSEmails: {
    extension: "csv",
    cuerpo: "Cluster,DRS Configuration,Details\r\nCluster-E2E-01,Disabled,DRS has been manually deactivated\r\nCluster-E2E-02,Enabled,OK"
  },
  processStorageDRSEmails: {
    extension: "csv",
    cuerpo: "Datastore Cluster,sDRS Configuration,DRS Enabled\r\nSDRS-E2E-01,Disabled,True"
  },
  processViewEmails: {
    // ComponentesDeView.processData() filtra por VIEW_FILTER_COLUMN = "Porcentaje de uso (%)"
    // contra un umbral de 85 (horizon/ComponentesDeView.js) — no acepta cualquier columna.
    extension: "csv",
    cuerpo: "Component,Porcentaje de uso (%)\r\nConnection-Server-E2E-01,91.4"
  },
  processDISCOSMONTADOSRulesEmails: {
    extension: "json",
    cuerpo: '[{"Proxy": "proxy-e2e-01", "VM": "vm-mounted-e2e", "Status": "Failed", "Details": "Backup disk stuck"}]'
  },
  processDatastoreSpaceEmails: {
    extension: "csv",
    cuerpo: "Name,Free Space,Cluster,Used Space (%)\r\nvsanDatastore-E2E-PROD,197093.12,,92.89\r\nvsanDatastore-E2E-DEV,432770.28,,52.73"
  },
  processIdleVMsEmails: {
    extension: "csv",
    cuerpo: "Virtual Machine,CPU,Memory,Status\r\nvm-e2e-idle-01,2,8192,Idle\r\nvm-e2e-idle-02,4,16384,OK"
  },
  processUndersizedVMsEmails: {
    extension: "csv",
    cuerpo: "Virtual Machine,CPU,Memory,Status\r\nvm-e2e-under-01,1,2048,Undersized\r\nvm-e2e-under-02,2,4096,OK"
  },
  processOversizedVMsEmails: {
    extension: "csv",
    cuerpo: "Virtual Machine,CPU,Memory,Status\r\nvm-e2e-over-01,16,65536,Oversized\r\nvm-e2e-over-02,2,4096,OK"
  },
  processVmsWithQuestionsEmails: {
    extension: "json",
    cuerpo: '[{"Virtual Machine": "vm-e2e-blocked-01", "Question": "Did you copy or move this VM?", "Response Required": "Yes"}]'
  },
  processDATASTORESLOCALESVMsEmails: {
    extension: "csv",
    cuerpo: "Virtual Machine,Datastore,Type\r\nvm-e2e-local-01,datastore1-local,local"
  },
  processInaccessibleVMsEmails: {
    extension: "csv",
    cuerpo: "Virtual Machine,Status,Details\r\nvm-e2e-dead-01,Inaccessible,Configuration file vmx not found"
  },
  processVMsOperativasEmails: {
    extension: "csv",
    cuerpo: "Virtual Machine,Partition Usage (%)\r\nvm-e2e-tools-01,88.5"
  },
  processSnapshotsEmails: {
    extension: "csv",
    cuerpo: "VM Name,Age,Snapshot_Space,Cantidad\r\nvm-e2e-snap-01,15,45.2,1\r\nvm-e2e-snap-02,1,1.5,0"
  },
  processApagadasVMsEmails: {
    extension: "csv",
    cuerpo: "Virtual Machine,Days Powered Off,Last Active\r\nvm-e2e-off-01,45,01/06/2026"
  },
  processOrphanedVMsEmails: {
    // findAttachment() de OrphanedVMs solo acepta un .xlsx que contenga attachmentMatch,
    // o bien un .csv cuyo nombre contenga "details".
    extension: "csv",
    nombreArchivo: "details-Orphaned VMs.csv",
    cuerpo: "File Path,Size (GB),Datastore\r\n[vsan] orphaned_vms/vm_e2e_orphaned.vmdk,120,vsanDatastore"
  },
  processDuplicateJobEmails: {
    // Mismo criterio que Orphaned VMs: xlsx con el match, o csv con "details" en el nombre.
    extension: "csv",
    nombreArchivo: "details-VMs en mas de un Job.csv",
    cuerpo: "Virtual Machine,Job 1,Job 2,Status\r\nvm-e2e-double-backup-01,Daily_Backup_01,Daily_Backup_02,Duplicate"
  },
  processRepositorySpaceEmails: {
    extension: "xlsx",
    filasXlsx: [
      ["Repository Name", "Path", "Capacity (GB)", "Free Space (GB)", "Free Space (%)"],
      ["Veeam-Repo-E2E", "E:\\Backup", "10000", "850", "8.5"]
    ]
  },
  processHorizonDashboardEmails: {
    extension: "json",
    cuerpo: '[{"Pool": "Pool-E2E-01", "Problem": "Provisioning error", "Machines": 3}]'
  },
  processHorizonProblemMachinesEmails: {
    extension: "json",
    cuerpo: '[{"Machine": "vdi-e2e-01", "State": "Agent unreachable", "Pool": "Pool-E2E-01"}]'
  },
  processTanzuEmails: {
    extension: "txt",
    cuerpo: [
      "    [INFO] Perfil activo: weekly",
      "    [INFO] Exclusiones cargadas: 0",
      "",
      "========== Cluster: e2e ==========",
      "    [INFO] env=dev | criticality=low",
      "---------- Test de conexión API... ----------",
      "  [SUCCESS] API cluster e2e OK",
      "---------- Chequeo cantidad de contenedores sin Requests y Limits ----------",
      "  [ERROR] ✖ Contenedores sin Requests CPU: 378",
      "  [ERROR] ✖ Contenedores sin Limits CPU: 383",
      "---------- Chequeo PVs y PVCs no Bound ----------",
      "  [SUCCESS] ✔ Todos los PVs están en estado Bound - OK",
      "---------- Chequeoddeployments que tienen menos de 2 réplicas ----------",
      "  [ERROR] ✖ Deployments con menos de 2 réplicas: 1010",
      "---------- Chequeo de Dataprotection ----------",
      "  [SUCCESS] ✔ Todos los backups están OK",
      "  [SUCCESS] ✔ Todos los restores están OK"
    ].join("\r\n")
  },

  // --- Reportes de Veeam ONE: solo se archivan en Drive y cierran su tarea programada ---
  processVeeamVMsProtegidasEmails: {
    extension: "csv",
    cuerpo: "VM Name,Job,Last Backup\r\nvm-e2e-prot-01,Daily_Backup_E2E,16/07/2026"
  },
  processVeeamReplicasProtegidasEmails: {
    extension: "csv",
    cuerpo: "VM Name,Replica Job,Last Replica\r\nvm-e2e-repl-01,Replica_E2E,16/07/2026"
  },
  processVeeamCapacityPlanningEmails: {
    extension: "csv",
    cuerpo: "Repository,Used (GB),Projected Full\r\nVeeam-Repo-E2E,9150,30/09/2026"
  },
  processVeeamDailyProtectionStatusEmails: {
    extension: "csv",
    cuerpo: "VM Name,Protected,Last Session Result\r\nvm-e2e-daily-01,Yes,Success"
  },
  processVeeamContencionCPUEmails: {
    extension: "csv",
    cuerpo: "Object,Type,CPU Ready (%)\r\nesx-e2e-01,Host,12.4"
  },
  processVeeamInventarioVMsEmails: {
    extension: "csv",
    cuerpo: "VM Name,Host,Power State\r\nvm-e2e-inv-01,esx-e2e-01,poweredOn"
  }
};

/**
 * Casos borde. Se prueban sobre POCOS processors, no sobre los ~30: toda esta lógica vive en
 * la clase base MailProcessor, así que ejercitarla una vez alcanza para cubrirla. Se eligen
 * los reportes que efectivamente rompieron en producción.
 *
 * `esperado` describe el desenlace correcto de cada caso:
 *  - `etiqueta`: en qué etiqueta de Gmail tiene que terminar el hilo.
 *  - `cierraTarea`: si la Tarea Programada del reporte debe quedar cerrada.
 *  - `subeADrive`: si el adjunto tiene que aparecer en la carpeta del día.
 *
 * Es una función y no una constante a propósito: usa OPS_LABEL_PROCESADO, que se declara en
 * core/MailUtils.js. En Apps Script todos los archivos comparten un scope global y el orden
 * de evaluación del nivel superior no está garantizado, así que leer una constante de otro
 * archivo al inicializar rompería el proyecto ENTERO con un ReferenceError. Mismo criterio
 * que obtenerRegistroDeProcesadores() en core/Main.js.
 *
 * @returns {Object} Casos borde indexados por nombre.
 */
function obtenerCasosBorde() {
  return {
  vacio: {
      descripcion: "CSV con solo encabezados: reporte limpio, es el estado NORMAL de varias operaciones (incidente del 28/07/2026)",
      extension: "csv",
      cuerpo: "Virtual Machine,Status,Details",
      esperado: { etiqueta: OPS_LABEL_PROCESADO, cierraTarea: true, subeADrive: true }
    },
    separadorPuntoYComa: {
      descripcion: "Mismo reporte pero delimitado por ';' en vez de ',' (incidente del 27/07/2026)",
      extension: "csv",
      cuerpo: "Virtual Machine;Status;Details\r\nvm-e2e-dead-01;Inaccessible;Configuration file vmx not found",
      esperado: { etiqueta: OPS_LABEL_PROCESADO, cierraTarea: true, subeADrive: true }
    },
    entrecomillado: {
      descripcion: "Todos los campos entre comillas: causa raíz del incidente del 27/07/2026 en parseCsvDeReporte",
      extension: "csv",
      cuerpo: '"Virtual Machine","Status","Details"\r\n"vm-e2e-dead-01","Inaccessible","Configuration file vmx not found"',
      esperado: { etiqueta: OPS_LABEL_PROCESADO, cierraTarea: true, subeADrive: true }
    },
    columnasEnEspanol: {
      descripcion: "Encabezados en español ('Particion'): valida que COLUMN_ALIASES los mapee a los nombres que usan las reglas de excepción",
      extension: "csv",
      cuerpo: "Virtual Machine,Particion,Porcentaje de uso (%)\r\nvm-e2e-full-01,C:\\,91.0",
      esperado: { etiqueta: OPS_LABEL_PROCESADO, cierraTarea: true, subeADrive: true }
    },
    adjuntoSinMatch: {
      descripcion: "El adjunto no coincide con attachmentMatch: debe quedar NO_OP pero dejando una advertencia visible, no desaparecer en silencio",
      extension: "csv",
      nombreArchivo: "otra-cosa-que-no-matchea.csv",
      cuerpo: "Virtual Machine,Status\r\nvm-e2e-01,Inaccessible",
      // NO_OP marca el hilo como procesado (reintentar no cambia el nombre del archivo),
      // pero no crea ticket ni cierra la tarea programada.
      esperado: { etiqueta: OPS_LABEL_PROCESADO, cierraTarea: false, subeADrive: false }
    },
    duplicado: {
      descripcion: "El mismo reporte enviado dos veces el mismo día. El primero cierra la Tarea Programada; el " +
        "segundo ya no encuentra nada abierto y debe resolverse como DUPLICADO: aviso y comentario en la tarea, " +
        "NO [OPS-ERROR]. Los DOS correos tienen que terminar en [OPS-PROCESADO], y Drive debe quedar con una sola " +
        "copia del archivo (crearArchivoSiNoExiste es idempotente). Antes el segundo se apartaba como si faltara " +
        "corregir algo, que es el caso real que reportó el equipo el 28/07/2026.",
      extension: "csv",
      cuerpo: "Virtual Machine,Status,Details\r\nvm-e2e-dead-01,Inaccessible,Configuration file vmx not found",
      repeticiones: 2,
      esperado: { etiqueta: OPS_LABEL_PROCESADO, cierraTarea: true, subeADrive: true, sinDuplicadosEnDrive: true }
    },
    adjuntoNuevoEnSegundoEnvio: {
      descripcion: "Caso real reportado por el equipo (28/07/2026): el cliente manda el reporte del día en dos " +
        "correos separados — el primero trae solo el PDF, el segundo (mismo asunto, mismo día) trae PDF + un " +
        "archivo que antes no había llegado. Los DOS adjuntos tienen que terminar en Drive, el PDF sin " +
        "duplicarse, y el segundo correo se resuelve como reporte duplicado (ver caso 'duplicado'), no como " +
        "error. Se prueba sobre un reporte de Veeam ONE (pasos:['drive']) porque ese archetype no filtra por " +
        "attachmentMatch: archiva TODO lo que traiga el correo, igual que el caso real (PDF + XLSX).",
      envios: [
        {
          adjuntos: [
            { extension: "pdf", nombreArchivo: "Replicas protegidas.pdf", cuerpo: "%PDF-1.4 (contenido simulado del harness E2E)" }
          ]
        },
        {
          adjuntos: [
            { extension: "pdf", nombreArchivo: "Replicas protegidas.pdf", cuerpo: "%PDF-1.4 (contenido simulado del harness E2E)" },
            // Con filasXlsx se genera un XLSX REAL (convertDataToXlsxBlob). No sirve un blob
            // vacío: un adjunto de 0 bytes no sobrevive el viaje Gmail -> Drive y el caso
            // pasaría en verde sin haber probado nada.
            { extension: "xlsx", nombreArchivo: "Replicas protegidas.xlsx", filasXlsx: [["VM Name", "Replica Job", "Last Replica"], ["vm-e2e-repl-01", "Replica_E2E", "28/07/2026"]] }
          ]
        }
      ],
      esperado: { etiqueta: OPS_LABEL_PROCESADO, cierraTarea: true, subeADrive: true }
    },
    sinAnomaliasReales: {
      descripcion: "El reporte TRAE filas, pero ninguna es una anomalía real: todas quedan descartadas " +
        "(acá por ser 'Backup to tape'; el caso que se vio en producción fue con todas las VMs exceptuadas). " +
        "filterOrphanedVMsData*() devuelve el encabezado como primera fila de `rows`, así que ese reporte " +
        "deja rows.length === 1 y vmCount === 0. Como MailProcessor enruta por finalAlerts.length, el caso " +
        "caía en handleAlerts() y abría un ticket que decía 'Se han detectado 0 Orphaned VMs' " +
        "(PTRNSNR-12069, 07/08/2026). Lo correcto es no crear NINGÚN ticket y cerrar la Tarea Programada.\n" +
        "Ojo: distinto del caso 'vacio', donde el reporte no trae filas y corta antes, en isDataEmpty().",
      extension: "csv",
      // Tiene que contener "details" (o el attachmentMatch) para que lo tome findAttachment().
      nombreArchivo: "details-Orphaned VMs sin anomalias.csv",
      cuerpo: [
        "Workload Name,Restore Points,Backup Location,Last Backup Date,Deleted at,Type of protection",
        "vm-e2e-orphan-tape-01,3,Repo-E2E,10/08/2026,20/08/2026,Backup to tape",
        "vm-e2e-orphan-tape-02,5,Repo-E2E,10/08/2026,20/08/2026,Backup to tape"
      ].join("\r\n"),
      esperado: {
        etiqueta: OPS_LABEL_PROCESADO,
        cierraTarea: true,
        subeADrive: true,
        // La aserción que hace fallar este caso contra el código viejo.
        creaTicket: false,
        ticketSummary: ORPHANED_VMS_TICKET_SUMMARY
      }
    }
  };
}

/**
 * Sobre qué processors se corren los casos borde de arriba.
 * "VMs inaccesibles" y "Capacidad de particiones" son los dos que rompieron en producción
 * (reporte vacío el 28/07, alias de columna en español en varias ocasiones).
 */
const E2E_CASOS_BORDE_APLICAN_A = {
  vacio: ['processInaccessibleVMsEmails'],
  separadorPuntoYComa: ['processInaccessibleVMsEmails'],
  entrecomillado: ['processInaccessibleVMsEmails'],
  columnasEnEspanol: ['processPartitionEmails'],
  adjuntoSinMatch: ['processInaccessibleVMsEmails'],
  duplicado: ['processInaccessibleVMsEmails'],
  adjuntoNuevoEnSegundoEnvio: ['processVeeamReplicasProtegidasEmails'],
  sinAnomaliasReales: ['processOrphanedVMsEmails']
};

/** MIME por extensión de fixture. */
const E2E_MIME_POR_EXTENSION = {
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf"
};

/**
 * Construye el correo de prueba (asunto + adjunto) de una fixture, derivando asunto y nombre
 * de archivo de la configuración REAL del processor para que no puedan desincronizarse.
 *
 * @param {string} tarea Clave del registro de processors (ej. "processInaccessibleVMsEmails").
 * @param {Object} fixture Entrada de E2E_FIXTURES o de obtenerCasosBorde().
 * @param {string} runId Identificador de la corrida, para poder encontrar y limpiar estos correos.
 * @param {string} caso Nombre del caso ("normal", "vacio", ...). Va en el asunto porque un mismo
 *   processor se prueba con varios casos y, sin él, todos los correos serían indistinguibles.
 * @returns {{asunto: string, blob: GoogleAppsScript.Base.Blob, nombreArchivo: string, scheduledTaskName: string}|null}
 */
function construirCorreoDeFixture(tarea, fixture, runId, caso) {
  const processor = obtenerProcessorDeTarea(tarea);
  if (!processor) return null;

  if (!processor.emailSubject || String(processor.emailSubject).trim() === "") {
    Logger.log(`[E2E] El processor de "${tarea}" no filtra por asunto (es el catch-all): no se le puede armar un correo dirigido.`);
    return null;
  }

  const nombreArchivo = _nombreDeArchivo(processor, fixture, caso);

  let blob;
  if (fixture.filasXlsx) {
    blob = convertDataToXlsxBlob(fixture.filasXlsx, nombreArchivo);
    if (!blob) {
      Logger.log(`[E2E] No se pudo generar el XLSX de la fixture "${tarea}".`);
      return null;
    }
  } else {
    const mime = E2E_MIME_POR_EXTENSION[fixture.extension] || "text/plain";
    blob = Utilities.newBlob(fixture.cuerpo, mime, nombreArchivo);
  }

  return {
    asunto: `${processor.emailSubject} ${E2E_MARCADOR(runId, caso)}`,
    blob: blob,
    nombreArchivo: nombreArchivo,
    scheduledTaskName: processor.scheduledTaskName || null
  };
}

/**
 * Como construirCorreoDeFixture(), pero para fixtures con múltiples ENVÍOS y/o varios adjuntos
 * por envío (fixture.envios) — a diferencia de `repeticiones`, que reenvía el MISMO adjunto tal
 * cual, acá cada envío puede traer adjuntos distintos.
 *
 * Caso real que motiva esto: un cliente manda el reporte del día en un correo con un solo
 * adjunto, y más tarde otro correo con el mismo asunto que ya trae el adjunto que antes
 * faltaba — los dos tienen que terminar archivados en Drive, sin perder el primero ni
 * duplicarlo.
 *
 * @param {boolean} [soloMetadatos=false] Si es true, NO genera los adjuntos: devuelve solo
 *   asunto/nombres/tarea. Lo usa la verificación, que necesita los nombres pero no los archivos
 *   — y generar un XLSX crea una hoja temporal en Drive, basura que no hace falta para leer un
 *   nombre (mismo criterio que obtenerProcessorDeTarea()).
 * @returns {Array<{asunto: string, blobs: Array<Blob>, nombresArchivo: Array<string>, scheduledTaskName: string|null}>}
 */
function construirEnviosDeFixture(tarea, fixture, runId, caso, soloMetadatos) {
  const processor = obtenerProcessorDeTarea(tarea);
  if (!processor) return [];

  if (!processor.emailSubject || String(processor.emailSubject).trim() === "") {
    Logger.log(`[E2E] El processor de "${tarea}" no filtra por asunto (es el catch-all): no se le puede armar un correo dirigido.`);
    return [];
  }

  const asunto = `${processor.emailSubject} ${E2E_MARCADOR(runId, caso)}`;

  return fixture.envios.map(function (envio) {
    const blobs = [];
    const nombresArchivo = [];
    envio.adjuntos.forEach(function (adj) {
      const nombreArchivo = `${E2E_PREFIJO_FECHA()} ${adj.nombreArchivo}`;

      if (soloMetadatos) {
        nombresArchivo.push(nombreArchivo);
        return;
      }

      let blob;
      if (adj.filasXlsx) {
        blob = convertDataToXlsxBlob(adj.filasXlsx, nombreArchivo);
        if (!blob) {
          Logger.log(`[E2E] No se pudo generar el XLSX "${nombreArchivo}" de la fixture "${tarea}": el envío va a quedar incompleto.`);
          return;
        }
      } else {
        const mime = E2E_MIME_POR_EXTENSION[adj.extension] || "text/plain";
        blob = Utilities.newBlob(adj.cuerpo, mime, nombreArchivo);
      }

      blobs.push(blob);
      nombresArchivo.push(nombreArchivo);
    });
    return { asunto: asunto, blobs: blobs, nombresArchivo: nombresArchivo, scheduledTaskName: processor.scheduledTaskName || null };
  });
}

/**
 * Instancia el processor de una tarea del registro, o null si no se puede.
 * Separado de construirCorreoDeFixture() para poder leer la configuración de un processor
 * (ej. su scheduledTaskName) sin el costo de generar el adjunto — armar un XLSX crea una
 * hoja temporal en Drive, que no hace falta solo para saber cómo se llama una tarea.
 */
function obtenerProcessorDeTarea(tarea) {
  const entrada = obtenerRegistroDeProcesadores().find(function (e) { return e.tarea === tarea; });
  if (!entrada) {
    Logger.log(`[E2E] No existe la tarea "${tarea}" en el registro de processors.`);
    return null;
  }
  try {
    return entrada.crear();
  } catch (e) {
    Logger.log(`[E2E] No se pudo instanciar el processor de "${tarea}": ${e.message}`);
    return null;
  }
}

/**
 * Nombre del adjunto de una fixture.
 *
 * Dos requisitos que se cruzan:
 *  1. findAttachment() del processor tiene que aceptarlo. Si attachmentMatch es una extensión
 *     (".json") el match lo da la extensión y el nombre base puede ser el de la operación;
 *     si es un texto, el nombre TIENE que contenerlo.
 *  2. Tiene que ser único por caso. Un mismo processor se prueba con varias fixtures, y la
 *     carpeta de Drive del día deduplica por nombre (crearArchivoSiNoExiste): si todos los
 *     casos generaran el mismo nombre, solo se archivaría el primero y la verificación de los
 *     demás daría un falso resultado.
 *
 * El prefijo de fecha no es decorativo: la idempotencia del adjunto en Jira compara por nombre
 * de archivo, así que reportes de días distintos tienen que llamarse distinto.
 */
function _nombreDeArchivo(processor, fixture, caso) {
  const sufijo = `-${caso || "normal"}`;

  if (fixture.nombreArchivo) {
    const punto = String(fixture.nombreArchivo).lastIndexOf(".");
    const base = punto === -1 ? fixture.nombreArchivo : fixture.nombreArchivo.substring(0, punto);
    const ext = punto === -1 ? `.${fixture.extension}` : fixture.nombreArchivo.substring(punto);
    return `${E2E_PREFIJO_FECHA()} ${base}${sufijo}${ext}`;
  }

  const match = processor.attachmentMatch;
  const base = (!match || String(match).charAt(0) === ".") ? processor.operationName : match;
  return `${E2E_PREFIJO_FECHA()} ${base}${sufijo}.${fixture.extension}`;
}

/** Prefijo de fecha del nombre de archivo (los reportes reales lo traen y Jira lo usa para la idempotencia del adjunto). */
function E2E_PREFIJO_FECHA() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/**
 * Marcador que se agrega al final del asunto. Incluye el caso porque un mismo processor se
 * prueba con varias fixtures (normal + casos borde) y todas comparten el mismo emailSubject:
 * sin el caso en el asunto, la verificación no podría saber a cuál corresponde cada hilo.
 */
function E2E_MARCADOR(runId, caso) {
  return `${E2E_PREFIJO_MARCADOR(runId)}:${caso || "normal"}]`;
}

/** Parte del marcador común a toda la corrida. Sirve para buscar/filtrar todos sus correos. */
function E2E_PREFIJO_MARCADOR(runId) {
  return `[E2E:${runId}`;
}
