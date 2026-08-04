/**
 * @fileoverview Lógica específica para procesar reportes de "VMs con snapshots".
 * Refactorizado utilizando la clase base MailProcessor.
 */

// --- CONFIGURACIÓN ESPECÍFICA ---
const SNAPSHOTS_OPERATION_NAME = "VMs con snapshots";
const SNAPSHOTS_EMAIL_SUBJECT = "VMs con snapshots";
const SNAPSHOTS_FILENAME_MATCH = "VMs con snapshots";
const SNAPSHOTS_SCHEDULED_TASK_NAME_TO_CLOSE = "VMs con snapshots";
const SNAPSHOTS_ROW_LIMIT_FOR_TABLE = 5;
const SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE = "Se detectaron VMs con Snapshots";
const SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT = "Se detectaron VMs con Snapshots";

const AGE_MAX = 7;      // Días
const SIZE_MAX = 300;   // GB
const CANTIDAD_MAX = 3; // Unidades

class VMsConSnapshotsProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: SNAPSHOTS_OPERATION_NAME,
      emailSubject: SNAPSHOTS_EMAIL_SUBJECT,
      attachmentMatch: SNAPSHOTS_FILENAME_MATCH,
      scheduledTaskName: SNAPSHOTS_SCHEDULED_TASK_NAME_TO_CLOSE
    });
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    const fileNameUpper = attachment.getName().toUpperCase();
    const clientNameUpper = (config && config.clientName) ? config.clientName.toUpperCase() : "";
    
    const esBalanz = clientNameUpper.includes("BALANZ") || fileNameUpper.includes("BALANZ");
    const esMacro = clientNameUpper.includes("MACRO") || fileNameUpper.includes("MACRO");
    
    if (esBalanz && (!config || !config.clientName || !config.clientName.toUpperCase().includes("BALANZ"))) {
      config = getClientConfigByName("Operaciones BALANZ", this.operationName) || { clientName: "Operaciones BALANZ", jiraProjectKey: "OBC2", exceptions: [] };
    } else if (esMacro && (!config || !config.clientName || !config.clientName.toUpperCase().includes("MACRO"))) {
      config = getClientConfigByName("Operaciones Banco Macro", this.operationName) || { clientName: "Operaciones Banco Macro", jiraProjectKey: "OBM", exceptions: [] };
    } else if (!config || !config.clientName || config.clientName.toUpperCase().includes("DESCONOCIDO")) {
      return null;
    }
    return config;
  }

  processData(parsedData, clientConfig, summaryReport) {
    const headers = parsedData[0].map(h => h.trim());
    const reportRows = parsedData.slice(1);

    if (clientConfig && !clientConfig.exceptions) clientConfig.exceptions = [];

    const findCol = (namePart) => headers.findIndex(h => h.toLowerCase().includes(namePart.toLowerCase()));
    
    let idxName = findCol("Name");
    let idxAge = findCol("Number_Days_Old") !== -1 ? findCol("Number_Days_Old") : findCol("Age");  
    let idxSpace = findCol("Snapshot_Space") !== -1 ? findCol("Snapshot_Space") : findCol("Space");
    let idxCount = findCol("Number_Snapshots") !== -1 ? findCol("Number_Snapshots") : findCol("Cantidad");
    let idxSnapName = findCol("Snapshot_Name");

    if (idxName === -1 || idxAge === -1 || idxSpace === -1 || idxCount === -1) {
      summaryReport.errores.push({ error: "Faltan columnas clave." });
      return null;
    }
    
    headers[idxName] = "Name";

    // El reporte no siempre trae fila de "Total": en el de vSphere World la última línea es un
    // registro común. Popearla a ciegas la sacaba del análisis y encima la reinyectaba sin filtrar
    // en rowsForExport, así que el adjunto quedaba con una fila de más respecto del conteo del
    // ticket. Sólo se separa cuando de verdad parece un total.
    let summaryRow = [];
    if (reportRows.length > 0) {
      const ultima = reportRows[reportRows.length - 1];
      const claveUltima = (ultima[idxName] || "").toString().trim().toLowerCase();
      if (claveUltima === "" || claveUltima.startsWith("total")) summaryRow = reportRows.pop();
    }

    const parseSeguro = (val) => {
      if (!val) return 0;
      let clean = val.toString().trim();
      if (clean.includes('.') && clean.includes(',')) clean = clean.replace(/\./g, '');
      clean = clean.replace(',', '.');
      return parseFloat(clean) || 0;
    };

    // Un "Restore Point" es un punto de recuperación de un job de réplica de Veeam, no una
    // snapshot de vSphere. La cantidad que tiene es la retención configurada del job, así que la
    // regla de CANTIDAD no aplica: 3 restore points es la réplica funcionando bien, y pedir que
    // se borren rompe la cadena. Sí queda sujeto a ANTIGÜEDAD, para que una cadena trabada con
    // restore points viejos siga alertando.
    const esRestorePoint = (row) => idxSnapName !== -1 &&
      (row[idxSnapName] || "").toString().trim().toLowerCase().startsWith("restore point");

    // Devuelve las reglas que rompe la fila. Se usa dos veces (filtrado y desglose) para que el
    // conteo por criterio salga sólo de las filas que quedaron como alerta: contarlas dentro del
    // filter incluía filas que después descartaba isRowExcepted.
    const reglasQueRompe = (row) => {
      const age = parseSeguro(row[idxAge]);
      const space = parseSeguro(row[idxSpace]);
      const count = parseSeguro(row[idxCount]);

      const razones = [];
      if (age >= AGE_MAX) razones.push(`Antigüedad >= ${AGE_MAX} días`);
      if (space >= SIZE_MAX) razones.push(`Tamaño >= ${SIZE_MAX} GB`);
      if (count >= CANTIDAD_MAX && !esRestorePoint(row)) razones.push(`Cantidad >= ${CANTIDAD_MAX}`);
      return razones;
    };

    const finalAlerts = reportRows.filter(row => {
      if (row.length < idxAge || row.join('').trim() === '') return false;

      const vmName = (row[idxName] || "").trim();
      if (vmName.toLowerCase().includes("replica")) return false;

      // Number_Days_Old = -1 no es una antigüedad: es la marca del reporte origen para snapshots
      // que ya no existen en vSphere (arrastra el histórico de las borradas). Verificado sobre el
      // reporte completo: en las 111 VMs no-réplica, la cantidad de filas con edad real coincide
      // exacto con Number_Snapshots. Sobre esas filas no hay nada que accionar, y como
      // Number_Snapshots viene estampado por VM en todas sus filas, disparaban la regla de
      // cantidad una vez por cada fila fantasma.
      if (parseSeguro(row[idxAge]) < 0) return false;

      return reglasQueRompe(row).length > 0 && !isRowExcepted(row, headers, clientConfig.exceptions);
    });

    // Desglose por criterio: sin esto la descripción listaba "Antigüedad >= 7 días" y
    // "Cantidad >= 3" sin decir cuántos registros caían en cada uno, y se leía como si el total
    // entero fuera por antigüedad. Una fila puede romper más de una regla, así que la suma de los
    // parciales puede superar el total.
    const conteoPorRazon = {};
    finalAlerts.forEach(row => {
      reglasQueRompe(row).forEach(r => { conteoPorRazon[r] = (conteoPorRazon[r] || 0) + 1; });
    });
    const reasonsText = Object.keys(conteoPorRazon)
      .map(r => `* ${r}: ${conteoPorRazon[r]} registro${conteoPorRazon[r] === 1 ? '' : 's'}`)
      .join('\n');

    const rowsForExport = [...finalAlerts];
    if (summaryRow.length > 0) rowsForExport.push(summaryRow);

    return { headers, finalAlerts, rowsForExport, reasonsText };
  }

  findExistingTicket(clientConfig) {
    return findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE, clientConfig.jiraProjectKey) ||
           findExistingJiraTicket(SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT, clientConfig.jiraProjectKey);
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;

    if (existingTicketKey) {
      if (haSidoActualizadoHoy(existingTicketKey, "ALERTA-SNAPSHOTS")) return { status: 'SUCCESS' };
      
      let commentText = `🚨 **El problema persiste.** [HU-ALERTA-SNAPSHOTS]\n\nSe detectaron ${alertCount} VMs fuera de norma:\n${reasonsText}\n\n`;
      
      if (alertCount <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
        commentText += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(row => commentText += `| ${row.map(c => (c || "").trim()).join(" | ")} |\n`);
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} actualizado con tabla.` });
      } else {
        // El nombre DEBE incluir la fecha del reporte: addAttachmentToJiraTicket omite adjuntos
        // que ya existen en el ticket, y con un nombre fijo la actualización del día siguiente
        // se descartaría por error. Se usa la misma convención que MailProcessor.handleAlerts.
        const nombreReporte = attachmentName.replace(/\.csv$/i, "-FILTRADO.xlsx");
        const xlsxBlob = convertDataToXlsxBlob([headers, ...rowsForExport], nombreReporte);
        const attStatus = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
        
        if (attStatus.status === 'SUCCESS') {
            commentText += "Se adjunta reporte detallado.";
            addCommentToJiraTicket(existingTicketKey, commentText);
            summaryReport.exitos.push({ mensaje: `Ticket ${existingTicketKey} actualizado con adjunto.` });

            const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName);
            if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
        } else {
            // No cerrar la tarea programada acá: el reporte todavía no se adjuntó. Si un 500
            // transitorio de Jira cierra la tarea de todos modos, el próximo reintento la
            // encuentra ya cerrada (NOT_FOUND es terminal en buscarYCerrarTareaProgramada) y el
            // correo se aparta a [OPS-ERROR] para siempre aunque el 500 se hubiera resuelto solo.
            summaryReport.advertencias.push("Fallo al adjuntar.");
            return { status: attStatus.status === 'HTTP_500' ? 'HTTP_500' : 'FAILURE' };
        }
      }

      if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      return { status: 'SUCCESS' };
      
    } else {
      let summary, description, xlsxBlob = null;
      description = `Se detectaron ${alertCount} VMs con snapshots fuera del estándar permitido:\n${reasonsText}\n\n`;
      
      if (alertCount <= SNAPSHOTS_ROW_LIMIT_FOR_TABLE) {
        summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_TABLE;
        description += `|| ${headers.join(" || ")} ||\n`;
        finalAlerts.forEach(rowData => {
          description += `| ${rowData.map(cell => (cell || "").trim()).join(" | ")} |\n`;
        });
      } else {
        summary = SNAPSHOTS_JIRA_TICKET_SUMMARY_ATTACHMENT;
        description += `Debido a la cantidad de registros (${alertCount}), se adjunta el reporte detallado.`;
        const newFileName = attachmentName.replace(/\.xlsx$|\.csv$/i, "") + "-FILTRADO.xlsx";
        xlsxBlob = convertDataToXlsxBlob([headers, ...rowsForExport], newFileName);
      }
     
      const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig, this.operationName);
      const estadoCreacion = (creationResult && creationResult.status) ? creationResult.status : 'ERROR';

      if (estadoCreacion === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
      } else {
        // Mismo motivo que en la rama de ticket existente: si el reporte no se llegó a adjuntar,
        // NO se cierra la tarea programada. Cerrarla acá hace que el reintento la encuentre
        // cerrada (NOT_FOUND es terminal) y mande el correo a [OPS-ERROR] para siempre, aunque
        // el 500 de Jira haya sido pasajero.
        summaryReport.errores.push(creationResult && creationResult.detail ? creationResult.detail : {
          cliente: clientConfig.clientName,
          error: `No se pudo crear/completar el ticket de "${this.operationName}"`,
          detalle: `Estado devuelto: ${estadoCreacion}. El correo queda pendiente y se reintenta.`
        });
        Logger.log(`[${this.operationName}] Creación/adjunto no confirmado (estado ${estadoCreacion}). NO se cierra la tarea programada; el correo se reintenta.`);
        return { status: estadoCreacion };
      }

      if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      return { status: estadoCreacion };
    }
  }
}

function processSnapshotsEmails() {
  new VMsConSnapshotsProcessor().processEmails();
}