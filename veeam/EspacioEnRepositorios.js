/**
 * @fileoverview Lógica específica para procesar reportes de "Espacio en Repositorios".
 * El reporte de Veeam ya trae filtrados los repositorios con bajo espacio (<10%).
 * Este script genera un ticket si existen filas y no están exceptuadas.
 * APLICA ESTILO: Usa la función compartida generateStyledReportBlob.
 * CORRECCIÓN: Mejora la detección de cabecera y usa excepciones centralizadas.
 * * REQUIERE: Servicio "Drive API" activado (v3).
 */

// --- CONFIGURACIÓN ESPECÍFICA DE LA TAREA ---
const REPO_SPACE_OPERATION_NAME = "Espacio en Repositorios"; 

// Variables de búsqueda
const REPO_SPACE_EMAIL_SUBJECT = "Espacio en repositorios"; 
const REPO_SPACE_FILENAME_MATCH = "Espacio en repositorios"; 
const REPO_SPACE_TASK_NAME = "Espacio en Repositorios"; 
const REPO_SPACE_TICKET_SUMMARY = "Se detectaron repositorios con poco espacio disponible"; 


// --- FUNCIÓN PRINCIPAL (TRIGGER) ---

class EspacioEnRepositoriosProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: REPO_SPACE_OPERATION_NAME,
      emailSubject: REPO_SPACE_EMAIL_SUBJECT,
      attachmentMatch: REPO_SPACE_FILENAME_MATCH,
      scheduledTaskName: REPO_SPACE_TASK_NAME
    });
  }

  processSingleMessage(message, summaryReport) {
    const subjectLower = message.getSubject().toLowerCase();
    const requiredSubjectPart = this.emailSubject.toLowerCase();
    if (!subjectLower.includes(requiredSubjectPart)) {
      Logger.log(`El asunto "${message.getSubject()}" no contiene la frase requerida "${this.emailSubject}". Se omite.`);
      return { status: 'SUCCESS' };
    }
    return super.processSingleMessage(message, summaryReport);
  }

  findAttachment(message) {
    let attachmentToUse = null;
    this.extractedBlobs = [];

    message.getAttachments().forEach(att => {
      const attNameLower = att.getName().toLowerCase();
      if (attNameLower.endsWith(".zip") || att.getContentType() === "application/zip") {
        try {
          const zipBlob = att.copyBlob();
          const bytes = zipBlob.getBytes();
          const size = bytes.length;

          const magic = size >= 4 ? `${(bytes[0] & 0xFF).toString(16)}-${(bytes[1] & 0xFF).toString(16)}-${(bytes[2] & 0xFF).toString(16)}-${(bytes[3] & 0xFF).toString(16)}` : "archivo muy corto";
          Logger.log(`[DEBUG findAttachment] ZIP "${att.getName()}" | Tamaño: ${size} bytes | Magic: ${magic}`);

          zipBlob.setContentType("application/zip");
          let unzippedBlobs = Utilities.unzip(zipBlob);

          if (!unzippedBlobs || unzippedBlobs.length === 0) {
            Logger.log(`[DEBUG findAttachment] unzip con copyBlob() devolvió 0. Reintentando con newBlob()...`);
            const rawBlob = Utilities.newBlob(bytes, "application/zip", att.getName());
            unzippedBlobs = Utilities.unzip(rawBlob);
          }

          if (unzippedBlobs && unzippedBlobs.length > 0) {
            this.extractedBlobs = this.extractedBlobs.concat(unzippedBlobs);
          } else {
            if (size >= 2 && (bytes[0] & 0xFF) === 0x1F && (bytes[1] & 0xFF) === 0x8B) {
              Logger.log(`[DEBUG findAttachment] Detectado formato GZIP. Intentando ungzip...`);
              const gzBlob = Utilities.newBlob(bytes, "application/x-gzip", att.getName());
              const ungzipped = Utilities.ungzip(gzBlob);
              const csvName = att.getName().replace(/\.zip$/i, ".csv");
              ungzipped.setName(csvName);
              this.extractedBlobs.push(ungzipped);
            } else {
              Logger.log(`[DEBUG findAttachment] unzip sigue en 0. Intentando leer como texto directo...`);
              const textContent = zipBlob.getDataAsString("UTF-8");
              if (textContent.includes(",") || textContent.includes(";")) {
                Logger.log(`[DEBUG findAttachment] El contenido parece ser un CSV. Usándolo directamente.`);
                const csvBlob = Utilities.newBlob(textContent, "text/csv", att.getName().replace(/\.zip$/i, ".csv"));
                this.extractedBlobs.push(csvBlob);
              } else {
                Logger.log(`[DEBUG findAttachment] No se pudo interpretar el archivo. ZIP vacío o formato desconocido.`);
              }
            }
          }
        } catch(e) {
          Logger.log(`[DEBUG findAttachment] Error al descomprimir "${att.getName()}": ${e.message}`);
          this.extractedBlobs.push(att.copyBlob());
        }
      } else {
        this.extractedBlobs.push(att.copyBlob());
      }
    });

    const searchString = this.attachmentMatch.toLowerCase().trim();

    const attachmentExcel = this.extractedBlobs.find(blob => {
      const name = blob.getName().toLowerCase();
      return name.includes(searchString) && name.endsWith(".xlsx");
    });

    const attachmentCsv = this.extractedBlobs.find(blob => {
      const name = blob.getName().toLowerCase();
      return (name.includes("details") || name.includes(searchString)) && name.endsWith(".csv");
    });

    if (attachmentExcel) {
      this.isV13 = false;
      return attachmentExcel;
    } else if (attachmentCsv) {
      this.isV13 = true;
      return attachmentCsv;
    }

    const allCsvs = this.extractedBlobs.filter(blob => blob.getName().toLowerCase().endsWith(".csv"));
    if (allCsvs.length === 1) {
      Logger.log(`[DEBUG findAttachment] Fallback: usando el único CSV encontrado: "${allCsvs[0].getName()}"`);
      this.isV13 = true;
      return allCsvs[0];
    }

    if (this.extractedBlobs.length === 0) {
      Logger.log(`[DEBUG findAttachment] Fallback: ZIP vacío. Se asume reporte sin anomalías.`);
      this.isV13 = true;
      return Utilities.newBlob("Repository: Name,Repository: Free Space (%),Backup Server Name\n", "text/csv", "empty_report.csv");
    }

    Logger.log(`[DEBUG findAttachment] No se encontró ningún adjunto válido. searchString="${searchString}"`);
    return null;
  }

  resolveClientConfig(config, sender, attachment, message, summaryReport) {
    if (config) config.tecnologia = "Veeam Backup & Replication"; 
    return config;
  }

  parseAttachment(attachment, summaryReport) {
    try {
      if (this.isV13) {
        const csvString = attachment.getDataAsString();
        return parseCsvRobust(csvString);
      } else {
        return convertRepoExcelToDataLocal(attachment.copyBlob());
      }
    } catch (e) {
      summaryReport.errores.push({ error: `Fallo al leer el archivo ${this.isV13 ? 'CSV' : 'Excel'}.`, detalle: e.message });
      return null;
    }
  }

  processData(parsedData, clientConfig, summaryReport) {
    const filteredData = filterRepositoryData(parsedData, clientConfig.exceptions);
    if (filteredData.rows.length === 0) {
      return { headers: [], finalAlerts: [], rowsForExport: [], reasonsText: "" };
    }
    const headers = filteredData.rows[0];
    const finalAlerts = filteredData.rows.slice(1);
    return { headers, finalAlerts, rowsForExport: filteredData.rows, reasonsText: "" };
  }

  findExistingTicket(clientConfig) {
    return findTargetReportTicket(REPO_SPACE_TICKET_SUMMARY, clientConfig.jiraProjectKey);
  }

  handleNoAlerts(existingTicketKey, clientConfig, summaryReport) {
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Anomalía resuelta.** El reporte actual indica que los repositorios tienen espacio suficiente.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
    return { status: 'SUCCESS' };
  }

  handleAlerts(existingTicketKey, clientConfig, summaryReport, headers, finalAlerts, rowsForExport, reasonsText, attachmentName) {
    const alertCount = finalAlerts.length;
    const newFileName = attachmentName.replace(/\.(xlsx|csv|xls|json)$/i, " - FILTRADO.xlsx");
    
    // El método `generateStyledReportBlob` lo espera con la cabecera incluida
    const xlsxBlob = generateStyledReportBlob([headers, ...finalAlerts], newFileName, [], "Repository: Name");
    
    if (existingTicketKey) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attachmentResult.status === 'SUCCESS') {
        const commentText = `🚨 **Atención:** Se detectaron **${alertCount}** repositorios con poco espacio. Ver adjunto actualizado.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Ticket existente <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> actualizado con evidencia.` });
        
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, this.operationName); 
        if (accountIdAsignado) ticketInformativo(existingTicketKey, accountIdAsignado);
        return { status: 'SUCCESS' };
      } else {
        summaryReport.advertencias.push(attachmentResult.detail);
        return { status: attachmentResult.status };
      }
    } else {
      const description = `Se ha detectado que **${alertCount}** repositorio(s) tienen un espacio libre crítico (generalmente inferior al 10%).\n\nEsto pone en riesgo la ejecución exitosa de los backups. Por favor revisar el adjunto y tomar acciones de limpieza o expansión.`;
      
      const creationResult = createTicketAndNotify(REPO_SPACE_TICKET_SUMMARY, description, xlsxBlob, clientConfig, this.operationName);
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
        if (this.scheduledTaskName) buscarYCerrarTareaProgramada(this.scheduledTaskName, clientConfig, false);
      } else if (creationResult.status === 'ERROR') {
        summaryReport.errores.push(creationResult.detail);
      } else {
        summaryReport.advertencias.push(creationResult.detail);
      }
      return { status: creationResult.status };
    }
  }
}

function processRepositorySpaceEmails() {
  new EspacioEnRepositoriosProcessor().processEmails();
}

// --- FUNCIONES LOCALES ---

/**
 * Filtra los repositorios detectados en el reporte.
 * CORREGIDO: Evita filas de metadatos como "Columns:" y usa excepciones centralizadas.
 */
function filterRepositoryData(allRows, exceptions) {
  const resultRows = [];
  let currentHeader = [];
  let normalizedHeaders = []; // Para isRowExcepted
  let repoCount = 0;
  
  let COL_IDX_NAME = -1;
  let headerFound = false;
  let startIndex = 0;

  // 1. Detección de Cabecera (ESTRICTA)
  for (let i = 0; i < allRows.length; i++) {
    const rowString = allRows[i].join(" ").toLowerCase();
    
    // Buscamos "Repository: Name" Y "Free Space"
    // Y CRUCIAL: Que NO contenga "columns:" (así evitamos la fila de metadatos)
    if (rowString.includes("repository: name") && 
        rowString.includes("free space") && 
        !rowString.includes("columns:")) {
          
      currentHeader = allRows[i];
      // Normalizamos cabecera para las excepciones
      normalizedHeaders = currentHeader.map(h => normalizarEncabezado(h));
      
      resultRows.push(currentHeader); // Guardamos la cabecera real
      startIndex = i + 1;
      headerFound = true;

      // Buscamos índice de columna
      for (let c = 0; c < currentHeader.length; c++) {
        const val = currentHeader[c].toString().toLowerCase().trim();
        if (val.includes("repository: name")) COL_IDX_NAME = c;
      }
      break;
    }
  }

  if (!headerFound || COL_IDX_NAME === -1) {
    return { rows: [], vmCount: 0 };
  }

  // 2. Filtrado de Filas
  for (let i = startIndex; i < allRows.length; i++) {
    const row = allRows[i];
    const repoName = (row[COL_IDX_NAME] || "").toString().trim();

    // Saltar filas vacías
    if (repoName === "") continue;
    
    // Saltar filas basura que hayan quedado (filtros, fechas)
    if (repoName.toLowerCase().includes("custom filters") || 
        repoName.toLowerCase().includes("report generation")) {
      continue;
    }

    // Chequeo de excepciones USANDO LA FUNCIÓN COMPARTIDA
    if (!isRowExcepted(row, normalizedHeaders, exceptions)) {
      resultRows.push(row);
      repoCount++;
    } else {
      Logger.log(`Repositorio omitido por excepción: ${repoName}`);
    }
  }

  return { rows: resultRows, vmCount: repoCount };
}

/**
 * Función local para leer Excel (Sheet1).
 */
function convertRepoExcelToDataLocal(blob) {
  let tempFileId;
  try {
    const resource = { name: "[TEMP] " + blob.getName(), mimeType: MimeType.GOOGLE_SHEETS };
    const tempFile = Drive.Files.create(resource, blob);
    tempFileId = tempFile.id;
    Utilities.sleep(2000);
    const spreadsheet = SpreadsheetApp.openById(tempFileId);
    
    // Sheet1 por defecto
    const sheet = spreadsheet.getSheets()[0];
    return sheet.getDataRange().getDisplayValues(); 
  } catch (e) {
    Logger.log("Error convirtiendo Excel: " + e.message);
    throw e;
  } finally {
    if (tempFileId) {
      try { Drive.Files.update({trashed: true}, tempFileId); } catch (e) {}
    }
  }
}

function processEspacioRepositoriosEmails() {
  new EspacioRepositoriosProcessor().processEmails();
}
