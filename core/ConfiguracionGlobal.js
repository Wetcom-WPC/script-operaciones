/**
 * @fileoverview Contiene todas las constantes de configuración que son
 * compartidas por todos los scripts del proyecto.
 */

const MASTER_INDEX_SHEET_ID = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");

// Nombre de la pestaña del Índice Maestro con la tabla de clientes (remitentes, proyecto de
// Jira, etc.). Se lee por NOMBRE, nunca por posición (.getSheets()[0]): el 30/10/2026 se
// descubrió que una pestaña oculta ("_Operadores", con una tabla de log sin relación) había
// quedado en la posición 0 del spreadsheet -alguien la insertó o reordenó-, así que
// .getSheets()[0] dejó de devolver esta pestaña en silencio. Resultado: getClientConfig() no
// encontraba NINGÚN cliente (ni el dominio ni el email coincidían con nada en los datos de
// "_Operadores"), así que ningún reporte cerraba su Tarea Programada ni se archivaba
// correctamente — sin ningún error, porque "fila no encontrada" es un resultado válido para un
// cliente que de verdad no está dado de alta. Si esta pestaña se renombra, hay que actualizar
// esta constante (y nada más: todos los lectores del Índice Maestro pasan por acá).
const MASTER_INDEX_SHEET_NAME = "Sheet1";
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

