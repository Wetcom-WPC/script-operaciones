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

    // FIX (BUG-01): El Excel de excepciones de "Zombies VMDKs" referencia la columna "name",
    // pero en la pestaña vHealth de RVTools la columna del objeto suele llamarse "Object"
    // (por eso la detección de objectIndex admite "object"/"vm"). Como normalizarEncabezado("Object")
    // devuelve "object" != "name", isRowExcepted nunca encontraba la columna y TODAS las reglas de
    // excepción (fcd, hbrdisk.RDID, appvolumes, cp-parent-, TEMPLATE) quedaban sin aplicarse.
    //
    // Solución robusta e independiente de la versión de RVTools: forzamos que la columna detectada
    // como objeto se exponga con el nombre canónico "name" y la de mensaje como "message" en el
    // arreglo de encabezados que consume el motor de excepciones. Como isRowExcepted vuelve a
    // normalizar cada encabezado, pasar nombres ya canónicos es idempotente y seguro.
    const headersParaExcepcion = ["vcenter", ...originalHeaders.map(h => normalizarEncabezado(h))];
    const idxName = objectIndex + 1;      // +1 compensa el vCenter agregado al frente
    const idxMessage = msgTypeIndex + 1;

    // vHealth suele traer más de una columna que normaliza a "message" (ej. "Message" y
    // "Message Type"). Como isRowExcepted resuelve la columna con indexOf(), que devuelve la
    // PRIMERA coincidencia, una regla sobre "message" leería la columna equivocada. Renombramos
    // las repetidas para que "name" y "message" identifiquen sin ambigüedad a las detectadas.
    headersParaExcepcion.forEach((h, i) => {
      if (i !== idxName && h === "name") headersParaExcepcion[i] = `name_col${i}`;
      if (i !== idxMessage && h === "message") headersParaExcepcion[i] = `message_col${i}`;
    });
    headersParaExcepcion[idxName] = "name";
    headersParaExcepcion[idxMessage] = "message";

    // Se loguean también los encabezados ORIGINALES: si alguna regla de excepción no aplica,
    // esto muestra de inmediato contra qué columnas reales se está comparando.
    Logger.log(`[ZombieDebug] originales: [${originalHeaders.join(", ")}]`);
    Logger.log(`[ZombieDebug] headersParaExcepcion: [${headersParaExcepcion.join(", ")}] | objectIndex=${objectIndex}, msgTypeIndex=${msgTypeIndex}`);

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