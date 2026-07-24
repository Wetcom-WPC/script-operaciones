// ==========================================
// CÓDIGO DEL SCRIPT (Optimizado para ejecutarse cada hora sin fugas de memoria en ScriptProperties)
// ==========================================

function revisarHojasPorTiempo() {
  const propiedades = PropertiesService.getScriptProperties();
  const linkDeLaSheet = propiedades.getProperty("DEBUG_SHEET_URL");
  
  if (!linkDeLaSheet || linkDeLaSheet.trim() === "") {
    Logger.log("[BajaAltaComponentes] Error: DEBUG_SHEET_URL no está configurada en ScriptProperties.");
    return;
  }

  const webhookGeneral = propiedades.getProperty("SLACK_WEBHOOK_GENERAL") || "";
  const SLACK_WEBHOOKS = {
    "POD1": webhookGeneral,
    "POD2": webhookGeneral,
    "POD3": webhookGeneral,
    "POD4": webhookGeneral,
    "POD5": webhookGeneral
  };

  let ss;
  try {
    ss = SpreadsheetApp.openByUrl(linkDeLaSheet);
  } catch (err) {
    Logger.log("No se pudo abrir el Excel. Verifica los permisos o la URL. Error: " + err.toString());
    return;
  }
  
  const nombresHojas = Object.keys(SLACK_WEBHOOKS);
  
  nombresHojas.forEach(nombreHoja => {
    const sheet = ss.getSheetByName(nombreHoja);
    if (!sheet) return;
    
    const ultimaFila = sheet.getLastRow();
    if (ultimaFila < 2) return;
    
    const datos = sheet.getRange(2, 1, ultimaFila - 1, 3).getValues();
    
    // En lugar de miles de properties separadas (POD1_fila_2, POD1_fila_3...),
    // guardamos un único objeto JSON por hoja en ScriptProperties para evitar fugas y desbordes de cuota.
    const propiedadKeyHoja = `BajaAlta_State_${nombreHoja}`;
    const rawState = propiedades.getProperty(propiedadKeyHoja);
    let estadoHoja = {};
    try {
      if (rawState) estadoHoja = JSON.parse(rawState);
    } catch (e) {
      estadoHoja = {};
    }
    
    let huboCambios = false;

    datos.forEach((fila, indice) => {
      const numeroFila_real = indice + 2;
      const componente = fila[0].toString().trim();
      const tecnologia = fila[1].toString().trim();
      const estado = fila[2].toString().trim();
      
      const valorAnterior = estadoHoja[numeroFila_real] || "";
      const valorActual = `${componente}|${tecnologia}|${estado}`;
      
      if (valorAnterior !== valorActual) {
        // Evitamos enviar alertas si la fila se inicializa por primera vez vacía
        if (valorAnterior === "" && componente === "" && tecnologia === "" && estado === "") return;
        
        huboCambios = true;
        
        if (componente === "" && tecnologia === "" && estado === "") {
          // Si la fila se vació por completo, la borramos del estado para liberar memoria
          delete estadoHoja[numeroFila_real];
        } else {
          estadoHoja[numeroFila_real] = valorActual;
        }
        
        let mensaje = "";
        if (componente === "" && tecnologia === "" && estado === "") {
          mensaje = `⚠️ *[${nombreHoja}]* Se borró el contenido de la fila ${numeroFila_real} (Componente removido).\n🔗 Ver en Drive: ${linkDeLaSheet}`;
        } else if (estado.toLowerCase() === "baja") {
          mensaje = `🛑 *[${nombreHoja}]* dio de baja un componente en *${tecnologia || "[Sin tecnología]"}* (Componente: *${componente || "[Sin nombre]"}*).\n🔗 Ver en Drive: ${linkDeLaSheet}`;
        } else {
          mensaje = `📝 *[${nombreHoja}]* Modificación detectada en la fila ${numeroFila_real}:\n• *Componente:* ${componente || "[Vacío]"}\n• *Tecnología:* ${tecnologia || "[Vacío]"}\n• *Estado:* ${estado || "[Vacío]"}\n🔗 Ver en Drive: ${linkDeLaSheet}`;
        }
        
        if (mensaje !== "") {
          enviarASlack(SLACK_WEBHOOKS[nombreHoja], mensaje);
        }
      }
    });

    if (huboCambios) {
      propiedades.setProperty(propiedadKeyHoja, JSON.stringify(estadoHoja));
    }
  });
}

function enviarASlack(webhookUrl, mensaje) {
  if (!webhookUrl || webhookUrl.trim() === "") return;
  const payload = { "text": mensaje };
  const opciones = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload)
  };
  try {
    fetchWithRetries(webhookUrl, opciones);
  } catch (error) {
    Logger.log("Error al enviar a Slack: " + error.toString());
  }
}

