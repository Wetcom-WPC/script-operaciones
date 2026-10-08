// ─── Corrección a mano del semáforo (cliente × tecnología × día) ────────────────────────
//
// El semáforo deduce "se envió" de dos cosas: el tilde del Índice y el log de envíos. Las dos
// dependen de que alarmas@wetcom.com vaya en copia. Cuando alguien manda el reporte y se
// olvida de la copia, el mail SALIÓ pero acá figura en rojo, y no había forma de corregirlo:
// la celda quedaba mintiendo todo el día y el cliente aparecía como incompleto.
//
// Esto permite forzar el estado de una celda. No reescribe el log ni el Índice (esos son el
// registro de lo que el sistema vio, y falsearlos sería peor): se guarda aparte, se aplica
// encima al mostrar, y la celda queda marcada como corregida a mano con quién lo hizo y por
// qué. El motivo es obligatorio a propósito — una celda en verde sin explicación es
// exactamente el fallo silencioso que AGENTS.md §7 pide no fabricar.

const WEBAPP_TAB_CORRECCIONES = 'Envíos Corregidos a Mano';
const WEBAPP_COLS_CORRECCIONES = ['Fecha', 'Cliente', 'Clave Cliente', 'Tecnología', 'Estado', 'Motivo', 'Autor', 'Actualizado'];
const WEBAPP_TAB_HISTORIAL_CORRECCIONES = 'Historial de Correcciones';
const WEBAPP_COLS_HISTORIAL_CORRECCIONES = ['Cuándo', 'Acción', 'Quién', 'Fecha del envío', 'Cliente', 'Tecnología',
  'Estado anterior', 'Estado nuevo', 'Motivo anterior', 'Motivo nuevo'];
const WEBAPP_CORRECCION_MOTIVO_MAX = 300;
// Los dos únicos estados que se pueden forzar. 'enviado' es el caso real (salió sin copia a
// alarmas@); 'no_enviado' existe para el inverso: el log registró algo que en realidad no se
// mandó al cliente.
const WEBAPP_CORRECCION_ESTADOS = ['enviado', 'no_enviado'];

/** Clave de una corrección dentro del día: "<cliente normalizado>|<tecnología>". */
function _webappClaveCorreccion(clave, tecnologia) {
  return clave + '|' + tecnologia;
}

/** Una celda que empieza con = + - @ la toma Sheets como fórmula. La comilla la neutraliza. */
function _webappTextoSeguro(texto) {
  const s = String(texto || '');
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/**
 * Correcciones de una fecha, indexadas por "<clave cliente>|<tecnología>".
 * Sin pestaña (nadie corrigió nunca nada) no es un error: devuelve {}.
 */
function _webappLeerCorrecciones(ss, fechaISO) {
  const tab = ss.getSheetByName(WEBAPP_TAB_CORRECCIONES);
  if (!tab || tab.getLastRow() < 2) return {};
  const filas = tab.getRange(2, 1, tab.getLastRow() - 1, WEBAPP_COLS_CORRECCIONES.length).getValues();
  const porClave = {};
  filas.forEach(function (r) {
    const fecha = _webappFechaISO(r[0]);
    if (fechaISO && fecha !== fechaISO) return;
    const clave = String(r[2] || '');
    const tecnologia = String(r[3] || '');
    if (!clave || !tecnologia) return;
    porClave[_webappClaveCorreccion(clave, tecnologia)] = {
      fecha: fecha,
      cliente: String(r[1] || ''),
      tecnologia: tecnologia,
      estado: String(r[4] || '').trim().toLowerCase(),
      motivo: String(r[5] || '').replace(/^'(?=[=+\-@])/, ''),
      autor: String(r[6] || ''),
      actualizado: r[7] instanceof Date ? Utilities.formatDate(r[7], HORARIO_OPERATIVO_TZ, 'dd/MM HH:mm') : String(r[7] || '')
    };
  });
  return porClave;
}

function _webappRegistrarHistorialCorreccion(ss, accion, usuario, fecha, cliente, tecnologia, anterior, nuevo) {
  let tab = ss.getSheetByName(WEBAPP_TAB_HISTORIAL_CORRECCIONES);
  if (!tab) {
    tab = ss.insertSheet(WEBAPP_TAB_HISTORIAL_CORRECCIONES);
    tab.getRange(1, 1, 1, WEBAPP_COLS_HISTORIAL_CORRECCIONES.length).setValues([WEBAPP_COLS_HISTORIAL_CORRECCIONES])
      .setFontWeight('bold').setBackground('#1A5276').setFontColor('#FFFFFF');
    tab.setFrozenRows(1);
  }
  tab.appendRow([
    new Date(), accion, usuario, fecha, cliente, tecnologia,
    anterior ? anterior.estado : '', nuevo ? nuevo.estado : '',
    anterior ? _webappTextoSeguro(anterior.motivo) : '', nuevo ? _webappTextoSeguro(nuevo.motivo) : ''
  ]);
}

/**
 * Fuerza (o deshace) el estado de una celda del semáforo.
 *
 * @param {Object} datos
 * @param {string} datos.fecha      Día del envío, 'yyyy-MM-dd'. No se aceptan fechas futuras.
 * @param {string} datos.cliente    Nombre del cliente tal como lo muestra el semáforo.
 * @param {string} datos.tecnologia Una de WEBAPP_TECHS_SEMAFORO.
 * @param {string} datos.estado     'enviado', 'no_enviado', o vacío para quitar la corrección.
 * @param {string} datos.motivo     Por qué. Obligatorio salvo que se esté quitando.
 * @param {string} [datos.sheetId]  Planilla de logs (selector de entorno).
 * @returns {Object} La corrección guardada, o {borrado:true} si se quitó.
 */
function webapp_corregirEnvio(datos) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAdmin(usuario);
  datos = datos || {};

  const sheetId = datos.sheetId || WEBAPP_LOGS_PROD_ID;
  if (sheetId !== WEBAPP_LOGS_PROD_ID && sheetId !== WEBAPP_LOGS_TEST_ID) throw new Error('Planilla de logs no reconocida.');

  const fecha = String(datos.fecha || '');
  const hoy = Utilities.formatDate(new Date(), HORARIO_OPERATIVO_TZ, 'yyyy-MM-dd');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > hoy) throw new Error('Fecha inválida.');

  const tecnologia = String(datos.tecnologia || '');
  if (WEBAPP_TECHS_SEMAFORO.indexOf(tecnologia) === -1) throw new Error('Tecnología no reconocida: ' + tecnologia);

  const cliente = _webappTexto(datos.cliente, 120).trim();
  const clave = _webappClaveCliente(cliente);
  if (!clave) throw new Error('Falta el cliente.');

  const estado = String(datos.estado || '').trim().toLowerCase();
  if (estado && WEBAPP_CORRECCION_ESTADOS.indexOf(estado) === -1) throw new Error('Estado no reconocido: ' + estado);

  const motivo = String(datos.motivo || '').trim();
  if (estado && !motivo) throw new Error('Para corregir una celda a mano hay que decir por qué.');
  if (motivo.length > WEBAPP_CORRECCION_MOTIVO_MAX) {
    throw new Error('El motivo supera los ' + WEBAPP_CORRECCION_MOTIVO_MAX + ' caracteres.');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Otra persona está guardando una corrección; probá de nuevo en unos segundos.');
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    let tab = ss.getSheetByName(WEBAPP_TAB_CORRECCIONES);
    if (!tab) {
      tab = ss.insertSheet(WEBAPP_TAB_CORRECCIONES);
      tab.getRange(1, 1, 1, WEBAPP_COLS_CORRECCIONES.length).setValues([WEBAPP_COLS_CORRECCIONES])
        .setFontWeight('bold').setBackground('#1A5276').setFontColor('#FFFFFF');
      tab.setFrozenRows(1);
    }

    let filaExistente = -1;
    let anterior = null;
    if (tab.getLastRow() > 1) {
      const valores = tab.getRange(2, 1, tab.getLastRow() - 1, 6).getValues();
      for (let i = 0; i < valores.length; i++) {
        if (_webappFechaISO(valores[i][0]) === fecha && String(valores[i][2]) === clave && String(valores[i][3]) === tecnologia) {
          filaExistente = i + 2;
          anterior = {
            estado: String(valores[i][4] || '').trim().toLowerCase(),
            motivo: String(valores[i][5] || '').replace(/^'(?=[=+\-@])/, '')
          };
          break;
        }
      }
    }

    // Primero el historial y después el cambio: si no se puede dejar constancia, no se cambia
    // nada. Una celda en verde sin rastro de quién la puso ahí es peor que una en rojo.
    if (!estado) {
      if (filaExistente > 0) {
        _webappRegistrarHistorialCorreccion(ss, 'Quitado', usuario, fecha, cliente, tecnologia, anterior, null);
        tab.deleteRow(filaExistente);
      }
      Logger.log('[WebApp] Corrección quitada por ' + usuario + ': ' + fecha + ' ' + cliente + ' ' + tecnologia);
      return { borrado: true, fecha: fecha, clave: clave, tecnologia: tecnologia };
    }

    const nuevo = { estado: estado, motivo: motivo };
    const sinCambios = anterior && anterior.estado === estado && anterior.motivo === motivo;
    if (!sinCambios) {
      _webappRegistrarHistorialCorreccion(ss, anterior ? 'Editado' : 'Creado', usuario, fecha, cliente, tecnologia, anterior, nuevo);
    }

    const fila = [fecha, cliente, clave, tecnologia, estado, _webappTextoSeguro(motivo), usuario, new Date()];
    if (filaExistente > 0) {
      tab.getRange(filaExistente, 1, 1, WEBAPP_COLS_CORRECCIONES.length).setValues([fila]);
    } else {
      tab.appendRow(fila);
    }

    Logger.log('[WebApp] Envío corregido a mano por ' + usuario + ': ' + fecha + ' ' + cliente + ' ' + tecnologia + ' -> ' + estado);
    return {
      fecha: fecha, clave: clave, cliente: cliente, tecnologia: tecnologia,
      estado: estado, motivo: motivo, autor: usuario
    };
  } finally {
    lock.releaseLock();
  }
}
