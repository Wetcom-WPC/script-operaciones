/**
 * @fileoverview Quién puede ver qué en el panel.
 *
 * Hasta ahora el panel no distinguía usuarios: el deploy se publica para todo el dominio
 * (`"access": "DOMAIN"` en appsscript.json) y el filtro opcional de Script Properties, si está
 * vacío, deja entrar a todos. Es decir que cualquier cuenta @wetcom.com podía no solo mirar,
 * sino ejecutar las acciones del panel —tildar la casilla del Índice, que dispara el mail al
 * cliente, o lanzar el ciclo de operaciones—, y todo eso corriendo como alarmas@.
 *
 * Esto habilita abrirlo a los PODs sin regalar esas acciones.
 *
 * DOS COSAS IMPORTANTES
 *
 * 1. El control es del SERVIDOR. Esconder un botón en el HTML no protege nada: desde la
 *    consola del navegador se puede llamar a cualquier función del servidor. Por eso el rol se
 *    verifica dentro de cada función, y los datos se filtran antes de devolverlos — si se
 *    mandaran todos y se filtraran en el navegador, se verían igual con F12.
 *
 * 2. Quien pueda EDITAR la planilla de logs puede darse permiso de admin a sí mismo. La
 *    pestaña tiene que vivir en una planilla compartida solo con el equipo; a los PODs no hay
 *    que darles acceso de edición ahí. El panel no necesita que la tengan: la lee alarmas@.
 */

const WEBAPP_TAB_PERMISOS = 'Permisos del Panel';
const WEBAPP_COLS_PERMISOS = ['Email', 'Rol', 'PODs', 'Activo', 'Notas', 'Actualizado'];

// Los dos roles que existen hoy.
//   admin -> ve todo el panel y puede ejecutar las acciones.
//   pod   -> solo lectura, y solo de los PODs que tenga asignados.
const WEBAPP_ROL_ADMIN = 'admin';
const WEBAPP_ROL_POD   = 'pod';

// Secciones que puede abrir cada rol. El navegador usa esto para mostrar solo lo que
// corresponde, pero NO es el control de acceso: eso lo hace cada función del servidor.
const WEBAPP_SECCIONES_POR_ROL = {
  admin: ['inicio', 'operaciones', 'indice', 'llegadas', 'logs', 'jira', 'reportes', 'permisos'],
  pod:   ['operaciones', 'llegadas']
};

/** Caché por ejecución: la pestaña se lee una sola vez aunque la pregunten diez funciones. */
let _webappPermisosCache = null;

/**
 * Lee la pestaña de permisos.
 * @returns {{filas: Object, configurado: boolean}} filas indexadas por email en minúsculas.
 */
function _webappLeerPermisos() {
  if (_webappPermisosCache) return _webappPermisosCache;

  const resultado = { filas: {}, configurado: false };
  try {
    const ss = SpreadsheetApp.openById(WEBAPP_LOGS_PROD_ID);
    const tab = ss.getSheetByName(WEBAPP_TAB_PERMISOS);
    if (tab && tab.getLastRow() > 1) {
      tab.getRange(2, 1, tab.getLastRow() - 1, WEBAPP_COLS_PERMISOS.length).getValues()
        .forEach(function (r) {
          const email = String(r[0] || '').trim().toLowerCase();
          if (!email) return;
          const activo = String(r[3] || '').trim().toUpperCase();
          // Vacío cuenta como activo: así agregar a alguien es escribir su mail y nada más.
          if (activo === 'NO') return;
          const rol = String(r[1] || '').trim().toLowerCase() === WEBAPP_ROL_ADMIN
            ? WEBAPP_ROL_ADMIN : WEBAPP_ROL_POD;
          const pods = String(r[2] || '').split(',')
            .map(function (p) { return p.trim().toUpperCase(); })
            .filter(function (p) { return p; });
          resultado.filas[email] = { email: email, rol: rol, pods: pods, notas: String(r[4] || '') };
          resultado.configurado = true;
        });
    }
  } catch (e) {
    // Si la planilla no se puede leer NO se abre la puerta: se corta. Un error de lectura no
    // puede convertirse en "pasa cualquiera" (AGENTS.md §7).
    Logger.log('[WebApp] No se pudo leer la pestaña de permisos: ' + e.message);
    throw new Error('No se pudo verificar tus permisos. Probá de nuevo en unos segundos.');
  }

  _webappPermisosCache = resultado;
  return resultado;
}

/**
 * Qué puede hacer una persona.
 *
 * Mientras la pestaña NO exista o esté vacía, todos entran como admin: es exactamente el
 * comportamiento de hoy, para que desplegar esto no deje al equipo afuera del panel de un día
 * para el otro. Apenas se carga la primera fila, la pestaña manda y quien no figure queda
 * afuera.
 *
 * @param {string} email
 * @returns {{email: string, rol: string, pods: Array<string>, todo: boolean,
 *            configurado: boolean, secciones: Array<string>}}
 */
function webapp_permisoDe(email) {
  const mail = String(email || '').trim().toLowerCase();
  const permisos = _webappLeerPermisos();

  if (!permisos.configurado) {
    Logger.log('[WebApp] La pestaña "' + WEBAPP_TAB_PERMISOS + '" está vacía o no existe: ' +
      'todo el dominio entra como admin. Cargarla para activar los roles.');
    return {
      email: mail, rol: WEBAPP_ROL_ADMIN, pods: [], todo: true,
      configurado: false, secciones: WEBAPP_SECCIONES_POR_ROL.admin
    };
  }

  const fila = permisos.filas[mail];
  if (!fila) {
    return { email: mail, rol: null, pods: [], todo: false, configurado: true, secciones: [] };
  }

  const esAdmin = fila.rol === WEBAPP_ROL_ADMIN;
  return {
    email: mail,
    rol: fila.rol,
    pods: fila.pods,
    todo: esAdmin,
    configurado: true,
    secciones: WEBAPP_SECCIONES_POR_ROL[fila.rol] || []
  };
}

/** El permiso de quien está llamando ahora. */
function webapp_permisoActual() {
  return webapp_permisoDe(webapp_usuarioActual());
}

/**
 * Corta si quien llama no puede entrar al panel.
 * @param {string} usuario
 * @returns {Object} El permiso, para no tener que volver a calcularlo.
 */
function webapp_exigirPermiso(usuario) {
  // Session.getActiveUser() devuelve vacío en algunos casos (cuenta fuera del dominio, o
  // ciertos contextos de ejecución). Sin esto, esa persona caería en el "no figura en la
  // pestaña" y se le diría que pida permiso, cuando el problema es otro y pedir permiso no lo
  // arregla. Distinguirlo es la diferencia entre un pedido al equipo y un ticket.
  if (!String(usuario || '').trim()) {
    Logger.log('[WebApp] No se pudo identificar al usuario (getActiveUser vacío).');
    throw new Error('No se pudo identificar tu cuenta de Google. Entrá con tu cuenta @wetcom.com, ' +
      'o avisale al equipo de Operaciones si ya estás con ella.');
  }

  const permiso = webapp_permisoDe(usuario);
  if (!permiso.rol) {
    Logger.log('[WebApp] Acceso denegado a "' + usuario + '": no figura en ' + WEBAPP_TAB_PERMISOS);
    throw new Error('No tenés permiso para usar este panel. Pedíselo al equipo de Operaciones.');
  }
  if (permiso.rol === WEBAPP_ROL_POD && permiso.pods.length === 0) {
    Logger.log('[WebApp] "' + usuario + '" tiene rol pod pero ningún POD asignado.');
    throw new Error('Tu usuario no tiene ningún POD asignado. Avisale al equipo de Operaciones.');
  }
  return permiso;
}

/**
 * Corta si quien llama no es admin. Va en TODA función que modifique algo o que exponga
 * información que no es del POD de quien pregunta.
 * @param {string} usuario
 * @returns {Object} El permiso.
 */
function webapp_exigirAdmin(usuario) {
  const permiso = webapp_exigirPermiso(usuario);
  if (!permiso.todo) {
    Logger.log('[WebApp] "' + usuario + '" (rol ' + permiso.rol + ') intentó una acción de admin.');
    throw new Error('Esta acción es solo para el equipo de Operaciones.');
  }
  return permiso;
}

/** ¿Este POD le corresponde a quien pregunta? */
function webapp_puedeVerPod(permiso, pod) {
  if (!permiso) return false;
  if (permiso.todo) return true;
  return permiso.pods.indexOf(String(pod || '').trim().toUpperCase()) !== -1;
}

/**
 * Deja en la lista solo lo que le corresponde ver a quien pregunta.
 *
 * Se filtra ACÁ y no en el navegador a propósito: si los datos de todos los PODs viajaran al
 * cliente, se verían igual abriendo las herramientas de desarrollo.
 *
 * @param {Array} lista
 * @param {Object} permiso
 * @param {Function} podDe Devuelve el POD de un elemento de la lista.
 */
function webapp_filtrarPorPod(lista, permiso, podDe) {
  if (!lista || !lista.length) return [];
  if (permiso && permiso.todo) return lista;
  return lista.filter(function (x) { return webapp_puedeVerPod(permiso, podDe(x)); });
}

// ─── Administración desde el panel ──────────────────────────────────────────────────────

/** La pestaña, creándola con sus encabezados si todavía no existe. */
function _webappTabPermisos(ss, crearSiFalta) {
  let tab = ss.getSheetByName(WEBAPP_TAB_PERMISOS);
  if (!tab && crearSiFalta) {
    tab = ss.insertSheet(WEBAPP_TAB_PERMISOS);
    tab.getRange(1, 1, 1, WEBAPP_COLS_PERMISOS.length).setValues([WEBAPP_COLS_PERMISOS])
      .setFontWeight('bold').setBackground('#1A5276').setFontColor('#FFFFFF');
    tab.setFrozenRows(1);
    tab.setColumnWidth(1, 240);
    tab.setColumnWidth(3, 140);
    tab.setColumnWidth(5, 260);
  }
  return tab;
}

/**
 * Los permisos cargados, para la pestaña de administración. Solo admin.
 * @returns {Object}
 */
function webapp_listarPermisos() {
  const permiso = webapp_exigirAdmin(webapp_usuarioActual());
  const permisos = _webappLeerPermisos();
  const filas = Object.keys(permisos.filas).map(function (k) { return permisos.filas[k]; });
  filas.sort(function (a, b) {
    if (a.rol !== b.rol) return a.rol === WEBAPP_ROL_ADMIN ? -1 : 1;
    return a.email.localeCompare(b.email);
  });
  return {
    configurado: permisos.configurado,
    yo: permiso.email,
    roles: [WEBAPP_ROL_ADMIN, WEBAPP_ROL_POD],
    permisos: filas
  };
}

/**
 * Da de alta, modifica o elimina el permiso de una persona. Solo admin.
 *
 * @param {Object} datos
 * @param {string} datos.email  A quién.
 * @param {string} datos.rol    'admin' o 'pod'. Vacío = eliminar.
 * @param {string} datos.pods   PODs separados por coma. Solo aplica al rol 'pod'.
 * @param {string} [datos.notas]
 */
function webapp_guardarPermiso(datos) {
  const usuario = webapp_usuarioActual();
  const miPermiso = webapp_exigirAdmin(usuario);
  datos = datos || {};

  const email = String(datos.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Mail inválido: ' + datos.email);

  const rol = String(datos.rol || '').trim().toLowerCase();
  if (rol && rol !== WEBAPP_ROL_ADMIN && rol !== WEBAPP_ROL_POD) throw new Error('Rol no reconocido: ' + rol);

  // Nadie se puede sacar a sí mismo el permiso de admin: si lo hiciera y fuera el último, la
  // pestaña quedaría sin nadie que pueda editarla y habría que arreglarla a mano en la planilla.
  if (email === miPermiso.email && rol !== WEBAPP_ROL_ADMIN) {
    throw new Error('No podés quitarte a vos mismo el permiso de admin.');
  }

  const pods = String(datos.pods || '').split(',')
    .map(function (p) { return p.trim().toUpperCase(); })
    .filter(function (p) { return p; });
  if (rol === WEBAPP_ROL_POD && pods.length === 0) {
    throw new Error('Un usuario con rol "pod" necesita al menos un POD asignado.');
  }

  const notas = String(datos.notas || '').trim().substring(0, 300);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Otra persona está editando los permisos; probá de nuevo.');
  try {
    const ss = SpreadsheetApp.openById(WEBAPP_LOGS_PROD_ID);
    const tab = _webappTabPermisos(ss, true);

    let fila = -1;
    if (tab.getLastRow() > 1) {
      const emails = tab.getRange(2, 1, tab.getLastRow() - 1, 1).getValues();
      for (let i = 0; i < emails.length; i++) {
        if (String(emails[i][0] || '').trim().toLowerCase() === email) { fila = i + 2; break; }
      }
    }

    if (!rol) {
      if (fila > 0) tab.deleteRow(fila);
      Logger.log('[WebApp] ' + usuario + ' eliminó el permiso de ' + email);
    } else {
      const valores = [email, rol, pods.join(','), 'SI', notas, new Date()];
      if (fila > 0) tab.getRange(fila, 1, 1, WEBAPP_COLS_PERMISOS.length).setValues([valores]);
      else tab.appendRow(valores);
      Logger.log('[WebApp] ' + usuario + ' guardó el permiso de ' + email + ': ' + rol +
        (pods.length ? ' (' + pods.join(',') + ')' : ''));
    }

    _webappPermisosCache = null;   // la próxima lectura ve el cambio
    return webapp_listarPermisos();
  } finally {
    lock.releaseLock();
  }
}
