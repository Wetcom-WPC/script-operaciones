/**
 * Archivo de configuracion global. Contiene variables y constantes
 * compartidas por todos los scripts del proyecto.
 */

const MASTER_INDEX_SHEET_ID = "1ZriSQeckRp_hWXS0X-CdGzrnnplCj2KmcLHgAbXo6qU"; // Forzado por pedido de Ian
const JIRA_AUTH_TOKEN_BASE_64 = PropertiesService.getScriptProperties().getProperty("JIRA_API_TOKEN_BASE64");
const SLACK_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL"); /** Canal tareas-programadas-tickets-logs*/
const JIRA_FILTER_ID_REPORTE_DIARIO = PropertiesService.getScriptProperties().getProperty("JIRA_FILTER_VSPHERE_DIARIO");
const SLACK_WEBHOOK_URL_REPORTE_DIARIO = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_REPORTE_DIARIO");  /** Canal resumen-operaciones */  
const JIRA_STATUS_TO_CLOSE = "Finalizado";
const SLACK_WEBHOOK_URL_RESUMEN_TICKETS = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_RESUMEN_TICKETS");   /** Canal resumen-operaciones */
const JIRA_DOMAIN = PropertiesService.getScriptProperties().getProperty('JIRA_DOMAIN');

/**
 * Cliente al que se redirige TODO cuando el proyecto corre en modo TESTING.
 * Es la contracara de la redirección de correo que ya hacía sendEmail(): en testing
 * ningún ticket ni archivo puede terminar en el proyecto o la carpeta de un cliente real.
 */
const TESTING_SAFETY_CLIENT_NAME = "WPC - Operaciones Testing";

/**
 * @returns {boolean} true si este proyecto de Apps Script es un entorno de pruebas.
 *
 * Se lee en cada llamada (y no en una constante de nivel superior) porque el valor puede
 * cambiarse desde Script Properties sin volver a desplegar, y porque las pruebas necesitan
 * poder simular ambos entornos dentro de una misma ejecución.
 */
function esEntornoTesting() {
  return PropertiesService.getScriptProperties().getProperty("ENVIRONMENT") === "TESTING";
}

