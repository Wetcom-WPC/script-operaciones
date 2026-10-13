/**
 * Módulo de herramientas y utilidades secundarias
 * para no ensuciar el Main ni los servicios principales.
 */
const Tools = {
  
  /**
   * Elimina borradores (.json) en Drive que tengan más de 7 días de antigüedad.
   */
  limpiarBorradoresViejos: function() {
    if (!Config.ID_CARPETA_BORRADORES || Config.ID_CARPETA_BORRADORES.trim() === "") {
      Logger.log("No hay carpeta de borradores configurada en Config.js.");
      return;
    }
    
    try {
      const folder = DriveApp.getFolderById(Config.ID_CARPETA_BORRADORES);
      const limitDate = new Date();
      limitDate.setDate(limitDate.getDate() - 7); // Archivos más antiguos a 7 días
      
      const files = folder.getFiles();
      let eliminados = 0;
      
      while (files.hasNext()) {
        const file = files.next();
        if (file.getDateCreated() < limitDate) {
          file.setTrashed(true);
          eliminados++;
        }
      }
      
      Logger.log(`Limpieza completada. Se enviaron ${eliminados} borradores antiguos a la papelera.`);
    } catch(e) {
      Logger.log("Error al limpiar borradores viejos: " + e.message);
    }
  },

  /**
   * Elimina las filas de la hoja de Excepciones cuya fecha/hora de expiración haya pasado.
   */
  limpiarExcepcionesVencidas: function() {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheets = ss.getSheets();
      let eliminadasTotal = 0;
      
      const ahora = new Date();

      sheets.forEach(sheet => {
        const sheetName = sheet.getName();
        if (sheetName.startsWith("Excepciones ") && sheetName !== "Excepciones") {
          const lastRow = sheet.getLastRow();
          if (lastRow < 2) return; // Continuar con la siguiente hoja
          
          // Data desde fila 2, col 1 hasta col 8 (A hasta H)
          const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
          
          // Recorremos de abajo hacia arriba para que eliminar filas no modifique los índices restantes
          for (let i = data.length - 1; i >= 0; i--) {
            const row = data[i];
            const fechaVal = row[6]; // Índice corregido (Antes 7)
            const horaVal = row[7];  // Índice corregido (Antes 8)
            const validaHasta = Fechas.interpretarVencimiento(fechaVal, horaVal);

            // Si tiene fecha de expiración y ya pasó
            if (validaHasta && validaHasta < ahora) {
              sheet.deleteRow(i + 2);
              eliminadasTotal++;
            }
          }
        }
      });
      
      Logger.log(`Mantenimiento completado. Se eliminaron ${eliminadasTotal} excepciones caducadas en total.`);
    } catch(e) {
      Logger.log("Error al limpiar excepciones vencidas: " + e.message);
    }
  },

  /**
   * Verifica si la fecha proporcionada (por defecto hoy) es fin de semana o feriado en Argentina.
   *
   * Si la API de feriados no responde ni siquiera tras reintentar, se asume que el día NO
   * es hábil (se envía la guardia) y se avisa por Slack. Antes era al revés: una falla de
   * la API hacía que la guardia se diera por omitida en silencio, así que una caída de
   * `api.argentinadatos.com` un feriado real dejaba a los clientes sin nadie mirando. Una
   * guardia de más un día hábil es molesta; una guardia de menos un feriado real es el
   * problema que esta función existe para evitar.
   */
  esFinDeSemanaOFeriado: function(fecha = new Date()) {
    // 1. Validar Fin de Semana (Sábado = 6, Domingo = 0)
    const dia = fecha.getDay();
    if (dia === 0 || dia === 6) {
      Logger.log("Hoy es fin de semana.");
      return true;
    }

    // 2. Validar Feriados usando la API pública
    const año = fecha.getFullYear();
    const feriados = this._consultarFeriados(año);

    if (feriados === null) {
      const aviso = `No se pudo consultar la API de feriados para ${año} (se reintentó una vez). ` +
        `Se asume día NO hábil y se envía la guardia igual, para no arriesgarse a omitirla en un feriado real.`;
      Logger.log(aviso);
      SlackService.enviarLogTexto(`⚠️ ${aviso}`);
      return true;
    }

    // Formatear la fecha a YYYY-MM-DD para buscarla en el JSON
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const diaMes = String(fecha.getDate()).padStart(2, '0');
    const fechaBuscada = `${año}-${mes}-${diaMes}`;

    const esFeriado = feriados.some(feriado => feriado.fecha === fechaBuscada);
    if (esFeriado) {
      Logger.log(`Hoy (${fechaBuscada}) es Feriado en Argentina.`);
    }
    return esFeriado;
  },

  /**
   * Pide el listado de feriados del año a la API pública, con UN reintento (vía
   * `Http.conReintento`) ante una falla de red, un HTTP distinto de 200 o un JSON ilegible:
   * así un error momentáneo no se trata igual que una caída real del servicio. Devuelve
   * null si los dos intentos fallan.
   */
  _consultarFeriados: function(año) {
    const url = `https://api.argentinadatos.com/v1/feriados/${año}`;

    try {
      const feriados = Http.conReintento(() => {
        const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        if (response.getResponseCode() !== 200) {
          throw new Error(`HTTP ${response.getResponseCode()}`);
        }
        return JSON.parse(response.getContentText());
      });
      Logger.log(`API de feriados consultada para el año ${año}.`);
      return feriados;
    } catch (e) {
      Logger.log(`Error consultando feriados para el año ${año} (tras reintentar): ${e.message}`);
      return null;
    }
  }
};
