/**
 * =================================================================
 * SCRIPT ORQUESTADOR DE RVTOOLS - V6.2
 * Fix: gestionarReporteRVTools ahora pushea a summaryReport.exitos
 *      cuando el adjunto Excel se sube correctamente. Antes no lo
 *      hacía, dejando summaryReport vacío cuando el comment era
 *      saltado por haSidoActualizadoHoy → Slack no enviaba nada.
 * =================================================================
 */

const RVTOOLS_ROW_LIMIT_FOR_TABLE = 7;

function hola() {
  procesarRVToolsManual("WPC - Operaciones Testing", "1REqgcvp0q0nDFHYuULKhzb2Yc-Hdnw7h");
}

/**
 * FUNCIÓN PRINCIPAL: Invocada desde la Sheet (checkbox Col U) o desde
 * procesarEnviosPorLote (trigger de tiempo cada 5 min).
 */
function procesarRVToolsManual(clientName, rvToolsFolderId) {
  Logger.log(`--- INICIANDO PROCESO MANUAL RVTOOLS: ${clientName} ---`);
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };

  if (!rvToolsFolderId || rvToolsFolderId.trim() === "") {
    return { success: false, message: "El ID de la carpeta de Drive está vacío." };
  }

  // 1. Obtenemos configuraciones del cliente
  const configZombies = getClientConfigByName(clientName, ZOMBIE_TASK_NAME);
  const configConnect = getClientConfigByName(clientName, CONNECT_TASK_NAME);

  if (!configZombies || !configConnect) {
    return { success: false, message: `No se encontró la configuración en el índice para ${clientName}.` };
  }

  // 2. Buscar la carpeta más reciente con formato de fecha (ej: "20260219")
  let latestFolder;
  try {
    latestFolder = encontrarCarpetaMasReciente(DriveApp.getFolderById(rvToolsFolderId));
  } catch (e) {
    return { success: false, message: `Error al acceder a la carpeta de Drive: ${e.message}` };
  }

  if (!latestFolder) {
    return { success: false, message: `No se encontraron subcarpetas con formato de fecha (YYYYMMDD) para ${clientName}.` };
  }

  // 3. Extraer archivos Excel a procesar
  let allZombieAnomalies = [];
  let allZombieHeaders  = [];
  let allConnectAnomalies = [];
  let allConnectHeaders   = [];

  const files = latestFolder.getFiles();
  const filesToProcess = [];

  while (files.hasNext()) {
    const file = files.next();
    const fileNameLower = file.getName().toLowerCase();
    if (fileNameLower.endsWith(".xlsx") || fileNameLower.endsWith(".xlsm")) {
      filesToProcess.push(file);
    }
  }

  if (filesToProcess.length === 0) {
    return { success: false, message: `No hay archivos .xlsx o .xlsm en la carpeta ${latestFolder.getName()}.` };
  }

  // 4. Procesar cada archivo encontrado
  for (const file of filesToProcess) {
    let tempSheetId = null;
    try {
      Logger.log(`Analizando archivo: ${file.getName()}`);
      // Creamos una copia temporal en Google Sheets para poder leerla
      const tempSheetFile = Drive.Files.copy(
        { mimeType: MimeType.GOOGLE_SHEETS, name: `[TEMP] ${file.getName()}` },
        file.getId()
      );
      tempSheetId = tempSheetFile.id;
      const tempSpreadsheet = SpreadsheetApp.openById(tempSheetId);

      // Extraer vCenter
      const vcenterFQDN = obtenerVCenterDesdeMetaData(tempSpreadsheet);

      // Analizar Zombies
      const zombieResult = procesarZombiesVmdk(tempSpreadsheet, configZombies, summaryReport, vcenterFQDN);
      if (zombieResult && zombieResult.anomalies.length > 0) {
        allZombieAnomalies = allZombieAnomalies.concat(zombieResult.anomalies);
        allZombieHeaders   = zombieResult.headers;
      }

      // Analizar ConnectAtPowerOn
      const connectResult = procesarConnectAtPowerOn(tempSpreadsheet, configConnect, summaryReport, vcenterFQDN);
      if (connectResult && connectResult.anomalies.length > 0) {
        allConnectAnomalies = allConnectAnomalies.concat(connectResult.anomalies);
        allConnectHeaders   = connectResult.headers;
      }

    } catch (e) {
      Logger.log(`Error leyendo archivo ${file.getName()}: ${e.message}`);
      summaryReport.errores.push({ error: "Error de lectura", detalle: `Archivo: ${file.getName()} - ${e.message}` });
    } finally {
      // SIEMPRE borrar la hoja temporal para no ensuciar el Drive
      if (tempSheetId) {
        try { DriveApp.getFileById(tempSheetId).setTrashed(true); } catch (e) {
          Logger.log(`No se pudo borrar el archivo temporal (${tempSheetId}): ${e.message}`);
        }
      }
    }
  }

  // 5. Gestionar Tickets en Jira
  Logger.log("Gestionando tickets en Jira...");
  gestionarReporteRVTools(configZombies, summaryReport, ZOMBIE_TASK_NAME,  ZOMBIE_TICKET_TITLE,  allZombieHeaders,  allZombieAnomalies);
  gestionarReporteRVTools(configConnect, summaryReport, CONNECT_TASK_NAME, CONNECT_TICKET_TITLE, allConnectHeaders, allConnectAnomalies);

  // 6. Enviar mensaje a Slack
  enviarResumenSlack(`RVTools MANUAL: ${clientName}`, summaryReport);

  // 7. Retornar resultado a la Sheet
  if (summaryReport.errores.length > 0) {
    return { success: false, message: "Se detectaron errores durante el proceso. Revisa el canal de Slack." };
  }

  return {
    success: true,
    message: `Anomalías detectadas:\n🧟 Zombies: ${allZombieAnomalies.length}\n🔌 Connect: ${allConnectAnomalies.length}`
  };
}

// =================================================================
// FUNCIONES AUXILIARES
// =================================================================

function encontrarCarpetaMasReciente(carpetaPadre) {
  const subCarpetas = carpetaPadre.getFolders();
  let carpetaMasReciente = null;
  let nombreMasReciente  = "";

  while (subCarpetas.hasNext()) {
    const carpeta      = subCarpetas.next();
    const nombreCarpeta = carpeta.getName();
    if (/^\d{8}$/.test(nombreCarpeta)) {
      if (nombreCarpeta > nombreMasReciente) {
        nombreMasReciente  = nombreCarpeta;
        carpetaMasReciente = carpeta;
      }
    }
  }
  return carpetaMasReciente;
}

function obtenerVCenterDesdeMetaData(spreadsheet) {
  try {
    const sheet = spreadsheet.getSheetByName("vMetaData");
    if (!sheet) return "Desconocido";

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return "Desconocido";

    const headers     = data[0].map(h => String(h).trim().toLowerCase());
    const serverIndex = headers.indexOf("server");

    if (serverIndex !== -1 && data[1][serverIndex]) {
      return data[1][serverIndex];
    }
    return "Desconocido";
  } catch (e) {
    Logger.log("Error leyendo vMetaData: " + e.message);
    return "Error";
  }
}

function gestionarReporteRVTools(clientConfig, summaryReport, taskName, ticketTitle, headers, allAnomalies) {
  try {
    if (!clientConfig) return;

    const alertCount = allAnomalies.length;
    // Busca por nombre corto para máxima flexibilidad
    const existingTicketKey = findExistingJiraTicket(taskName, clientConfig.jiraProjectKey, "Tarea A Demanda");

    if (alertCount === 0) {
      // Sin anomalías: comentar que la situación se normalizó
      if (existingTicketKey) {
        addCommentToJiraTicket(
          existingTicketKey,
          `✅ **La anomalía no persiste.** El último reporte de RVTools para "${taskName}" no muestra alertas válidas.`
        );
        summaryReport.exitos.push({
          mensaje: `Ticket Actualizado (la anomalía no persiste): <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}>`
        });
      }
    } else {
      let description = "";
      let xlsxBlob    = null;
      let newFileName = "";

      if (alertCount <= RVTOOLS_ROW_LIMIT_FOR_TABLE) {
        // Pocas filas: tabla inline en la descripción del ticket
        description = `Se detectaron ${alertCount} nuevas anomalías para "${taskName}":\n\n`;
        description += `|| ${headers.join(" || ")} ||\n`;
        allAnomalies.forEach(row => {
          description += `| ${row.map(cell => (cell || "-").toString().trim()).join(" | ")} |\n`;
        });
      } else {
        // Muchas filas: adjuntar Excel filtrado
        description  = `Se detectaron ${alertCount} anomalías para "${taskName}". Se adjunta un reporte Excel filtrado con el detalle.`;
        newFileName  = `${taskName} - Filtrado.xlsx`;
        xlsxBlob     = convertDataToXlsxBlob([headers, ...allAnomalies], newFileName);
      }

      if (existingTicketKey) {
        let attachmentIsReady = true;

        // --- ADJUNTO ---
        if (xlsxBlob) {
          const attachmentName = newFileName;
          if (!buscarAdjuntoEnTicket(existingTicketKey, attachmentName)) {
            const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
            if (attachmentResult.status !== 'SUCCESS') {
              attachmentIsReady = false;
              summaryReport.errores.push({
                error: "Fallo al adjuntar Excel en " + existingTicketKey,
                detalle: JSON.stringify(attachmentResult.detail)
              });
            } else {
              // FIX: registrar el adjunto exitoso en exitos para que enviarResumenSlack
              // tenga contenido incluso cuando haSidoActualizadoHoy salta el comment.
              // Antes este push no existía, dejando summaryReport vacío → Slack silencioso.
              summaryReport.exitos.push({
                mensaje: `📎 Adjunto subido a <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}>: _${attachmentName}_`
              });
            }
          }
        }

        // --- BLOQUE 1: COMENTAR SI NO FUE ACTUALIZADO HOY ---
        // haSidoActualizadoHoy evita duplicar el mismo comentario en el mismo día.
        if (attachmentIsReady && !haSidoActualizadoHoy(existingTicketKey, taskName)) {
          const comment = `[AUTO-UPDATE:${new Date().toISOString().slice(0, 10)}] ${taskName}\n\n🚨 **La anomalía persiste.**\n\n${description}`;
          addCommentToJiraTicket(existingTicketKey, comment);
          summaryReport.exitos.push({
            mensaje: `Ticket actualizado: <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}>`
          });
        }

        // --- BLOQUE 2: CIERRE INFORMATIVO (lógica aislada) ---
        if (attachmentIsReady) {
          const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, taskName);
          if (accountIdAsignado) {
            ticketInformativo(existingTicketKey, accountIdAsignado);
          }
        }

      } else {
        // No existe ticket → crear uno nuevo
        const creationResult = createTicketAndNotify(ticketTitle, description, xlsxBlob, clientConfig, taskName);
        if (creationResult.status === 'SUCCESS') {
          summaryReport.exitos.push(creationResult.detail);
        } else {
          summaryReport.errores.push({
            error: "No se pudo crear el ticket de " + taskName,
            detalle: JSON.stringify(creationResult.detail)
          });
        }
      }
    }

    // --- CIERRE DE TAREA PROGRAMADA ---
    const closeResult = buscarYCerrarTareaProgramada(taskName, clientConfig, false);
    if (closeResult && closeResult.status === 'SUCCESS') {
      const mensajeDeCierre = (closeResult.detail || closeResult.message || "").toString().toLowerCase();
      if (!mensajeDeCierre.includes("no se encontró") && !mensajeDeCierre.includes("not found")) {
        summaryReport.tareasCerradas++;
      }
    }

  } catch (e) {
    summaryReport.errores.push({
      error: "Fallo crítico al gestionar reporte para " + taskName,
      detalle: e.message
    });
  }
}
