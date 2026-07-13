const BACKUP_OPERATION_NAME = "Backup por tag"
const BACKUP_SCHEDULED_TASK_NAME_TO_CLOSE = "Backup por tag";


function enviarMailBackupPorTagDiarios() {
  // === CONFIGURACIÓN ===
  const destinatario = "equipo_mon@gbsj.com.ar, fabian.gallo@wetcom.com, gabriel.brunner@bancoentrerios.com.ar, Fabian.Urchueguia@bancoentrerios.com.ar";
  const ccDestinatario = "wpc@wetcom.com, pod1@wetcom.com";
  // Archivos a buscar dentro de la carpeta del día
  const archivo1 = "ReporteVeeamv123_prodvcenter02.xlsx";
  const archivo2 = "ReporteVeeamv123_vcenter.xlsx";

  // ID de la carpeta raíz donde están las carpetas YYYYMMDD
  const ROOT_FOLDER_ID = PropertiesService.getScriptProperties().getProperty("DRIVE_RVTOOLS_LIC_FOLDER_ID");

  // === FECHA ===
  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  const mm = String(hoy.getMonth() + 1).padStart(2, "0");
  const dd = String(hoy.getDate()).padStart(2, "0");

  const nombreCarpeta = `${yyyy}${mm}${dd}`;

  // === CUERPO DEL MAIL ===
  const cuerpo = 
`Estimados, buenos días, espero que se encuentren muy bien.
Les adjuntamos el reporte de Backup Por Tag.

Ante cualquier duda o consulta, estamos a su disposición.
Saludos.`;

  // === ASUNTO ===
  const asunto = `Reporte Backup Por Tag - Wetcom / Petersen - ${dd}/${mm}/${yyyy}`;

  // === OBTENER CARPETA RAÍZ ===
  const carpetaRaiz = DriveApp.getFolderById(ROOT_FOLDER_ID);

  // === BUSCAR LA CARPETA DEL DÍA ===
  const carpetas = carpetaRaiz.getFoldersByName(nombreCarpeta);
  if (!carpetas.hasNext()) {
    throw new Error(`❌ No existe la carpeta del día ${nombreCarpeta} dentro de la raíz.`);
  }

  const carpetaDia = carpetas.next();

  // === BUSCAR ARCHIVOS ===
  const archivos = carpetaDia.getFiles();
  const adjuntos = [];
  let encontrado1 = false;
  let encontrado2 = false;

  while (archivos.hasNext()) {
    const archivo = archivos.next();
    const nombre = archivo.getName();

    if (nombre === archivo1) {
      adjuntos.push(archivo.getBlob());
      encontrado1 = true;
    }

    if (nombre === archivo2) {
      adjuntos.push(archivo.getBlob());
      encontrado2 = true;
    }
  }

  // === VALIDAR PRESENCIA DE LOS 2 ARCHIVOS ===
  if (!encontrado1 || !encontrado2) {
    Logger.log(`❌ ERROR: Faltan archivos en ${nombreCarpeta}. Mail NO enviado.`);
    Logger.log(`Encontrado archivo1 (${archivo1}): ${encontrado1}`);
    Logger.log(`Encontrado archivo2 (${archivo2}): ${encontrado2}`);
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

  Logger.log(`📧 Mail enviado correctamente con asunto: "${asunto}"`);

  const clientConfig = getClientConfig("@gbsj.com.ar", VIEW_OPERATION_NAME);

  const tareaProgamada = buscarYCerrarTareaProgramada(BACKUP_SCHEDULED_TASK_NAME_TO_CLOSE,clientConfig, false)
}



