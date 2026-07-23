/**
 * Un analizador de CSV robusto que maneja comillas internas, saltos de línea y detecta separadores (coma o punto y coma).
 * @param {string} csvText El contenido del archivo CSV como texto.
 * @param {string} [separator=null] Separador opcional (si no se indica, autodetecta por la primera línea).
 * @returns {Array<Array<string>>} Un array 2D con los datos del CSV.
 */
function parseCsvRobust(csvText, separator = null) {
  if (!csvText) return [];
  const lines = csvText.split(/\r\n|\n|\r/);
  const firstLine = lines.find(l => l.trim() !== '') || '';
  const sep = separator || (firstLine.includes(';') ? ';' : ',');

  const result = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const row = [];
    let currentField = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = i < line.length - 1 ? line[i+1] : null;

      if (char === '"' && inQuotes && nextChar === '"') {
        currentField += '"';
        i++; // Skip next quote
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === sep && !inQuotes) {
        row.push(currentField);
        currentField = '';
      } else {
        currentField += char === '|' ? '-' : char;
      }
    }
    row.push(currentField);
    result.push(row);
  }
  return result;
}

const COLUMN_ALIASES = {
  "name": ["virtual machine", "vm", "vm name", "nombre", "machine"],
  "used space (%)": ["utilization (%)", "space used (%)", "percent used", "uso (%)", "utilizacion (%)", "used space percent", "percentage of used space"],
  "snapshot space (gb)": ["snapshot space", "espacio snapshot (gb)", "snapshot size (gb)", "snapshot size", "space", "size (gb)", "tamanio (gb)", "size", "snapshot_space"],
  "partition usage (%)": ["porcentaje de uso (%)", "porcentaje de uso", "free space (%)", "uso de particion (%)", "uso de particion", "partition usage", "partition_usage_(%)"],
  "number_days_old": ["age", "days old", "dias", "antiguedad", "number days old", "created"],
  "number_snapshots": ["cantidad", "snapshots", "number snapshots", "count"]
};

/**
 * Normaliza un texto de encabezado para una comparación robusta.
 * Quita espacios al inicio/final, convierte a minúsculas, colapsa
 * múltiples espacios internos y reemplaza guiones por espacios.
 * Además, busca en el mapa COLUMN_ALIASES para retornar el nombre canónico.
 * @param {string} header El texto del encabezado.
 * @returns {string} El texto normalizado y canónico.
 */
function normalizarEncabezado(header) {
  if (typeof header !== 'string') return '';
  const normalized = header
    .replace(/^"|"$/g, '')   // Elimina comillas al inicio y final
    .replace(/^\uFEFF/g, '') // Elimina BOM (Byte Order Mark)
    .trim()                  // Quita espacios en los extremos
    .toLowerCase()           // Convierte todo a minúsculas
    .replace(/\s+/g, ' ')   // Reemplaza múltiples espacios por uno solo
    .replace(/-/g, ' ');     // Reemplaza guiones por espacios para tolerar guiones en lugar de espacios

  // Búsqueda en mapa de aliases
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (canonical === normalized || aliases.includes(normalized)) {
      return canonical;
    }
  }
  return normalized;
}


/**
 * FUNCIÓN MODIFICADA
 * Verifica si una fila de reporte debe ser omitida según las reglas de excepción.
 * Ahora utiliza la normalización de encabezados para ser más robusta.
 * @param {Array} reportRow - La fila de datos del reporte.
 * @param {Array<string>} headers - La lista de encabezados YA NORMALIZADOS del reporte.
 * @param {Object} exceptions - El objeto con las reglas de excepción del cliente.
 * @returns {boolean} - `true` si la fila cumple con alguna regla de excepción, `false` en caso contrario.
 */
function isRowExcepted(reportRow, headers, exceptions) {
  const normalizedHeaders = headers.map(h => normalizarEncabezado(h));
  for (const exceptionId in exceptions) {
    const ruleGroup = exceptions[exceptionId];
    const allConditionsMet = ruleGroup.every(condition => {
      // Normalizamos la columna leída desde el Excel de Excepciones antes de buscarla
      const normalizedConditionColumn = normalizarEncabezado(condition.column);
      const colIndex = normalizedHeaders.indexOf(normalizedConditionColumn);

      if (colIndex === -1) {
        // Este log es útil para depurar por qué una regla de excepción no funciona
        Logger.log(`ADVERTENCIA DE EXCEPCIÓN: La columna "${condition.column}" (normalizada como "${normalizedConditionColumn}") definida en el Excel de excepciones no se encontró en el reporte.`);
        return false; // La condición falla porque la columna no existe en el reporte
      }
      const reportValueStr = (reportRow[colIndex] || "").trim();
      return condition.values.some(exceptionValue => {
        const reportValueLower = reportValueStr.toLowerCase();
        switch (condition.matchType.toLowerCase()) {
          case 'exacta': return (reportValueLower === exceptionValue);
          case 'contiene': return reportValueLower.includes(exceptionValue);
          case 'empieza con': return reportValueLower.startsWith(exceptionValue);
          case 'termina con': return reportValueLower.endsWith(exceptionValue);
          case 'mayor que': case 'menor que':
            const reportNum = parseFloat(reportValueStr);
            const exceptionNum = parseFloat(exceptionValue);
            if (!isNaN(reportNum) && !isNaN(exceptionNum)) {
              if (condition.matchType.toLowerCase() === 'mayor que') return reportNum > exceptionNum;
              else return reportNum < exceptionNum;
            } return false;
          default: return false;
        }
      });
    });
    if (allConditionsMet) return true; // Si todas las condiciones de un grupo se cumplen, la fila está exceptuada
  }
  return false;
}

function convertDataToXlsxBlob(dataArray, newFileName) {
  let tempSheet = null;
  try {
    // --- INICIO DE LA CORRECCIÓN ---
    // Se añade una pausa de 1500 milisegundos (1.5 segundos) para evitar
    // errores intermitentes de permisos al crear varios archivos seguidos.
    Utilities.sleep(1500);
    // --- FIN DE LA CORRECCIÓN ---

    if (!dataArray || dataArray.length === 0 || !Array.isArray(dataArray[0])) {
      Logger.log("Error en convertDataToXlsxBlob: El array de datos está vacío o mal formado.");
      return null;
    }
    
    const numColumns = dataArray[0].length;
    for (let i = 1; i < dataArray.length; i++) {
      while (dataArray[i].length < numColumns) {
        dataArray[i].push('');
      }
    }
    
    tempSheet = SpreadsheetApp.create(`Temp_Conversion_${new Date().getTime()}`);
    const sheet = tempSheet.getSheets()[0];
    sheet.getRange(1, 1, dataArray.length, dataArray[0].length).setValues(dataArray);
    SpreadsheetApp.flush();

    const url = `https://docs.google.com/spreadsheets/d/${tempSheet.getId()}/export?format=xlsx`;
    const params = { "method": "GET", "headers": { "Authorization": `Bearer ${ScriptApp.getOAuthToken()}` }, "muteHttpExceptions": true };
    const response = UrlFetchApp.fetch(url, params);
    
    if (response.getResponseCode() !== 200) {
      Logger.log(`Error al exportar la hoja temporal. Código de respuesta: ${response.getResponseCode()}`);
      return null;
    }

    const xlsxBlob = response.getBlob();
    xlsxBlob.setName(newFileName);
    return xlsxBlob;
  } catch (e) {
    Logger.log(`Error CRÍTICO en convertDataToXlsxBlob: ${e.message} | Stack: ${e.stack}`);
    return null;
  }
  finally { 
    if (tempSheet) {
      DriveApp.getFileById(tempSheet.getId()).setTrashed(true);
    }
  }
}
/**
 * NUEVA FUNCIÓN DE ESTILO ESTÁNDAR (CORPORATIVO)
 * Toma datos crudos, busca la tabla, limpia columnas, aplica estilo verde/blanco y exporta.
 * * @param {Array<Array<string>>} rawData - Datos crudos leídos del Excel (incluyendo filas de metadatos arriba).
 * @param {string} fileName - Nombre del archivo de salida.
 * @param {Array<string>} columnsToIgnore - Lista de encabezados a eliminar (ej: ["Average VM..."]).
 * @param {string} headerKeyword - Palabra clave para encontrar dónde empieza la tabla (ej: "Virtual Machine").
 * @returns {Blob} El archivo Excel formateado listo para Jira.
 */
function generateStyledReportBlob(rawData, fileName, columnsToIgnore = [], headerKeyword = "") {
  let tempSheet = null;
  let tempFileId = null;

  try {
    if (!rawData || rawData.length === 0) return null;

    // --- 1. DETECTAR EL ENCABEZADO Y RECORTAR ---
    // Muchos reportes tienen texto basura arriba ("Scope:...", "Date:..."). Buscamos la tabla real.
    let tableData = rawData;
    if (headerKeyword) {
      const headerIndex = rawData.findIndex(row => 
        row.join(" ").toLowerCase().includes(headerKeyword.toLowerCase())
      );
      if (headerIndex !== -1) {
        tableData = rawData.slice(headerIndex); // Nos quedamos solo desde el encabezado hacia abajo
      }
    }

    if (tableData.length === 0) return null;

    // --- 2. FILTRAR COLUMNAS (Vacías + Ignoradas) ---
    const headers = tableData[0];
    const indicesToRemove = [];
    const ignoreNormalized = columnsToIgnore.map(c => c.toLowerCase().trim());

    headers.forEach((h, index) => {
      const hStr = (h || "").toString();
      const hNorm = hStr.toLowerCase().trim();
      // Eliminar si está vacío o si está en la lista de ignorados
      if (hStr.trim() === "" || ignoreNormalized.some(ign => hNorm.includes(ign))) {
        indicesToRemove.push(index);
      }
    });
    // Ordenar descendente para borrar sin romper índices
    indicesToRemove.sort((a, b) => b - a);

    const cleanData = tableData.map(row => {
      const newRow = [...row];
      indicesToRemove.forEach(index => {
        if (index < newRow.length) newRow.splice(index, 1);
      });
      return newRow;
    });

    if (cleanData.length === 0) return null;

    // --- 3. CREAR EXCEL TEMPORAL ---
    tempSheet = SpreadsheetApp.create(`TEMP_REPORT_${new Date().getTime()}`);
    tempFileId = tempSheet.getId();
    const sheet = tempSheet.getSheets()[0];
    
    // Escribir datos limpios
    const range = sheet.getRange(1, 1, cleanData.length, cleanData[0].length);
    range.setValues(cleanData);
    
    // --- 4. APLICAR ESTILO CORPORATIVO ---
    
    // A. Bordes Negros a TODA la tabla
    range.setBorder(true, true, true, true, true, true, "black", SpreadsheetApp.BorderStyle.SOLID);
    
    // B. Encabezados (Fila 1): Fondo Verde (#34a853), Letra Blanca, Negrita
    const headerRange = sheet.getRange(1, 1, 1, cleanData[0].length);
    headerRange.setBackground("#34a853");
    headerRange.setFontColor("white");
    headerRange.setFontWeight("bold");
    headerRange.setHorizontalAlignment("center");
    headerRange.setVerticalAlignment("middle");
    
    // C. Primera Columna con datos (Fila 2 en adelante): Fondo Verde (#34a853), Letra Blanca, Negrita
    if (cleanData.length > 1) {
      const firstColRange = sheet.getRange(2, 1, cleanData.length - 1, 1);
      firstColRange.setBackground("#34a853");
      firstColRange.setFontColor("white");
      firstColRange.setFontWeight("bold");
    }
    
    // D. Ajustar anchos
    sheet.autoResizeColumns(1, cleanData[0].length);
    SpreadsheetApp.flush();

    // --- 5. EXPORTAR A BLOB ---
    const url = `https://docs.google.com/spreadsheets/d/${tempFileId}/export?format=xlsx`;
    const params = { "method": "GET", "headers": { "Authorization": `Bearer ${ScriptApp.getOAuthToken()}` }, "muteHttpExceptions": true };
    const response = UrlFetchApp.fetch(url, params);
    
    if (response.getResponseCode() === 200) {
      const blob = response.getBlob();
      blob.setName(fileName);
      return blob;
    } else {
      throw new Error("Error exportando XLSX.");
    }

  } catch (e) {
    Logger.log("Error en generateStyledReportBlob: " + e.message);
    return null;
  } finally {
    if (tempFileId) {
      try { Drive.Files.update({trashed: true}, tempFileId); } catch (e) {}
    }
  }
}

/**
 * Obtiene las llaves de soporte desde la columna N del Índice Maestro.
 * @returns {Array<string>} Lista de llaves de soporte en mayúsculas.
 */
function obtenerLlavesDeSoporte() {
  const sheet = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0]; 
  const data = sheet.getRange("N2:P" + sheet.getLastRow()).getValues();
  const llavesSoporte = [];
  
  data.forEach(row => {
    const keySoporte = row[0]; // Columna N
    if (keySoporte) {
      llavesSoporte.push(keySoporte.toString().toUpperCase().trim()); 
    }
  });
  
  return llavesSoporte; 
}

