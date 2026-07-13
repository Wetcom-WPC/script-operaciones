const RECOLECCION_SCHEDULED_TASK_NAME_TO_CLOSE = "Automatizacion de recoleccion de jobs";

function enviarMailRecoleccionDiarios() {
  // ---> NUEVO: EL PATOVICA DE FERIADOS <---
  if (esFeriadoHoy()) {
    Logger.log("EJECUCIÓN OMITIDA: Hoy es feriado en el calendario de Alarmas Wetcom.");
    borrarActivadorTemporal(); // Super importante para cortar la cadena de triggers
    return;
  }
  
  // === CONFIGURACIÓN ===
  const destinatario = "mara.cannella@comafi.com.ar,ulises.nunez@comafi.com.ar,Gustavo.Rodriguez@comafi.com.ar,emiliano.chiarini@comafi.com.ar";
  const ccDestinatario = "pod2@wetcom.com,wpc@wetcom.com,wpc@wetcom.com";
  // ID de la carpeta raíz donde están las carpetas YYYYMMDD
  const ROOT_FOLDER_ID = PropertiesService.getScriptProperties().getProperty("DRIVE_RVTOOLS_ZOMB_FOLDER_ID");

  // === FECHA ===
  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  const mm = String(hoy.getMonth() + 1).padStart(2, "0");
  const dd = String(hoy.getDate()).padStart(2, "0");

  const nombreCarpeta = `${yyyy}${mm}${dd}`;

  // === LÓGICA DE LUNES (72 hs) VS RESTO (24 hs) ===
  const diaSemana = hoy.getDay(); // 0 = domingo, 1 = lunes, ..., 6 = sábado
  const esLunes = (diaSemana === 1);

  // Sufijo para el nombre del archivo (24hs / 72hs)
  const sufijoArchivos = esLunes ? "72hs" : "24hs";
  const textoHorasCorto = esLunes ? "72 h" : "24 h";
  const textoHorasLargo = esLunes ? "72 hs" : "24 hs";

  // Nombre del ÚNICO archivo esperado según el día
  const nombreArchivoEsperado = `RecoleccionJobs${sufijoArchivos}.xlsx`;

  // === ASUNTO ===
  const asunto = `Reporte de Comafi - Últimas ${textoHorasCorto} - Wetcom / Comafi`;

  // === CUERPO (Modificado para quitar "y agentes") ===
  const cuerpo =
`Estimados, buenos días.

A continuación adjunto el reporte diario con los jobs de Veeam que se ejecutaron en las últimas ${textoHorasLargo}.

Ante cualquier duda o consulta estamos a su disposición.`;

  // === OBTENER CARPETA RAÍZ ===
  const carpetaRaiz = DriveApp.getFolderById(ROOT_FOLDER_ID);

  // === BUSCAR LA CARPETA DEL DÍA ===
  const carpetas = carpetaRaiz.getFoldersByName(nombreCarpeta);
  if (!carpetas.hasNext()) {
    throw new Error(`❌ No existe la carpeta del día ${nombreCarpeta} dentro de la raíz.`);
  }

  const carpetaDia = carpetas.next();

  // === BUSCAR EL ARCHIVO ===
  const archivos = carpetaDia.getFiles();
  const adjuntos = [];

  while (archivos.hasNext()) {
    const archivo = archivos.next();
    
    // Si encuentra nuestro archivo esperado, lo guarda y corta la búsqueda
    if (archivo.getName() === nombreArchivoEsperado) {
      adjuntos.push(archivo.getBlob());
      break; 
    }
  }

  // === VALIDAR PRESENCIA DEL ARCHIVO ===
  if (adjuntos.length === 0) {
    Logger.log(`❌ ERROR: No se encontró el archivo ${nombreArchivoEsperado} en la carpeta ${nombreCarpeta}. Mail NO enviado.`);
    return; // <-- Detiene y NO envía nada
  }

  // === ENVIAR EL MAIL ===
  MailApp.sendEmail({
    to: destinatario,
    cc: ccDestinatario,
    subject: asunto,
    body: cuerpo,
    attachments: adjuntos
  });

  Logger.log(`📧 Mail enviado correctamente con asunto: "${asunto}" y el archivo ${nombreArchivoEsperado}.`);

  const clientConfig = getClientConfig("@comafi.com.ar", VIEW_OPERATION_NAME);

  const tareaProgamada = buscarYCerrarTareaProgramada(RECOLECCION_SCHEDULED_TASK_NAME_TO_CLOSE, clientConfig, false);
}
function crearTriggerDiario() {

  // Crea el nuevo activador basado en tiempo
  ScriptApp.newTrigger("enviarMailRecoleccionDiarios")
    .timeBased()
    .everyDays(1) // Se ejecuta cada día
    .atHour(9)    // En la franja de 9:00 a.m. a 10:00 a.m.
    .create();
    
  Logger.log("¡Activador creado con éxito para ejecutarse diariamente entre las 9:00 y las 10:00 a.m.!");
}
