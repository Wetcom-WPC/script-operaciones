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

  // --- TESTS: FuncionesCompartidas ---
  Logger.log("--- Test: Funciones Compartidas ---");
  assertEqual(extractDRPClientName("Alertas de vSphere DRP OSDE (2026-07-23)", "Alertas de vSphere"), "OSDE", "extractDRPClientName: extrae cliente OSDE");
  assertEqual(extractDRPClientName("vSphere DRP CLIENTEX (algo)", "vSphere"), "CLIENTEX", "extractDRPClientName: extrae cliente CLIENTEX");

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

  Logger.log("=== FIN DE SUITE DE PRUEBAS ===");
  Logger.log(`Resultados: ${passed} Pasaron, ${failed} Fallaron.`);
  
  if (failed > 0) {
    throw new Error(`Fallaron ${failed} pruebas unitarias.`);
  }
}
