/**
 * @fileoverview Reportes de Veeam ONE que solo se archivan en Drive y cierran su tarea programada.
 *
 * ETAPA 2 del refactor: antes estos reportes no tenían processor y los manejaba el trigger
 * aparte `organizarReportesEnDrive`, que buscaba por REMITENTE y con una ventana de horas.
 * Ese diseño los perdía: si un lote no llegaba a tiempo, el correo salía de la ventana y
 * nunca más se miraba (27/07/2026, ningún reporte de Veeam ONE llegó a Drive).
 *
 * Ahora son processors como cualquier otro: declaran `pasos: ['drive']` (no crean tickets)
 * y el pipeline garantiza que el correo no se marque [OPS-PROCESADO] hasta que el archivo
 * esté en Drive Y la tarea programada esté cerrada.
 */

/**
 * Base para los reportes de Veeam ONE: mismo comportamiento, solo cambia el nombre.
 * El asunto y el nombre de la tarea programada coinciden (así están dados de alta en Jira).
 */
class VeeamOneReporteProcessor extends MailProcessor {
  constructor(nombreReporte) {
    super({
      operationName: nombreReporte,
      emailSubject: nombreReporte,
      scheduledTaskName: nombreReporte,
      pasos: ['drive'] // Solo se archiva: estos reportes no abren tickets de anomalía.
    });
  }
}

/**
 * Nombres de los reportes de Veeam ONE. Son a la vez el asunto del correo y el nombre de la
 * tarea programada en Jira. Antes vivían como `REPORTES_QUE_CIERRAN_TAREAS_BASE` dentro de
 * SubirReportesADrive.js.
 */
const REPORTES_VEEAM_ONE = [
  "VMs protegidas",
  "Replicas protegidas",
  "Capacity Planning",
  "VM Daily Protection Status",
  "Hosts y VMs con contencion de CPU",
  "Inventario de VMs",
];

function processVeeamVMsProtegidasEmails() {
  new VeeamOneReporteProcessor("VMs protegidas").processEmails();
}

function processVeeamReplicasProtegidasEmails() {
  new VeeamOneReporteProcessor("Replicas protegidas").processEmails();
}

function processVeeamCapacityPlanningEmails() {
  new VeeamOneReporteProcessor("Capacity Planning").processEmails();
}

function processVeeamDailyProtectionStatusEmails() {
  new VeeamOneReporteProcessor("VM Daily Protection Status").processEmails();
}

function processVeeamContencionCPUEmails() {
  new VeeamOneReporteProcessor("Hosts y VMs con contencion de CPU").processEmails();
}

function processVeeamInventarioVMsEmails() {
  new VeeamOneReporteProcessor("Inventario de VMs").processEmails();
}
