/**
 * =================================================================
 * SCRIPT DE LÓGICA DE ZOMBIES VMDK (RVTOOLS) - V3.2
 * Fix: headersParaExcepcion ahora usa normalizarEncabezado()
 *      de forma consistente con isRowExcepted, evitando el
 *      "ADVERTENCIA DE EXCEPCIÓN: columna vCenter no encontrada".
 * =================================================================
 */

const ZOMBIE_TASK_NAME  = "Zombies VMDKs";
const ZOMBIE_TICKET_TITLE = "Se detectaron Zombies VMDKs";
const ZOMBIE_TAB_NAME   = "vHealth";

function procesarZombiesVmdk(spreadsheet, clientConfig, summaryReport, vcenterFQDN) {
  try {
    const sheet = spreadsheet.getSheetByName(ZOMBIE_TAB_NAME);
    if (!sheet) return { headers: [], anomalies: [] };

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return { headers: [], anomalies: [] };

    const originalHeaders  = data[0].map(h => h.toString().trim());
    const normalizedHeaders = originalHeaders.map(h => h.toLowerCase().replace(/\uFEFF/g, '').trim());
    const rows = data.slice(1);

    // BUSQUEDA FLEXIBLE DE COLUMNAS
    let msgTypeIndex = -1;
    let objectIndex  = -1;

    normalizedHeaders.forEach((h, idx) => {
      if (h.includes("message")) msgTypeIndex = idx;
      if (h === "name" || h.includes("object") || h === "vm") objectIndex = idx;
    });

    if (msgTypeIndex === -1 || objectIndex === -1) {
      Logger.log(`ERROR: Columnas no encontradas en vHealth. Detectadas: ${normalizedHeaders.join(", ")}`);
      summaryReport.errores.push({ error: "Columnas no encontradas", detalle: `Faltan Message o Name en vHealth` });
      return { headers: [], anomalies: [] };
    }

    const anomalies = rows.filter(row => {
      const msgType = (row[msgTypeIndex] || "").toString().toLowerCase();
      const nameVal = (row[objectIndex]  || "").toString().toLowerCase();
      return msgType.includes("zombie") && nameVal.includes("vmdk");
    });

    if (anomalies.length === 0) return { headers: [], anomalies: [] };

    // FIX: usar normalizarEncabezado() tanto para "vCenter" como para los encabezados
    // del reporte, garantizando la misma normalización que usa isRowExcepted internamente.
    // Antes se usaba ["vcenter", ...normalizedHeaders] con lowercase manual, lo que
    // producía desajuste cuando normalizarEncabezado() no lowercasea de la misma forma.
    const headersParaExcepcion = [
      normalizarEncabezado("vCenter"),
      ...originalHeaders.map(h => normalizarEncabezado(h))
    ];

    const finalAnomalies = anomalies.filter(row => {
      const rowWithVcenter = [vcenterFQDN, ...row];
      return !isRowExcepted(rowWithVcenter, headersParaExcepcion, clientConfig.exceptions);
    });

    if (finalAnomalies.length === 0) return { headers: [], anomalies: [] };

    const headersParaTicket   = ["vCenter", "Name", "Message"];
    const anomaliasParaTicket = finalAnomalies.map(row => [
      vcenterFQDN,
      row[objectIndex],
      row[msgTypeIndex]
    ]);

    return { headers: headersParaTicket, anomalies: anomaliasParaTicket };

  } catch (e) {
    Logger.log(`ERROR en Zombies: ${e.message}`);
    summaryReport.errores.push({ error: `Error en ${ZOMBIE_TAB_NAME}`, detalle: e.message });
    return { headers: [], anomalies: [] };
  }
}