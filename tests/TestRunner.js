/**
 * @fileoverview Framework básico de pruebas unitarias nativo para Apps Script.
 */

function runAllTests() {
  Logger.log("=== INICIANDO SUITE DE PRUEBAS ===");
  
  let passed = 0;
  let failed = 0;

  function assertEqual(actual, expected, testName) {
    if (actual === expected) {
      Logger.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      Logger.log(`❌ [FAIL] ${testName} | Esperado: "${expected}", Obtenido: "${actual}"`);
      failed++;
    }
  }

  function assertTrue(condition, testName) {
    if (condition) {
      Logger.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      Logger.log(`❌ [FAIL] ${testName} | Se esperaba verdadero.`);
      failed++;
    }
  }
  
  function assertFalse(condition, testName) {
    if (!condition) {
      Logger.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      Logger.log(`❌ [FAIL] ${testName} | Se esperaba falso.`);
      failed++;
    }
  }

  // --- TESTS: Configuraciones Globales y Propiedades ---
  Logger.log("--- Test: Propiedades del Script (Script Properties) ---");
  const requiredProperties = [
    "MASTER_INDEX_SHEET_ID",
    "JIRA_API_TOKEN_BASE64",
    "SLACK_WEBHOOK_GENERAL",
    "JIRA_FILTER_VSPHERE_DIARIO",
    "SLACK_WEBHOOK_REPORTE_DIARIO",
    "SLACK_WEBHOOK_RESUMEN_TICKETS",
    "JIRA_DOMAIN",
    "ENVIRONMENT"
  ];
  
  const props = PropertiesService.getScriptProperties();
  requiredProperties.forEach(prop => {
    const value = props.getProperty(prop);
    assertTrue(value !== null && value.trim() !== "", `Script Property "${prop}" existe y no está vacía.`);
  });

  // --- TESTS: DataProcessingService ---
  Logger.log("--- Test: DataProcessingService ---");
  // Test: normalizarEncabezado
  try {
    assertEqual(normalizarEncabezado("  Mi Columna  "), "mi columna", "normalizarEncabezado: recorta y minúscula");
    assertEqual(normalizarEncabezado("Espacios   Extra"), "espacios extra", "normalizarEncabezado: colapsa espacios");
    // C-06: casos "sucios" para validar la robustez real (mayúsculas, guiones, alias).
    assertEqual(normalizarEncabezado("VM-Name"), "name", "normalizarEncabezado: guiones->espacio y alias a canónico 'name'");
    assertEqual(normalizarEncabezado("  VM   Name "), "name", "normalizarEncabezado: espacios extra + alias 'vm name'->'name'");
    // Relevante a BUG-01: 'object' NO está aliaseado a 'name', por eso Zombies forzaba mal la columna.
    assertEqual(normalizarEncabezado("Object"), "object", "normalizarEncabezado: 'object' se mantiene (no aliaseado a name)");
  } catch(e) { Logger.log("Error en Test normalizarEncabezado: " + e.message); }

  // Test: parseCsvRobust
  try {
    const csvTest = 'Col1,Col2\nVal1,"Val,2"';
    const parsed = parseCsvRobust(csvTest);
    assertEqual(parsed.length, 2, "parseCsvRobust: lee 2 filas");
    assertEqual(parsed[1][1], "Val,2", "parseCsvRobust: respeta comas internas");
  } catch(e) { Logger.log("Error en Test parseCsvRobust: " + e.message); }

  // Test: detectarSeparadorCsv — cubre el incidente del 27/07/2026, donde un separador
  // mal detectado partía el CSV en 1 sola columna y TODAS las operaciones fallaban con
  // "Columna X no encontrada".
  try {
    assertEqual(detectarSeparadorCsv('Name,Cluster,Estado'), ",", "detectarSeparadorCsv: CSV por comas");
    assertEqual(detectarSeparadorCsv('Name;Cluster;Estado'), ";", "detectarSeparadorCsv: CSV por punto y coma");
    // Un ';' suelto dentro de un valor no debe ganarle a las comas reales.
    assertEqual(detectarSeparadorCsv('Name,Cluster; Sitio,Estado'), ",", "detectarSeparadorCsv: ';' suelto no confunde");
    // Separadores entre comillas se ignoran.
    assertEqual(detectarSeparadorCsv('Name,Cluster,"PROD; DRP"'), ",", "detectarSeparadorCsv: ignora separadores entre comillas");
    // Primera línea vacía o de preámbulo: no debe decidir por sí sola.
    assertEqual(detectarSeparadorCsv('\nName;Cluster;Estado\n"a";"b";"c"'), ";", "detectarSeparadorCsv: tolera primera línea vacía");
    assertEqual(detectarSeparadorCsv('Reporte vSphere\nName;Cluster;Estado'), ";", "detectarSeparadorCsv: tolera preámbulo de título");

    // Regresión end-to-end: el encabezado debe quedar partido en varias columnas.
    const csvConPreambulo = '\nName;Partition Usage (%);Cluster\n"SRV-01";"92";"PROD"';
    const filas = parseCsvRobust(csvConPreambulo);
    const encabezado = filas.find(r => r.length > 1) || [];
    assertEqual(encabezado.length, 3, "parseCsvRobust: encabezado se parte en 3 columnas (no en 1)");
    const headersNorm = encabezado.map(h => normalizarEncabezado(h.replace(/^"|"$/g, '')));
    assertTrue(headersNorm.indexOf(normalizarEncabezado("Partition Usage (%)")) !== -1,
               "parseCsvRobust + normalizarEncabezado: se encuentra 'Partition Usage (%)'");
  } catch(e) { Logger.log("Error en Test detectarSeparadorCsv: " + e.message); }

  // Test: parseCsvDeReporte — causa raíz del incidente del 27/07/2026. Los CSV con
  // TODOS los campos entrecomillados quedaban en una sola columna porque se les
  // quitaban las comillas externas a ciegas, descompensando el balance de comillas.
  try {
    const csvEntrecomillado = '"Name","DRS Configuration","Datacenter"\n"CL-01","Disabled","DC1"';
    const filas = parseCsvDeReporte(csvEntrecomillado);
    assertEqual(filas[0].length, 3, "parseCsvDeReporte: campos entrecomillados -> 3 columnas (no 1)");
    const headersNorm = filas[0].map(h => normalizarEncabezado(h));
    assertTrue(headersNorm.indexOf(normalizarEncabezado("DRS Configuration")) !== -1,
               "parseCsvDeReporte: se encuentra 'DRS Configuration' tras normalizar");

    // El caso que la limpieza original SÍ resolvía debe seguir funcionando.
    const csvFilaEnvuelta = '"Name,DRS Configuration,Datacenter"\n"CL-01,Disabled,DC1"';
    assertEqual(parseCsvDeReporte(csvFilaEnvuelta)[0].length, 3,
                "parseCsvDeReporte: fila entera envuelta en comillas se desenvuelve");

    // Un valor con el separador adentro no debe partirse.
    const conSeparadorInterno = parseCsvDeReporte('"Name","Cluster"\n"vm1","PROD, DRP"');
    assertEqual(conSeparadorInterno[1][1], "PROD, DRP", "parseCsvDeReporte: valor con coma interna intacto");
  } catch(e) { Logger.log("Error en Test parseCsvDeReporte: " + e.message); }

  // Test: alias Particion/Partition. Los reportes en español traen "Particion" pero las
  // reglas del Excel de excepciones dicen "Partition": sin alias esas reglas no aplicaban.
  try {
    assertEqual(normalizarEncabezado("Particion"), "partition", "normalizarEncabezado: 'Particion' -> 'partition'");
    assertEqual(normalizarEncabezado("Partición"), "partition", "normalizarEncabezado: 'Partición' (con acento) -> 'partition'");
    // No debe pisarse con la columna del porcentaje de uso, que es otra cosa.
    assertEqual(normalizarEncabezado("Porcentaje de uso (%)"), "partition usage (%)",
                "normalizarEncabezado: '% de uso' sigue mapeando a 'partition usage (%)'");

    const headersEsp = ["name", "datacenter", "particion", "porcentaje de uso (%)"];
    const reglaPartition = { r: [{ column: "Partition", matchType: "Exacta", values: ["c:"] }] };
    assertTrue(isRowExcepted(["srv-01", "DC1", "C:", "91"], headersEsp, reglaPartition),
               "isRowExcepted: regla 'Partition' aplica sobre reporte con columna 'particion'");
    assertFalse(isRowExcepted(["srv-01", "DC1", "D:", "91"], headersEsp, reglaPartition),
                "isRowExcepted: otra partición no queda exceptuada");
  } catch(e) { Logger.log("Error en Test alias Particion: " + e.message); }

  // Test: isRowExcepted
  try {
    const headers = ["vm name", "status"]; // Ya normalizados
    const exceptions = {
      "regla1": [
        { column: "VM Name", matchType: "Exacta", values: ["servidor1", "servidor2"] }
      ]
    };

    assertTrue(isRowExcepted(["Servidor1", "PoweredOff"], headers, exceptions), "isRowExcepted: match exacto ignora mayúsculas en valor");
    assertFalse(isRowExcepted(["Servidor3", "PoweredOff"], headers, exceptions), "isRowExcepted: falla si el valor no está en la lista");

    // C-06: valores "sucios" en el ENCABEZADO del reporte (mayúsculas, espacios extra, guiones).
    // Verifica que la coincidencia dependa de normalizarEncabezado y no de que el header ya venga limpio.
    const headersSucios = ["  VM   Name  ", "STATUS"];
    const excExacta = { "r": [{ column: "Name", matchType: "Exacta", values: ["servidor1"] }] };
    assertTrue(isRowExcepted(["servidor1", "PoweredOff"], headersSucios, excExacta), "isRowExcepted: normaliza header sucio 'VM   Name' -> 'name'");
    assertFalse(isRowExcepted(["servidorX", "PoweredOff"], headersSucios, excExacta), "isRowExcepted: no matchea si el valor está ausente");

    // matchType 'contiene' con el valor del reporte en MAYÚSCULAS.
    const excContiene = { "r": [{ column: "name", matchType: "Contiene", values: ["fcd"] }] };
    assertTrue(isRowExcepted(["FCD-1234-flat.VMDK"], ["name"], excContiene), "isRowExcepted: 'contiene' ignora mayúsculas del valor del reporte");
    assertFalse(isRowExcepted(["hbrdisk-9.vmdk"], ["name"], excContiene), "isRowExcepted: 'contiene' no matchea sin el substring");

    // BUG-01: reproduce la raíz. Si el header del reporte es "object" (no aliaseado a name) y la
    // regla usa "name", NO debe matchear -> por eso las excepciones de Zombies nunca aplicaban.
    assertFalse(isRowExcepted(["fcd-1.vmdk"], ["object"], excContiene), "isRowExcepted: columna 'object' != 'name' NO matchea (raíz de BUG-01)");
    // Y con la columna ya forzada a 'name' (como ahora hace procesarZombiesVmdk), SÍ matchea.
    assertTrue(isRowExcepted(["fcd-1.vmdk"], ["name"], excContiene), "isRowExcepted: columna forzada a 'name' matchea (fix BUG-01)");
  } catch(e) { Logger.log("Error en Test isRowExcepted: " + e.message); }

  // --- TESTS: JiraService (A-03) ---
  Logger.log("--- Test: JiraService / ADF ---");
  try {
    const marcador = "[AUTO-UPDATE:2026-07-24] Zombies VMDKs";
    const adf = construirAdfDesdeTexto(`${marcador}\n\n🚨 La anomalía persiste.`);
    const adfStr = JSON.stringify(adf);
    // El lector haSidoActualizadoHoy hace JSON.stringify(body).includes(marcador): debe sobrevivir.
    assertTrue(adfStr.includes(marcador), "construirAdfDesdeTexto: preserva el marcador anti-duplicado como texto contiguo");
    assertEqual(adf.type, "doc", "construirAdfDesdeTexto: genera documento ADF con type 'doc'");
    assertEqual(adf.version, 1, "construirAdfDesdeTexto: ADF version 1");
    // Texto vacío no debe romper (genera un nodo con espacio).
    const adfVacio = construirAdfDesdeTexto("");
    assertTrue(JSON.stringify(adfVacio).length > 0, "construirAdfDesdeTexto: tolera texto vacío");
  } catch(e) { Logger.log("Error en Test construirAdfDesdeTexto: " + e.message); }

  // --- TESTS: Ventana operativa (BUG-03) ---
  Logger.log("--- Test: Ventana Operativa ---");
  try {
    assertTrue(typeof estaEnHorarioOperativo() === "boolean", "estaEnHorarioOperativo: retorna boolean");
    assertTrue(HORARIO_OPERATIVO_INICIO < HORARIO_OPERATIVO_FIN, "Ventana operativa: HORARIO_OPERATIVO_INICIO < HORARIO_OPERATIVO_FIN");
    assertTrue(dentroDeVentanaOperativa("test") === estaEnHorarioOperativo(), "dentroDeVentanaOperativa: consistente con estaEnHorarioOperativo");
  } catch(e) { Logger.log("Error en Test ventana operativa: " + e.message); }

  // --- TESTS: Pipeline unificado / pasos declarados (refactor 27/07/2026) ---
  Logger.log("--- Test: MailProcessor / pasos declarados ---");
  try {
    // Por defecto un reporte necesita crear tickets Y archivarse en Drive.
    const porDefecto = new MailProcessor({ operationName: "test-default", emailSubject: "x" });
    assertTrue(porDefecto.requierePaso('tickets'), "pasos: por defecto incluye 'tickets'");
    assertTrue(porDefecto.requierePaso('drive'), "pasos: por defecto incluye 'drive'");

    // Los reportes tipo Veeam ONE solo se archivan: no crean tickets.
    const soloDrive = new MailProcessor({ operationName: "test-drive", emailSubject: "x", pasos: ['drive'] });
    assertFalse(soloDrive.requierePaso('tickets'), "pasos: un processor 'drive' NO ejecuta el paso de tickets");
    assertTrue(soloDrive.requierePaso('drive'), "pasos: un processor 'drive' sí ejecuta el paso de Drive");

    // Un paso inexistente nunca se ejecuta (evita typos silenciosos en la config).
    assertFalse(porDefecto.requierePaso('inexistente'), "pasos: un paso no declarado no se ejecuta");
  } catch(e) { Logger.log("Error en Test pasos declarados: " + e.message); }

  // --- TESTS: resolución de remitente para Drive ---
  Logger.log("--- Test: DriveClientIndexSingleton / parseo de From ---");
  try {
    const emailDeFrom = DriveClientIndexSingleton.emailDeFrom;
    // El caso real que motivó el refactor: reportes de Veeam ONE de Petersen.
    assertEqual(emailDeFrom('"Veeam ONE" <veeamsmtp@gpsa.com.ar>'), "veeamsmtp@gpsa.com.ar", "emailDeFrom: extrae la casilla de un From con nombre visible");
    assertEqual(emailDeFrom("vrealizeoperations@gbsj.com.ar"), "vrealizeoperations@gbsj.com.ar", "emailDeFrom: tolera un From sin nombre visible");
    assertEqual(emailDeFrom("  ALERTAS@Wetcom.COM  "), "alertas@wetcom.com", "emailDeFrom: normaliza espacios y mayúsculas");
    assertEqual(emailDeFrom(null), "", "emailDeFrom: tolera null sin romper");
  } catch(e) { Logger.log("Error en Test emailDeFrom: " + e.message); }

  // --- TESTS: registro central de fallos (regresión del incidente WPC-815, 27/07/2026) ---
  Logger.log("--- Test: Registro de fallos del mensaje ---");
  try {
    iniciarSeguimientoDeFallos();
    assertEqual(obtenerFallosDelMensaje().length, 0, "fallos: arranca vacío tras iniciarSeguimientoDeFallos()");

    // Caso real: Jira devolvió HTTP 500 al adjuntar y el processor igual devolvía SUCCESS.
    registrarFalloDePaso("addAttachmentToJiraTicket", "Ticket WPC-815: Jira devolvió HTTP 500 al adjuntar.");
    assertEqual(obtenerFallosDelMensaje().length, 1, "fallos: registra el fallo de adjunto");
    assertEqual(obtenerFallosDelMensaje()[0].origen, "addAttachmentToJiraTicket", "fallos: guarda el origen del fallo");

    // Cada correo arranca limpio: un fallo no puede contaminar al siguiente.
    iniciarSeguimientoDeFallos();
    assertEqual(obtenerFallosDelMensaje().length, 0, "fallos: se limpian entre correos");

    // El registro devuelve una copia: mutarla no debe afectar el estado interno.
    registrarFalloDePaso("resolveJiraTicket", "Ticket X: no existe transición.");
    const copia = obtenerFallosDelMensaje();
    copia.push({ origen: "falso", detalle: "no debería persistir" });
    assertEqual(obtenerFallosDelMensaje().length, 1, "fallos: obtenerFallosDelMensaje devuelve una copia, no la referencia interna");

    // Fallos terminales: los que no se arreglan reintentando (ej. tarea programada inexistente).
    iniciarSeguimientoDeFallos();
    registrarFalloDePaso("addAttachmentToJiraTicket", "HTTP 500 transitorio");
    assertFalse(hayFalloTerminal(), "fallos: un fallo transitorio NO es terminal (se reintenta)");

    registrarFalloDePaso("buscarYCerrarTareaProgramada", "La tarea no existe en el proyecto", true);
    assertTrue(hayFalloTerminal(), "fallos: NOT_FOUND marca el correo como terminal (va a [OPS-ERROR])");
    assertEqual(obtenerFallosDelMensaje()[1].terminal, true, "fallos: guarda el flag terminal en el registro");

    iniciarSeguimientoDeFallos();
    assertFalse(hayFalloTerminal(), "fallos: el flag terminal también se limpia entre correos");
  } catch(e) { Logger.log("Error en Test registro de fallos: " + e.message); }

  // --- TESTS: registro de processors (Etapa A/B del refactor) ---
  Logger.log("--- Test: Registro de processors ---");
  try {
    const registro = obtenerRegistroDeProcesadores();
    assertTrue(registro.length > 24, "registro: incluye los processors originales + los de Veeam ONE + el catch-all");

    // Toda entrada debe poder instanciarse: si una clase se renombra, esto lo detecta acá
    // y no en producción a mitad del ciclo.
    let instanciablesOk = true;
    registro.forEach(function (e) {
      try {
        const p = e.crear();
        if (!p || typeof p.processEmails !== "function") instanciablesOk = false;
      } catch (err) {
        instanciablesOk = false;
        Logger.log(`  -> No se pudo instanciar "${e.tarea}": ${err.message}`);
      }
    });
    assertTrue(instanciablesOk, "registro: todas las entradas se instancian y exponen processEmails()");

    // El catch-all debe ir SIEMPRE último: si corriera antes, se llevaría correos que
    // le corresponden a un processor específico.
    assertEqual(registro[registro.length - 1].tarea, "processReportesSinProcessorEmails", "registro: el catch-all es la última tarea del ciclo");

    // Los asuntos reclamados alimentan al catch-all; el suyo propio ("") no debe estar.
    const asuntos = obtenerAsuntosConProcessor();
    assertTrue(asuntos.indexOf("VMs protegidas") !== -1, "asuntos: incluye los reportes de Veeam ONE (Etapa 2)");
    assertTrue(asuntos.every(function (a) { return a && a.trim() !== ""; }), "asuntos: no incluye vacíos (el catch-all quedaría sin correos)");
  } catch(e) { Logger.log("Error en Test registro de processors: " + e.message); }

  Logger.log("=== FIN DE SUITE DE PRUEBAS ===");
  Logger.log(`Resultados: ${passed} Pasaron, ${failed} Fallaron.`);
  
  if (failed > 0) {
    throw new Error(`Fallaron ${failed} pruebas unitarias.`);
  }
}
