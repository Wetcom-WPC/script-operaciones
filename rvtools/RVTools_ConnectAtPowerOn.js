/**
 * =================================================================
 * SCRIPT DE LÓGICA DE CONNECT AT POWER ON (RVTOOLS) - V3.4
 * Fix: headersParaExcepcion ahora usa normalizarEncabezado()
 *      de forma consistente con isRowExcepted, evitando el
 *      "ADVERTENCIA DE EXCEPCIÓN: columna vCenter no encontrada".
 * =================================================================
 */

const CONNECT_TASK_NAME   = "VMs sin connect at power on";
const CONNECT_TICKET_TITLE = "Se detectaron VMs sin Connect al Power On";
const CONNECT_TAB_NAME    = "vNetwork";

function procesarConnectAtPowerOn(spreadsheet, clientConfig, summaryReport, vcenterFQDN) {
  try {
    const sheet = spreadsheet.getSheetByName(CONNECT_TAB_NAME);
    if (!sheet) {
      Logger.log(`No se encontró la pestaña "${CONNECT_TAB_NAME}".`);
      return { headers: [], anomalies: [] };
    }

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return { headers: [], anomalies: [] };

    const originalHeaders = data[0].map(h => h.toString().trim());
    const rows = data.slice(1);

    // Mapeo flexible de índices
    const { normalizedHeaders, headerIndices } = manejarEncabezadosDuplicadosVNetwork(originalHeaders);

    // Verificación de columnas críticas
    const idxVM        = headerIndices["vm"];
    const idxPower     = headerIndices["powerstate"];
    const idxConnected = headerIndices["connected"];
    const idxStarts    = headerIndices["starts connected"];

    if (idxVM === undefined || idxPower === undefined || idxConnected === undefined || idxStarts === undefined) {
      Logger.log(`ERROR: Columnas faltantes en vNetwork.`);
      summaryReport.errores.push({ error: "Columnas no encontradas", detalle: `Faltan columnas clave en vNetwork` });
      return { headers: [], anomalies: [] };
    }

    // Filtrado de anomalías (Power: On, Connected: True, Starts: False)
    const anomalies = rows.filter(row => {
      const powerState     = (row[idxPower]     || "").toString().toLowerCase().trim();
      const connected      = (row[idxConnected] || "").toString().toLowerCase().trim();
      const startsConnected = (row[idxStarts]   || "").toString().toLowerCase().trim();
      return powerState === 'poweredon' && connected === 'true' && startsConnected === 'false';
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

    // --- CONSTRUCCIÓN DEL REPORTE FINAL (Asegurando nombres) ---
    const headersParaTicket = ["vCenter", "VM Name", "Powerstate", "Connected", "Starts Connected"];

    const anomaliasParaTicket = finalAnomalies.map(row => {
      return [
        vcenterFQDN,
        row[idxVM]        ? row[idxVM].toString().trim()    : "Desconocido",
        row[idxPower]     || "-",
        row[idxConnected] || "-",
        row[idxStarts]    || "-"
      ];
    });

    return { headers: headersParaTicket, anomalies: anomaliasParaTicket };

  } catch (e) {
    Logger.log(`ERROR en ConnectAtPowerOn: ${e.message}`);
    summaryReport.errores.push({ error: `Error en ${CONNECT_TAB_NAME}`, detalle: e.message });
    return { headers: [], anomalies: [] };
  }
}

function manejarEncabezadosDuplicadosVNetwork(originalHeaders) {
  const headerCounts  = {};
  const normalizedHeaders = [];
  const headerIndices = {};

  originalHeaders.forEach((header, index) => {
    let hLimpio = header.toString().replace(/\uFEFF/g, '').trim().toLowerCase();

    // Lógica de detección flexible por contenido
    if ((hLimpio === "vm" || hLimpio.includes("virtual machine")) && headerIndices["vm"] === undefined) {
      headerIndices["vm"] = index;
    }
    if (hLimpio.includes("powerstate") || hLimpio.includes("power state")) {
      headerIndices["powerstate"] = index;
    }
    if (hLimpio === "connected") {
      headerIndices["connected"] = index;
    }
    if (hLimpio.includes("starts connected") || hLimpio.includes("start connected")) {
      headerIndices["starts connected"] = index;
    }

    if (headerCounts[hLimpio]) {
      headerCounts[hLimpio]++;
      hLimpio = `${hLimpio}_${headerCounts[hLimpio]}`;
    } else {
      headerCounts[hLimpio] = 1;
    }
    normalizedHeaders.push(hLimpio);
  });

  return { normalizedHeaders, headerIndices };
}