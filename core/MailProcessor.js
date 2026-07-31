/**
 * @fileoverview MailProcessor base class.
 * Centraliza la lógica repetitiva de procesamiento de correos, parsing, chequeo de excepciones y comunicación con Jira.
 * Aplica el patrón Template Method.
 */

class MailProcessor {
  /**
   * @param {Object} config - Configuración base del procesador.
   * @param {String} config.operationName - Nombre de la operación para logs y Slack (ej. "VMs con snapshots").
   * @param {String} config.emailSubject - Asunto a buscar en Gmail.
   * @param {String} config.attachmentMatch - Substring para identificar el adjunto (opcional).
   * @param {String} config.scheduledTaskName - Nombre de la tarea programada a cerrar (opcional).
   */
  constructor(config) {
    this.operationName = config.operationName;
    this.emailSubject = config.emailSubject;
    this.attachmentMatch = config.attachmentMatch;
    this.scheduledTaskName = config.scheduledTaskName;
    this.ticketSummary = config.ticketSummary; // NEW: For generic handleAlerts

    // Pasos que este reporte necesita para considerarse COMPLETO. El hilo solo se marca
    // [OPS-PROCESADO] si TODOS los pasos declarados salieron bien; si alguno falla queda
    // [OPS-PENDIENTE] y se reintenta. Así un reporte que creó el ticket pero no se archivó
    // en Drive (o al revés) no se da por terminado. Ver AGENTS.md.
    // Valores posibles: 'tickets' | 'drive'
    this.pasos = config.pasos || ['tickets', 'drive'];
  }

  /** @returns {boolean} true si este processor debe ejecutar el paso indicado. */
  requierePaso(paso) {
    return this.pasos.indexOf(paso) !== -1;
  }

  /**
   * Punto de entrada principal. Orquesta la búsqueda y el procesamiento.
   */
  processEmails() {
    const timeGuard = new TimeGuard({ operationName: this.operationName });
    const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0, timeGuard: timeGuard };
    const threads = fetchAndFilterGlobalThreads(this.emailSubject);
    
    if (threads.length > 0) {
      for (const thread of threads) {
        // --- TIME GUARD (por hilo) ---
        if (!timeGuard.check(`Thread ${thread.getId()}`)) {
          summaryReport.advertencias.push({
            ticketKey: "N/A",
            problema: "Límite de tiempo de ejecución alcanzado o margen <30s (TimeGuard).",
            accion: "Se pausó la ejecución por seguridad y se notificó la traza a Slack. El resto de los correos en la bandeja se procesarán en la próxima ejecución."
          });
          break; // Sale del loop limpiamente
        }

        // Procesamos TODOS los mensajes del hilo, no solo el último.
        // Gmail puede agrupar en un mismo thread dos correos distintos con el mismo asunto
        // (ej. un PDF y un XLSX de Veeam ONE enviados casi al mismo tiempo). Si solo tomábamos
        // el último mensaje con getMessages()[getMessageCount()-1], los adjuntos del primero
        // nunca llegaban a Drive aunque el hilo quedara marcado [OPS-PROCESADO].
        const mensajesDelHilo = thread.getMessages();
        let estadoFinalHilo = 'SUCCESS';

        for (const message of mensajesDelHilo) {
          // TimeGuard por mensaje: un hilo con muchos mensajes no debe agotar el tiempo.
          if (!timeGuard.check(`Mensaje en hilo ${thread.getId()}`)) {
            summaryReport.advertencias.push({
              ticketKey: "N/A",
              problema: "Límite de tiempo de ejecución alcanzado o margen <30s (TimeGuard).",
              accion: "Se pausó la ejecución por seguridad. Los mensajes restantes de este hilo se procesarán en la próxima ejecución."
            });
            estadoFinalHilo = 'FAILURE'; // El hilo no está completo: no marcarlo como PROCESADO.
            break;
          }

          try {
            const result = this.processSingleMessage(message, summaryReport);
            const status = result ? result.status : 'ERROR';
            // El estado del hilo queda en el peor resultado de todos sus mensajes:
            // ERROR_TERMINAL > ERROR > FAILURE/HTTP_500 > SUCCESS
            if (status === 'ERROR_TERMINAL') {
              estadoFinalHilo = 'ERROR_TERMINAL';
            } else if (status === 'ERROR' && estadoFinalHilo !== 'ERROR_TERMINAL') {
              estadoFinalHilo = 'ERROR';
            } else if ((status === 'FAILURE' || status === 'HTTP_500') && estadoFinalHilo === 'SUCCESS') {
              estadoFinalHilo = status;
            }
            // SUCCESS y NO_OP no degradan el estado acumulado.
          } catch (e) {
            summaryReport.errores.push({ 
              error: `Error Crítico en Script: ${e.message}`, 
              detalle: `Correo: "${message.getSubject()}" | Stack: ${e.stack}` 
            });
            if (estadoFinalHilo !== 'ERROR_TERMINAL') estadoFinalHilo = 'ERROR';
          }
        }

        etiquetarYMarcarProcesado(thread, estadoFinalHilo);
      }
    }
    
    enviarResumenSlack(this.operationName, summaryReport);
    
    // --- BATCHED WRITES (FLUSH) ---
    if (typeof flushLogs === "function") {
      flushLogs();
    }
  }

  /**
   * Procesa un único mensaje de correo. Aplica el Template Method.
   */
  processSingleMessage(message, summaryReport) {
    const errorCountBefore = summaryReport.errores.length;
    let clientName = "_Desconocido_";

    // Arranca el seguimiento de fallos de ESTE correo. Las funciones de JiraService anotan
    // ahí cuando una escritura no se concreta, y al final se consulta el registro: así un
    // handleAlerts() sobrescrito que devuelve SUCCESS de más no puede dar por procesado un
    // correo cuyo adjunto o cierre de ticket falló (ver core/Utils.js).
    iniciarSeguimientoDeFallos();

    try {
      Logger.log(`--- Procesando: "${message.getSubject()}" ---`);
      const senderEmail = message.getFrom();
      
      const attachments = message.getAttachments();
      Logger.log(`[DEBUG MAIL] Encontrados ${attachments.length} adjuntos en el correo.`);
      attachments.forEach(att => {
        Logger.log(`  - Adjunto: "${att.getName()}" | Tipo: "${att.getContentType()}"`);
      });
      
      // --- Processors SOLO-DRIVE (no crean tickets) ---
      // Reportes que únicamente se archivan (Veeam ONE, catch-all): no hace falta parsear el
      // adjunto ni resolver excepciones, solo guardarlo y cerrar la tarea programada si tienen una.
      if (!this.requierePaso('tickets')) {
        const configSoloDrive = getClientConfig(senderEmail, this.operationName);
        if (configSoloDrive) clientName = configSoloDrive.clientName;

        let resultadoSoloDrive = this.ejecutarPasoDrive(message, clientName, summaryReport, { status: 'SUCCESS' });

        if (this.scheduledTaskName && resultadoSoloDrive.status === 'SUCCESS') {
          if (configSoloDrive) {
            resultadoSoloDrive = this.cerrarTareaProgramadaSiCorresponde(configSoloDrive, summaryReport);
          } else {
            summaryReport.advertencias.push({
              cliente: clientName,
              problema: `No se encontró configuración para ${senderEmail}, así que no se pudo cerrar la tarea "${this.scheduledTaskName}".`,
              accion: "Verificar que el remitente esté en el Índice Maestro."
            });
          }
        }

        enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
        return this.aplicarFallosRegistrados(resultadoSoloDrive, message, clientName, summaryReport);
      }

      const attachment = this.findAttachment(message);
      if (!attachment) {
        // El correo llegó de un remitente conocido y con el asunto correcto, pero ningún
        // adjunto matchea "attachmentMatch". El hilo se marca [OPS-PROCESADO] igual (reintentar
        // no va a cambiar el nombre del archivo), así que sin esta advertencia el reporte
        // desaparecía en silencio: nada en Slack, nada en la planilla, y la tarea programada
        // quedaba abierta sin que nadie supiera por qué.
        Logger.log(`[DEBUG MAIL] NO_OP: No se encontró ningún adjunto válido que coincida con la palabra clave "${this.attachmentMatch}".`);
        const nombresAdjuntos = attachments.map(att => att.getName()).join(", ") || "(ninguno)";
        summaryReport.advertencias.push({
          cliente: clientName,
          problema: `El correo "${message.getSubject()}" no trae ningún adjunto que coincida con "${this.attachmentMatch}". Adjuntos encontrados: ${nombresAdjuntos}.`,
          accion: `No se creó ticket ni se cerró la tarea programada${this.scheduledTaskName ? ` "${this.scheduledTaskName}"` : ""}. Revisar el nombre del archivo que genera el reporte o el valor de attachmentMatch.`
        });
        return { status: 'NO_OP' };
      }

      let clientConfig = getClientConfig(senderEmail, this.operationName);
      clientConfig = this.resolveClientConfig(clientConfig, senderEmail, attachment, message, summaryReport);
      
      if (!clientConfig) {
        summaryReport.errores.push({ error: 'Error de Configuración', detalle: `No se encontró config para: ${senderEmail}` });
        enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
        return { status: 'ERROR' };
      }

      clientName = clientConfig.clientName;

      const parsedData = this.parseAttachment(attachment, summaryReport);

      // El parseo falló (parseAttachment devolvió null y ya dejó el error en summaryReport).
      // NO es un reporte limpio: no se sabe qué traía. Antes compartía el `return SUCCESS`
      // con el caso vacío, así que el hilo quedaba [OPS-PROCESADO] con el reporte sin
      // procesar y sin posibilidad de reintento. Se devuelve FAILURE para que se reintente.
      if (!parsedData) {
        enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
        return { status: 'FAILURE' };
      }

      // Reporte SIN filas (solo encabezados, o archivo vacío) = reporte limpio. Es el estado
      // NORMAL de varias operaciones ("VMs inaccesibles", "VMs en datastores locales", etc.).
      //
      // Antes se devolvía SUCCESS acá mismo, salteándose el cierre de la tarea programada y
      // el paso de Drive, y dejando el summaryReport completamente vacío. Con el resumen
      // vacío, enviarResumenSlack() corta sin mandar nada y _registrarEnLog() descarta la
      // fila por ser resultado "OK": el correo quedaba [OPS-PROCESADO], la TP abierta y NADA
      // dejaba rastro. Fue exactamente lo que pasó el 28/07/2026 con 5 reportes de vROps.
      //
      // Un reporte vacío es el mismo caso de negocio que uno con filas donde todas quedaron
      // exceptuadas, así que se enruta por el mismo camino (handleNoAlerts + Drive), que ya
      // cierra la tarea y reporta. Ver AGENTS.md §7: un paso que no ocurrió no puede ser
      // indistinguible de uno exitoso.
      if (this.isDataEmpty(parsedData)) {
        summaryReport.exitos.push({
          mensaje: `📄 Reporte de ${clientName} recibido sin filas (solo encabezados): no hay anomalías que reportar.`
        });

        let resultadoVacio = this.handleNoAlerts(this.findExistingTicket(clientConfig), clientConfig, summaryReport);
        resultadoVacio = this.ejecutarPasoDrive(message, clientName, summaryReport, resultadoVacio);

        enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
        return this.aplicarFallosRegistrados(resultadoVacio, message, clientName, summaryReport);
      }

      const processed = this.processData(parsedData, clientConfig, summaryReport);
      if (!processed) {
        enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
        return { status: 'FAILURE' };
      }

      const { headers, finalAlerts, rowsForExport, reasonsText } = processed;

      // --- PASO 'tickets' ---
      let result = { status: 'SUCCESS' };
      if (this.requierePaso('tickets')) {
        const existingTicketKey = this.findExistingTicket(clientConfig);
        if (finalAlerts.length === 0) {
          result = this.handleNoAlerts(existingTicketKey, clientConfig, summaryReport);
        } else {
          result = this.handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachment.getName(), attachment);
        }
      }

      // --- PASO 'drive' ---
      // Se ejecuta aunque el paso de tickets haya fallado: archivar el reporte es valioso
      // por sí solo y es idempotente. Pero el estado final solo es SUCCESS si AMBOS pasos
      // salieron bien, así que el hilo se reintenta igual hasta que los dos estén OK.
      const resultadoFinal = this.ejecutarPasoDrive(message, clientName, summaryReport, result);

      enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
      return this.aplicarFallosRegistrados(resultadoFinal, message, clientName, summaryReport);

    } catch (e) {
      summaryReport.errores.push({ 
        cliente: clientName,
        error: `Error Crítico: ${e.message}`, 
        detalle: `Fallo durante el procesamiento del correo. Stack: ${e.stack}`
      });
      enrichErrorsWithClient(summaryReport.errores, errorCountBefore, clientName);
      return { status: 'FAILURE' };
    }
  }

  /**
   * Degrada el resultado a FAILURE si alguna operación de Jira no se concretó durante este
   * correo, sin importar qué haya devuelto el handleAlerts() de la subclase.
   *
   * Existe porque 21 processors sobrescriben handleAlerts() y varios devuelven SUCCESS aunque
   * el adjunto o el cierre hayan fallado: el 27/07/2026 un HTTP 500 al adjuntar terminó igual
   * marcado como [OPS-PROCESADO]. En vez de parchear los 21 (y depender de que el próximo se
   * acuerde), el chequeo vive acá, en un solo lugar.
   *
   * @returns {Object} Resultado final del correo.
   */
  aplicarFallosRegistrados(resultado, message, clientName, summaryReport) {
    const fallos = obtenerFallosDelMensaje();
    if (fallos.length === 0) return resultado;

    const estadoOriginal = resultado && resultado.status ? resultado.status : 'DESCONOCIDO';
    const resumenFallos = fallos.map(function (f) { return `${f.origen}: ${f.detalle}`; }).join(" | ");
    const esTerminal = hayFalloTerminal();

    summaryReport.errores.push({
      cliente: clientName,
      error: esTerminal
        ? `El correo requiere intervención manual: ${fallos.length} paso(s) fallaron`
        : `El correo no se completó: ${fallos.length} paso(s) fallaron`,
      detalle: `Operación "${this.operationName}" | Correo: "${message.getSubject()}" | ${resumenFallos}. ${esTerminal ? `Se apartó con la etiqueta ${OPS_LABEL_ERROR} y NO se reintenta hasta corregir la configuración.` : "Queda pendiente y se reintenta en el próximo ciclo."}`
    });

    if (esTerminal) {
      Logger.log(`[${this.operationName}] Correo APARTADO (la operación reportó ${estadoOriginal}, pero hubo un fallo que reintentar no arregla). Se etiqueta ${OPS_LABEL_ERROR}. Detalle: ${resumenFallos}`);
      return { status: 'ERROR_TERMINAL' };
    }

    Logger.log(`[${this.operationName}] Correo NO completado (la operación reportó ${estadoOriginal}, pero hubo ${fallos.length} fallo(s) registrado(s)). Se mantiene en ${OPS_LABEL_PENDIENTE}. Detalle: ${resumenFallos}`);

    // Se preserva HTTP_500 porque aguas arriba se distingue de un fallo genérico.
    const esHttp500 = estadoOriginal === 'HTTP_500' || fallos.some(function (f) { return f.detalle.indexOf("HTTP 500") !== -1; });
    return { status: esHttp500 ? 'HTTP_500' : 'FAILURE' };
  }

  /**
   * Ejecuta el paso 'drive' (si este processor lo declara) y combina su resultado con el
   * del paso de tickets. El correo se considera COMPLETO solo si los dos pasos salieron bien.
   *
   * @param {GoogleAppsScript.Gmail.GmailMessage} message Correo en proceso.
   * @param {string} clientName Nombre del cliente, para los mensajes de error.
   * @param {Object} summaryReport Reporte acumulado que se envía a Slack.
   * @param {Object} resultadoTickets Resultado del paso de tickets.
   * @returns {Object} Estado final del correo.
   */
  ejecutarPasoDrive(message, clientName, summaryReport, resultadoTickets) {
    if (!this.requierePaso('drive')) return resultadoTickets;

    const blobsToUpload = this.extractedBlobs || null;
    const resultadoDrive = subirAdjuntosDeMensajeADrive(message, this.operationName, blobsToUpload);

    if (resultadoDrive.ok) {
      if (resultadoDrive.subidos.length > 0) {
        summaryReport.exitos.push({
          mensaje: `📁 Se archivaron en Drive ${resultadoDrive.subidos.length} archivo(s) de ${resultadoDrive.cliente}: ${resultadoDrive.subidos.join(", ")}.`
        });
      }
      return resultadoTickets;
    }

    // Drive falló: se reporta con el detalle completo y se fuerza el reintento del correo.
    summaryReport.errores.push({
      cliente: resultadoDrive.cliente !== "_Desconocido_" ? resultadoDrive.cliente : clientName,
      error: "No se pudo archivar el reporte en Drive",
      detalle: `Operación "${this.operationName}" | Correo: "${message.getSubject()}" | Motivos: ${resultadoDrive.errores.join(" | ")}. El correo queda pendiente y se reintenta en el próximo ciclo.`
    });

    const estadoTickets = resultadoTickets && resultadoTickets.status ? resultadoTickets.status : 'DESCONOCIDO';
    Logger.log(`[${this.operationName}] Correo NO completado: paso tickets=${estadoTickets}, paso drive=FALLÓ. Se mantiene en ${OPS_LABEL_PENDIENTE}.`);
    return { status: 'FAILURE' };
  }

  // ==========================================
  // HOOKS (Métodos a sobrescribir por subclases)
  // ==========================================

  findAttachment(message) {
    this.extractedBlobs = [];

    // Primero extraemos los blobs de los adjuntos, descomprimiendo si es necesario.
    message.getAttachments().forEach(att => {
      const attNameLower = att.getName().toLowerCase();
      if (attNameLower.endsWith(".zip") || att.getContentType() === "application/zip") {
        try {
          const unzippedBlobs = Utilities.unzip(att.copyBlob());
          this.extractedBlobs = this.extractedBlobs.concat(unzippedBlobs);
        } catch(e) { 
          Logger.log(`Error descomprimiendo ${att.getName()}: ${e.message}`);
          this.extractedBlobs.push(att.copyBlob()); // Fallback si falla unzip
        }
      } else {
        this.extractedBlobs.push(att.copyBlob());
      }
    });

    // Luego buscamos el archivo que coincida entre todos los extraídos/originales
    return this.extractedBlobs.find(att => {
      const nameLower = att.getName().toLowerCase().replace(/-/g, ' ');
      const matchLower = this.attachmentMatch ? this.attachmentMatch.toLowerCase().replace(/-/g, ' ') : '';
      const nameMatch = this.attachmentMatch ? nameLower.includes(matchLower) : true;
      
      // Robustez para tipos de archivo CSV, Excel (.xlsx, .xls), JSON y TXT
      // Nota: Los blobs extraídos de un ZIP pueden tener contentTypes genéricos, 
      // por lo que las comprobaciones de extensión son fundamentales.
      const contentType = (att.getContentType && typeof att.getContentType === 'function') ? att.getContentType().toLowerCase() : "";
      const typeMatch = contentType.includes("csv") || 
                        contentType.includes("excel") || 
                        contentType.includes("spreadsheet") || 
                        contentType.includes("json") || 
                        contentType.includes("plain") || 
                        nameLower.endsWith(".csv") || 
                        nameLower.endsWith("xlsx") || 
                        nameLower.endsWith("xls") ||
                        nameLower.endsWith("json") ||
                        nameLower.endsWith(".txt");
                        
      return nameMatch && typeMatch;
    });
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    try {
      // Todo el parseo (detección de separador y tolerancia a filas envueltas en
      // comillas) vive en parseCsvDeReporte() / DataProcessingService.js.
      // NO reimplementar acá ninguna de esas dos cosas: este método tenía su propia
      // copia de ambas y fue el origen del incidente del 27/07/2026.
      return parseCsvDeReporte(attachment.getDataAsString("UTF-8"));
    } catch (e) {
      summaryReport.errores.push({ error: "Error parseando CSV", detalle: e.message });
      return null;
    }
  }

  isDataEmpty(parsedData) {
    return !parsedData || parsedData.length <= 1; // Solo headers o vacío
  }

  /**
   * @returns {Object} { headers, finalAlerts, rowsForExport, reasonsText }
   */
  processData(parsedData, clientConfig, summaryReport) {
    throw new Error("processData() debe ser implementado por la subclase.");
  }

  findExistingTicket(clientConfig) {
    throw new Error("findExistingTicket() debe ser implementado por la subclase.");
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **La anomalía no persiste.** El reporte está limpio.");
      summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    return this.cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport);
  }

  /**
   * Cierra la tarea programada del reporte, si este processor tiene una configurada.
   *
   * Antes el resultado se descartaba y siempre se devolvía SUCCESS: un cierre que nunca
   * ocurrió era indistinguible de uno exitoso (AGENTS.md §7). Ahora se loguea el desenlace
   * concreto y un fallo real deja el correo pendiente para reintentar.
   *
   * @returns {Object} Estado del paso.
   */
  cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport) {
    if (!this.scheduledTaskName) return { status: 'SUCCESS' };

    const resultado = buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    const estado = resultado && resultado.status ? resultado.status : 'SIN_RESPUESTA';

    if (estado === 'SUCCESS') {
      summaryReport.tareasCerradas++;
      Logger.log(`[${this.operationName}] Tarea programada "${this.scheduledTaskName}" cerrada para ${clientConfig.clientName}.`);
      return { status: 'SUCCESS' };
    }

    if (estado === 'DEFERRED') {
      // La guarda central de buscarYCerrarTareaProgramada decidió no cerrar porque este correo
      // ya venía con un paso fallido. Ese fallo ya se reporta en aplicarFallosRegistrados, así
      // que acá no se agrega otro error: solo se propaga que el correo no quedó completo.
      return { status: 'FAILURE' };
    }

    if (estado === 'DUPLICADO') {
      // El reporte del día ya se había procesado y su tarea está cerrada. El correo se da por
      // COMPLETO (el trabajo está hecho, y los adjuntos nuevos que trajera ya se archivaron en
      // Drive): se avisa, pero no se aparta a [OPS-ERROR] como si faltara algo por corregir.
      summaryReport.advertencias.push({
        cliente: clientConfig.clientName,
        problema: `El reporte "${this.scheduledTaskName}" llegó más de una vez hoy: la tarea ${resultado.taskKey} ya estaba en estado "${resultado.estadoTarea}".`,
        accion: "No se reabrió la tarea y se dejó un comentario en ella. Los adjuntos nuevos, si los había, igual se archivaron en Drive. Revisar si el origen está enviando el reporte duplicado."
      });
      Logger.log(`[${this.operationName}] Reporte duplicado de ${clientConfig.clientName}: la tarea ${resultado.taskKey} ya estaba cerrada. El correo se da por procesado.`);
      return { status: 'SUCCESS' };
    }

    if (estado === 'NOT_FOUND') {
      // NOT_FOUND cuenta como NO procesado, pero es un fallo TERMINAL: reintentar no hace
      // aparecer una tarea que no existe. buscarYCerrarTareaProgramada ya lo registró como
      // terminal, así que el correo termina apartado con [OPS-ERROR] en vez de acumularse.
      // Llegar acá significa que NO hay ninguna tarea con ese nombre creada hoy, en ningún
      // estado: el caso "ya la cerró un correo anterior" se resuelve antes, como DUPLICADO.
      summaryReport.advertencias.push({
        cliente: clientConfig.clientName,
        problema: `No existe ninguna tarea programada "${this.scheduledTaskName}" creada hoy en el proyecto ${clientConfig.jiraProjectKey} (en ningún estado).`,
        accion: `El correo se aparta con ${OPS_LABEL_ERROR}. Verificar que la tarea se haya creado y que el nombre coincida exactamente.`
      });
      return { status: 'ERROR_TERMINAL' };
    }

    summaryReport.errores.push({
      cliente: clientConfig.clientName,
      error: `No se pudo cerrar la tarea programada "${this.scheduledTaskName}"`,
      detalle: `Proyecto ${clientConfig.jiraProjectKey} | Estado devuelto: ${estado}. El correo queda pendiente y se reintenta.`
    });
    return { status: 'FAILURE' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName, attachmentBlob = null) {
    if (!this.ticketSummary) {
      throw new Error("handleAlerts() debe ser implementado por la subclase, o bien proveer 'ticketSummary' en la configuración base.");
    }
    
    const alertCount = finalAlerts.length;
    const newFileName = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
    const xlsxBlob = convertDataToXlsxBlob([headers, ...finalAlerts], newFileName);

    // convertDataToXlsxBlob() devuelve null si falla (datos mal formados, error de Drive, etc).
    // Sin esta guarda el null llegaba hasta addAttachmentToJiraTicket() y explotaba con
    // "Cannot read properties of null (reading 'getName')", abortando el correo entero.
    // Cortamos acá con un error claro y dejamos el thread sin marcar para que se reintente.
    if (!xlsxBlob) {
      summaryReport.errores.push({
        error: "No se pudo generar el Excel del reporte",
        cliente: clientConfig.clientName,
        detalle: `Operación "${this.operationName}": convertDataToXlsxBlob() devolvió null para ${alertCount} fila(s). Se reintentará en el próximo ciclo.`
      });
      return { status: 'FAILURE' };
    }

    if (existingTicketKey) {
      // La verificación de idempotencia ahora vive dentro de addAttachmentToJiraTicket(),
      // para que también cubra a los processors que sobrescriben este método.
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);

      if (attachmentResult.status === 'SUCCESS') {
        const commentText = `🚨 **El problema persiste.** Se adjunta el reporte actualizado con **${alertCount}** objetos afectados.`;
        addCommentToJiraTicket(existingTicketKey, commentText);

        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName);
        if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado, summaryReport.timeGuard);

        summaryReport.exitos.push({ mensaje: `Anomalía Persiste. Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> con el nuevo reporte.` });
      } else {
        // Antes se registraba el error pero igual se devolvía SUCCESS más abajo, así que el
        // hilo quedaba [OPS-PROCESADO] con el reporte sin adjuntar y nadie lo reintentaba.
        summaryReport.errores.push(attachmentResult.detail || {
          error: "Fallo al adjuntar el reporte",
          cliente: clientConfig.clientName,
          ticket: existingTicketKey
        });
        Logger.log(`[${this.operationName}] No se pudo adjuntar "${newFileName}" al ticket ${existingTicketKey} de ${clientConfig.clientName} (estado ${attachmentResult.status}). El correo queda pendiente.`);
        return { status: attachmentResult.status === 'HTTP_500' ? 'HTTP_500' : 'FAILURE' };
      }
    } else {
      const description = `Se encontraron ${alertCount} alertas. Se adjunta el reporte completo para su revisión.`;
      const creationResult = createTicketAndNotify(this.ticketSummary, description, xlsxBlob, clientConfig, this.operationName);

      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else {
        summaryReport.errores.push(creationResult.detail);
        Logger.log(`[${this.operationName}] No se pudo crear/actualizar el ticket de ${clientConfig.clientName} (estado ${creationResult.status}). El correo queda pendiente.`);
        return { status: creationResult.status === 'HTTP_500' ? 'HTTP_500' : 'FAILURE' };
      }
    }

    return this.cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport);
  }
}

/**
 * Enriquece la lista de errores agregando el nombre de cliente a aquellos
 * que no lo tienen registrado aún en un rango de índices.
 */
function enrichErrorsWithClient(errores, startIndex, clientName) {
  for (let i = startIndex; i < errores.length; i++) {
    if (!errores[i].cliente) {
      errores[i].cliente = clientName;
    }
  }
}
