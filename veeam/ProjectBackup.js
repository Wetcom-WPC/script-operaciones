// =======================
// CONFIGURACIÓN
// =======================

// ID de la carpeta DONDE ESTÁN los archivos originales (Origen)
const ID_CARPETA_ORIGEN = PropertiesService.getScriptProperties().getProperty("DRIVE_REPORTES_ORIG_FOLDER_ID");

// ID de la carpeta DONDE SE GUARDARÁN las copias (Destino)
const ID_CARPETA_DESTINO = PropertiesService.getScriptProperties().getProperty("DRIVE_REPORTES_DEST_FOLDER_ID");

// Lista exacta de nombres de archivos a copiar
// (Respeta mayúsculas, minúsculas y espacios tal cual están en Drive)
const ARCHIVOS_A_COPIAR = [
  "Automatizar Operaciones", // Apps Script
  "Envio de Reportes",       // Apps Script
  "Indice - General",        // Sheet
  "Configuracion",           // Sheet
  "ReportesClientes",        // Sheet
  "Envio de reportes"        // Sheet (Ojo con la minúscula/mayúscula si es diferente al script)
];

// =======================
// FUNCIÓN PRINCIPAL
// =======================

function backupAppsScriptProjectToDrive() {
  try {
    const carpetaOrigen = DriveApp.getFolderById(ID_CARPETA_ORIGEN);
    const carpetaDestinoPrincipal = DriveApp.getFolderById(ID_CARPETA_DESTINO);
    
    // 1. Crear una subcarpeta con la fecha de hoy para mantener orden
    const fechaHoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    const nombreCarpetaBackup = `Backup_${fechaHoy}`;
    
    // Verificamos si ya existe la carpeta de hoy (por si corres el script 2 veces)
    const carpetasExistentes = carpetaDestinoPrincipal.getFoldersByName(nombreCarpetaBackup);
    let carpetaBackupDia;
    
    if (carpetasExistentes.hasNext()) {
      carpetaBackupDia = carpetasExistentes.next();
    } else {
      carpetaBackupDia = carpetaDestinoPrincipal.createFolder(nombreCarpetaBackup);
    }

    Logger.log(`📂 Guardando en carpeta: ${nombreCarpetaBackup}`);

    // 2. Recorrer la lista de nombres y buscar en la carpeta origen
    let archivosCopiados = 0;

    ARCHIVOS_A_COPIAR.forEach(nombreArchivo => {
      // Buscamos dentro de la carpeta origen específica
      const iteradorArchivos = carpetaOrigen.getFilesByName(nombreArchivo);
      
      if (!iteradorArchivos.hasNext()) {
        Logger.log(`⚠️ No encontrado: "${nombreArchivo}" en la carpeta origen.`);
      }

      // Usamos while por si hay dos archivos con el mismo nombre (ej. un Script y un Sheet llamados igual)
      while (iteradorArchivos.hasNext()) {
        const archivoOriginal = iteradorArchivos.next();
        
        // Hacemos la copia
        archivoOriginal.makeCopy(nombreArchivo, carpetaBackupDia);
        Logger.log(`✅ Copiado: ${nombreArchivo} (${archivoOriginal.getMimeType()})`);
        archivosCopiados++;
      }
    });

    Logger.log(`🎉 Proceso finalizado. Total archivos copiados: ${archivosCopiados}`);

  } catch (e) {
    Logger.log(`❌ Error crítico: ${e.message}`);
    MailApp.sendEmail(Session.getActiveUser().getEmail(), "Error Backup Drive", e.message);
  }
}

// =======================
// ACTIVADOR (TRIGGER)
// =======================

function configurarTriggerAutomatico() {
  // Elimina triggers anteriores para no duplicar
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("realizarBackupDiario")
    .timeBased()
    .everyDays(1)
    .atHour(2) // Se ejecuta entre las 2am y 3am
    .create();
    
  Logger.log("⏰ Backup automático programado para las 02:00 AM diariamente.");
}
