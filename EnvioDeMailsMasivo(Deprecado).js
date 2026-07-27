/**
 * FUNCIÓN DE EMERGENCIA — Envía todos los mails de operaciones de una vez.
 * Reemplaza el uso de los checkboxes mientras se resuelve el problema del trigger.
 *
 * CÓMO USAR:
 *   1. Pegá este archivo en el proyecto BotonCheckBox
 *   2. Seleccioná la función que necesitás en el dropdown
 *   3. Ejecutá manualmente
 *
 * FUNCIONES DISPONIBLES:
 *   enviarTodosMailsVSphere()  → manda todos los mails de vSphere
 *   enviarTodosMailsVeeam()    → manda todos los mails de Veeam
 *   enviarTodosMailsNutanix()  → manda todos los mails de Nutanix
 *   enviarTodosLosMails()      → manda TODOS (vSphere + Veeam + Nutanix) para todos los clientes
 

var ID_INDICE_GENERAL = "1ZriSQeckRp_hWXS0X-CdGzrnnplCj2KmcLHgAbXo6qU";

// Clientes a OMITIR (filas que no son clientes reales)
var CLIENTES_OMITIR = ["WPC - Operaciones Testing", "WPC - Soporte Testing", ""];

function enviarTodosMailsVSphere() {
  _enviarMailsMasivo("vSphere");
}

function enviarTodosMailsVeeam() {
  _enviarMailsMasivo("Veeam");
}

function enviarTodosMailsNutanix() {
  _enviarMailsMasivo("Nutanix");
}

function enviarTodosLosMails() {
  Logger.log("======= ENVÍO MASIVO COMPLETO =======");
  _enviarMailsMasivo("vSphere");
  _enviarMailsMasivo("Veeam");
  _enviarMailsMasivo("Nutanix");
  Logger.log("======= FIN ENVÍO MASIVO =======");
}

function _enviarMailsMasivo(tecnologia) {
  Logger.log("\n--- Iniciando envío masivo: " + tecnologia + " ---");

  var sheet = SpreadsheetApp.openById(ID_INDICE_GENERAL).getSheetByName("Sheet1");
  if (!sheet) { Logger.log("ERROR: No se encontró Sheet1."); return; }

  var datos = sheet.getRange(2, 1, sheet.getLastRow() - 1, 22).getValues();
  var enviados = 0;
  var omitidos = 0;

  datos.forEach(function(fila, idx) {
    var fila_num = idx + 2;

    var nombreOps           = fila[1]  ? fila[1].toString().trim()  : "";
    var opsKey              = fila[3]  ? fila[3].toString().trim()  : "";
    var podEmail            = fila[8]  ? fila[8].toString().trim()  : "";
    var nombreEmpresa       = fila[11] ? fila[11].toString().trim() : "";
    var servicios           = fila[12] ? fila[12].toString().toLowerCase() : "";
    var soporteKey          = fila[13] ? fila[13].toString().trim() : "";
    var nombreSoporte       = fila[15] ? fila[15].toString().trim() : "";
    var clientesYaProcesados = {}; // ← agregar esto
    // Saltar filas vacías o de testing
    if (!nombreOps || CLIENTES_OMITIR.indexOf(nombreOps) !== -1) {
      return;
    }
      var claveUnica = nombreEmpresa + "_" + tecnologia;
      if (clientesYaProcesados[claveUnica]) {
        Logger.log("[DUPLICADO] Saltando fila " + fila_num + " - " + nombreEmpresa + " (ya enviado)");
        return;
      }
    clientesYaProcesados[claveUnica] = true;
    // Saltar si no tiene POD o keys
    if (!podEmail || (!opsKey && !soporteKey)) {
      Logger.log("[OMITIDO] Fila " + fila_num + " - " + nombreOps + ": sin POD o sin keys Jira.");
      omitidos++;
      return;
    }

    // Verificar si el cliente tiene la tecnología en su columna Servicios
    var tieneVSphere  = servicios.includes("vsphere");
    var tieneVeeam    = servicios.includes("veeam");
    var tieneNutanix  = servicios.includes("nutanix");

    var debeEnviar = false;
    if (tecnologia === "vSphere"  && tieneVSphere)  debeEnviar = true;
    if (tecnologia === "Veeam"    && tieneVeeam)    debeEnviar = true;
    if (tecnologia === "Nutanix"  && tieneNutanix)  debeEnviar = true;

    if (!debeEnviar) {
      Logger.log("[SKIP] " + nombreOps + " no tiene " + tecnologia + " en sus servicios.");
      return;
    }

if (misTickets.length === 0) {
  try {
    const ui = SpreadsheetApp.getUi();
    const listaKeysTexto = keysDisponibles.length > 0 ? keysDisponibles.slice(0, 20).join(", ") : "VACÍO";
    const mensaje = `⚠️ Atención: 0 Tickets Encontrados\n\nProbamos buscar por:\n1. Ops: "${opsKey}" ó "${nombreOps}"\n2. Sup: "${soporteKey}" ó "${nombreSoporte}"\n------------------------------------------------\nDISPONIBLES HOY: [ ${listaKeysTexto} ... ]\n------------------------------------------------\n¿Enviar mail "Verde" (Sin anomalías) de todas formas?`;
    const respuesta = ui.alert("Diagnóstico", mensaje, ui.ButtonSet.YES_NO);
    if (respuesta == ui.Button.NO) return false;
  } catch(uiError) {
    // Sin UI disponible (ejecución masiva) → continúa y envía mail verde
    Logger.log("Sin UI disponible, enviando mail verde automáticamente para: " + nombreEmpresa);
  }
}
    Logger.log("[ENVIANDO] Fila " + fila_num + " - " + nombreOps + " - " + tecnologia + " → " + podEmail);

    try {
      var resultado = enviarMailUnitario(
        tecnologia,
        opsKey,
        nombreOps,
        soporteKey,
        nombreSoporte,
        nombreEmpresa,
        podEmail,
        servicios
      );

      if (resultado === true) {
        Logger.log("[OK] Mail enviado: " + nombreOps + " - " + tecnologia);
        enviados++;
      } else {
        Logger.log("[CANCELADO] " + nombreOps + " - " + tecnologia + ": el usuario canceló.");
      }
    } catch (err) {
      Logger.log("[ERROR] " + nombreOps + " - " + tecnologia + ": " + err.message);
    }

    // Pausa entre mails para no saturar la API de Gmail
    Utilities.sleep(1500);
  });

  Logger.log("--- Fin " + tecnologia + ": " + enviados + " enviados, " + omitidos + " omitidos por datos incompletos ---");
}*/