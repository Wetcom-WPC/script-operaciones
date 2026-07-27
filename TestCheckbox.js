/**
 * =================================================================
 * PROCESADOR AUTOMÁTICO DE ENVIOS POR TIEMPO - V14
 * Cambios vs V13:
 *  - EVALUACIÓN 4: RVTools (Col U) procesado automáticamente,
 *    igual que los mails. Marca Col Y (TC_COL_RVTOOLS_PROCESADO)
 *    cuando termina para no reprocesar.
 *  - resetearColumnasEnviados extendido de R-X a R-Y (8 cols).
 * =================================================================
 */

// --- CONFIGURACIÓN DE COLUMNAS (Sheet1) ---
const TC_COL_CHECK_VSPHERE = 18; // Col R (Mail vSphere / Horizon)
const TC_COL_CHECK_VEEAM   = 19; // Col S (Mail Veeam)
const TC_COL_CHECK_NUTANIX = 20; // Col T (Mail Nutanix)
const TC_COL_CHECK_RVTOOLS = 21; // Col U (RVTools)
const TC_COL_CHECK_TANZU   = 25; // Col Y (Procesar Tanzu)

// --- COLUMNAS DE CONTROL / REPOSITORIO DE ENVIADOS ---
const TC_COL_ENVIADO_VSPHERE   = 22; // Col V
const TC_COL_ENVIADO_VEEAM     = 23; // Col W
const TC_COL_ENVIADO_NUTANIX   = 24; // Col X
const TC_COL_ENVIADO_TANZU     = 26; // Col Z (Mail Tanzu Enviado)
// Col U (RVTools) se resetea a false después de procesar — no necesita columna separada

const TC_HOJA_OBJETIVO = "Sheet1";


/**
 * Función principal — trigger de tiempo cada 5 minutos.
 * Procesa mails pendientes (R/S/T) y RVTools pendiente (U)
 * dentro de la ventana 8:00-11:00 AM.
 */
function procesarEnviosPorLote() {
  const ahora = new Date();
  const horaActual = ahora.getHours();

  if (horaActual < 8 || horaActual >= 17) {
    Logger.log(`💤 Fuera de rango operativo (${horaActual}hs). Deteniendo.`);
    try {
      const ss    = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName(TC_HOJA_OBJETIVO);
      if (sheet) {
        sheet.getRange("R23").setValue("Envio de Mails Automatico de 8am a 17pm");
        sheet.getRange("S23").setValue("");
      }
    } catch (e) {
      Logger.log(`⚠️ No se pudo actualizar R23 fuera de horario: ${e.toString()}`);
    }
    return;
  }

  Logger.log(`🚀 Dentro de horario operativo (${horaActual}hs). Iniciando revisión...`);

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TC_HOJA_OBJETIVO);

  if (!sheet) {
    Logger.log(`❌ No se encontró la hoja "${TC_HOJA_OBJETIVO}"`);
    return;
  }

  const ultimaFila = sheet.getLastRow();
  if (ultimaFila < 2) return;

  // Extendemos a 25 columnas para leer también Col Y
  const rangoDatos = sheet.getRange(2, 1, ultimaFila - 1, 25);
  const valores    = rangoDatos.getValues();

  Logger.log("⏳ Iniciando revisión de envíos y RVTools pendientes...");

  for (let i = 0; i < valores.length; i++) {
    const filaDatos      = valores[i];
    const numeroFilaReal = i + 2;

    // Datos comunes
    const nombreOps          = filaDatos[1];
    const opsKey             = filaDatos[3]  ? filaDatos[3].toString().trim()  : "";
    const podEmail           = filaDatos[8]  ? filaDatos[8].toString().trim()  : "";
    const nombreEmpresaRep   = filaDatos[11];
    const servicios          = filaDatos[12];
    const soporteKey         = filaDatos[13] ? filaDatos[13].toString().trim() : "";
    const nombreSoporte      = filaDatos[15];

    // =========================================================================
    // EVALUACIÓN 1: MAIL VSPHERE (Col R vs Col V)
    // =========================================================================
    const quiereVsphere    = filaDatos[TC_COL_CHECK_VSPHERE - 1]   === true;
    const yaEnviadoVsphere = filaDatos[TC_COL_ENVIADO_VSPHERE - 1] === true;

    if (quiereVsphere && !yaEnviadoVsphere) {
      if (validarDatosCriticos(numeroFilaReal, podEmail, opsKey, soporteKey)) {
        Logger.log(`✉️ Enviando Mail vSphere para fila ${numeroFilaReal}...`);
        try {
          enviarMailUnitario("vSphere", opsKey, nombreOps, soporteKey, nombreSoporte, nombreEmpresaRep, podEmail, servicios);
          sheet.getRange(numeroFilaReal, TC_COL_ENVIADO_VSPHERE).setValue(true);
          Logger.log(`✅ Mail vSphere marcado como enviado en fila ${numeroFilaReal}`);
        } catch (err) {
          Logger.log(`❌ Error enviando vSphere en fila ${numeroFilaReal}: ${err.toString()}`);
        }
      }
    }

    // =========================================================================
    // EVALUACIÓN 2: MAIL VEEAM (Col S vs Col W)
    // =========================================================================
    const quiereVeeam    = filaDatos[TC_COL_CHECK_VEEAM - 1]   === true;
    const yaEnviadoVeeam = filaDatos[TC_COL_ENVIADO_VEEAM - 1] === true;

    if (quiereVeeam && !yaEnviadoVeeam) {
      if (validarDatosCriticos(numeroFilaReal, podEmail, opsKey, soporteKey)) {
        Logger.log(`✉️ Enviando Mail Veeam para fila ${numeroFilaReal}...`);
        try {
          enviarMailUnitario("Veeam", opsKey, nombreOps, soporteKey, nombreSoporte, nombreEmpresaRep, podEmail, servicios);
          sheet.getRange(numeroFilaReal, TC_COL_ENVIADO_VEEAM).setValue(true);
          Logger.log(`✅ Mail Veeam marcado como enviado en fila ${numeroFilaReal}`);
        } catch (err) {
          Logger.log(`❌ Error enviando Veeam en fila ${numeroFilaReal}: ${err.toString()}`);
        }
      }
    }

    // =========================================================================
    // EVALUACIÓN 3: MAIL NUTANIX (Col T vs Col X)
    // =========================================================================
    const quiereNutanix    = filaDatos[TC_COL_CHECK_NUTANIX - 1]   === true;
    const yaEnviadoNutanix = filaDatos[TC_COL_ENVIADO_NUTANIX - 1] === true;

    if (quiereNutanix && !yaEnviadoNutanix) {
      if (validarDatosCriticos(numeroFilaReal, podEmail, opsKey, soporteKey)) {
        Logger.log(`✉️ Enviando Mail Nutanix para fila ${numeroFilaReal}...`);
        try {
          enviarMailUnitario("Nutanix", opsKey, nombreOps, soporteKey, nombreSoporte, nombreEmpresaRep, podEmail, servicios);
          sheet.getRange(numeroFilaReal, TC_COL_ENVIADO_NUTANIX).setValue(true);
          Logger.log(`✅ Mail Nutanix marcado como enviado en fila ${numeroFilaReal}`);
        } catch (err) {
          Logger.log(`❌ Error enviando Nutanix en fila ${numeroFilaReal}: ${err.toString()}`);
        }
      }
    }

    // =========================================================================
    // EVALUACIÓN 4: RVTOOLS (Col U)
    // Al terminar se resetea Col U a false — sin columna de estado separada.
    // En caso de error también se resetea para evitar bucles infinitos;
    // el equipo puede volver a marcarla si quiere reintentar.
    // =========================================================================
    const quiereRVTools = filaDatos[TC_COL_CHECK_RVTOOLS - 1] === true;

    if (quiereRVTools) {
      const nombreParaConfig = filaDatos[1]  ? filaDatos[1].toString().trim()  : "";
      const folderId         = filaDatos[9]  ? filaDatos[9].toString().trim()  : "";
      const nombreParaCartel = filaDatos[11] ? filaDatos[11].toString().trim() : nombreParaConfig;

      if (!folderId) {
        Logger.log(`⚠️ Fila ${numeroFilaReal}: RVTools omitido — falta ID de carpeta (Col J) para ${nombreParaCartel}.`);
      } else {
        Logger.log(`🔍 Procesando RVTools para fila ${numeroFilaReal}: ${nombreParaCartel}...`);
        try {
          const resultado = AutomatizarOperaciones.procesarRVToolsManual(nombreParaConfig, folderId);
          if (resultado.success) {
            Logger.log(`✅ RVTools completado para ${nombreParaCartel}: ${resultado.message}`);
          } else {
            Logger.log(`⚠️ RVTools finalizado con advertencias para ${nombreParaCartel}: ${resultado.message}`);
          }
        } catch (err) {
          Logger.log(`❌ Error procesando RVTools en fila ${numeroFilaReal}: ${err.toString()}`);
        } finally {
          // Siempre reseteamos Col U para que no se reprocese en la próxima vuelta
          sheet.getRange(numeroFilaReal, TC_COL_CHECK_RVTOOLS).setValue(false);
        }
      }
    }

    // =========================================================================
    // EVALUACIÓN 5: TANZU (Col Y vs Col Z)
    // =========================================================================
    const quiereTanzu = filaDatos[TC_COL_CHECK_TANZU - 1] === true;
    const yaEnviadoTanzu = filaDatos[TC_COL_ENVIADO_TANZU - 1] === true;

    if (quiereTanzu && !yaEnviadoTanzu) {
      const nombreParaConfig = filaDatos[1]  ? filaDatos[1].toString().trim()  : "";
      const folderId         = filaDatos[9]  ? filaDatos[9].toString().trim()  : "";
      const nombreParaCartel = filaDatos[11] ? filaDatos[11].toString().trim() : nombreParaConfig;

      if (!folderId) {
        Logger.log(`⚠️ Fila ${numeroFilaReal}: Tanzu omitido — falta ID de carpeta (Col J) para ${nombreParaCartel}.`);
      } else {
        Logger.log(`✉️ Procesando Tanzu para fila ${numeroFilaReal}: ${nombreParaCartel}...`);
        try {
          const resultado = AutomatizarOperaciones.procesarTanzuManual(nombreParaConfig, folderId);
          if (resultado.success) {
            sheet.getRange(numeroFilaReal, TC_COL_ENVIADO_TANZU).setValue(true);
            Logger.log(`✅ Tanzu completado para ${nombreParaCartel}: ${resultado.message}`);
          } else {
            Logger.log(`⚠️ Tanzu finalizado con advertencias para ${nombreParaCartel}: ${resultado.message}`);
          }
        } catch (err) {
          Logger.log(`❌ Error procesando Tanzu en fila ${numeroFilaReal}: ${err.toString()}`);
        }
      }
    }

  } // fin bucle for

  // =========================================================================
  // ACTUALIZACIÓN DEL CRONÓMETRO EN R23 / S23
  // =========================================================================
  const ahoraMismo   = new Date();
  const proximaVuelta = new Date(ahoraMismo.getTime() + 5 * 60 * 1000);
  const formatoCompleto = Utilities.formatDate(proximaVuelta, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  sheet.getRange("S23").setValue(formatoCompleto);
  sheet.getRange("R23").setFormula('=IF(NOW() >= S23; "🤖 Enviando Emails..."; "Proximo Envio de Mails En: " & TEXT(ROUND((S23 - NOW()) * 1440); "00") & " min")');

  Logger.log(`✅ Lote terminado. Próxima vuelta: ${formatoCompleto}`);
}

/**
 * Valida datos mínimos antes de procesar un mail.
 */
function validarDatosCriticos(fila, podEmail, opsKey, soporteKey) {
  if (!podEmail || (!opsKey && !soporteKey)) {
    Logger.log(`⚠️ Fila ${fila} omitida: Falta Email POD o Keys de Jira.`);
    return false;
  }
  return true;
}

/**
 * Resetea a false todos los checkboxes de Col R a Col Y (R, S, T, U, V, W, X, Y).
 * Solo actúa sobre celdas con valor booleano para no tocar celdas con "-" o texto.
 * Se ejecuta automáticamente todas las noches vía trigger.
 */
function resetearColumnasEnviados() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TC_HOJA_OBJETIVO);

  if (!sheet) {
    Logger.log(`❌ No se encontró la hoja "${TC_HOJA_OBJETIVO}"`);
    return;
  }

  const ultimaFila = sheet.getLastRow();
  if (ultimaFila < 2) {
    Logger.log("📋 Hoja vacía o solo encabezados.");
    return;
  }

  Logger.log("⏳ Iniciando borrado inteligente (Columnas R a Y)...");

  const colInicio       = 18; // Col R
  const totalColumnas   = 9;  // R(18) a Z(26)
  const cantFilas       = ultimaFila - 1;

  const rango  = sheet.getRange(2, colInicio, cantFilas, totalColumnas);
  const valores = rango.getValues();

  for (let f = 0; f < valores.length; f++) {
    for (let c = 0; c < totalColumnas; c++) {
      if (typeof valores[f][c] === "boolean") {
        valores[f][c] = false;
      }
    }
  }

  rango.setValues(valores);
  Logger.log(`✅ Checkboxes R-Y reseteados para ${cantFilas} filas.`);
}

/**
 * Crea el trigger de tiempo para procesarEnviosPorLote (cada 5 minutos).
 */
function crearTriggerPorTiempoCada5Minutos() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "procesarEnviosPorLote") {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger("procesarEnviosPorLote")
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log("🚀 Trigger de 5 min creado para procesarEnviosPorLote.");
}

/**
 * Crea el trigger nocturno para resetearColumnasEnviados.
 */
function crearTriggerLimpiezaNocturna() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "resetearColumnasEnviados") {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger("resetearColumnasEnviados")
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .create();

  Logger.log("🌙 Trigger nocturno creado para resetearColumnasEnviados.");
}