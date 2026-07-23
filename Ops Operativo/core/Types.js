/**
 * @fileoverview Definiciones de tipos globales y documentación JSDoc (Tipado Estricto).
 * Esto permite al IDE y a Google Apps Script autocompletar propiedades y prevenir errores tipográficos.
 */

/**
 * @typedef {Object} ClientConfig
 * Configuración maestra de un cliente obtenida desde el Índice Maestro.
 * 
 * @property {string} clientName - Nombre exacto del cliente.
 * @property {string} [clientNameSop] - Nombre del cliente en Service Desk de Soporte.
 * @property {string} jiraProjectKey - Clave del proyecto principal en Jira (ej: "WPC").
 * @property {string} [jiraProjectKeySop] - Clave del proyecto en Jira de Soporte.
 * @property {string} serviceDeskId - ID interno numérico del portal de Service Desk.
 * @property {string} [serviceDeskIdSop] - ID interno numérico del portal de Soporte.
 * @property {string} requestTypeId - ID interno del Request Type correspondiente a la alerta.
 * @property {string} [requestTypeIdSop] - ID interno del Request Type de Soporte.
 * @property {string} tecnologia - Tecnología asociada (ej: "VMware vSphere").
 * @property {string|null} origen - Origen del alerta (ej: "vCenter A").
 * @property {Object} exceptions - Mapa de excepciones activas agrupadas por Exception ID.
 */

/**
 * @typedef {Object} ExceptionRule
 * Una regla de excepción para filtrar filas de reportes.
 * 
 * @property {string} column - Nombre de la columna en el CSV/Excel.
 * @property {string} matchType - Tipo de coincidencia ('Exacta', 'Contiene', 'Empieza Con', etc).
 * @property {Array<string>} values - Lista de valores esperados para exceptuar.
 */

/**
 * @typedef {Object} SummaryReport
 * Reporte consolidado de una ejecución del MailProcessor.
 * 
 * @property {Array<{mensaje: string}>} exitos - Lista de mensajes de éxito.
 * @property {Array<{ticketKey: string, problema: string, accion: string}>} advertencias - Lista de problemas no fatales.
 * @property {Array<{cliente: string, error: string, ticket?: string, detalle?: string}>} errores - Lista de errores fatales.
 * @property {number} tareasCerradas - Conteo de tareas programadas que fueron cerradas.
 */

/**
 * @typedef {Object} ProcessResult
 * Resultado estándar devuelto por funciones de servicio.
 * 
 * @property {'SUCCESS'|'ERROR'|'WARNING'|'NOT_FOUND'|'SKIPPED'|'HTTP_500'} status - Estado de la operación.
 * @property {Object} [detail] - Detalles adicionales dependientes de la operación.
 */
