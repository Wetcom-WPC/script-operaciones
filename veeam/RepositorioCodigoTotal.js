/**
 * Consolida el código de la carpeta de automatizaciones en un Google Doc
 * y envía un reporte de ejecución al canal de Slack de Logs.
 */
function consolidarCodigoParaGemini() {
  const SLACK_WEBHOOK_LOGS = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_LOGS");
  const docId = PropertiesService.getScriptProperties().getProperty("DOC_MEMORIA_INTERNA_ID"); 
  const nombreCarpeta = '🚗Automatizaciones'; 
  const hoy = new Date();
  
  // Objeto para trackear estadísticas del log
  let stats = { archivos: 0, subarchivos: 0, errores: [] };

  const diaSemana = hoy.getDay(); // 0 es Domingo, 6 es Sábado
  if (diaSemana === 0 || diaSemana === 6) {
    console.log("Hoy es fin de semana. Saltando actualización.");
    return; 
  }
  
  try {
    const doc = DocumentApp.openById(docId);
    const body = doc.getBody();
    body.clear(); 
    
    body.appendParagraph("📚 REPOSITORIO DE CÓDIGO - PROYECTO OPERACIONES")
        .setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph("Actualización: " + hoy.toLocaleString());

    const carpetas = DriveApp.getFoldersByName(nombreCarpeta);
    
    if (carpetas.hasNext()) {
      const carpeta = carpetas.next();
      procesarCarpeta(carpeta, body, stats); // Pasamos stats por referencia
      
      const mensajeExito = `✅ *Se actualizo el repositorio de scripts de operaciones correctamente*\nSe han procesado *${stats.archivos}* proyectos de script y *${stats.subarchivos}* archivos .gs.\nDocumento: <https://docs.google.com/document/d/${docId}/edit|Ver Repositorio>`;
      enviarLogSlack(SLACK_WEBHOOK_LOGS, mensajeExito);
      console.log("¡Hecho! Todo el código consolidado con éxito.");
    } else {
      throw new Error("No se encontró la carpeta '" + nombreCarpeta + "'");
    }
  } catch (e) {
    const mensajeError = `❌ *Error en Consolidación de Código*\nDetalle: ${e.message}`;
    enviarLogSlack(SLACK_WEBHOOK_LOGS, mensajeError);
    console.error(mensajeError);
  }
}

function procesarCarpeta(carpeta, body, stats) {
  const archivos = carpeta.getFilesByType(MimeType.GOOGLE_APPS_SCRIPT);
  
  while (archivos.hasNext()) {
    const archivo = archivos.next();
    stats.archivos++;
    const nombre = archivo.getName();
    
    try {
      const url = "https://script.google.com/feeds/download/export?id=" + archivo.getId() + "&format=json";
      const opciones = {
        headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      };
      
      const respuesta = UrlFetchApp.fetch(url, opciones);
      if (respuesta.getResponseCode() !== 200) throw new Error("Error de permisos/exportación");
      
      const proyectoJson = JSON.parse(respuesta.getContentText());
      
      body.appendParagraph("📂 ARCHIVO: " + nombre)
          .setHeading(DocumentApp.ParagraphHeading.HEADING2);
      
      proyectoJson.files.forEach(file => {
        stats.subarchivos++;
        body.appendParagraph("📄 Sub-archivo: " + file.name + ".gs")
            .setHeading(DocumentApp.ParagraphHeading.HEADING3);
        
        let textoCodigo = body.appendParagraph(file.source);
        textoCodigo.setFontFamily("Courier New");
        textoCodigo.setFontSize(9);
        
        body.appendPageBreak();
      });
    } catch (err) {
      console.warn("No se pudo procesar: " + nombre);
    }
  }

  const subcarpetas = carpeta.getFolders();
  while (subcarpetas.hasNext()) {
    procesarCarpeta(subcarpetas.next(), body, stats);
  }
}

/**
 * Función auxiliar para enviar notificaciones a Slack
 */
function enviarLogSlack(webhookUrl, texto) {
  const payload = {
    "text": texto,
    "username": "Bot de Repositorio Operaciones",
    "icon_emoji": ":robot_face:"
  };
  
  const opciones = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload)
  };
  
  UrlFetchApp.fetch(webhookUrl, opciones);
}

