/**
 * =================================================================
 * ESTADO DE LICENCIAS — clasificación única + persistencia
 * =================================================================
 *
 * El ciclo de licencias corre el último día hábil del mes y termina en un mail al POD. Con
 * eso, el estado de las licencias de un cliente existe en la casilla de quien recibió ese
 * mail y en ningún otro lado: no se puede consultar después, ni ver el conjunto, ni filtrar
 * por POD. Este archivo deja el mismo resultado escrito en una solapa de la planilla, para
 * que el dashboard lo muestre.
 *
 * Lo importante es de DÓNDE sale ese resultado. "Vencida", "próxima a vencer" y "vigente" no
 * se calculan igual en las dos tecnologías:
 *
 *   - vSphere: solo cuentan las licencias EN USO (usadas > 0). Una licencia vencida que nadie
 *     usa no es un problema operativo.
 *   - Veeam: el vencimiento manda esté en uso o no, y antes se descartan los sockets
 *     redundantes (filtrarSocketsRedundantes).
 *
 * Esa diferencia es intencional y estaba escrita CUATRO veces en services/Licencias.js: en
 * los dos armadores de mail y en los dos avisos de Slack. El dashboard habría sido la quinta
 * copia, y es exactamente el patrón del §5 de AGENTS.md: el día que alguien corrija el umbral
 * en una, el mail y el dashboard empiezan a decir cosas distintas sobre el mismo cliente y no
 * hay forma de saber a cuál creerle. Ahora clasifican todos por acá.
 *
 * Lo que se guarda es la clasificación YA HECHA, no las licencias crudas: si el dashboard
 * reclasificara al leer, volveríamos al mismo problema por otro camino.
 */

const LIC_ESTADO_TAB = "Estado de Licencias";

const LIC_ESTADO_ENCABEZADOS = [
  "Ciclo", "Actualizado", "Tecnología", "Cliente", "POD", "Estado del cliente",
  "Origen", "Licencia", "Tipo", "Vencimiento", "Días restantes",
  "Usadas", "Total", "Unidad", "Estado"
];

// Estado de una licencia suelta.
const LIC_EST_VENCIDA    = "Vencida";
const LIC_EST_POR_VENCER = "Por vencer";
const LIC_EST_VIGENTE    = "Vigente";
const LIC_EST_SIN_USO    = "Sin uso";

// Estado del cliente: lo que define el color del semáforo.
const LIC_CLI_VENCIDA    = "Vencida";
const LIC_CLI_POR_VENCER = "Por vencer";
const LIC_CLI_OK         = "OK";
const LIC_CLI_SIN_DATOS  = "Sin datos";

/**
 * =================================================================
 * CLASIFICACIÓN (única fuente de verdad)
 * =================================================================
 */

/**
 * @param {Array<Object>} todasLasLicencias Licencias de vSphere ya deduplicadas.
 * @returns {{tecnologia: string, licencias: Array, vencidas: Array, proximas: Array, sanasEnUso: Array, sinUso: Array}}
 */
function clasificarLicenciasVsphere(todasLasLicencias) {
  const licencias = todasLasLicencias || [];
  return {
    tecnologia: LIC_TECNOLOGIA_VSPHERE,
    licencias:  licencias,
    vencidas:   licencias.filter(a => a.usadas > 0 && a.diasRestantes < 0),
    proximas:   licencias.filter(a => a.usadas > 0 && a.diasRestantes >= 0 && a.diasRestantes <= DIAS_UMBRAL_VENCIMIENTO),
    sanasEnUso: licencias.filter(a => a.usadas > 0 && a.diasRestantes > DIAS_UMBRAL_VENCIMIENTO),
    sinUso:     licencias.filter(a => a.usadas === 0)
  };
}

/**
 * Igual que la de vSphere pero con las reglas de Veeam: descarta primero los sockets
 * redundantes y después clasifica por vencimiento, en uso o no.
 *
 * @param {Array<Object>} todasLasLicencias Licencias de Veeam ya deduplicadas.
 * @returns {{tecnologia: string, licencias: Array, vencidas: Array, proximas: Array, sanasEnUso: Array, sinUso: Array}}
 */
function clasificarLicenciasVeeam(todasLasLicencias) {
  const licencias = filtrarSocketsRedundantes(todasLasLicencias || []);
  return {
    tecnologia: LIC_TECNOLOGIA_VEEAM,
    licencias:  licencias,
    vencidas:   licencias.filter(a => a.diasRestantes < 0),
    proximas:   licencias.filter(a => a.diasRestantes >= 0 && a.diasRestantes <= VEEAM_LIC_DIAS_UMBRAL),
    sanasEnUso: licencias.filter(a => a.usadas > 0 && a.diasRestantes > VEEAM_LIC_DIAS_UMBRAL),
    sinUso:     licencias.filter(a => a.usadas === 0 && a.diasRestantes > VEEAM_LIC_DIAS_UMBRAL)
  };
}

/**
 * Estado del cliente a partir de su clasificación. Es la misma prioridad que define el color
 * del encabezado del mail: vencida manda sobre próxima a vencer, y próxima sobre todo OK.
 *
 * @param {Object} clas Resultado de clasificarLicencias*.
 * @returns {string} Una de las constantes LIC_CLI_*.
 */
function estadoClienteLicencias(clas) {
  if (!clas || !clas.licencias || clas.licencias.length === 0) return LIC_CLI_SIN_DATOS;
  if (clas.vencidas.length > 0) return LIC_CLI_VENCIDA;
  if (clas.proximas.length > 0) return LIC_CLI_POR_VENCER;
  return LIC_CLI_OK;
}

/**
 * =================================================================
 * PERSISTENCIA
 * =================================================================
 */

/**
 * Deja en la solapa "Estado de Licencias" una fila por licencia del cliente, con el estado
 * que le corresponde según la clasificación que ya se usó para armar el mail.
 *
 * Reemplaza las filas que ese mismo cliente y esa misma tecnología hayan dejado en el ciclo
 * en curso, y no toca las de ciclos anteriores: el ciclo se corta cada ~4,5 minutos y sigue
 * en segundo plano, así que un cliente puede procesarse más de una vez, y además queda el
 * historial mes a mes.
 *
 * NUNCA hace fallar la corrida: el mail al POD es el entregable y esto es un agregado. Pero
 * tampoco falla en silencio (AGENTS.md §7): loguea el motivo concreto y, si le pasan el
 * summaryReport, deja una advertencia ahí.
 *
 * @param {string} tecnologia LIC_TECNOLOGIA_VSPHERE o LIC_TECNOLOGIA_VEEAM.
 * @param {string} cliente Nombre del cliente, tal como figura en la solapa de configuración.
 * @param {string} pod POD al que se le manda el reporte.
 * @param {Object} clas Resultado de clasificarLicencias*.
 * @param {Object} [summaryReport] Para dejar la advertencia si no se pudo guardar.
 */
function guardarEstadoLicenciasDelCliente(tecnologia, cliente, pod, clas, summaryReport) {
  try {
    const hoja  = _licEstadoHoja();
    const ciclo = cicloActual();
    const filas = _licEstadoFilas(ciclo, tecnologia, cliente, pod, clas);

    _licEstadoBorrarDelCiclo(hoja, ciclo, tecnologia, cliente);

    if (filas.length > 0) {
      hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, LIC_ESTADO_ENCABEZADOS.length)
          .setValues(filas);
    }
    console.log("📊 [" + cliente + "] Estado de licencias " + (LIC_NOMBRE[tecnologia] || tecnologia) + " guardado (" + filas.length + " fila/s).");

  } catch (e) {
    const motivo = "No se pudo guardar el estado de licencias de " + cliente + " (" + tecnologia + "): " + e.message;
    console.error("⚠️ " + motivo);
    if (summaryReport && summaryReport.advertencias) {
      summaryReport.advertencias.push({
        ticket: "-",
        problema: motivo,
        accion: 'El mail al POD salió igual. Lo que queda sin actualizar es la solapa "' + LIC_ESTADO_TAB + '", que es lo que lee el dashboard.'
      });
    }
  }
}

/**
 * La solapa, creándola con sus encabezados si no existe.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function _licEstadoHoja() {
  const ss = abrirIndiceLicencias();
  let hoja = ss.getSheetByName(LIC_ESTADO_TAB);
  if (hoja) return hoja;

  hoja = ss.insertSheet(LIC_ESTADO_TAB);
  hoja.getRange(1, 1, 1, LIC_ESTADO_ENCABEZADOS.length)
      .setValues([LIC_ESTADO_ENCABEZADOS])
      .setFontWeight("bold");
  hoja.setFrozenRows(1);
  console.log('✅ Solapa "' + LIC_ESTADO_TAB + '" creada.');
  return hoja;
}

/**
 * Arma una fila por licencia, recorriendo los cuatro grupos de la clasificación.
 *
 * El estado de cada licencia sale del grupo en el que cayó, no de recalcularlo acá: es lo
 * que mantiene la diferencia entre las reglas de vSphere y las de Veeam (una licencia vencida
 * sin uso es "Sin uso" en vSphere y "Vencida" en Veeam, a propósito).
 *
 * @returns {Array<Array<any>>}
 */
function _licEstadoFilas(ciclo, tecnologia, cliente, pod, clas) {
  const ahora            = new Date();
  const estadoDelCliente = estadoClienteLicencias(clas);
  const esVeeam          = tecnologia === LIC_TECNOLOGIA_VEEAM;
  const nombreTec        = LIC_NOMBRE[tecnologia] || tecnologia;
  const filas            = [];

  // Un cliente que se procesó y no dejó ninguna licencia tiene que quedar registrado igual.
  // Si no, en el dashboard es indistinguible de uno que nunca corrió, que es un problema
  // distinto y se arregla de otra forma.
  if (!clas || !clas.licencias || clas.licencias.length === 0) {
    return [[
      ciclo, ahora, nombreTec, cliente, pod || "",
      LIC_CLI_SIN_DATOS, "", "(no se encontraron licencias)", "", "", "", "", "", "", ""
    ]];
  }

  const agregar = function (licencia, estado) {
    filas.push([
      ciclo,
      ahora,
      nombreTec,
      cliente,
      pod || "",
      estadoDelCliente,
      esVeeam ? (licencia.servidor || "") : (licencia.sitio || ""),
      licencia.nombre || "",
      esVeeam ? (licencia.tipo || "") : "",
      licencia.vencimiento || "",
      licencia.diasRestantes,
      licencia.usadas,
      licencia.total,
      esVeeam ? (licencia.workload || "") : (licencia.metrica || ""),
      estado
    ]);
  };

  clas.vencidas.forEach(function (l) { agregar(l, LIC_EST_VENCIDA); });
  clas.proximas.forEach(function (l) { agregar(l, LIC_EST_POR_VENCER); });
  clas.sanasEnUso.forEach(function (l) { agregar(l, LIC_EST_VIGENTE); });
  clas.sinUso.forEach(function (l) { agregar(l, LIC_EST_SIN_USO); });

  return filas;
}

/**
 * Borra las filas que ese cliente y esa tecnología dejaron en el ciclo indicado.
 *
 * De abajo hacia arriba: borrando de arriba hacia abajo, cada deleteRow corre los índices que
 * quedan y se terminan borrando filas de otro cliente.
 */
function _licEstadoBorrarDelCiclo(hoja, ciclo, tecnologia, cliente) {
  const ultima = hoja.getLastRow();
  if (ultima < 2) return;

  // Ciclo, Actualizado, Tecnología, Cliente
  const datos   = hoja.getRange(2, 1, ultima - 1, 4).getValues();
  const nombre  = LIC_NOMBRE[tecnologia] || tecnologia;
  const buscado = String(cliente).trim();
  const aBorrar = [];

  for (let i = 0; i < datos.length; i++) {
    if (String(datos[i][0]).trim() === ciclo
     && String(datos[i][2]).trim() === nombre
     && String(datos[i][3]).trim() === buscado) {
      aBorrar.push(i + 2);
    }
  }

  for (let j = aBorrar.length - 1; j >= 0; j--) {
    hoja.deleteRow(aBorrar[j]);
  }
}
