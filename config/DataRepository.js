/**
 * Repositorio de datos para interactuar con las hojas de cálculo de Google Sheets
 */
const DataRepository = {
  
  obtenerMapeos: function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    const sheetClientes = ss.getSheetByName(Config.SHEET_CLIENTES);
    const sheetTiposAlarmas = ss.getSheetByName(Config.SHEET_TIPOS_ALARMAS);
    const sheetCorreosClientes = ss.getSheetByName(Config.SHEET_CORREOS_CLIENTES);
    const sheetCorreosPods = ss.getSheetByName(Config.SHEET_CORREOS_PODS);
    const sheetExcepciones = ss.getSheetByName(Config.SHEET_EXCEPCIONES);

    if (!sheetClientes) throw new Error(`La hoja "${Config.SHEET_CLIENTES}" no está disponible.`);
    if (!sheetTiposAlarmas) throw new Error(`La hoja "${Config.SHEET_TIPOS_ALARMAS}" no está disponible.`);
    
    // Si la hoja no existe, no rompemos el script (puede que estén en plena migración), solo pasamos un array vacío
    const correosData = sheetCorreosClientes ? sheetCorreosClientes.getDataRange().getValues() : [];
    const correosPodsData = sheetCorreosPods ? sheetCorreosPods.getDataRange().getValues() : [];
    
    // Leer todas las hojas de Excepciones separadas por POD
    let todasLasExcepciones = [];
    const sheets = ss.getSheets();
    sheets.forEach(sheet => {
      const sheetName = sheet.getName();
      // Ignorar la vieja "Excepciones" y buscar "Excepciones [POD]"
      if (sheetName.startsWith("Excepciones ") && sheetName !== "Excepciones") {
        const podName = sheetName.replace("Excepciones", "").trim();
        const data = sheet.getDataRange().getValues();
        const parseadas = this._parseExcepciones(data, podName);
        todasLasExcepciones = todasLasExcepciones.concat(parseadas);
      }
    });

    const datosClientes = sheetClientes.getDataRange().getValues();

    return {
      mapaClientes: this._createMap(datosClientes),
      mapaPodsClientes: this._crearMapaPods(datosClientes),
      mapaAlarmas: this._createMap(sheetTiposAlarmas.getDataRange().getValues()),
      mapaCorreos: this._parseCorreosEntorno(correosData),
      mapaCorreosPods: this._parseCorreosEntorno(correosPodsData),
      reglasExcepcion: todasLasExcepciones
    };
  },

  _createMap: function(dataArray) {
    // Omite la primera fila (encabezados) y mapea Col 1 -> Col 2.
    // Object.create(null) en vez de {}: la clave sale de una planilla editable por
    // cualquiera, y un valor como "constructor" o "toString" no debe resolver contra
    // el prototipo de Object en los lookups que hace quien consume este mapa.
    return dataArray.slice(1).reduce((map, row) => {
      if (row[0] && row[1]) {
        map[row[0].toString().trim()] = row[1].toString().trim();
      }
      return map;
    }, Object.create(null));
  },

  /**
   * Mapea el código de proyecto de Jira (Columna A) al POD que lo atiende (Columna C).
   *
   * La hoja Clientes ya declaraba ese dato —lo usa `actualizarDropdownsClientes` para armar
   * los dropdowns— pero se descartaba al armar los mapeos. Se usa como respaldo cuando el
   * ticket no trae el POD en el custom field de Jira. Ver AlarmProcessor.procesarAlarmas.
   */
  _crearMapaPods: function(dataArray) {
    return dataArray.slice(1).reduce((map, row) => {
      if (row[0] && row[2]) {
        map[row[0].toString().trim()] = row[2].toString().trim();
      }
      return map;
    }, Object.create(null));
  },

  _parseCorreosEntorno: function(dataArray) {
    const isTesting = !Config.esProduccion();
    return dataArray.slice(1).reduce((map, row) => {
      const keyName = row[0] ? row[0].toString().trim() : null;
      if (keyName) {
        // En TESTING usa columna C (índice 2), en PROD usa columna B (índice 1)
        const emailValue = isTesting ? (row[2] || row[1]) : row[1];
        if (emailValue) {
          map[keyName] = emailValue.toString().trim();
        }
      }
      return map;
    }, Object.create(null));
  },

  _parseExcepciones: function(dataArray, podName) {
    if (!dataArray || dataArray.length < 2) return [];
    
    return dataArray.slice(1).map(row => {
      const id = row[0];
      if (!id) return null; // Saltar filas vacías
      
      const fechaVal = row[6]; // Índice corregido (Antes 7)
      const horaVal = row[7];  // Índice corregido (Antes 8)
      const validaHasta = Fechas.interpretarVencimiento(fechaVal, horaVal);

      return {
        id: id.toString().trim(),
        pod: podName, // Obtenido del nombre de la pestaña
        cliente: row[1] && row[1] !== "" ? row[1].toString().trim() : 'TODOS',
        tipoAlarma: row[2] && row[2] !== "" ? row[2].toString().trim() : 'TODAS',
        campo: row[3] && row[3] !== "" ? row[3].toString().trim() : 'CUALQUIERA',
        condicion: row[4] && row[4] !== "" ? row[4].toString().trim() : 'Contiene',
        valor: row[5] ? row[5].toString().trim() : '',
        validaHasta: validaHasta
      };
    }).filter(r => r !== null);
  }
};
