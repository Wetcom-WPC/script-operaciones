/**
 * @fileoverview Funciones de prueba para validar componentes críticos del sistema antes de producción.
 */

function runAllTests() {
  Logger.log("Iniciando batería de pruebas...");

  testExtractDRPClientName();
  testConstantsExistence();

  Logger.log("Pruebas finalizadas.");
}

function testExtractDRPClientName() {
  Logger.log("--- Test: extractDRPClientName ---");
  const subject1 = "Alertas de vSphere DRP OSDE (2026-07-23)";
  const result1 = extractDRPClientName(subject1, "Alertas de vSphere");
  if (result1 === "OSDE") {
    Logger.log("✔ Prueba 1 exitosa");
  } else {
    Logger.log(`❌ Prueba 1 fallida. Esperado OSDE, obtenido ${result1}`);
  }

  const subject2 = "vSphere DRP CLIENTEX (algo)";
  const result2 = extractDRPClientName(subject2, "vSphere");
  if (result2 === "CLIENTEX") {
    Logger.log("✔ Prueba 2 exitosa");
  } else {
    Logger.log(`❌ Prueba 2 fallida. Esperado CLIENTEX, obtenido ${result2}`);
  }
}

function testConstantsExistence() {
  Logger.log("--- Test: Constantes Globales ---");
  const constantesRequeridas = [
    "MASTER_INDEX_SHEET_ID",
    "JIRA_DOMAIN",
    "JIRA_AUTH_TOKEN_BASE_64",
    "SLACK_WEBHOOK_URL",
    "ENVIRONMENT"
  ];
  
  const props = PropertiesService.getScriptProperties();
  let todasPresentes = true;

  constantesRequeridas.forEach(c => {
    const typeofC = typeof this[c];
    if (typeofC === "undefined" && !props.getProperty(c)) {
      Logger.log(`⚠️ Falla: La constante/propiedad ${c} no está definida.`);
      todasPresentes = false;
    }
  });

  if (todasPresentes) {
    Logger.log("✔ Todas las constantes requeridas parecen estar disponibles.");
  }
}
