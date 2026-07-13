// ==========================================
// CONFIGURACIÓN: Pon los datos de tu entorno
// ==========================================

// Pega aquí el link completo de tu Google Sheet en Drive
const LINK_DE_LA_SHEET = PropertiesService.getScriptProperties().getProperty("DEBUG_SHEET_URL");

// CONFIGURACIÓN: Tus Webhooks de Slack
const SLACK_WEBHOOKS = {
  "POD1": PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL"),
  "POD2": PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL"),
  "POD3": PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL"),
  "POD4": PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL"),
  "POD5": PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL")
};

// ==========================================
// CÓDIGO DEL SCRIPT (Optimizado para ejecutarse cada hora)
// ==========================================

function revisarHojasPorTiempo() {
  const propiedades = PropertiesService.getScriptProperties();
  let ss;
  
  try {
    // Abrimos el Excel externamente usando su URL fija
    ss = SpreadsheetApp.openByUrl(LINK_DE_LA_SHEET);
  } catch (err) {
    Logger.log("No se pudo abrir el Excel. Verifica los permisos o la URL. Error: " + err.toString());
    return;
  }
  
  const nombresHojas = Object.keys(SLACK_WEBHOOKS);
  
  nombresHojas.forEach(nombreHoja => {
    const sheet = ss.getSheetByName(nombreHoja);
    if (!sheet) return; // Si la pestaña no existe, pasa a la siguiente
    
    const ultimaFila = sheet.getLastRow();
    if (ultimaFila < 2) return; // Si solo está el encabezado, no hace nada
    
    // Leemos todos los datos de las columnas A, B y C de esa pestaña
    const datos = sheet.getRange(2, 1, ultimaFila - 1, 3).getValues();
    
    datos.forEach((fila, indice) => {
      const numeroFila_real = indice + 2;
      const componente = fila[0].toString().trim();
      const tecnologia = fila[1].toString().trim();
      const estado = fila[2].toString().trim();
      
      // Creamos una "clave" única para esta fila para recordar qué contenido tenía antes
      const idPropiedad = `${nombreHoja}_fila_${numeroFila_real}`;
      const valorAnterior = propiedades.getProperty(idPropiedad) || "";
      const valorActual = `${componente}|${tecnologia}|${estado}`;
      
      // Si el contenido actual de la fila cambió respecto a lo que recordábamos hace 1 hora...
      if (valorAnterior !== valorActual) {
        
        // Guardamos el nuevo estado en la memoria interna del script para la próxima hora
        propiedades.setProperty(idPropiedad, valorActual);
        
        // Evitamos enviar alertas masivas si la fila se inicializa por primera vez vacía
        if (valorAnterior === "" && componente === "" && tecnologia === "" && estado === "") return;
        
        let mensaje = "";
        
        // CASO A: Se vació la fila por completo
        if (componente === "" && tecnologia === "" && estado === "") {
          mensaje = `⚠️ *[${nombreHoja}]* Se borró el contenido de la fila ${numeroFila_real} (Componente removido).\n🔗 Ver en Drive: ${LINK_DE_LA_SHEET}`;
        } 
        // CASO B: Cambió a estado "baja"
        else if (estado.toLowerCase() === "baja") {
          mensaje = `🛑 *[${nombreHoja}]* dio de baja un componente en *${tecnologia || "[Sin tecnología]"}* (Componente: *${componente || "[Sin nombre]"}*).\n🔗 Ver en Drive: ${LINK_DE_LA_SHEET}`;
        } 
        // CASO C: Cualquier otra escritura nueva o actualización
        else {
          mensaje = `📝 *[${nombreHoja}]* Modificación detectada en la fila ${numeroFila_real}:\n• *Componente:* ${componente || "[Vacío]"}\n• *Tecnología:* ${tecnologia || "[Vacío]"}\n• *Estado:* ${estado || "[Vacío]"}\n🔗 Ver en Drive: ${LINK_DE_LA_SHEET}`;
        }
        
        // Enviar notificación a Slack
        if (mensaje !== "") {
          enviarASlack(SLACK_WEBHOOKS[nombreHoja], mensaje);
        }
      }
    });
  });
}

function enviarASlack(webhookUrl, mensaje) {
  const payload = { "text": mensaje };
  const opciones = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  try {
    UrlFetchApp.fetch(webhookUrl, opciones);
  } catch (error) {
    Logger.log("Error al enviar a Slack: " + error.toString());
  }
}

