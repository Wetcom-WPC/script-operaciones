/**
 * @fileoverview Script de inicialización y configuración de Etiquetas de Gmail.
 * Permite crear todas las etiquetas necesarias para el flujo de automatización de operaciones.
 */

/**
 * Lista maestra de etiquetas utilizadas por el sistema de automatización.
 * Puedes añadir nuevas etiquetas a este array si en el futuro se requieren más categorías.
 */
const ETIQUETAS_DEL_SISTEMA = [
  "[OPS-PENDIENTE]", // Etiqueta para correos en cola o en espera de reintento tras un fallo temporal
  "[OPS-PROCESADO]", // Etiqueta aplicada tras procesar exitosamente un reporte u operación
  "[OPS-ERROR]"      // Etiqueta para correos con errores críticos que requieren revisión manual
];

/**
 * Crea las etiquetas del sistema en la cuenta de Gmail de la persona que ejecuta el script.
 * Si la etiqueta ya existe en el Gmail del usuario, la conserva intacta sin duplicar ni arrojar error.
 * 
 * INSTRUCCIONES DE USO:
 * 1. Abre el editor de Google Apps Script.
 * 2. Selecciona la función `configurarEtiquetasGmail` en el menú desplegable superior.
 * 3. Haz clic en "Ejecutar".
 * 4. Consulta los Logs (Ver > Registros de ejecución) para verificar las etiquetas creadas.
 */
function configurarEtiquetasGmail() {
  Logger.log("=== 🚀 INICIANDO CONFIGURACIÓN DE ETIQUETAS DE GMAIL ===");
  
  let creadas = 0;
  let existentes = 0;
  let errores = 0;

  ETIQUETAS_DEL_SISTEMA.forEach(nombreEtiqueta => {
    try {
      let etiqueta = GmailApp.getUserLabelByName(nombreEtiqueta);
      if (etiqueta) {
        Logger.log(`ℹ️ La etiqueta "${nombreEtiqueta}" ya existe en tu cuenta de Gmail.`);
        existentes++;
      } else {
        GmailApp.createLabel(nombreEtiqueta);
        Logger.log(`✅ Etiqueta creada con éxito: "${nombreEtiqueta}"`);
        creadas++;
      }
    } catch (e) {
      Logger.log(`❌ Error al verificar o crear la etiqueta "${nombreEtiqueta}": ${e.message}`);
      errores++;
    }
  });

  Logger.log("=== 📊 RESUMEN DE LA CONFIGURACIÓN ===");
  Logger.log(`✅ Etiquetas nuevas creadas: ${creadas}`);
  Logger.log(`ℹ️ Etiquetas que ya existían: ${existentes}`);
  if (errores > 0) {
    Logger.log(`⚠️ Errores encontrados: ${errores}`);
  } else {
    Logger.log("🎉 ¡Configuración completada perfectamente en tu Gmail!");
  }
}
