/**
 * @fileoverview Fachada de la API Pública de Ops Playground consumida por Índice Playground.
 * Este es el contrato estable entre ambos proyectos. Romper firmas o retornos aquí
 * exige desplegar nuevas versiones de ambos proyectos en conjunto.
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
 * @param {string} cliente
 * @param {string} destinatario
 * @param {string} folderId
 * @param {string} pod
 */
function procesarLicenciasManualLibreria(cliente, destinatario, folderId, pod) {
  return internal_procesarLicenciasManualLibreria(cliente, destinatario, folderId, pod);
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
