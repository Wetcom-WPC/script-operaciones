/**
 * @fileoverview Salud de los archivos de RVTools subidos a Drive.
 *
 * El dashboard verificaba solo que EXISTIERA la carpeta de la semana. Un archivo corrupto, o
 * una carpeta creada y nunca completada, daban verde igual, y el problema aparecía recién
 * cuando alguien de otra área abría el archivo y no podía leerlo.
 *
 * Acá hay dos niveles de control:
 *
 *   Nivel 1 (revisarCarpeta): solo metadata de Drive, es casi gratis. Carpeta vacía, sin
 *   planillas, archivo de 0 bytes, o archivos más viejos que la carpeta que los contiene.
 *
 *   Nivel 2 (verificarPlanilla): abre el archivo de verdad, convirtiéndolo a Google Sheets
 *   igual que procesarRVToolsManual, y revisa que estén las pestañas que la automatización
 *   necesita y que tengan datos. Es lo único que detecta un archivo corrupto de tamaño
 *   normal, y es lo caro.
 *
 * Para que el nivel 2 pueda ser automático sin recalcular todo cada vez, cada resultado
 * definitivo se guarda con la huella del archivo (id + fecha de modificación + tamaño). Si la
 * huella no cambió, no se vuelve a abrir. Si alguien re-sube el archivo, la huella cambia y se
 * verifica de nuevo. Además cada vuelta tiene un presupuesto de tiempo y de archivos, así que
 * una semana nueva se termina de verificar en varias pasadas en vez de colgar una sola.
 */

// Pestañas que la automatización necesita: vMetaData (de ahí sale el vCenter), vHealth
// (Zombies VMDKs) y vNetwork (VMs sin connect at power on). Si falta alguna, el archivo puede
// abrir igual pero no sirve para trabajar.
const RVTOOLS_PESTANAS_NECESARIAS = ["vMetaData", "vHealth", "vNetwork"];

const RVTOOLS_TAB_VERIFICACION = "Verificación RVTools";
const RVTOOLS_COLS_VERIFICACION = ["Huella", "Cliente", "Carpeta", "Archivo", "Estado", "Detalle", "Verificado"];

// Presupuesto por vuelta. Convertir un RVTools grande tarda varios segundos y el dashboard no
// puede quedarse colgado: se verifican unos pocos por vez y el resto queda pendiente para la
// próxima. Con la memoria, en régimen normal no se abre ningún archivo.
const RVTOOLS_VERIF_MAX_ARCHIVOS = 4;
const RVTOOLS_VERIF_SEGUNDOS = 75;

// Tope de filas de la memoria, para que la pestaña no crezca para siempre.
const RVTOOLS_VERIF_MAX_FILAS = 3000;

// Un export puede hacerse un día y subirse al otro. Más que esto ya es "subieron un archivo
// viejo a la carpeta de esta semana".
const RVTOOLS_DIAS_GRACIA = 2;

/** Bytes en algo que se lee de un vistazo. */
function rvtoolsTamanoLegible(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

/** Las planillas de RVTools que hay en una carpeta, con lo que hace falta para evaluarlas. */
function rvtoolsListarPlanillas(carpeta) {
  const todos = [];
  const it = carpeta.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    todos.push({
      id: f.getId(),
      nombre: f.getName(),
      bytes: f.getSize(),
      tipo: f.getMimeType(),
      actualizadoMs: f.getLastUpdated().getTime(),
      esPlanilla: /\.(xlsx|xlsm)$/i.test(f.getName())
    });
  }
  return todos;
}

/** La fecha que declara el nombre de una carpeta tipo "20260930" (o "2026/20260930"). */
function _rvtoolsFechaDeCarpeta(nombreCarpeta) {
  const digitos = String(nombreCarpeta || "").split("/").pop().replace(/\D/g, "");
  let anio, mes, dia;
  if (digitos.length === 8) {
    anio = +digitos.substring(0, 4); mes = +digitos.substring(4, 6); dia = +digitos.substring(6, 8);
  } else if (digitos.length === 6) {
    anio = 2000 + +digitos.substring(0, 2); mes = +digitos.substring(2, 4); dia = +digitos.substring(4, 6);
  } else {
    return null;
  }
  const d = new Date(anio, mes - 1, dia);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Nivel 1: qué se puede decir de la carpeta sin abrir ningún archivo.
 * @returns {{estado: string, detalle: string, planillas: Array}} estado: 'ok' | 'vacia' |
 *   'sin_planillas' | 'archivo_vacio' | 'desactualizada'
 */
function rvtoolsRevisarCarpeta(carpeta, nombreCarpeta) {
  const archivos = rvtoolsListarPlanillas(carpeta);
  if (!archivos.length) {
    return { estado: "vacia", detalle: "La carpeta " + nombreCarpeta + " está vacía: se creó pero no se subió ningún archivo.", planillas: [] };
  }

  const planillas = archivos.filter(function (a) { return a.esPlanilla; });
  if (!planillas.length) {
    return {
      estado: "sin_planillas",
      detalle: "La carpeta " + nombreCarpeta + " tiene " + archivos.length + " archivo(s) pero ninguno es .xlsx o .xlsm.",
      planillas: []
    };
  }

  const vacios = planillas.filter(function (a) { return !a.bytes; });
  if (vacios.length) {
    return {
      estado: "archivo_vacio",
      detalle: "Archivo de 0 bytes (la subida quedó cortada): " + vacios.map(function (a) { return a.nombre; }).join(", "),
      planillas: planillas
    };
  }

  // Archivos más viejos que la carpeta que los contiene: la carpeta es de esta semana pero
  // adentro está el export de la anterior.
  const fechaCarpeta = _rvtoolsFechaDeCarpeta(nombreCarpeta);
  if (fechaCarpeta) {
    const corte = fechaCarpeta.getTime() - RVTOOLS_DIAS_GRACIA * 86400000;
    const masNuevo = Math.max.apply(null, planillas.map(function (a) { return a.actualizadoMs; }));
    if (masNuevo < corte) {
      return {
        estado: "desactualizada",
        detalle: "La carpeta " + nombreCarpeta + " existe, pero el archivo más nuevo es del " +
          Utilities.formatDate(new Date(masNuevo), HORARIO_OPERATIVO_TZ, "dd/MM/yyyy") + ".",
        planillas: planillas
      };
    }
  }

  return {
    estado: "ok",
    detalle: planillas.length + " planilla(s) en " + nombreCarpeta,
    planillas: planillas
  };
}

// --- Nivel 2: abrir el archivo -------------------------------------------------------------

/**
 * Abre una planilla de RVTools y revisa que tenga, con datos, las pestañas que la
 * automatización necesita. Convierte a Google Sheets igual que procesarRVToolsManual y borra
 * siempre la copia temporal.
 *
 * Un fallo de conversión NO siempre significa archivo corrupto: también puede ser un timeout o
 * un límite de Drive. Esos se devuelven como 'no_verificable' para reintentar más tarde, y no
 * se guardan en la memoria: marcar en rojo algo que no se pudo mirar haría que nadie confíe en
 * el semáforo.
 *
 * @returns {{estado: 'ok'|'roto'|'no_verificable', detalle: string}}
 */
function rvtoolsVerificarPlanilla(fileId, nombre) {
  let tempId = null;
  try {
    const temp = executeDriveWithBackoff(function () {
      return Drive.Files.copy({ mimeType: MimeType.GOOGLE_SHEETS, name: "[TEMP verificacion] " + nombre }, fileId);
    });
    tempId = temp.id;
    const ss = SpreadsheetApp.openById(tempId);
    const presentes = ss.getSheets().map(function (h) { return h.getName(); });

    const faltan = RVTOOLS_PESTANAS_NECESARIAS.filter(function (p) { return presentes.indexOf(p) === -1; });
    if (faltan.length) {
      return {
        estado: "roto",
        detalle: "Abre, pero le faltan pestañas: " + faltan.join(", ") + " (tiene " + presentes.length + ")."
      };
    }
    const sinDatos = RVTOOLS_PESTANAS_NECESARIAS.filter(function (p) {
      return ss.getSheetByName(p).getLastRow() < 2;
    });
    if (sinDatos.length) {
      return { estado: "roto", detalle: "Abre y están las pestañas, pero sin datos: " + sinDatos.join(", ") + "." };
    }
    const filas = RVTOOLS_PESTANAS_NECESARIAS.map(function (p) {
      return p + ": " + (ss.getSheetByName(p).getLastRow() - 1);
    });
    return { estado: "ok", detalle: presentes.length + " pestañas. Filas -> " + filas.join(", ") + "." };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (_rvtoolsErrorEsPasajero(msg)) {
      return { estado: "no_verificable", detalle: "No se pudo revisar ahora (se reintenta): " + msg };
    }
    return { estado: "roto", detalle: "No se pudo abrir: el archivo está dañado o no es un Excel válido. " + msg };
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e) {
        Logger.log("[RVTools] No se pudo borrar la copia temporal " + tempId + ": " + e.message);
      }
    }
  }
}

/** Un fallo de Drive que conviene reintentar en vez de culpar al archivo. */
function _rvtoolsErrorEsPasajero(mensaje) {
  const m = String(mensaje || "").toLowerCase();
  // "Exceeded maximum execution time" es el mensaje real de Apps Script cuando se corta por
  // tiempo, y no contiene la palabra "timeout": sin "exceeded" acá, un archivo sano que tarda
  // demasiado en convertirse quedaba marcado como roto.
  return ["timeout", "time out", "execution time", "exceeded", "limit", "rate", "quota",
    "internal error", "unavailable", "try again", "temporar", "abort", "backend",
    "503", "500"].some(function (p) {
    return m.indexOf(p) !== -1;
  });
}

// --- Memoria de verificaciones --------------------------------------------------------------

/** Identifica una versión concreta de un archivo: si se re-sube, cambia. */
function _rvtoolsHuella(planilla) {
  return planilla.id + ":" + planilla.actualizadoMs + ":" + planilla.bytes;
}

function _rvtoolsTabVerificacion(ss, crearSiFalta) {
  let tab = ss.getSheetByName(RVTOOLS_TAB_VERIFICACION);
  if (!tab && crearSiFalta) {
    tab = ss.insertSheet(RVTOOLS_TAB_VERIFICACION);
    tab.getRange(1, 1, 1, RVTOOLS_COLS_VERIFICACION.length).setValues([RVTOOLS_COLS_VERIFICACION])
      .setFontWeight("bold").setBackground("#1A5276").setFontColor("#FFFFFF");
    tab.setFrozenRows(1);
  }
  return tab;
}

/** Lo ya verificado, por huella. */
function rvtoolsLeerMemoria(idSpreadsheet) {
  const memoria = {};
  try {
    const tab = _rvtoolsTabVerificacion(SpreadsheetApp.openById(idSpreadsheet), false);
    if (!tab || tab.getLastRow() < 2) return memoria;
    tab.getRange(2, 1, tab.getLastRow() - 1, RVTOOLS_COLS_VERIFICACION.length).getValues().forEach(function (r) {
      if (r[0]) memoria[String(r[0])] = { estado: String(r[4] || ""), detalle: String(r[5] || "") };
    });
  } catch (e) {
    Logger.log("[RVTools] No se pudo leer la memoria de verificaciones: " + e.message);
  }
  return memoria;
}

/** Guarda resultados definitivos (ok o roto). Los 'no_verificable' no se guardan a propósito. */
function rvtoolsGuardarEnMemoria(idSpreadsheet, nuevos) {
  if (!nuevos || !nuevos.length) return;
  const candado = LockService.getScriptLock();
  try {
    candado.waitLock(20000);
  } catch (e) {
    Logger.log("[RVTools] No se pudo tomar el candado para guardar verificaciones.");
    return;
  }
  try {
    const ss = SpreadsheetApp.openById(idSpreadsheet);
    const tab = _rvtoolsTabVerificacion(ss, true);
    const filas = nuevos.map(function (n) {
      return [n.huella, n.cliente, n.carpeta, n.archivo, n.estado, n.detalle, new Date()];
    });
    tab.getRange(tab.getLastRow() + 1, 1, filas.length, RVTOOLS_COLS_VERIFICACION.length).setValues(filas);
    tab.getRange(2, 7, tab.getLastRow() - 1, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");

    // Las huellas viejas ya no le sirven a nadie: se van las más antiguas.
    const sobran = tab.getLastRow() - 1 - RVTOOLS_VERIF_MAX_FILAS;
    if (sobran > 0) tab.deleteRows(2, sobran);
  } catch (e) {
    Logger.log("[RVTools] No se pudieron guardar las verificaciones: " + e.message);
  } finally {
    candado.releaseLock();
  }
}

/**
 * Nivel 2 con memoria y presupuesto. Devuelve el estado del conjunto de planillas de un
 * cliente, abriendo solo las que todavía no se verificaron en su versión actual.
 *
 * @param {Object} contexto {memoria, nuevos, comenzoEn, abiertos} compartido entre clientes,
 *   para que el presupuesto sea de la vuelta entera y no de cada cliente por separado.
 * @returns {{estado: 'ok'|'roto'|'pendiente', detalle: string}}
 */
function rvtoolsVerificarPlanillas(cliente, nombreCarpeta, planillas, contexto) {
  const rotos = [];
  let pendientes = 0;
  let verificadas = 0;

  for (const planilla of planillas) {
    const huella = _rvtoolsHuella(planilla);
    let resultado = contexto.memoria[huella];

    if (!resultado) {
      const sinTiempo = (Date.now() - contexto.comenzoEn) / 1000 >= RVTOOLS_VERIF_SEGUNDOS;
      const sinCupo = contexto.abiertos >= RVTOOLS_VERIF_MAX_ARCHIVOS;
      if (sinTiempo || sinCupo) {
        pendientes++;
        continue;
      }
      Logger.log("[RVTools] Verificando " + cliente + " / " + planilla.nombre + " (" + rvtoolsTamanoLegible(planilla.bytes) + ")...");
      resultado = rvtoolsVerificarPlanilla(planilla.id, planilla.nombre);
      contexto.abiertos++;
      if (resultado.estado === "no_verificable") {
        Logger.log("[RVTools] " + planilla.nombre + ": " + resultado.detalle);
        pendientes++;
        continue;
      }
      contexto.memoria[huella] = resultado;
      contexto.nuevos.push({
        huella: huella, cliente: cliente, carpeta: nombreCarpeta,
        archivo: planilla.nombre, estado: resultado.estado, detalle: resultado.detalle
      });
    }

    if (resultado.estado === "roto") rotos.push(planilla.nombre + " (" + resultado.detalle + ")");
    else verificadas++;
  }

  if (rotos.length) {
    return { estado: "roto", detalle: "Archivo con problemas: " + rotos.join(" | ") };
  }
  if (pendientes) {
    return {
      estado: "pendiente",
      detalle: verificadas + " de " + planillas.length + " planilla(s) revisada(s); " + pendientes + " queda(n) para la próxima actualización."
    };
  }
  return { estado: "ok", detalle: "Las " + planillas.length + " planilla(s) abren y tienen datos." };
}
