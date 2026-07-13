/**
 * @fileoverview Contiene todas las constantes de configuración que son
 * compartidas por todos los scripts del proyecto.
 */

const MASTER_INDEX_SHEET_ID = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
const JIRA_AUTH_TOKEN_BASE_64 = PropertiesService.getScriptProperties().getProperty("JIRA_API_TOKEN_BASE64");
const SLACK_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL"); /** Canal tareas-programadas-tickets-logs*/
const JIRA_FILTER_ID_REPORTE_DIARIO = PropertiesService.getScriptProperties().getProperty("JIRA_FILTER_VSPHERE_DIARIO");
const SLACK_WEBHOOK_URL_REPORTE_DIARIO = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_REPORTE_DIARIO");  /** Canal resumen-operaciones */  
const JIRA_STATUS_TO_CLOSE = "Finalizado";
const SLACK_WEBHOOK_URL_RESUMEN_TICKETS = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_RESUMEN_TICKETS");   /** Canal resumen-operaciones */
const JIRA_DOMAIN = PropertiesService.getScriptProperties().getProperty('JIRA_DOMAIN');

