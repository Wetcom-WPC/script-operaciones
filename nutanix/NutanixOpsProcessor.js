/**
 * @fileoverview Processor para las validaciones operativas diarias de Nutanix.
 *
 * FORMATOS DE CORREO QUE ACEPTA
 *
 * Consolidado (el actual): nutanix_ops_sender.ps1 manda UN correo por cliente, con el JSON de
 * cada cluster y un manifiesto (nutanix_manifest_<fecha>_<hora>.json) que lista TODOS los
 * clusters que la Pivot tenía que consultar y cuáles pudo bajar. Cada cluster actualiza su propio
 * ticket, y las tareas programadas del cliente se cierran una sola vez, solo si llegaron todos.
 * Si falta alguno, las tareas quedan abiertas y el resumen de Slack dice cuál y por qué.
 *
 * Individual (legacy): un correo por cluster, sin manifiesto. Se sigue aceptando para no romper
 * senders viejos, pero cada correo cierra las tareas por su cuenta: el primero que llega las
 * cierra aunque los demás clusters no hayan llegado, y los siguientes dejan comentarios de
 * "reporte duplicado" en las tareas. Por eso este formato deja una advertencia pidiendo
 * actualizar el sender.
 *
 * Por qué el manifiesto lo arma la Pivot: es el único lugar que conoce la lista completa de
 * clusters del cliente (el array $CVMS del sender). Desde acá no hay forma de saber cuántos
 * correos esperar, ni de distinguir "todavía no llegó" de "no va a llegar".
 */

const NTX_OPERATION_NAME = "Operaciones Nutanix";
const NTX_EMAIL_SUBJECT  = "Operaciones Nutanix";
const NTX_ATTACHMENT_MATCH = "nutanix_ops";
const NTX_MANIFEST_MATCH = "nutanix_manifest";
const NTX_MANIFEST_TIPO  = "nutanix_ops_manifest";

// Nombres exactos de las tareas programadas en Jira
const NTX_TASKS = [
  "Estado del cluster",
  "Alertas activas en el cluster",
  "Estado de Data Resiliency",
  "Estado de salud de los discos del cluster"
];

/**
 * Lee un adjunto JSON de Nutanix. Tolera el BOM de UTF-8 que agregan algunas herramientas de
 * Windows: sin esto JSON.parse falla en el primer carácter y el reporte se descarta.
 */
function leerJsonDeAdjuntoNutanix(blob) {
  return JSON.parse(blob.getDataAsString("UTF-8").replace(/^﻿/, ""));
}

class NutanixOpsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: NTX_OPERATION_NAME,
      emailSubject: NTX_EMAIL_SUBJECT,
      attachmentMatch: NTX_ATTACHMENT_MATCH,
      pasos: ['tickets']
    });
    // Estado del correo en curso. El processor se reutiliza para todos los correos de una
    // corrida, así que findAttachment() y processData() lo reinician en cada uno.
    this._consolidado = null;
    this._datosIndividuales = null;
  }

  /**
   * Si el correo trae manifiesto, el adjunto "principal" es el manifiesto: así el cliente se
   * resuelve desde ahí aunque no haya llegado ningún cluster. Si no, es el JSON del único
   * cluster, como en el formato individual.
   */
  findAttachment(message) {
    const jsonDeCluster = super.findAttachment(message); // además carga this.extractedBlobs
    this._consolidado = null;
    this._datosIndividuales = null;

    const manifiesto = (this.extractedBlobs || []).find(function (blob) {
      return blob.getName().toLowerCase().indexOf(NTX_MANIFEST_MATCH) !== -1;
    });
    return manifiesto || jsonDeCluster;
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (attachment) {
      try {
        const data = leerJsonDeAdjuntoNutanix(attachment);
        if (data && data.clientName) {
           // Buscamos el cliente real por nombre exacto segun el JSON (o el manifiesto). La config
           // trae el requestTypeId que ClientConfigService resuelve desde la Columna F del Índice
           // Maestro: es lo que hace que el ticket entre por el portal y el cliente reciba la
           // notificación, igual que en vSphere y Veeam.
           const newConfig = getClientConfigByName(data.clientName, this.operationName);
           if (newConfig) {
             config = newConfig;
           } else {
             summaryReport.errores.push({
               error: "Cliente Nutanix no encontrado",
               detalle: `El JSON indica cliente "${data.clientName}" pero no existe exactamente así en la Columna B del Índice Maestro.`
             });
           }
        }
      } catch (e) {
        // Si falla el parseo aca, el metodo parseAttachment lo va a loggear despues
      }
    }
    if (config) config.tecnologia = "Nutanix";
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    if (attachment.getName().toLowerCase().indexOf(NTX_MANIFEST_MATCH) !== -1) {
      return this._parsearConsolidado(attachment, summaryReport);
    }

    try {
      const data = leerJsonDeAdjuntoNutanix(attachment);

      if (!data || !Array.isArray(data.validaciones) || data.validaciones.length === 0) {
        summaryReport.errores.push({
          error: "Formato JSON inválido o vacío",
          detalle: `El adjunto no contiene validaciones válidas.`
        });
        return null;
      }

      summaryReport.advertencias.push({
        cliente: data.clientName || "",
        problema: `Llegó un reporte Nutanix en formato individual (un correo por cluster, sin manifiesto) del cluster ${data.clusterName || "desconocido"}.`,
        accion: "Con este formato las tareas programadas se cierran con el primer cluster que llega, sin verificar que llegaron los demás. Actualizar nutanix_ops_sender.ps1 en la Pivot a la versión que manda un correo por cliente."
      });
      return data;
    } catch (e) {
      summaryReport.errores.push({
        error: "Error al parsear JSON",
        detalle: `Error: ${e.message}`
      });
      return null;
    }
  }

  /**
   * Arma la vista del correo consolidado: qué clusters llegaron con un reporte válido y cuáles
   * faltan. Un cluster falta si la Pivot no pudo bajarlo (lo dice el manifiesto), si el
   * manifiesto lo lista pero el adjunto no vino, o si el adjunto no es un reporte válido.
   *
   * @returns {{formato: string, clientName: string, recibidos: Array, faltantes: Array}|null}
   */
  _parsearConsolidado(adjuntoManifiesto, summaryReport) {
    let manifiesto;
    try {
      manifiesto = leerJsonDeAdjuntoNutanix(adjuntoManifiesto);
    } catch (e) {
      summaryReport.errores.push({
        error: "Manifiesto Nutanix ilegible",
        detalle: `${adjuntoManifiesto.getName()}: ${e.message}`
      });
      return null;
    }

    if (!manifiesto || manifiesto.tipo !== NTX_MANIFEST_TIPO || !Array.isArray(manifiesto.clusters) || manifiesto.clusters.length === 0) {
      summaryReport.errores.push({
        error: "Manifiesto Nutanix inválido",
        detalle: `${adjuntoManifiesto.getName()} no trae la lista de clusters que la Pivot tenía que consultar.`
      });
      return null;
    }

    const adjuntos = this.extractedBlobs || [];
    const recibidos = [];
    const faltantes = [];

    manifiesto.clusters.forEach(function (entrada) {
      const nombre = entrada.nombre || entrada.host || "(sin nombre)";
      const faltante = function (motivo) {
        faltantes.push({ nombre: nombre, host: entrada.host || "", motivo: motivo });
      };

      if (entrada.estado !== "OK") {
        faltante(entrada.detalle || "La Pivot no pudo obtener el reporte.");
        return;
      }

      const archivo = String(entrada.archivo || "").toLowerCase();
      const blob = adjuntos.find(function (b) { return b.getName().toLowerCase() === archivo; });
      if (!blob) {
        faltante(`El manifiesto lista "${entrada.archivo}" pero el correo no lo trae adjunto.`);
        return;
      }

      let datos;
      try {
        datos = leerJsonDeAdjuntoNutanix(blob);
      } catch (e) {
        faltante(`"${entrada.archivo}" no es un JSON válido (${e.message}).`);
        return;
      }
      if (!datos || !Array.isArray(datos.validaciones) || datos.validaciones.length === 0) {
        faltante(`"${entrada.archivo}" no trae validaciones.`);
        return;
      }

      if (datos.clientName && manifiesto.clientName &&
          String(datos.clientName).trim().toLowerCase() !== String(manifiesto.clientName).trim().toLowerCase()) {
        summaryReport.advertencias.push({
          cliente: manifiesto.clientName,
          problema: `El cluster ${nombre} reporta cliente "${datos.clientName}" pero la Pivot lo envió como "${manifiesto.clientName}".`,
          accion: "Se procesó dentro del cliente de la Pivot. Revisar CLIENT_NAME en nutanix_ops_check.sh de esa CVM."
        });
      }

      recibidos.push({ nombre: nombre, datos: datos });
    });

    return { formato: "consolidado", clientName: manifiesto.clientName, recibidos: recibidos, faltantes: faltantes };
  }

  isDataEmpty(parsedData) {
    // Un correo consolidado nunca es "vacío": aunque no haya llegado ningún cluster, hay que
    // avisar cuáles faltaron y dejar las tareas abiertas.
    if (parsedData && parsedData.formato === "consolidado") return false;
    return !parsedData || !Array.isArray(parsedData.validaciones) || parsedData.validaciones.length === 0;
  }

  processData(parsedData, clientConfig, summaryReport) {
    const headers = ["ID", "Nombre", "Estado", "Detalle"];

    if (parsedData.formato === "consolidado") {
      this._consolidado = parsedData;
      this._datosIndividuales = null;

      // Solo las validaciones con estado diferente a Chequeado generan alertas
      const derivadas = [];
      parsedData.recibidos.forEach(function (cluster) {
        cluster.datos.validaciones.forEach(function (v) {
          if (v.estado !== "Chequeado") derivadas.push(v);
        });
      });
      return { headers: headers, finalAlerts: derivadas, rowsForExport: [], reasonsText: this._textoDeDerivadas(derivadas) };
    }

    this._consolidado = null;
    this._datosIndividuales = parsedData;
    const derivadas = parsedData.validaciones.filter(v => v.estado !== "Chequeado");
    return { headers: headers, finalAlerts: derivadas, rowsForExport: [], reasonsText: this._textoDeDerivadas(derivadas) };
  }

  _textoDeDerivadas(derivadas) {
    return derivadas
      .map(v => `* *${v.id} — ${v.nombre}* (${v.estado}):\n  ${v.detalle}`)
      .join('\n\n');
  }

  // Un ticket por cluster
  resumenDeTicket(clusterName) {
    return `[OPS-NTX] ${clusterName} — Validaciones operativas`;
  }

  // Un correo puede traer varios clusters, así que el ticket se busca cluster por cluster en
  // _actualizarTicketDeCluster() y no una sola vez por correo.
  findExistingTicket(clientConfig) {
    return null;
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport) {
    return this._procesarClustersYCerrarTareas(clientConfig, summaryReport);
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    return this._procesarClustersYCerrarTareas(clientConfig, summaryReport);
  }

  /**
   * Actualiza el ticket de cada cluster del correo y recién después decide las tareas
   * programadas: se cierran solo si llegaron TODOS los clusters (AGENTS.md §8: no cerrar sin
   * evidencia). Con un cluster faltante el correo se da por procesado igual, porque reintentarlo
   * no hace aparecer el reporte que no se generó; el aviso queda en el resumen de Slack.
   */
  _procesarClustersYCerrarTareas(clientConfig, summaryReport) {
    const consolidado = this._consolidado;
    const clusters = consolidado
      ? consolidado.recibidos.map(function (c) { return c.datos; })
      : (this._datosIndividuales ? [this._datosIndividuales] : []);

    let resultado = { status: 'SUCCESS' };
    for (const datos of clusters) {
      const r = this._actualizarTicketDeCluster(datos, clientConfig, summaryReport);
      if (r.status !== 'SUCCESS' && resultado.status === 'SUCCESS') resultado = r;
    }

    // Si algún ticket no se pudo crear, las tareas no se tocan: el correo se reintenta completo
    // y el marcador de _actualizarTicketDeCluster evita repetir los comentarios ya hechos.
    if (resultado.status !== 'SUCCESS') return resultado;

    if (consolidado && consolidado.faltantes.length > 0) {
      const total = consolidado.recibidos.length + consolidado.faltantes.length;
      const detalle = consolidado.faltantes
        .map(function (f) { return `${f.nombre}${f.host ? ` (${f.host})` : ""}: ${f.motivo}`; })
        .join(" | ");

      summaryReport.advertencias.push({
        cliente: clientConfig.clientName,
        problema: `Faltó el reporte de ${consolidado.faltantes.length} de ${total} cluster(s) Nutanix. ${detalle}`,
        accion: `Las ${NTX_TASKS.length} tareas programadas quedan ABIERTAS porque no se validó todo el cliente. Revisar desde la Pivot los clusters que faltaron y cerrar las tareas a mano una vez verificados.`
      });
      Logger.log(`[${this.operationName}] ${clientConfig.clientName}: faltan ${consolidado.faltantes.length} de ${total} cluster(s), NO se cierran las tareas programadas. ${detalle}`);
      return { status: 'SUCCESS' };
    }

    return this.cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport);
  }

  /**
   * Crea o comenta el ticket de un cluster. Un cluster sin hallazgos no crea ticket: solo deja
   * constancia si ya había uno abierto.
   *
   * El comentario lleva el marcador [AUTO-UPDATE:fecha] que lee haSidoActualizadoHoy(): si el
   * correo se reintenta (por ejemplo, porque falló el ticket de OTRO cluster), los clusters que
   * ya se habían procesado no vuelven a comentar.
   */
  _actualizarTicketDeCluster(datos, clientConfig, summaryReport) {
    const clusterName = datos.clusterName || "Desconocido";
    const origenDetalle = `${clusterName} (${datos.clusterFqdn || "Desconocido"} / ${datos.origen || "N/A"})`;
    const derivadas = datos.validaciones.filter(v => v.estado !== "Chequeado");
    const resumen = this.resumenDeTicket(clusterName);
    const huella = `OPS-NTX ${clusterName}`;
    const marcadorDeHoy = `[AUTO-UPDATE:${new Date().toISOString().slice(0, 10)}]`;

    const ticketKey = findExistingJiraTicket(resumen, clientConfig.jiraProjectKey);

    if (ticketKey && haSidoActualizadoHoy(ticketKey, huella)) {
      return { status: 'SUCCESS' };
    }

    if (derivadas.length === 0) {
      if (ticketKey) {
        addCommentToJiraTicket(ticketKey,
          `${marcadorDeHoy} ${huella}\n\n` +
          `✅ *La anomalía no persiste.* El reporte está limpio.\n\n` +
          `*Cluster:* ${origenDetalle}`);
        summaryReport.exitos.push({ mensaje: `Ticket ${ticketKey} actualizado: ${clusterName} sin hallazgos.`, cliente: clientConfig.clientName });
      } else {
        summaryReport.exitos.push({ mensaje: `Cluster ${clusterName} de ${clientConfig.clientName} procesado sin anomalías.`, cliente: clientConfig.clientName });
      }
      return { status: 'SUCCESS' };
    }

    const reasonsText = this._textoDeDerivadas(derivadas);

    if (ticketKey) {
      addCommentToJiraTicket(ticketKey,
        `${marcadorDeHoy} ${huella}\n\n` +
        `🔄 *Reporte Nutanix Recibido*\n\n` +
        `*Cluster:* ${origenDetalle}\n\n` +
        `*Validaciones derivadas (${derivadas.length}):*\n\n` +
        `${reasonsText}`);
      summaryReport.exitos.push({ mensaje: `Ticket ${ticketKey} actualizado para ${clusterName}.`, cliente: clientConfig.clientName });
      return { status: 'SUCCESS' };
    }

    const description =
      `Se recibieron los resultados de las validaciones operativas diarias de Nutanix.\n\n` +
      `*Cluster:* ${origenDetalle}\n\n` +
      `*Validaciones derivadas (${derivadas.length}):*\n\n` +
      `${reasonsText}`;

    const creationResult = createTicketAndNotify(resumen, description, null, clientConfig, this.operationName);

    if (creationResult.status === 'SUCCESS') {
      summaryReport.exitos.push(creationResult.detail);
      return { status: 'SUCCESS' };
    }
    summaryReport.errores.push(creationResult.detail);
    return { status: creationResult.status === 'HTTP_500' ? 'HTTP_500' : 'FAILURE' };
  }

  // Sobrescribir para iterar y cerrar las 4 tareas
  cerrarTareaProgramadaSiCorresponde(clientConfig, summaryReport) {
    let allSuccess = true;
    let anyTerminal = false;

    for (const taskName of NTX_TASKS) {
      const resultado = buscarYCerrarTareaProgramada(taskName, clientConfig, false);
      const estado = resultado && resultado.status ? resultado.status : 'SIN_RESPUESTA';

      if (estado === 'SUCCESS') {
        summaryReport.tareasCerradas++;
        Logger.log(`[${this.operationName}] Tarea programada "${taskName}" cerrada para ${clientConfig.clientName}.`);
      } else if (estado === 'DUPLICADO') {
        Logger.log(`[${this.operationName}] Reporte duplicado: la tarea "${taskName}" ya estaba cerrada.`);
      } else if (estado === 'DEFERRED') {
        allSuccess = false;
      } else if (estado === 'NOT_FOUND') {
        summaryReport.advertencias.push({
          cliente: clientConfig.clientName,
          problema: `No existe tarea programada "${taskName}" creada hoy.`,
          accion: `Revisar si el nombre coincide exactamente.`
        });
        anyTerminal = true;
        allSuccess = false;
      } else {
        summaryReport.errores.push({
          cliente: clientConfig.clientName,
          error: `No se pudo cerrar la tarea "${taskName}"`,
          detalle: `Estado: ${estado}.`
        });
        allSuccess = false;
      }
    }

    if (anyTerminal) return { status: 'ERROR_TERMINAL' };
    return { status: allSuccess ? 'SUCCESS' : 'FAILURE' };
  }
}

function processNutanixOpsEmails() {
  new NutanixOpsProcessor().processEmails();
}
