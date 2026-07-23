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

  // --- TESTS: DataProcessingService ---
  
  // Test: normalizarEncabezado
  try {
    assertEqual(normalizarEncabezado("  Mi Columna  "), "mi columna", "normalizarEncabezado recorta y minúscula");
    assertEqual(normalizarEncabezado("Espacios   Extra"), "espacios extra", "normalizarEncabezado colapsa espacios");
  } catch(e) { Logger.log("Error en Test normalizarEncabezado: " + e.message); }

  // Test: parseCsvRobust
  try {
    const csvTest = 'Col1,Col2\nVal1,"Val,2"';
    const parsed = parseCsvRobust(csvTest);
    assertEqual(parsed.length, 2, "parseCsvRobust: lee 2 filas");
    assertEqual(parsed[1][1], "Val,2", "parseCsvRobust: respeta comas internas");
  } catch(e) { Logger.log("Error en Test parseCsvRobust: " + e.message); }

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
  } catch(e) { Logger.log("Error en Test isRowExcepted: " + e.message); }

  Logger.log("=== FIN DE SUITE DE PRUEBAS ===");
  Logger.log(`Resultados: ${passed} Pasaron, ${failed} Fallaron.`);
  
  if (failed > 0) {
    throw new Error(`Fallaron ${failed} pruebas unitarias.`);
  }
}
