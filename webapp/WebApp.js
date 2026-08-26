/**
 * @fileoverview Panel web de Operaciones. Es la fachada HTTP del proyecto: sirve la página
 * y expone las únicas funciones que el navegador puede invocar vía `google.script.run`.
 *
 * QUÉ PROBLEMA RESUELVE
 * El proyecto corre sobre la casilla alarmas@wetcom.com, a la que solo acceden el Tech Lead y
 * el SDM. En Apps Script, ejecutar una función a mano la corre sobre el Gmail de QUIEN la
 * ejecuta: para disparar un ciclo fuera de horario había que pedírselo a una de esas dos
 * personas y esperar a que estuviera disponible.
 *
 * Desplegada con `executeAs: USER_DEPLOYING` y publicada por alarmas@, esta WebApp corre
 * siempre sobre esa casilla, sin importar quién apriete el botón. El equipo obtiene dos cosas
 * que antes no tenía —lanzar el ciclo, y mirar en qué estado quedó cada reporte del día— sin
 * que nadie más necesite acceso al buzón.
 *
 * CÓMO SE DESPLIEGA: ver webapp/README-WEBAPP.md.
 */

/** Script Property (opcional) con emails separados por coma. Vacía = todo el dominio. */
const WEBAPP_PROP_AUTORIZADOS = 'WEBAPP_USUARIOS_AUTORIZADOS';

/** Script Property donde queda registrado el último lanzamiento manual (JSON). */
const WEBAPP_PROP_ULTIMO_LANZAMIENTO = 'WEBAPP_ULTIMO_LANZAMIENTO';

/**
 * Ventana mínima entre dos lanzamientos manuales.
 *
 * Cada lanzamiento crea un activador y Apps Script topea en 20 los activadores por usuario y
 * proyecto. Sin este freno, un doble clic nervioso (o dos personas a la vez) podría agotar la
 * cuota y dejar sin activadores al ciclo automático, que es el que sostiene la operación.
 */
const WEBAPP_COOLDOWN_MS = 60000;

/** Función del ciclo que dispara el botón. Es la misma que usa el activador diario. */
const WEBAPP_FUNCION_CICLO = 'ejecutarCicloDeOperaciones';

// --- Entrada HTTP --------------------------------------------------------------------------

/**
 * Punto de entrada de la WebApp.
 * @param {GoogleAppsScript.Events.DoGet} e
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  const usuario = webapp_usuarioActual();

  if (!webapp_estaAutorizado(usuario)) {
    return HtmlService.createTemplateFromFile('webapp/SinAcceso')
      .evaluate()
      .setTitle('Operaciones WETCOM')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  const plantilla = HtmlService.createTemplateFromFile('webapp/Index');
  // El JSON se incrusta dentro de un <script> de la página. Un asunto de correo que contenga
  // "</script>" cerraría el bloque antes de tiempo: escapando el "<" queda inofensivo y JSON
  // sigue siendo válido (< es el mismo carácter para el parser).
  plantilla.estadoInicial = JSON.stringify(webapp_estado()).replace(/</g, '\\u003c');

  return plantilla.evaluate()
    .setTitle('Operaciones WETCOM')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Inserta otro archivo HTML del proyecto dentro de una plantilla.
 * Se llama `webapp_include` y no `include` a propósito: en Apps Script todos los archivos
 * comparten un único scope global y un nombre genérico es una colisión esperando a pasar.
 * @param {string} nombre Ruta del archivo, ej. 'webapp/Estilos'.
 * @returns {string}
 */
function webapp_include(nombre) {
  return HtmlService.createHtmlOutputFromFile(nombre).getContent();
}

// --- Identidad y permisos ------------------------------------------------------------------

/**
 * @returns {string} Email de quien está usando el panel, o '' si Google no lo expone.
 */
function webapp_usuarioActual() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

/**
 * @returns {string} Casilla sobre la que corre realmente el código (la del deploy).
 */
function webapp_cuentaEfectiva() {
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

/**
 * Filtro opcional por encima del control de acceso del deploy.
 *
 * El deploy se publica para todo el dominio (es lo que hace innecesario repartir acceso al
 * buzón). Si en algún momento se quiere acotar a un grupo, alcanza con cargar la Script
 * Property `WEBAPP_USUARIOS_AUTORIZADOS` con los emails separados por coma — sin volver a
 * desplegar. Vacía o ausente, entra todo el dominio.
 *
 * @param {string} email
 * @returns {boolean}
 */
function webapp_estaAutorizado(email) {
  const crudo = PropertiesService.getScriptProperties().getProperty(WEBAPP_PROP_AUTORIZADOS);
  if (!crudo || !crudo.trim()) return true;

  const permitidos = crudo.split(',').map(function (x) { return x.trim().toLowerCase(); })
    .filter(function (x) { return x; });
  if (permitidos.length === 0) return true;

  return permitidos.indexOf(String(email || '').toLowerCase()) !== -1;
}

/** Corta la ejecución si quien llama no está en la lista. @param {string} usuario */
function webapp_exigirAutorizacion(usuario) {
  if (!webapp_estaAutorizado(usuario)) {
    throw new Error('No tenés permiso para usar este panel.');
  }
}

// --- API que consume el navegador ----------------------------------------------------------

/**
 * Estado inicial del panel. NO toca Gmail: devuelve la bandeja que haya en caché, para que
 * abrir la página sea barato. El escaneo real lo pide el botón "Actualizar".
 *
 * @returns {Object}
 */
function webapp_estado() {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  const ahora = new Date();
  const diaSemana = ahora.getDay();

  let feriado = false;
  try {
    feriado = esFeriadoHoy();
  } catch (e) {
    Logger.log('[WebApp] No se pudo consultar el calendario de feriados: ' + e.message);
  }

  return {
    usuario: usuario,
    cuenta: webapp_cuentaEfectiva(),
    testing: esEntornoTesting(),
    fecha: Utilities.formatDate(ahora, HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy'),
    hora: Utilities.formatDate(ahora, HORARIO_OPERATIVO_TZ, 'HH:mm'),
    ventana: { inicio: HORA_INICIO, fin: HORA_FIN },
    enVentana: ahora.getHours() >= HORA_INICIO && ahora.getHours() < HORA_FIN,
    finDeSemana: diaSemana < 1 || diaSemana > 5,
    feriado: feriado,
    cicloEnCurso: webapp_hayCicloEnCurso(),
    ultimoLanzamiento: webapp_leerUltimoLanzamiento(),
    bandeja: webapp_cacheLeer()
  };
}

/**
 * Dispara el ciclo de operaciones sobre la casilla del deploy.
 *
 * NO lo ejecuta acá adentro. Una llamada de `google.script.run` muere a los 6 minutos y el
 * ciclo está diseñado para encadenarse en varias ejecuciones (guarda el índice de la tarea
 * siguiente y se reprograma). Si el navegador cortara la ejecución a mitad de camino, la
 * cadena quedaría trunca: con `INDICE_SIGUIENTE_TAREA` a medias y sin activador que la retome,
 * el ciclo del día se detendría en seco.
 *
 * Por eso el botón crea un activador de una sola vez, exactamente igual a lo que hace el
 * propio ciclo cuando se reprograma (`crearNuevoActivador`). La respuesta vuelve al instante y
 * el ciclo corre después, con los 30 minutos completos de Apps Script a disposición.
 *
 * @param {boolean} [forzar=false] Lanzar aunque hoy sea feriado o fin de semana. El ciclo
 *   igual se va a omitir por diseño; sirve para dejar constancia en el log de ejecuciones.
 * @returns {Object} `{ok, codigo, mensaje, ...}` — `codigo` distingue los rechazos.
 */
function webapp_lanzarCiclo(forzar) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  const ahora = new Date();
  const diaSemana = ahora.getDay();
  const finDeSemana = diaSemana < 1 || diaSemana > 5;

  let feriado = false;
  try {
    feriado = esFeriadoHoy();
  } catch (e) {
    Logger.log('[WebApp] No se pudo consultar el calendario de feriados: ' + e.message);
  }

  // El ciclo se omite solo los fines de semana y feriados. Antes de gastar un activador en una
  // corrida que no va a hacer nada, se avisa y se pide confirmación explícita.
  if (!forzar && (finDeSemana || feriado)) {
    return {
      ok: false,
      codigo: 'DIA_NO_LABORAL',
      mensaje: 'Hoy es ' + (feriado ? 'feriado' : 'fin de semana') + '. El ciclo está programado ' +
        'para omitirse estos días: si lo lanzás igual, va a arrancar y salir sin procesar nada.'
    };
  }

  const ultimo = webapp_leerUltimoLanzamiento();
  if (ultimo && (Date.now() - new Date(ultimo.ts).getTime()) < WEBAPP_COOLDOWN_MS) {
    const faltan = Math.ceil((WEBAPP_COOLDOWN_MS - (Date.now() - new Date(ultimo.ts).getTime())) / 1000);
    return {
      ok: false,
      codigo: 'COOLDOWN',
      mensaje: 'Ya se lanzó un ciclo hace menos de un minuto (' + ultimo.usuario + '). ' +
        'Esperá ' + faltan + ' segundo/s.',
      ultimoLanzamiento: ultimo
    };
  }

  if (webapp_hayCicloEnCurso()) {
    return {
      ok: false,
      codigo: 'EN_CURSO',
      mensaje: 'Ya hay un ciclo corriendo en este momento. Cuando termine va a seguir solo con ' +
        'las tareas que falten; no hace falta lanzarlo de nuevo.'
    };
  }

  try {
    ScriptApp.newTrigger(WEBAPP_FUNCION_CICLO).timeBased().after(1000).create();
  } catch (e) {
    Logger.log('[WebApp] No se pudo crear el activador del ciclo: ' + e.message);
    return {
      ok: false,
      codigo: 'ERROR_ACTIVADOR',
      mensaje: 'No se pudo programar el ciclo: ' + e.message + '. Si dice que se llegó al ' +
        'límite de activadores, revisar los activadores del proyecto.'
    };
  }

  const registro = {
    usuario: usuario || '(desconocido)',
    ts: new Date().toISOString(),
    forzado: !!forzar
  };
  PropertiesService.getScriptProperties()
    .setProperty(WEBAPP_PROP_ULTIMO_LANZAMIENTO, JSON.stringify(registro));

  Logger.log('[WebApp] Ciclo lanzado manualmente por ' + registro.usuario +
    (forzar ? ' (forzado en día no laboral)' : ''));

  return {
    ok: true,
    codigo: 'LANZADO',
    mensaje: 'Ciclo lanzado. Arranca en unos segundos y sigue por su cuenta; podés cerrar esta ' +
      'página. El resultado se ve en "Ejecuciones" del proyecto de Apps Script.',
    ultimoLanzamiento: registro
  };
}

/**
 * Rehace la foto de la bandeja del día y la deja en caché.
 * @returns {Object} La estructura de bandeja (ver webapp_escanearBandeja).
 */
function webapp_actualizarBandeja() {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  const datos = webapp_escanearBandeja();
  webapp_cacheGuardar(datos);
  Logger.log('[WebApp] Bandeja actualizada por ' + usuario + ' en ' + datos.duracionMs + ' ms.');
  return datos;
}

// --- Auxiliares ----------------------------------------------------------------------------

/**
 * ¿Hay una ejecución del ciclo corriendo ahora mismo?
 *
 * Se pregunta por el candado del script, que es lo que el propio ciclo usa para no pisarse a
 * sí mismo. No se mira si existe un activador pendiente porque durante toda la ventana
 * operativa SIEMPRE hay uno (el ciclo se reprograma cada 5 minutos): eso daría "en curso" todo
 * el día. El candado se libera solo al terminar la ejecución.
 *
 * @returns {boolean}
 */
function webapp_hayCicloEnCurso() {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(500)) return true;
    lock.releaseLock();
    return false;
  } catch (e) {
    Logger.log('[WebApp] No se pudo consultar el candado del ciclo: ' + e.message);
    return false;
  }
}

/**
 * @returns {{usuario: string, ts: string, forzado: boolean}|null}
 */
function webapp_leerUltimoLanzamiento() {
  const crudo = PropertiesService.getScriptProperties().getProperty(WEBAPP_PROP_ULTIMO_LANZAMIENTO);
  if (!crudo) return null;
  try {
    return JSON.parse(crudo);
  } catch (e) {
    return null;
  }
}

/**
 * Comprobación rápida desde el editor de Apps Script, sin pasar por el navegador.
 * Deja en el log la URL del deploy activo, quién es la cuenta efectiva y cuántos correos ve.
 */
function manual_probarWebApp() {
  Logger.log('Cuenta efectiva (sobre la que corre la WebApp): ' + webapp_cuentaEfectiva());
  try {
    Logger.log('URL del deploy activo: ' + ScriptApp.getService().getUrl());
  } catch (e) {
    Logger.log('URL del deploy activo: (todavía no hay deploy de tipo WebApp)');
  }

  const datos = webapp_escanearBandeja();
  Logger.log('Bandeja del ' + datos.fecha + ' — escaneada en ' + datos.duracionMs + ' ms' +
    (datos.truncado ? ' (TRUNCADA: hay más correos de los que entraron en el tope)' : ''));
  datos.columnas.forEach(function (c) {
    Logger.log('  ' + c.titulo + ': ' + c.total);
  });
}
