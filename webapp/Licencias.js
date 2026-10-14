/**
 * @fileoverview Sección "Licencias" del panel: lee lo que dejó Script Alarmas.
 *
 * Script Alarmas clasifica las licencias de cada cliente (vSphere y Veeam) el último día hábil
 * del mes y deja el resultado en la solapa "Estado de Licencias" de su planilla, una fila por
 * licencia (ver Script Alarmas/services/LicenciasEstado.js). Esto solo LEE esa solapa.
 *
 * NO RECLASIFICA. "Vencida", "Por vencer" y "Vigente" no significan lo mismo en las dos
 * tecnologías (en vSphere solo cuentan las licencias en uso; en Veeam el vencimiento manda
 * igual), y esa regla vive en una sola función del otro proyecto. Acá se muestra el estado que
 * ya viene escrito; recalcularlo sería una segunda copia de la regla (AGENTS.md §5) y el día
 * que difieran el panel y el mail al POD dirían cosas distintas del mismo cliente.
 */

const WEBAPP_LICENCIAS_SPREADSHEET_ID = '19Mg3kgmTlW-Q2uy7tGEMiLJnX4J2a9lpEVxcncSQWdQ';
const WEBAPP_LICENCIAS_TAB = 'Estado de Licencias';
const WEBAPP_LICENCIAS_COLS = 15;   // A..O, ver LIC_ESTADO_ENCABEZADOS en Script Alarmas
const WEBAPP_LICENCIAS_CACHE_KEY = 'webapp_licencias_v1';
const WEBAPP_LICENCIAS_CACHE_SEG = 600;

/** Texto de una celda que puede venir como Date (Sheets convierte las fechas al leerlas). */
function _webappLicTexto(valor, formato) {
  if (valor instanceof Date) {
    return Utilities.formatDate(valor, HORARIO_OPERATIVO_TZ, formato || 'dd/MM/yyyy');
  }
  return String(valor === null || valor === undefined ? '' : valor).trim();
}

/** El número de una celda, o null si está vacía o no es un número. */
function _webappLicNumero(valor) {
  if (valor === '' || valor === null || valor === undefined) return null;
  const n = Number(valor);
  return isNaN(n) ? null : n;
}

/**
 * Lee la solapa completa, SIN recorte por POD. Es lo que se cachea.
 *
 * Si la solapa todavía no existe (Script Alarmas no corrió el ciclo desde que se despliega la
 * persistencia) devuelve `sinSolapa`, que el navegador explica distinto de "no hay licencias".
 */
function _webappLicenciasCompleto(forzar) {
  const cache = CacheService.getScriptCache();
  if (!forzar) {
    const guardado = cache.get(WEBAPP_LICENCIAS_CACHE_KEY);
    if (guardado) {
      try { return JSON.parse(guardado); } catch (e) {}
    }
  }

  const resultado = { sinSolapa: false, ciclos: [], ciclo: '', actualizado: '', filas: [] };
  const ss = SpreadsheetApp.openById(WEBAPP_LICENCIAS_SPREADSHEET_ID);
  const tab = ss.getSheetByName(WEBAPP_LICENCIAS_TAB);
  if (!tab) {
    resultado.sinSolapa = true;
    return resultado;
  }

  const ultima = tab.getLastRow();
  if (ultima >= 2) {
    const datos = tab.getRange(2, 1, ultima - 1, WEBAPP_LICENCIAS_COLS).getValues();
    datos.forEach(function (r) {
      const ciclo = _webappLicTexto(r[0], 'yyyy-MM');
      if (!ciclo) return;
      resultado.filas.push({
        ciclo: ciclo,
        actualizadoMs: r[1] instanceof Date ? r[1].getTime() : 0,
        tecnologia: _webappLicTexto(r[2]),
        cliente: _webappLicTexto(r[3]),
        pod: _webappLicTexto(r[4]).toUpperCase(),
        estadoCliente: _webappLicTexto(r[5]),
        origen: _webappLicTexto(r[6]),
        licencia: _webappLicTexto(r[7]),
        tipo: _webappLicTexto(r[8]),
        vencimiento: _webappLicTexto(r[9]),
        dias: _webappLicNumero(r[10]),
        usadas: _webappLicNumero(r[11]),
        total: _webappLicNumero(r[12]),
        unidad: _webappLicTexto(r[13]),
        estado: _webappLicTexto(r[14])
      });
    });
  }

  resultado.filas.forEach(function (f) {
    if (resultado.ciclos.indexOf(f.ciclo) === -1) resultado.ciclos.push(f.ciclo);
  });
  resultado.ciclos.sort().reverse();   // yyyy-MM ordena bien como texto: el más nuevo primero

  try {
    const serializado = JSON.stringify(resultado);
    if (serializado.length < 90000) cache.put(WEBAPP_LICENCIAS_CACHE_KEY, serializado, WEBAPP_LICENCIAS_CACHE_SEG);
  } catch (e) {}
  return resultado;
}

/**
 * Estado de las licencias de los clientes que le corresponden a quien pregunta.
 *
 * El recorte por POD va DESPUÉS del caché, nunca antes: el caché es del script y lo comparten
 * todos los usuarios, así que en él vive siempre el dato completo.
 *
 * @param {string} [ciclo] "yyyy-MM". Vacío = el más reciente.
 * @param {boolean} [forzar] Saltea el caché.
 * @returns {{sinSolapa: boolean, ciclos: Array<string>, ciclo: string, actualizado: string, filas: Array<Object>}}
 */
function webapp_obtenerLicencias(ciclo, forzar) {
  const permiso = webapp_exigirAutorizacion(webapp_usuarioActual());
  const completo = _webappLicenciasCompleto(!!forzar);

  const elegido = completo.ciclos.indexOf(String(ciclo || '')) !== -1 ? String(ciclo) : (completo.ciclos[0] || '');
  const delCiclo = completo.filas.filter(function (f) { return f.ciclo === elegido; });
  const visibles = webapp_filtrarPorPod(delCiclo, permiso, function (f) { return f.pod; });

  let ultimoMs = 0;
  visibles.forEach(function (f) { if (f.actualizadoMs > ultimoMs) ultimoMs = f.actualizadoMs; });
  const actualizado = ultimoMs ? Utilities.formatDate(new Date(ultimoMs), HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy HH:mm') : '';

  return {
    sinSolapa: completo.sinSolapa,
    ciclos: completo.ciclos,
    ciclo: elegido,
    actualizado: actualizado,
    filas: visibles
  };
}
