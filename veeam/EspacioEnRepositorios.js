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

function processRepositorySpaceEmails() {
  const summaryReport = { exitos: [], advertencias: [], errores: [], tareasCerradas: 0 };
  
  const searchQuery = construirBusquedaGmail(REPO_SPACE_EMAIL_SUBJECT);
  const threads = GmailApp.search(searchQuery);

  if (threads.length > 0) {
    threads.forEach(thread => {
      const message = thread.getMessages()[thread.getMessageCount() - 1];
      if (message.isUnread()) {
        try {
          const processingStatus = processSingleRepositorySpaceMessage(message, summaryReport);
          if (processingStatus !== 'HTTP_500') {
             thread.markRead();
          }
        } catch (e) {
          summaryReport.errores.push({ error: `Error Crítico en Script ${REPO_SPACE_OPERATION_NAME}: ${e.message}`, detalle: `Stack: ${e.stack}` });
        }
      }
    });
  }
  
  enviarResumenSlack(REPO_SPACE_OPERATION_NAME, summaryReport);
}


// --- LÓGICA DE PROCESAMIENTO ---

function processSingleRepositorySpaceMessage(message, summaryReport) {
  Logger.log(`--- Iniciando procesamiento para [${REPO_SPACE_OPERATION_NAME}] del correo: "${message.getSubject()}" ---`);
  
  // --- [NUEVO] VALIDACIÓN DE ASUNTO (CONTIENE + CASE INSENSITIVE) ---
  const subjectLower = message.getSubject().toLowerCase();
  const requiredSubjectPart = REPO_SPACE_EMAIL_SUBJECT.toLowerCase();

  if (!subjectLower.includes(requiredSubjectPart)) {
    Logger.log(`El asunto "${message.getSubject()}" no contiene la frase requerida "${REPO_SPACE_EMAIL_SUBJECT}". Se omite.`);
    return 'SUCCESS'; 
  }
  // ------------------------------------------------------------------

  const senderEmail = message.getFrom();
  const searchString = REPO_SPACE_FILENAME_MATCH.toLowerCase().trim();

  // 1. Buscar adjunto Excel (.xlsx)
  const attachment = message.getAttachments().find(att => {
    const attName = att.getName().toLowerCase();
    const isNameMatch = attName.includes(searchString);
    const isExcel = (att.getContentType() === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || attName.endsWith(".xlsx"));
    return isNameMatch && isExcel;
  });

  if (!attachment) {
    Logger.log(`No se encontró un adjunto Excel (.xlsx) válido.`);
    return 'SUCCESS'; 
  }

  // 2. Obtener configuración
  const clientConfig = getClientConfig(senderEmail, REPO_SPACE_OPERATION_NAME);
  if (!clientConfig) {
    summaryReport.errores.push({ error: "Configuración de cliente no encontrada.", detalle: `Remitente: ${senderEmail}` });
    return 'FAILURE';
  }

  // --- [LÍNEA AGREGADA ANTERIORMENTE] ---
  // Forzamos la tecnología a Veeam para este reporte, ignorando el Excel maestro.
  clientConfig.tecnologia = "Veeam Backup & Replication"; 
  // ---------------------------

  // 3. Convertir Excel a Datos
  let rawRows = [];
  try {
    // Usamos función local para leer Sheet1
    rawRows = convertRepoExcelToDataLocal(attachment.copyBlob());
  } catch (e) {
    summaryReport.errores.push({ error: "Fallo al leer el archivo Excel.", detalle: e.message });
    return 'FAILURE';
  }
  
  // 4. Filtrar Repositorios (Quitar excepciones)
  const filteredData = filterRepositoryData(rawRows, clientConfig.exceptions);
  const finalAlerts = filteredData.rows; 
  const alertCount = filteredData.vmCount; 

  // 5. Gestión de Tickets en Jira
  
  // Usamos la función que EXCLUYE "Tarea Programada"
  const existingTicketKey = findTargetReportTicketLocal(REPO_SPACE_TICKET_SUMMARY, clientConfig.jiraProjectKey);

  if (alertCount === 0) {
    // --- NO HAY ALERTAS ---
    if (existingTicketKey) {
      addCommentToJiraTicket(existingTicketKey, "✅ **Anomalía resuelta.** El reporte actual indica que los repositorios tienen espacio suficiente.");
      summaryReport.exitos.push({ mensaje: `Se actualizó el ticket <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> como resuelto.` });
    } else {
      summaryReport.exitos.push({ mensaje: `Reporte de ${clientConfig.clientName} procesado sin anomalías.` });
    }
    
    // Cerrar la tarea programada (Azul) si existe
    const closeResult = buscarYCerrarTareaProgramada(REPO_SPACE_TASK_NAME, clientConfig, false);
    if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
    
    return 'SUCCESS';

  } else {
    // --- SÍ HAY ALERTAS - GENERAR EXCEL CON ESTILO ---
    
    const newFileName = attachment.getName().replace(/\.xlsx$/i, " - FILTRADO.xlsx");
    
    // --- USO DE LA FUNCIÓN COMPARTIDA PARA FORMATEO ---
    // Usamos "Repository: Name" para asegurar que la función de formato
    // también recorte cualquier basura superior que haya sobrevivido al filtro manual.
    const xlsxBlob = generateStyledReportBlob(finalAlerts, newFileName, [], "Repository: Name");
    // -------------------------------------------------------------
    
    if (existingTicketKey) {
      const attachmentResult = addAttachmentToJiraTicket(existingTicketKey, xlsxBlob);
      if (attachmentResult.status === 'SUCCESS') {
        const commentText = `🚨 **Atención:** Se detectaron **${alertCount}** repositorios con poco espacio. Ver adjunto actualizado.`;
        addCommentToJiraTicket(existingTicketKey, commentText);
        summaryReport.exitos.push({ mensaje: `Ticket existente <${JIRA_DOMAIN}/browse/${existingTicketKey}|${existingTicketKey}> actualizado con evidencia.` });
        
        // Cerramos la tarea programada (Azul)
        const closeResult = buscarYCerrarTareaProgramada(REPO_SPACE_TASK_NAME, clientConfig, false);
        if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
        const accountIdAsignado = chequearSiEsInformativa(clientConfig.clientName, REPO_SPACE_OPERATION_NAME); 
          if (accountIdAsignado) {
             ticketInformativo(existingTicketKey, accountIdAsignado);
          }
        return 'SUCCESS';
      } else {
        summaryReport.advertencias.push(attachmentResult.detail);
        return attachmentResult.status;
      }
    } else {
      // Crear ticket nuevo (Incidente)
      const summary = REPO_SPACE_TICKET_SUMMARY;
      const description = `Se ha detectado que **${alertCount}** repositorio(s) tienen un espacio libre crítico (generalmente inferior al 10%).\n\nEsto pone en riesgo la ejecución exitosa de los backups. Por favor revisar el adjunto y tomar acciones de limpieza o expansión.`;
      
      const creationResult = createTicketAndNotify(summary, description, xlsxBlob, clientConfig,REPO_SPACE_OPERATION_NAME);
      
      if (creationResult.status === 'SUCCESS') {
        summaryReport.exitos.push(creationResult.detail);
        const closeResult = buscarYCerrarTareaProgramada(REPO_SPACE_TASK_NAME, clientConfig, false);
        if (closeResult.status === 'SUCCESS') summaryReport.tareasCerradas++;
      } else if (creationResult.status === 'ERROR') {
        summaryReport.errores.push(creationResult.detail);
      } else {
        summaryReport.advertencias.push(creationResult.detail);
      }
      return creationResult.status;
    }
  }
}

// --- FUNCIONES LOCALES ---

/**
 * Función local para buscar tickets ignorando "Tarea Programada".
 */
function findTargetReportTicketLocal(summary, projectKey) {
  const endpoint = `${JIRA_DOMAIN}/rest/api/3/search/jql`;
  
  let jql = `summary ~ "${summary.replace(/"/g, '\\"')}" AND statusCategory != "Done"`;
  if (projectKey) jql += ` AND project = "${projectKey}"`;
  
  // Excluir tarea interna
  jql += ` AND issuetype != "Tarea Programada"`;
  
  jql += " ORDER BY created DESC";
  
  const payload = { "jql": jql, "maxResults": 1, "fields": ["key"] };
  const options = {
    "method": "post", "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  };
  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      if (data.issues && data.issues.length > 0) return data.issues[0].key;
    }
    return null;
  } catch (e) { return null; }
}

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
