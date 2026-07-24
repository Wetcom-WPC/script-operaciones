/**
 * =================================================================
 * HERRAMIENTAS MANUALES / DE TESTING (acceso rápido desde el editor)
 * =================================================================
 * Funciones para ejecutar manualmente procesos desde el editor de Apps Script.
 * NO están conectadas a ningún trigger: son para pruebas y ejecuciones puntuales.
 *
 * Convención de nombres: prefijo `manual_` para que sean fáciles de encontrar en
 * el desplegable de funciones del editor.
 *
 * ⚠️ IMPORTANTE: varias de estas funciones ejecutan acciones reales (Jira/Gmail/Drive).
 * Verificá que la Script Property ENVIRONMENT esté en "TESTING" si no querés impactar
 * clientes reales (los envíos de correo se redirigen en TESTING, ver NotificationService.js).
 * =================================================================
 */

// Cliente y carpeta de Drive usados para probar el flujo de RVTools.
// (Reemplaza al viejo hola() que estaba en RVTools_Main.js — C-01).
const MANUAL_TEST_CLIENT_NAME = "WPC - Operaciones Testing";
const MANUAL_TEST_RVTOOLS_FOLDER_ID = "1hqgJzoMtaqcMdwCSaSHjGBVvYMxe5Tvw";

/**
 * Ejecuta el flujo completo de RVTools (Zombies + ConnectAtPowerOn) contra el
 * cliente/carpeta de testing. Antes se llamaba hola().
 */
function manual_RVToolsTesting() {
  const resultado = procesarRVToolsManual(MANUAL_TEST_CLIENT_NAME, MANUAL_TEST_RVTOOLS_FOLDER_ID);
  Logger.log(`[manual_RVToolsTesting] Resultado: ${JSON.stringify(resultado)}`);
  return resultado;
}

/**
 * Corre toda la suite de pruebas unitarias (tests/TestRunner.js).
 */
function manual_runAllTests() {
  return runAllTests();
}

/**
 * Muestra si estamos dentro de la ventana operativa (05-15hs AR) y la hora detectada.
 * Útil para validar la guarda horaria de los triggers 24/7 (BUG-03).
 */
function manual_probarHorarioOperativo() {
  const hora = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd HH:mm:ss");
  Logger.log(`[manual_probarHorarioOperativo] Hora AR: ${hora} | ¿Dentro de ventana operativa (${HORARIO_OPERATIVO_INICIO}-${HORARIO_OPERATIVO_FIN})? ${estaEnHorarioOperativo()}`);
}

/**
 * Ejecuta organizarReportesEnDrive IGNORANDO la guarda horaria (para pruebas fuera de horario).
 * Llama directamente a la lógica interna con una ventana de búsqueda de 2h.
 */
function manual_organizarReportesAhora() {
  const props = PropertiesService.getScriptProperties();
  const idCarpetaPrincipal = props.getProperty("DRIVE_AVISO_BASE_FOLDER_ID");
  const idHojaCalculo = props.getProperty("MASTER_INDEX_SHEET_ID");
  Logger.log("[manual_organizarReportesAhora] Ejecutando guardarYConvertirAdjuntosEnDrive (bypass de horario, ventana 2h)...");
  guardarYConvertirAdjuntosEnDrive(idCarpetaPrincipal, idHojaCalculo, 2);
}

/**
 * Ejecuta el procesamiento de alarmas de proxies de Veeam IGNORANDO la guarda horaria.
 */
function manual_procesarProxiesAhora() {
  Logger.log("[manual_procesarProxiesAhora] Ejecutando ProxiesVeeamProcessor (bypass de horario)...");
  new ProxiesVeeamProcessor().processEmails();
}

// Nombre de operación usado por defecto en manual_diagnosticarEncabezados. Cambiá este valor
// (o llamá directo a diagnosticarEncabezadosDeReporte("Otro Nombre") desde el editor) según
// qué reporte quieras inspeccionar. Debe ser el asunto EXACTO del correo (ej. "VMs operativas").
const MANUAL_DIAGNOSTICO_OPERATION_NAME = "VMs operativas";

/**
 * Diagnóstico de encabezados de un reporte (envuelve diagnosticarEncabezadosDeReporte de Utils.js).
 * SpreadsheetApp.getUi() no funciona al correr con el botón "Run" del editor (requiere un
 * contexto de UI real, ej. un menú de hoja), por eso acá se pasa el nombre de la operación
 * directamente como parámetro en vez de depender del prompt.
 */
function manual_diagnosticarEncabezados() {
  return diagnosticarEncabezadosDeReporte(MANUAL_DIAGNOSTICO_OPERATION_NAME);
}
