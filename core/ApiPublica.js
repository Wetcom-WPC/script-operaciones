/**
 * @fileoverview Fachada de la API Pública de Ops Playground consumida por Índice Playground.
 * Este es el contrato estable entre ambos proyectos. Romper firmas o retornos aquí
 * exige desplegar nuevas versiones de ambos proyectos en conjunto.
 *
 * BAJA 2026-08-26: procesarLicenciasManualLibreria dejó de exponerse. Los módulos
 * de licencias se eliminaron en 0ba6e87 y el Índice ya trae su propio motor
 * autocontenido en RVTools_Licencias.js. El Índice debe llamar a la función local,
 * sin el prefijo AutomatizarOperaciones.
 */

/**
 * @public
 * @param {string} filterId
 */
function generarReporteDiarioDeTickets(filterId) {
  return internal_generarReporteDiarioDeTickets(filterId);
}

/**
 * @public
 * @param {string} opsKey
 */
function generarReporteConsumoVsphere(opsKey) {
  return internal_generarReporteConsumoVsphere(opsKey);
}

/**
 * @public
 */
function ejecutarCicloDeOperaciones() {
  return internal_ejecutarCicloDeOperaciones();
}

/**
 * @public
 * @param {string} tecnologia
 * @param {string} cliente
 * @param {string} pod
 * @param {number} totalTickets
 * @param {Array} itemsErrores
 * @param {Array} itemsAdvertencias
 * @param {string} asunto
 * @param {boolean} modoTest
 */
function registrarEnvioMail(tecnologia, cliente, pod, totalTickets, itemsErrores, itemsAdvertencias, asunto, modoTest) {
  return internal_registrarEnvioMail(tecnologia, cliente, pod, totalTickets, itemsErrores, itemsAdvertencias, asunto, modoTest);
}

/**
 * @public
 * @param {string} clientName
 * @param {string} rvToolsFolderId
 */
function procesarRVToolsManual(clientName, rvToolsFolderId) {
  return internal_procesarRVToolsManual(clientName, rvToolsFolderId);
}

/**
 * @public
 * @param {string} clientName
 * @param {string} tanzuFolderId
 */
function procesarTanzuManual(clientName, tanzuFolderId) {
  return internal_procesarTanzuManual(clientName, tanzuFolderId);
}

/**
 * @public
 * @param {string} clientName
 * @param {string} operationName
 * @param {boolean} [soporte=false]
 */
function getClientConfigByName(clientName, operationName, soporte) {
  return internal_getClientConfigByName(clientName, operationName, soporte);
}

/**
 * @public
 * ATENCIÓN: Esta función fue catalogada como "interna" pero el Índice la invoca directamente.
 * Un refactor futuro debería quitar esta responsabilidad del Índice.
 * @param {string} taskNameBase
 * @param {object} clientConfig
 * @param {boolean} useClientNameInTask
 */
function buscarYCerrarTareaProgramada(taskNameBase, clientConfig, useClientNameInTask) {
  return internal_buscarYCerrarTareaProgramada(taskNameBase, clientConfig, useClientNameInTask);
}
