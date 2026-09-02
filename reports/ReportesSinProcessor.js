/**
 * @fileoverview Red de seguridad del pipeline: archiva los reportes que ningún processor reclama.
 *
 * Hasta la Etapa 2, el trigger `organizarReportesEnDrive` archivaba en Drive TODO lo que
 * llegara de los remitentes del Índice Maestro, tuviera processor o no. Al apagarlo, cualquier
 * reporte sin processor propio habría dejado de archivarse **en silencio** — por ejemplo los
 * clientes de la pestaña "Adjuntos" (como Operaciones GIRE), que no tienen proyecto de Jira.
 *
 * Este processor corre ÚLTIMO en el ciclo y agarra lo que quedó sin dueño: solo lo archiva en
 * Drive. Si un mismo asunto aparece seguido acá, es la señal de que le falta su propio processor.
 */

class ReportesSinProcessorProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: "Reportes sin processor",
      emailSubject: "",          // No filtra por asunto: se queda con lo que nadie reclamó.
      pasos: ['drive']           // Solo archiva; no crea tickets ni cierra tareas.
    });
  }

  /**
   * Igual que el processEmails() de la clase base, pero la fuente de hilos son los que ningún
   * otro processor reclama (por eso no se puede usar fetchAndFilterGlobalThreads, que filtra
   * justamente por asunto).
   */
  processEmails() {
    const timeGuard = new TimeGuard({ operationName: this.operationName });
    const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0, timeGuard: timeGuard };

    const asuntosReclamados = obtenerAsuntosConProcessor();
    const threads = fetchThreadsSinProcessor(asuntosReclamados);

    if (threads.length > 0) {
      Logger.log(`[${this.operationName}] ${threads.length} correo(s) sin processor propio. Se archivan en Drive.`);
    }

    for (const thread of threads) {
      if (!timeGuard.check(`Thread ${thread.getId()}`)) {
        summaryReport.advertencias.push({
          ticketKey: "N/A",
          problema: "Límite de tiempo de ejecución alcanzado (TimeGuard).",
          accion: "El resto de los correos sin processor se archivan en la próxima ejecución."
        });
        break;
      }

      const mensajesDelHilo = thread.getMessages();
      let estadoFinalHilo = 'SUCCESS';

      for (const message of mensajesDelHilo) {
        try {
          Logger.log(`[${this.operationName}] Archivando correo sin processor: "${message.getSubject()}" (de ${message.getFrom()}).`);
          const result = this.processSingleMessage(message, summaryReport);
          
          if (!result || result.status !== 'SUCCESS') {
            estadoFinalHilo = 'ERROR';
          }
        } catch (e) {
          summaryReport.errores.push({
            error: `Error Crítico en Script: ${e.message}`,
            detalle: `Correo: "${message.getSubject()}" | Stack: ${e.stack}`
          });
          estadoFinalHilo = 'ERROR';
        }
      }

      etiquetarYMarcarProcesado(thread, estadoFinalHilo);
    }

    enviarResumenSlack(this.operationName, summaryReport);

    if (typeof flushLogs === "function") {
      flushLogs();
    }
  }
}

function processReportesSinProcessorEmails() {
  new ReportesSinProcessorProcessor().processEmails();
}
