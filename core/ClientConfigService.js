/**
 * REEMPLAZA ESTA FUNCIÓN en FuncionesCompartidas.gs
 * * Busca la configuración de un cliente por su NOMBRE (Columna B) en el Índice Maestro.
 * CORREGIDA para ser inmune a espacios en blanco (con .trim()).
 */const DRP_CLIENT_NAME_MAP = {
  "BERSA": "Operaciones Banco de Entre Rios",
  "SANTA FE": "Operaciones Banco Santa Fe",
  "SAN JUAN": "Operaciones Banco de San Juan",
  "SANTA CRUZ": "Operaciones Banco de Santa Cruz"
};

/**
 * @namespace MasterSheetSingleton
 * Singleton en memoria para la apertura y lectura del Índice Maestro y Pestañas de Excepciones/Informativas.
 * Evita la apertura repetida de SpreadsheetApp.openById y las llamadas de red getValues() en cada iteración del bucle.
 */
const MasterSheetSingleton = (function() {
  let _masterDataCache = null;
  let _informativasDataCache = null;
  const _exceptionDataCache = {}; // { 'fileId_operationName': { exceptionSheet, exceptionData } }
  
  return {
    /**
     * Devuelve la matriz 2D completa de datos de la primera hoja (Sheet1 / Índice Maestro).
     * Abre SpreadsheetApp.openById una única vez por ejecución del script.
     * @returns {Array<Array<any>>}
     */
    getMasterData: function() {
      if (!_masterDataCache) {
        const idHojaCalculo = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID") || (typeof MASTER_INDEX_SHEET_ID !== 'undefined' ? MASTER_INDEX_SHEET_ID : null);
        if (!idHojaCalculo) throw new Error("FATAL: Property MASTER_INDEX_SHEET_ID no configurada.");
        const masterSheet = SpreadsheetApp.openById(idHojaCalculo).getSheets()[0];
        _masterDataCache = masterSheet.getDataRange().getValues();
        Logger.log(`[MasterSheetSingleton] Índice Maestro cargado en memoria (${_masterDataCache.length} filas).`);
      }
      return _masterDataCache;
    },

    /**
     * Devuelve la matriz 2D de la pestaña 'Informativas' del Índice Maestro.
     * Abre y lee una única vez por ejecución.
     * @returns {Array<Array<any>>|null}
     */
    getInformativasData: function() {
      if (_informativasDataCache === null) {
        const idHojaCalculo = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID") || (typeof MASTER_INDEX_SHEET_ID !== 'undefined' ? MASTER_INDEX_SHEET_ID : null);
        if (!idHojaCalculo) throw new Error("FATAL: Property MASTER_INDEX_SHEET_ID no configurada.");
        const ss = SpreadsheetApp.openById(idHojaCalculo);
        const sheet = ss.getSheetByName("Informativas");
        if (!sheet) {
          Logger.log(`[MasterSheetSingleton] ⚠️ La hoja 'Informativas' no existe.`);
          _informativasDataCache = [];
        } else {
          _informativasDataCache = sheet.getDataRange().getValues();
          Logger.log(`[MasterSheetSingleton] Hoja 'Informativas' cargada en memoria (${_informativasDataCache.length} filas).`);
        }
      }
      return _informativasDataCache;
    },

    /**
     * Devuelve el objeto con la hoja y matriz de datos de excepciones para un cliente y operación.
     * @param {string} exceptionFileId ID del archivo Spreadsheet de excepciones del cliente.
     * @param {string} operationName Nombre de la operación/pestaña (ej. "VMs operativas").
     * @returns {{ exceptionSheet: GoogleAppsScript.Spreadsheet.Sheet|null, exceptionData: Array<Array<any>> }}
     */
    getExceptionData: function(exceptionFileId, operationName) {
      const cacheKey = `${exceptionFileId}_${operationName}`;
      if (!_exceptionDataCache[cacheKey]) {
        try {
          const exceptionSheet = SpreadsheetApp.openById(exceptionFileId).getSheetByName(operationName);
          if (!exceptionSheet) {
            _exceptionDataCache[cacheKey] = { exceptionSheet: null, exceptionData: [] };
          } else {
            const data = exceptionSheet.getDataRange().getValues();
            _exceptionDataCache[cacheKey] = { exceptionSheet, exceptionData: data };
            Logger.log(`[MasterSheetSingleton] Excepciones cargadas para "${operationName}" (${data.length} filas).`);
          }
        } catch (e) {
          Logger.log(`[MasterSheetSingleton] Error abriendo excepciones ${cacheKey}: ${e.message}`);
          _exceptionDataCache[cacheKey] = { exceptionSheet: null, exceptionData: [] };
        }
      }
      return _exceptionDataCache[cacheKey];
    },

    /**
     * Invalida los cachés en memoria. Útil si se modificó un valor en la hoja durante la misma ejecución
     * y se requiere releer de Drive.
     */
    invalidate: function() {
      _masterDataCache = null;
      _informativasDataCache = null;
      for (const k in _exceptionDataCache) {
        delete _exceptionDataCache[k];
      }
      Logger.log(`[MasterSheetSingleton] Caché de hojas invalidado.`);
    }
  };
})();

/**
 * Procesa y valida las reglas de excepciones.
 * @param {Array<Array>} rawExceptionData - Datos crudos de la hoja de excepciones
 * @param {GoogleAppsScript.Spreadsheet.Sheet} exceptionSheet - La hoja de excepciones, para actualizar si algo vence
 * @returns {Object} Excepciones agrupadas
 */
function procesarReglasExcepciones(rawExceptionData, exceptionSheet) {
  const exceptionData = rawExceptionData.slice(1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  exceptionData.forEach((row, index) => {
    const isActive = (row[5] != null ? String(row[5]) : "").toUpperCase();
    if (isActive !== 'SI') return;
    let isRuleValid = true;
    let reasonForInvalidity = "";
    const expiryDateValue = row[4];
    if (expiryDateValue) {
      let expiryDate;
      if (expiryDateValue instanceof Date) { expiryDate = expiryDateValue; }
      else if (typeof expiryDateValue === 'string' && expiryDateValue.includes('/')) {
        const parts = expiryDateValue.split('/');
        if (parts.length === 3) expiryDate = new Date(parseInt(parts[2], 10), parseInt(parts[0], 10) - 1, parseInt(parts[1], 10));
      }
      if (expiryDate && !isNaN(expiryDate.getTime())) {
        expiryDate.setHours(0, 0, 0, 0);
        if (expiryDate < today) {
          isRuleValid = false;
          reasonForInvalidity = "La fecha ha vencido.";
        }
      }
    }
    if (!isRuleValid && exceptionSheet) {
      Logger.log(`Desactivando excepción "${row[0]}". Motivo: ${reasonForInvalidity}`);
      exceptionSheet.getRange(index + 2, 6).setValue("NO");
      row[5] = "NO";
    }
  });

  const activeExceptions = exceptionData.filter(row => (row[5] != null ? String(row[5]) : "").toUpperCase() === 'SI');
  const groupedExceptions = {};
  activeExceptions.forEach(row => {
    const exceptionId = row[0];
    if (!groupedExceptions[exceptionId]) groupedExceptions[exceptionId] = [];
    groupedExceptions[exceptionId].push({
      column: row[1], matchType: row[2], 
      values: (row[3] != null ? String(row[3]) : "").split(',').map(v => v.trim().toLowerCase())
    });
  });
  return groupedExceptions;
}

/**
 * Extrae y mapea el nombre del cliente DRP desde el asunto del correo.
 * @param {string} emailSubject Asunto del correo electrónico.
 * @param {string} baseSubject Asunto base de la operación (ej. "Affinity Rules" o "Alertas de vSphere").
 * @returns {string|null} Nombre mapeado del cliente en el Índice Maestro, o el extraído si no está en el mapa, o null si no es DRP.
 */
function extractDRPClientName(emailSubject, baseSubject = "") {
  if (!emailSubject || typeof emailSubject !== 'string' || !emailSubject.toLowerCase().includes('drp')) return null;
  const safeBase = baseSubject ? String(baseSubject).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : "";
  const regex = new RegExp(`${safeBase}\\s(.*?)\\s\\(`, 'i');
  const match = emailSubject.match(regex) || emailSubject.match(/vSphere\s(.*?)\s\(/i);
  if (match && match[1]) {
    const rawName = match[1].trim();
    const mapped = DRP_CLIENT_NAME_MAP[rawName.toUpperCase()];
    return mapped || rawName;
  }
  return null;
}

function getClientConfigByName(clientName, operationName) {
  try {
    if (!clientName) {
      Logger.log(`[ClientConfigService] clientName es nulo o indefinido en getClientConfigByName para la operación "${operationName || 'sin especificar'}".`);
      return null;
    }
    const safeClientName = String(clientName).trim().toLowerCase();
    const masterData = MasterSheetSingleton.getMasterData();
    
    // Añadimos String(row[1] || "") para ser completamente inmunes a valores nulos o no-strings
    const clientRow = masterData.find(row => row && row[1] != null && String(row[1]).trim().toLowerCase() === safeClientName);

    if (!clientRow) {
      Logger.log(`[DRP] No se encontró una fila para el NOMBRE de cliente "${clientName}" en el Índice Maestro.`);
      return null;
    }

    const clientNameFound = clientRow[1] != null ? String(clientRow[1]) : "",
          exceptionFileId = clientRow[2],
          jiraProjectKey = clientRow[3],
          serviceDeskId = clientRow[4],
          requestTypeName = clientRow[5],
          tecnologiaValue = clientRow[6],
          origenValue = clientRow[7] || null;

    if (!clientNameFound || !jiraProjectKey || !serviceDeskId || !requestTypeName || !tecnologiaValue) {
      Logger.log(`ERROR: La configuración para "${clientNameFound}" (encontrado por nombre) está incompleta.`);
      return null;
    }

    const requestTypeId = getRequestTypeIdForServiceDesk(serviceDeskId, requestTypeName);
    if (!requestTypeId) return null;

    const { exceptionSheet, exceptionData: rawExceptionData } = MasterSheetSingleton.getExceptionData(exceptionFileId, operationName);
    
    if (!exceptionSheet) {
      Logger.log(`ADVERTENCIA: No se encontró la PESTAÑA de excepciones "${operationName}" en el archivo del cliente ${clientNameFound}. Se continuará sin excepciones.`);
      return { exceptions: {}, clientName: clientNameFound.trim(), jiraProjectKey, serviceDeskId, requestTypeId, tecnologia: tecnologiaValue, origen: origenValue };
    }

    const groupedExceptions = procesarReglasExcepciones(rawExceptionData, exceptionSheet);

    return {
      exceptions: groupedExceptions, clientName: clientNameFound.trim(), jiraProjectKey: jiraProjectKey,
      serviceDeskId: serviceDeskId, requestTypeId: requestTypeId,
      tecnologia: tecnologiaValue, origen: origenValue
    };
  } catch (e) {
    Logger.log(`ERROR CRÍTICO DENTRO DE getClientConfigByName: ${e.message}`);
    Logger.log(`Stack: ${e.stack}`);
    return null; 
  }
}

// --- FUNCIÓN PRINCIPAL DE CONFIGURACIÓN Y EXCEPCIONES ---

/**
 * Extrae la configuración del cliente de forma robusta, manejando diferentes
 * formatos de remitente de correo electrónico.
 */
function getClientConfig(senderEmail, operationName, soporte = false) {
  try {
    if (!senderEmail || typeof senderEmail !== 'string') {
      Logger.log(`[ClientConfigService] senderEmail es inválido o nulo en getClientConfig para operación "${operationName}": "${senderEmail}"`);
      return null;
    }
    // --- INICIO DE LA CORRECCIÓN ---
    let cleanEmail = senderEmail;
    const emailMatch = senderEmail.match(/<([^>]+)>/);
    if (emailMatch && emailMatch[1]) {
      cleanEmail = emailMatch[1];
    }
    
    const domainMatch = cleanEmail.match(/@(.+)/);
    // --- FIN DE LA CORRECCIÓN ---

    if (!domainMatch || !domainMatch[1]) {
      Logger.log(`No se pudo extraer un dominio válido del remitente original: "${senderEmail}"`);
      return null;
    }
    const domain = "@" + domainMatch[1].trim();

    const masterData = MasterSheetSingleton.getMasterData();
    const clientRow = masterData.find(row => {
      if (!row || row[0] == null) return false;
      const remitentes = String(row[0]).split(',').map(r => r.trim().toLowerCase());
      return remitentes.includes(domain.toLowerCase()) || remitentes.includes(cleanEmail.toLowerCase());
    });

    if (!clientRow) {
      Logger.log(`No se encontró una fila para el dominio "${domain}" o email "${cleanEmail}" en el Índice Maestro.`);
      return null;
    }

    const clientName = clientRow[1] != null ? String(clientRow[1]) : "",
          exceptionFileId = clientRow[2],
          jiraProjectKey = clientRow[3],
          serviceDeskId = clientRow[4],
          requestTypeName = clientRow[5],
          tecnologiaValue = clientRow[6],
          origenValue = clientRow[7] || null,
          jiraProjectKeySop = clientRow[13],
          serviceDeskIdSop = clientRow[14],
          requestTypeNameSop = clientRow[16],
          clientNameSop = clientRow[15] != null ? String(clientRow[15]) : "";

    if (!clientName || !jiraProjectKey || !serviceDeskId || !requestTypeName || !tecnologiaValue) {
      Logger.log(`ERROR: La configuración para "${clientName}" (dominio ${domain}) está incompleta en el Índice Maestro.`);
      return null;
    }

    const requestTypeId = getRequestTypeIdForServiceDesk(serviceDeskId, requestTypeName);
    const requestTypeIdSop = getRequestTypeIdForServiceDesk(serviceDeskIdSop, requestTypeNameSop);
    if (!requestTypeId) return null;
    
    const { exceptionSheet, exceptionData: rawExceptionData } = MasterSheetSingleton.getExceptionData(exceptionFileId, operationName);
    
    if (!exceptionSheet && !soporte) {
      Logger.log(`ADVERTENCIA: No se encontró la PESTAÑA de excepciones "${operationName}" en el archivo del cliente ${clientName}. Se continuará sin excepciones.`);
      return { exceptions: {}, clientName, jiraProjectKey, serviceDeskId, requestTypeId, tecnologia: tecnologiaValue, origen: origenValue };
    } else if (!exceptionSheet && soporte) {
      Logger.log(`ADVERTENCIA: No se encontró la PESTAÑA de excepciones "${operationName}" en el archivo del cliente ${clientName}. Se continuará sin excepciones.`);
      return { exceptions: {}, clientNameSop, jiraProjectKeySop, serviceDeskIdSop, requestTypeIdSop, tecnologia: "Veeam Backup & Replication", origen: origenValue };
    }

    const groupedExceptions = procesarReglasExcepciones(rawExceptionData, exceptionSheet);
    if (soporte){
      return {
      exceptions: groupedExceptions, clientNameSop, jiraProjectKeySop, serviceDeskIdSop, 
      requestTypeIdSop, tecnologia: "Veeam Backup & Replication", origen: origenValue
      };
    }
    return {
      exceptions: groupedExceptions, clientName, jiraProjectKey, serviceDeskId, 
      requestTypeId, tecnologia: tecnologiaValue, origen: origenValue
    };
  } catch (e) {
    Logger.log(`ERROR CRÍTICO DENTRO DE getClientConfig: ${e.message}`);
    Logger.log(`Stack: ${e.stack}`);
    return null; 
  }
}


/**
 * Busca en la hoja 'Informativas' si una tarea debe cerrarse automáticamente.
 * @param {string} clientName Nombre del cliente.
 * @param {string} operationName Nombre de la tarea/operación.
 * @returns {string|null} El accountId del asignado si es informativa, null si no.
 */
function chequearSiEsInformativa(clientName, operationName) {
  try {
    if (!clientName || !operationName) return null;
    const safeClient = String(clientName).trim().toLowerCase();
    const safeOp = String(operationName).trim().toLowerCase();
    const data = MasterSheetSingleton.getInformativasData();
    if (!data || data.length === 0) return null;
    
    // Asumimos columnas: A: Cliente, B: Tarea, C: Nombre, D: Informante ID (accountId)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row && row[0] != null && row[1] != null &&
          String(row[0]).trim().toLowerCase() === safeClient &&
          String(row[1]).trim().toLowerCase() === safeOp) {
        return row[3]; // Retorna el accountId de la columna D
      }
    }
  } catch (e) {
    Logger.log("❌ Error en chequearSiEsInformativa: " + e.message);
  }
  return null;
}

