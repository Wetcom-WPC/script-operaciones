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
function webapp_listaClientes() {
  const lista = [];
  try {
    const PROD_INDEX_ID = "1ZriSQeckRp_hWXS0X-CdGzrnnplCj2KmcLHgAbXo6qU";
    const spreadsheet = SpreadsheetApp.openById(PROD_INDEX_ID);
    const sheet = spreadsheet.getSheets()[0];
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const cli = data[i][1]; // Index 1 is Client Name
      const pkey = data[i][3]; // Index 3 is Project Key
      if (cli && typeof cli === 'string') {
        lista.push({ nombre: cli.trim(), key: (pkey || '').toString().toUpperCase().trim() });
      }
    }
  } catch (e) {
    Logger.log('[WebApp] Error leyendo clientes desde PROD_INDEX: ' + e.message);
  }
  return lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/**
 * Extrae los nombres de los miembros del equipo WPC para usarlos en queries JQL.
 * @returns {Array<string>} Lista de nombres formateados para JQL (incluye "currentUser()")
 */
function webapp_obtenerEquipoWPC() {
  let creadores = ["currentUser()"];
  try {
    const wpcSheetId = "14-l10On3DeGAhNPQu0qDI2bUHFmrkxlBYlG0Q1bSDZw";
    const sheetWPC = SpreadsheetApp.openById(wpcSheetId).getSheetByName("Equipo");
    if (sheetWPC) {
      const dataWPC = sheetWPC.getRange("A2:A").getValues();
      dataWPC.forEach(row => {
        const nombre = row[0];
        if (nombre && typeof nombre === 'string' && nombre.trim() !== '') {
          creadores.push(`"${nombre.trim()}"`);
        }
      });
    }
  } catch(e) {
    Logger.log("Error leyendo planilla Equipo WPC: " + e.message);
  }
  return creadores;
}

/**
 * Obtiene los datos de Jira para armar los gráficos interactivos.
 * @param {string} projectKey La clave del proyecto (Ops) del cliente.
 * @param {string} rango El filtro de tiempo (ej: 'mes_actual')
 */
function webapp_obtenerDatosGraficosJira(projectKey, rango) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  if (!projectKey || projectKey === 'ALL') {
    throw new Error("Debe seleccionar un cliente específico.");
  }

  // 1. Obtener claves de proyectos (Ops y Soporte) del Índice Maestro PROD
  const PROD_INDEX_ID = "1ZriSQeckRp_hWXS0X-CdGzrnnplCj2KmcLHgAbXo6qU";
  let keyOps = projectKey;
  let keySop = null;

  try {
    const sheet = SpreadsheetApp.openById(PROD_INDEX_ID).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const pkey = data[i][3]; // Columna D: Jira Project Key (Ops)
      const pkeySop = data[i][13]; // Columna N: Jira Project Key (Soporte)
      if (pkey && pkey.toString().toUpperCase().trim() === projectKey.toUpperCase()) {
        if (pkeySop) {
          keySop = pkeySop.toString().toUpperCase().trim();
        }
        break;
      }
    }
  } catch(e) {
    Logger.log("Error leyendo indice PROD para gráficos: " + e.message);
  }

  // 2. Construir JQL
  let jqlRango = `created >= startOfMonth()`; // default este mes
  if (rango === 'mes_pasado') {
    jqlRango = `created >= startOfMonth(-1) AND created < startOfMonth()`;
  } else if (rango === '30dias') {
    jqlRango = `created >= "-30d"`;
  } else if (rango === '7dias') {
    jqlRango = `created >= "-7d"`;
  }

  let proyectosStr = `"${keyOps}"`;
  if (keySop) proyectosStr += `, "${keySop}"`;

  // 3. Obtener nombres del equipo WPC
  const creadoresStr = webapp_obtenerEquipoWPC().join(", ");
  const jql = `project IN (${proyectosStr}) AND creator IN (${creadoresStr}) AND ${jqlRango} ORDER BY created DESC`;

  let allTickets = [];
  let nextPageToken = null;
  const maxResults = 100;

  try {
    while (true) {
      const payload = {
        "jql": jql,
        "maxResults": maxResults,
        "fields": ["key", "summary", "status", "created", "project", "customfield_12316"] 
      };
      
      if (nextPageToken) payload.nextPageToken = nextPageToken;

      const options = {
        "method": "post", 
        "contentType": "application/json",
        "headers": getJiraHeaders(),
        "payload": JSON.stringify(payload),
        "muteHttpExceptions": true
      };

      const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/search/jql`, options);
      if (respuesta.getResponseCode() !== 200) {
        Logger.log("Error consultando gráficos Jira: " + respuesta.getContentText());
        break;
      }
      
      const data = JSON.parse(respuesta.getContentText());
      if (data.issues) allTickets = allTickets.concat(data.issues);
      if (!data.nextPageToken) break;
      nextPageToken = data.nextPageToken;
    }
  } catch (e) {
    Logger.log('Error Jira Graficos: ' + e.message);
  }

  // 3. Procesar datos
  let ticketsOps = [];
  let ticketsSop = [];
  let tecMap = {};

  allTickets.forEach(issue => {
    const projKey = issue.fields.project.key.toUpperCase();
    const isOps = projKey === keyOps.toUpperCase();
    
    // Extraer tecnología
    let tec = "Desconocida / Sin asignar";
    if (issue.fields.customfield_12316 && issue.fields.customfield_12316.value) {
      tec = issue.fields.customfield_12316.value;
    }

    const t = {
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      statusCategory: issue.fields.status.statusCategory.colorName,
      created: issue.fields.created,
      tecnologia: tec
    };

    if (isOps) ticketsOps.push(t);
    else ticketsSop.push(t);

    if (!tecMap[tec]) tecMap[tec] = { ops: 0, sop: 0 };
    if (isOps) tecMap[tec].ops++;
    else tecMap[tec].sop++;
  });

  let seriesBarras = [];
  for (let tec in tecMap) {
    seriesBarras.push({
      tecnologia: tec,
      ops: tecMap[tec].ops,
      sop: tecMap[tec].sop
    });
  }

  return {
    ticketsOps,
    ticketsSop,
    stats: {
      totalOps: ticketsOps.length,
      totalSop: ticketsSop.length,
      barras: seriesBarras
    }
  };
}

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

  const hoyStr = Utilities.formatDate(ahora, HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy');
  
  let procesadosHoy = 0;
  let erroresHoy = 0;
  let faltantesHoy = 0;
  try {
    const cached = CacheService.getScriptCache().get('kpis_hoy_' + hoyStr);
    if (cached) {
      const kp = JSON.parse(cached);
      procesadosHoy = kp.procesados;
      erroresHoy = kp.errores;
      faltantesHoy = kp.faltantes;
    } else {
      const logs = webapp_obtenerLogs(100); // 100 rows is enough for a single day usually
      const hoyCorto = hoyStr.substring(0, 5); // dd/MM
      procesadosHoy = logs.estadoFinal.filter(function(l) {
        return l.fecha === hoyStr && (
          l.estado === 'Éxito' ||
          l.estado === 'SUCCESS' ||
          (l.estado && l.estado.toLowerCase().indexOf('resuelto') > -1)
        );
      }).length;
      erroresHoy = logs.erroresScript.filter(function(l) {
        return l.hora && l.hora.startsWith(hoyCorto);
      }).length;
      faltantesHoy = logs.reportesFaltantes.filter(function(l) {
        return l.fecha === hoyStr;
      }).length;
      CacheService.getScriptCache().put(
        'kpis_hoy_' + hoyStr,
        JSON.stringify({ procesados: procesadosHoy, errores: erroresHoy, faltantes: faltantesHoy }),
        300 // 5 minutos de caché
      );
    }
  } catch(e) {
    Logger.log("Error calculando KPIs de salud: " + e.message);
  }

  return {
    usuario: usuario,
    cuenta: webapp_cuentaEfectiva(),
    testing: esEntornoTesting(),
    fecha: hoyStr,
    hora: Utilities.formatDate(ahora, HORARIO_OPERATIVO_TZ, 'HH:mm'),
    ventana: { inicio: HORA_INICIO, fin: HORA_FIN },
    enVentana: ahora.getHours() >= HORA_INICIO && ahora.getHours() < HORA_FIN,
    finDeSemana: diaSemana < 1 || diaSemana > 5,
    feriado: feriado,
    cicloEnCurso: webapp_hayCicloEnCurso(),
    ultimoLanzamiento: webapp_leerUltimoLanzamiento(),
    bandeja: webapp_cacheLeer(),
    clientes: webapp_listaClientes(),
    kpis: {
      procesados: procesadosHoy,
      errores: erroresHoy,
      faltantes: faltantesHoy
    }
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

  // La marca se pone ANTES de crear el activador, no después: el activador dispara en un
  // segundo y si llegara a ganarle a esta escritura, el ciclo se tomaría por automático y
  // volvería a reprogramarse solo — justo lo que la corrida manual no debe hacer.
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_EJECUCION_MANUAL, 'true');

  try {
    ScriptApp.newTrigger(WEBAPP_FUNCION_CICLO).timeBased().after(1000).create();
  } catch (e) {
    props.deleteProperty(PROP_EJECUCION_MANUAL);
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
  props.setProperty(WEBAPP_PROP_ULTIMO_LANZAMIENTO, JSON.stringify(registro));

  Logger.log('[WebApp] Ciclo lanzado manualmente por ' + registro.usuario +
    (forzar ? ' (forzado en día no laboral)' : ''));

  return {
    ok: true,
    codigo: 'LANZADO',
    mensaje: 'Ciclo en ejecución, revisar executions en el proyecto.',
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

/**
 * Obtiene las ejecuciones recientes de todas las hojas de Logs.
 * @param {number} limite Cantidad máxima de logs a devolver por pestaña.
 * @returns {Object} Objeto con listas de logs para cada pestaña.
 */
function webapp_obtenerLogs(limite, overrideSheetId) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);
  
  if (!limite) limite = 50;
  
  const resultados = {
    estadoFinal: [],
    erroresScript: [],
    envioMails: [],
    reportesFaltantes: []
  };
  
  try {
    const logSheetId = overrideSheetId || WEBAPP_LOGS_PROD_ID || PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID") || (typeof LOG_SHEET_ID !== 'undefined' ? LOG_SHEET_ID : null);
    if (!logSheetId) return resultados;
    
    const ss = SpreadsheetApp.openById(logSheetId);

    function parsearFechaLog(val) {
      if (!val) return new Date();
      if (val instanceof Date) return val;
      const s = String(val).trim();
      const partes = s.split(' ');
      const fechaParte = partes[0].split('-');
      if (fechaParte.length === 3) {
        const anio = parseInt(fechaParte[0], 10);
        const mes = parseInt(fechaParte[1], 10) - 1;
        const dia = parseInt(fechaParte[2], 10);
        let hora = 0, min = 0, sec = 0;
        if (partes[1]) {
          const horaParte = partes[1].split(':');
          hora = parseInt(horaParte[0], 10) || 0;
          min = parseInt(horaParte[1], 10) || 0;
          sec = parseInt(horaParte[2], 10) || 0;
        }
        return new Date(anio, mes, dia, hora, min, sec);
      }
      const d = new Date(val);
      return isNaN(d.getTime()) ? new Date() : d;
    }
    
    // Función auxiliar para leer y formatear una hoja
    function procesarHoja(nombreHoja, mapeador) {
      const sheet = ss.getSheetByName(nombreHoja);
      if (!sheet) return [];
      const data = sheet.getDataRange().getValues();
      if (data.length <= 1) return [];
      
      const rows = data.slice(1);
      // Ordenar por la fecha/timestamp más reciente descendente
      rows.sort(function(a, b) {
        const d1 = parsearFechaLog(a[11] || a[0]).getTime();
        const d2 = parsearFechaLog(b[11] || b[0]).getTime();
        return (isNaN(d2) ? 0 : d2) - (isNaN(d1) ? 0 : d1);
      });
      
      const limiteReal = Math.min(rows.length, limite);
      const procesados = [];
      for (let i = 0; i < limiteReal; i++) {
        procesados.push(mapeador(rows[i]));
      }
      return procesados;
    }

    // 1. Estado Final
    resultados.estadoFinal = procesarHoja("Estado Final", function(r) {
      let d = parsearFechaLog(r[11] || r[0]);
      return {
        hora: Utilities.formatDate(d, HORARIO_OPERATIVO_TZ, 'HH:mm'),
        fecha: Utilities.formatDate(d, HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy'),
        operacion: r[1] || "",
        origen: r[2] || "",
        cliente: r[3] || "",
        pod: r[4] || "",
        intentos: r[5] || 0,
        estado: r[6] || "",
        ticketsCreados: r[7] || 0,
        ultimoError: r[10] || ""
      };
    });

    // 2. Errores del Script
    resultados.erroresScript = procesarHoja("Errores del Script", function(r) {
      let d = parsearFechaLog(r[0] ? (r[1] ? r[0] + ' ' + r[1] : r[0]) : new Date());
      const reincStr = (r[6] || "").toString().trim().toLowerCase();
      const esReinc = reincStr === "sí" || reincStr === "si" || reincStr === "true";
      return {
        hora: Utilities.formatDate(d, HORARIO_OPERATIVO_TZ, 'dd/MM HH:mm'),
        operacion: r[2] || "",
        origen: r[3] || "",
        cliente: r[4] || "",
        error: r[5] || "",
        reincidente: esReinc,
        diaSemana: r[7] || ""
      };
    });

    // 3. Envío de Mails
    resultados.envioMails = procesarHoja("Envío de Mails", function(r) {
      let horaStr = r[1];
      if (r[1] instanceof Date) {
        horaStr = Utilities.formatDate(r[1], HORARIO_OPERATIVO_TZ, 'HH:mm:ss');
      }
      // La fecha estaba en la hoja pero no se exponía, así que no se podía saber si una fila
      // era de hoy o de la semana pasada. La necesita el semáforo de la matriz (que solo mira
      // hoy) y la métrica de envíos fuera de horario.
      let fechaStr = r[0];
      if (r[0] instanceof Date) {
        fechaStr = Utilities.formatDate(r[0], HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy');
      }
      return {
        fecha: fechaStr || "-",
        horaStr: horaStr || "-",
        cliente: r[3] || "-",
        tecnologia: r[4] || "-",
        pod: r[5] || "-",
        estado: r[6] || "Desconocido",
        totalTickets: r[7] !== "" ? r[7] : 0,
        soporte: r[8] !== "" ? r[8] : 0,
        operaciones: r[9] !== "" ? r[9] : 0
      };
    });

    // 4. Reportes Faltantes
    resultados.reportesFaltantes = procesarHoja("Logs Reportes Faltantes", function(r) {
      // Fecha en col 0, Hora en col 1
      return {
        fecha: r[0] ? Utilities.formatDate(new Date(r[0]), HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy') : "-",
        hora: r[1] ? Utilities.formatDate(new Date(r[1]), HORARIO_OPERATIVO_TZ, 'HH:mm') : "-",
        cliente: r[2] || "",
        pod: r[3] || "",
        tecnologia: r[4] || "",
        operacion: r[5] || ""
      };
    });

  } catch (e) {
    Logger.log('[WebApp] Error obteniendo logs globales: ' + e.message);
  }
  
  return resultados;
}

/**
 * Consulta Jira para obtener los tickets del bot.
 * @param {string} rango "hoy" o "7dias"
 * @returns {Array<Object>} Lista de clientes con sus respectivos tickets
 */
function webapp_obtenerTicketsJira(rango, projectKey) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  let jqlRango = `created >= "-24h"`; // default hoy
  if (rango === "7dias") {
    jqlRango = `created >= "-7d"`;
  } else if (rango === "mes_actual") {
    jqlRango = `created >= startOfMonth()`;
  } else if (rango === "mes_pasado") {
    jqlRango = `created >= startOfMonth(-1) AND created < startOfMonth()`;
  }

  const creadoresStr = webapp_obtenerEquipoWPC().join(", ");
  let jql = `creator IN (${creadoresStr}) AND ${jqlRango}`;

  if (projectKey && projectKey !== "ALL") {
    jql += ` AND project = "${projectKey}"`;
  }
  
  jql += ` ORDER BY created DESC`;

  // 1. Ejecutar consulta JQL
  let allTickets = [];
  let nextPageToken = null;
  const maxResults = 100;
  
  try {
    while (true) {
      const payload = {
        "jql": jql,
        "maxResults": maxResults,
        "fields": ["key", "summary", "status", "created", "project"] 
      };
      
      if (nextPageToken) {
        payload.nextPageToken = nextPageToken;
      }

      const options = {
        "method": "post", 
        "contentType": "application/json",
        "headers": getJiraHeaders(),
        "payload": JSON.stringify(payload),
        "muteHttpExceptions": true
      };

      const respuesta = fetchWithRetries(`${JIRA_DOMAIN}/rest/api/3/search/jql`, options);
      const httpCode = respuesta.getResponseCode();
      
      if (httpCode !== 200) {
        Logger.log(`[JIRA] Error al buscar tickets en dashboard (HTTP ${httpCode}). Response: ${respuesta.getContentText()}`);
        break;
      }
      
      const data = JSON.parse(respuesta.getContentText());
      
      if (data.issues && data.issues.length > 0) {
        allTickets = allTickets.concat(data.issues);
      }
      
      if (!data.nextPageToken) {
        break; // ya trajimos todos
      }
      nextPageToken = data.nextPageToken;
    }
  } catch (e) {
    Logger.log('[WebApp] Error consultando tickets de Jira: ' + e.message);
  }

  // 2. Mapear Project Keys a Nombres de Clientes leyendo MASTER_INDEX
  const mapaClientes = {};
  try {
    const MASTER_INDEX_SHEET_ID = PropertiesService.getScriptProperties().getProperty("MASTER_INDEX_SHEET_ID");
    if (MASTER_INDEX_SHEET_ID) {
      const sheetData = SpreadsheetApp.openById(MASTER_INDEX_SHEET_ID).getSheets()[0].getDataRange().getValues();
      for (let i = 1; i < sheetData.length; i++) {
        const r = sheetData[i];
        const clienteNombre = r[1] ? r[1].toString().trim() : "";
        const opsKey = r[3] ? r[3].toString().trim().toUpperCase() : "";
        const sopKey = r[13] ? r[13].toString().trim().toUpperCase() : "";
        if (clienteNombre) {
          if (opsKey) mapaClientes[opsKey] = clienteNombre;
          if (sopKey) mapaClientes[sopKey] = clienteNombre;
        }
      }
    }
  } catch(e) {
    Logger.log("[WebApp] Error al leer Master Index para Jira: " + e.message);
  }

  // 3. Agrupar tickets por cliente
  const agrupado = {};
  allTickets.forEach(function(issue) {
    const pKey = issue.fields.project.key.toUpperCase();
    const clienteName = mapaClientes[pKey] || pKey; // fallback al project key si no está mapeado

    if (!agrupado[clienteName]) {
      agrupado[clienteName] = { cliente: clienteName, tickets: [] };
    }
    
    agrupado[clienteName].tickets.push({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      statusCategory: issue.fields.status.statusCategory.colorName,
      created: issue.fields.created
    });
  });

  // Convertir a array y ordenar por nombre
  const resultados = Object.keys(agrupado).map(function(k) { return agrupado[k]; });
  resultados.sort(function(a, b) {
    return a.cliente.localeCompare(b.cliente);
  });

  return resultados;
}

// --- Control del Índice y Envíos de Mail ----------------------------------------------------

/**
 * ID oficial del Índice General (Master Index / Configuración Operativa).
 */
const WEBAPP_INDICE_SPREADSHEET_ID = "1ZriSQeckRp_hWXS0X-CdGzrnnplCj2KmcLHgAbXo6qU";
const WEBAPP_LOGS_PROD_ID = "1O-iTAhWRonBcAp3xN7t5_y_TZTvyAtoBP0TIVAIzweQ";

/**
 * Obtiene el estado actual de todas las filas y checkboxes del Índice Operativo.
 * Columnas consultadas:
 *   Col B (2): Nombre Cliente Ops
 *   Col D (4): Jira Ops Key
 *   Col I (9): POD / Casilla destino
 *   Col L (12): Nombre Empresa
 *   Col M (13): Servicios habilitados (vsphere, veeam, nutanix, horizon, etc.)
 *   Col N (14): Jira Soporte Key
 *   Col R (18): Checkbox vSphere
 *   Col S (19): Checkbox Veeam
 *   Col T (20): Checkbox Nutanix
 *   Col U (21): Checkbox RVTools
 *
 * @returns {Object} Estado con lista de clientes y métricas resumidas
 */
function webapp_obtenerEstadoIndice() {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  const cacheKey = "webapp_estado_indice_v1";
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch(e) {}
  }

  const clientes = [];
  let casillasMarcadas = 0;

  try {
    const spreadsheet = SpreadsheetApp.openById(WEBAPP_INDICE_SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName("Sheet1") || spreadsheet.getSheets()[0];
    const lastRow = sheet.getLastRow();

    if (lastRow > 1) {
      // Tomamos desde la fila 2 hasta la última, hasta la columna 24 (X: Mail Nutanix Enviado)
      const data = sheet.getRange(2, 1, lastRow - 1, 24).getValues();

      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const filaNum = i + 2;

        const nombreOps     = row[1]  ? row[1].toString().trim()  : "";
        const opsKey        = row[3]  ? row[3].toString().trim().toUpperCase() : "";
        const podVal        = row[8]  ? row[8].toString().trim()  : "";
        const nombreEmpresa = row[11] ? row[11].toString().trim() : "";
        const servicios     = row[12] ? row[12].toString().toLowerCase() : "";
        const soporteKey    = row[13] ? row[13].toString().trim().toUpperCase() : "";

        // Omitir filas sin nombre o pruebas internas vacías
        const nombreBajo = nombreOps.toLowerCase();
        if (!nombreOps || nombreBajo === "true" || nombreBajo === "false" || nombreBajo.includes("testing") || nombreBajo.startsWith("wpc -") || podVal.toUpperCase() === "WPC") {
          continue;
        }

        const checkVsphere = row[17] === true || String(row[17]).toUpperCase() === "TRUE";
        const checkVeeam   = row[18] === true || String(row[18]).toUpperCase() === "TRUE";
        const checkNutanix = row[19] === true || String(row[19]).toUpperCase() === "TRUE";
        const checkRVTools = row[20] === true || String(row[20]).toUpperCase() === "TRUE";

        // Columnas V, W, X (Enviados hoy)
        const enviadoVsphere = row[21] === true || String(row[21]).toUpperCase() === "TRUE";
        const enviadoVeeam   = row[22] === true || String(row[22]).toUpperCase() === "TRUE";
        const enviadoNutanix = row[23] === true || String(row[23]).toUpperCase() === "TRUE";

        if (checkVsphere) casillasMarcadas++;
        if (checkVeeam) casillasMarcadas++;
        if (checkNutanix) casillasMarcadas++;
        if (checkRVTools) casillasMarcadas++;

        // Habilitaciones según columna Servicios
        const tieneVsphere = servicios.includes("vsphere");
        const tieneVeeam   = servicios.includes("veeam");
        const tieneNutanix = servicios.includes("nutanix");
        const tieneHorizon = servicios.includes("horizon");
        const tieneTanzu   = servicios.includes("tanzu");
        const tieneRVTools = servicios.includes("rvtools") || tieneVsphere;

        // Normalización de POD (ej: "POD1", "pod1@wetcom.com" -> "POD1")
        let podDisplay = podVal;
        if (podVal.includes("@")) {
          podDisplay = podVal.split("@")[0];
        }
        podDisplay = podDisplay.replace(/\s+/g, "").toUpperCase();
        if (!podDisplay) podDisplay = "-";

        clientes.push({
          fila: filaNum,
          nombre: nombreOps,
          empresa: nombreEmpresa || nombreOps,
          pod: podDisplay,
          podRaw: podVal,
          opsKey: opsKey,
          soporteKey: soporteKey,
          servicios: servicios,
          tecnologias: {
            vsphere: { habilitado: tieneVsphere, checked: checkVsphere, enviado: enviadoVsphere, col: 18 },
            veeam:   { habilitado: tieneVeeam,   checked: checkVeeam,   enviado: enviadoVeeam,   col: 19 },
            nutanix: { habilitado: tieneNutanix, checked: checkNutanix, enviado: enviadoNutanix, col: 20 },
            rvtools: { habilitado: tieneRVTools, checked: checkRVTools, col: 21 },
            horizon: { habilitado: tieneHorizon },
            // Tanzu no tiene casilla de "enviado" en el Índice: se manda a mano y se sabe que
            // salió por el mail en copia a alarmas@ (ver _webappSincronizarEnviosManuales).
            tanzu:   { habilitado: tieneTanzu, enviado: false }
          }
        });
      }
    }
  } catch (err) {
    Logger.log("[WebApp] Error al obtener estado del Índice: " + err.message);
    throw new Error("No se pudo leer el Índice Operativo: " + err.message);
  }

  // Ordenar PRIMERO por POD y luego alfabéticamente por cliente
  clientes.sort(function(a, b) {
    const podA = (a.pod || "").toUpperCase();
    const podB = (b.pod || "").toUpperCase();
    if (podA !== podB) {
      // Dejar los sin POD ("-") al final
      if (podA === "-") return 1;
      if (podB === "-") return -1;
      return podA.localeCompare(podB);
    }
    return a.nombre.localeCompare(b.nombre);
  });

  // Datos del próximo envío
  const proximo = webapp_calcularProximoEnvio();

  const resultado = {
    clientes: clientes,
    totalClientes: clientes.length,
    casillasMarcadas: casillasMarcadas,
    proximoEnvio: proximo,
    actualizadoEn: new Date().toISOString()
  };

  try {
    CacheService.getScriptCache().put(cacheKey, JSON.stringify(resultado), 45); // 45 segs
  } catch(e) {}

  return resultado;
}

/**
 * Modifica el valor de una casilla de verificación en el Índice Operativo.
 * @param {number} fila Número de fila en la Spreadsheet
 * @param {number} col Número de columna (18=vSphere, 19=Veeam, 20=Nutanix, 21=RVTools)
 * @param {boolean} nuevoValor true o false
 * @returns {Object} { ok: boolean, fila, col, nuevoValor }
 */
function webapp_marcarCheckboxIndice(fila, col, nuevoValor) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  // Validaciones de seguridad de fila y columna
  const colsPermitidas = [18, 19, 20, 21];
  if (!colsPermitidas.includes(Number(col))) {
    throw new Error("Columna no permitida para edición de checkbox: " + col);
  }
  if (!fila || Number(fila) < 2) {
    throw new Error("Número de fila inválido: " + fila);
  }

  const valBool = (nuevoValor === true || nuevoValor === "true");

  try {
    const spreadsheet = SpreadsheetApp.openById(WEBAPP_INDICE_SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName("Sheet1") || spreadsheet.getSheets()[0];
    
    // Escribir el nuevo valor boolean en la celda
    sheet.getRange(Number(fila), Number(col)).setValue(valBool);
    SpreadsheetApp.flush();

    // Invalidar el caché
    try {
      CacheService.getScriptCache().remove("webapp_estado_indice_v1");
    } catch(e) {}

    Logger.log(`[WebApp] Checkbox actualizado por ${usuario}: Fila ${fila}, Col ${col} -> ${valBool}`);

    return {
      ok: true,
      fila: Number(fila),
      col: Number(col),
      valor: valBool,
      mensaje: `Casilla actualizada correctamente (${valBool ? "Marcada" : "Desmarcada"}).`
    };
  } catch (err) {
    Logger.log(`[WebApp] Error al marcar checkbox en fila ${fila}, col ${col}: ${err.message}`);
    throw new Error("Error al actualizar la celda en el Índice: " + err.message);
  }
}

/**
 * Dispara el procesamiento manual de RVTools para un cliente puntual.
 * @param {number} fila Fila del cliente en la hoja
 * @param {string} clienteNombre Nombre del cliente
 */
function webapp_procesarRVToolsCliente(fila, clienteNombre) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  try {
    // 1. Marcar el checkbox U (21) en el Índice para trazabilidad
    webapp_marcarCheckboxIndice(fila, 21, true);

    // 2. Si la función de biblioteca o global está disponible, invocarla
    let mensajeRespuesta = "Procesamiento de RVTools solicitado y encolado en el Índice.";
    if (typeof AutomatizarOperaciones !== 'undefined' && typeof AutomatizarOperaciones.procesarRVTools === 'function') {
      AutomatizarOperaciones.procesarRVTools(clienteNombre);
      mensajeRespuesta = `RVTools procesado exitosamente para ${clienteNombre}.`;
    }

    return {
      ok: true,
      cliente: clienteNombre,
      mensaje: mensajeRespuesta
    };
  } catch(e) {
    Logger.log(`[WebApp] Error procesando RVTools para ${clienteNombre}: ${e.message}`);
    throw new Error("No se pudo iniciar el procesamiento de RVTools: " + e.message);
  }
}

/**
 * Calcula cuándo será la próxima ejecución programada del lote de envíos de correo.
 * Los triggers por defecto corren cada 5 minutos en la ventana 08:00 a 11:00 hs (GMT-3).
 */
function webapp_calcularProximoEnvio() {
  const ahora = new Date();
  const horaActual = ahora.getHours();
  const minutosActual = ahora.getMinutes();
  const diaSemana = ahora.getDay(); // 0=Dom, 6=Sab

  const finDeSemana = (diaSemana === 0 || diaSemana === 6);
  const dentroDeVentana = (horaActual >= 8 && horaActual < 11);

  // Calcular próximo múltiplo de 5 minutos
  const proxMin = Math.ceil((minutosActual + 1) / 5) * 5;
  let horaProx = horaActual;
  let minProx = proxMin;

  if (minProx >= 60) {
    horaProx += 1;
    minProx = 0;
  }

  let proximoTexto = "";
  let estadoVentana = "";

  if (finDeSemana) {
    estadoVentana = "FIN_DE_SEMANA";
    proximoTexto = "Próximo Lunes 08:00 hs";
  } else if (horaActual < 8) {
    estadoVentana = "ANTES_DE_VENTANA";
    proximoTexto = "Hoy 08:00 hs";
  } else if (dentroDeVentana) {
    estadoVentana = "EN_VENTANA";
    const horaFormato = (horaProx < 10 ? "0" : "") + horaProx + ":" + (minProx < 10 ? "0" : "") + minProx + " hs";
    const minutosFaltan = ((horaProx * 60 + minProx) - (horaActual * 60 + minutosActual));
    proximoTexto = `${horaFormato} (en ~${minutosFaltan} min)`;
  } else {
    estadoVentana = "FINALIZADA_HOY";
    proximoTexto = "Mañana 08:00 hs";
  }

  return {
    estado: estadoVentana,
    proximaEjecucion: proximoTexto,
    enVentana: dentroDeVentana,
    finDeSemana: finDeSemana
  };
}

// Cuánto se guarda el estado de RVTools antes de volver a escanear Drive. Escanear las
// carpetas cliente por cliente es lo más caro de todo el dashboard, y el dato cambia a lo
// sumo una vez por semana, así que no puede recalcularse en cada refresco.
//
// Se eligió caché perezoso en vez de un trigger programado a propósito. Un trigger cada 15
// minutos corre 96 veces por día aunque nadie abra el dashboard — incluido el domingo a las
// 3 AM — y la cuota de Apps Script es la misma que necesitan las operaciones. Así, el primero
// que mira paga el escaneo y el resto lee lo guardado; cuando nadie mira, no cuesta nada. El
// botón "Actualizar" lo fuerza.
const WEBAPP_CACHE_RVTOOLS_SEGUNDOS = 1800; // 30 minutos

/**
 * Estado semanal de las RVTools por cliente, listo para el semáforo.
 *
 * Las RVTools no son diarias: se suben una vez por semana, entre miércoles y viernes. Mirar
 * "¿está la carpeta de hoy?" (lo que hace el auditor de las 9:45) pinta de rojo cuatro de
 * cada cinco días a clientes que están al día. Acá la pregunta es otra: ¿hay una carpeta
 * NUEVA de la semana que corresponde?
 *
 *   - Semana de referencia: la actual desde el miércoles; lunes y martes, todavía la
 *     anterior (la de esta semana no venció, y lo que importa es si faltó la pasada).
 *   - Vale cualquier carpeta fechada desde el lunes de esa semana hasta hoy. Si la más nueva
 *     es de la semana pasada, no se subió.
 *   - Si falta y es miércoles o jueves, queda "pendiente" (la ventana sigue abierta). Desde
 *     el viernes —o si el lunes todavía falta la de la semana pasada— es rojo.
 *
 * La búsqueda de carpetas NO se reimplementa: se reusan las mismas funciones del auditor
 * de RVTools (reports/AuditorMailyRVTools.js) — la columna J del Índice, los formatos de
 * fecha aceptados y el caso de la subcarpeta de año (BALANZ). Si mañana cambia cómo se
 * nombran las carpetas, se arregla en un solo lugar (AGENTS.md §5).
 *
 * @param {boolean} [forzar] true para saltear el caché.
 * @returns {{calculadoA:string, error:(string|null), clientes:Object}} clientes[nombre] =
 *   { estado: 'ok'|'pendiente'|'falta'|'sin_dato', carpeta, detalle }
 */
function webapp_obtenerEstadoRVTools(forzar) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  const cacheKey = 'webapp_rvtools_semana_v1';
  const cache = CacheService.getScriptCache();
  if (!forzar) {
    const guardado = cache.get(cacheKey);
    if (guardado) {
      try { return JSON.parse(guardado); } catch (e) {}
    }
  }

  const ahora = new Date();
  const resultado = {
    calculadoA: Utilities.formatDate(ahora, HORARIO_OPERATIVO_TZ, 'dd/MM HH:mm'),
    error: null,
    clientes: {}
  };

  // Día de la semana en hora Argentina: 1 = lunes ... 7 = domingo.
  const dia = parseInt(Utilities.formatDate(ahora, HORARIO_OPERATIVO_TZ, 'u'), 10);
  const diasDesdeElLunes = (dia - 1) + (dia <= 2 ? 7 : 0);
  const esperados = [];
  for (let d = 0; d <= diasDesdeElLunes; d++) {
    const fecha = new Date(ahora.getTime() - d * 86400000);
    _rvtoolsFechasEsperadas(fecha).forEach(function (f) { esperados.push(f); });
  }
  const lunesRef = new Date(ahora.getTime() - diasDesdeElLunes * 86400000);
  const desdeTxt = Utilities.formatDate(lunesRef, HORARIO_OPERATIVO_TZ, 'dd/MM');
  const enVentana = (dia === 3 || dia === 4);

  let filas;
  try {
    filas = _rvtoolsLeerFilasIndice();
  } catch (e) {
    filas = null;
  }
  if (!filas) {
    // "No pude fijarme" no es "no se subió": sin Índice no se pinta nada de rojo (§7).
    resultado.error = 'No se pudo leer el Índice para ubicar las carpetas de RVTools.';
    return resultado;
  }

  filas.forEach(function (fila) {
    if (!fila.folderId) {
      resultado.clientes[fila.cliente] = { estado: 'sin_dato', carpeta: null, detalle: 'Sin link de carpeta en la columna J del Índice' };
      return;
    }
    try {
      const carpeta = _rvtoolsBuscarCarpetaDeFecha(DriveApp.getFolderById(fila.folderId), esperados, fila.cliente);
      if (carpeta) {
        resultado.clientes[fila.cliente] = { estado: 'ok', carpeta: carpeta, detalle: 'Subida: carpeta ' + carpeta };
      } else if (enVentana) {
        resultado.clientes[fila.cliente] = { estado: 'pendiente', carpeta: null, detalle: 'Todavía no hay carpeta nueva desde el ' + desdeTxt + ' (la ventana es de miércoles a viernes)' };
      } else {
        resultado.clientes[fila.cliente] = { estado: 'falta', carpeta: null, detalle: 'No hay carpeta nueva desde el ' + desdeTxt };
      }
    } catch (e) {
      resultado.clientes[fila.cliente] = { estado: 'sin_dato', carpeta: null, detalle: 'No se pudo abrir la carpeta: ' + e.message };
    }
  });

  try {
    const serializado = JSON.stringify(resultado);
    if (serializado.length < 90000) cache.put(cacheKey, serializado, WEBAPP_CACHE_RVTOOLS_SEGUNDOS);
  } catch (e) {}
  return resultado;
}

// Columnas del semáforo. Solo van las tecnologías de las que EXISTE un registro de envío:
// vSphere, Veeam y Nutanix lo marca el Índice (columnas V/W/X) y lo anota el log; Tanzu, el
// mail que se manda a mano con alarmas@ en copia; RVTools se verifica en Drive. Horizon queda
// afuera a propósito: sale dentro del mail de vSphere, y una columna propia repetiría el dato.
const WEBAPP_TECHS_SEMAFORO = ['vSphere', 'Veeam', 'Nutanix', 'Tanzu', 'RVTools'];

/**
 * Semáforo de envíos del día: por cliente y tecnología, si salió o no, y a qué hora.
 *
 * Reemplaza a la vieja matriz de salud, que mostraba los estados Success/Warning/Error del
 * log. Eso ya se ve en "Logs del Sistema > Envío de Mails" y además no respondía la pregunta
 * que se hace el equipo diez veces por día: "¿salió el mail de tal cliente?". Un envío puede
 * terminar en Warning y haber salido igual — el estado habla de los tickets que llevaba
 * adentro, no de si el correo se mandó.
 *
 * NO relee el Índice ni vuelve a deducir qué tiene contratado cada cliente: reusa
 * webapp_obtenerEstadoIndice(), que es la misma fuente que alimenta "Control de Envíos". Así
 * las dos pestañas no pueden contradecirse (AGENTS.md §5).
 *
 * Tres fuentes, todas existentes:
 *   - Índice, columnas V/W/X  -> si salió el mail (lo marca el proyecto de Índice al enviarlo)
 *   - Log "Envío de Mails"    -> a qué hora salió
 *   - webapp_obtenerEstadoRVTools() -> si hay carpeta de RVTools nueva de la semana
 *
 * @param {string} [overrideSheetId] Planilla de logs a usar (selector de entorno).
 * @param {boolean} [forzar] true para re-escanear Drive (botón "Actualizar").
 * @returns {Object}
 */
function webapp_obtenerMatrizEnvios(overrideSheetId, forzar) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  const indice = webapp_obtenerEstadoIndice();
  const hoyStr = Utilities.formatDate(new Date(), HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy');

  // --- Hora de envío, desde el log ---
  // La clave es "<cliente normalizado>|<tech>". El log guarda el nombre de empresa ("BALANZ")
  // y el Índice el nombre de operaciones ("Operaciones BALANZ"), así que se normalizan los dos
  // sacando el prefijo.
  const horaPorClienteTech = {};
  const normalizar = function (nombre) {
    return String(nombre || '').toLowerCase().replace(/^operaciones\s+/i, '').trim();
  };

  try {
    const logs = webapp_obtenerLogs(1000, overrideSheetId || WEBAPP_LOGS_PROD_ID);
    (logs.envioMails || []).forEach(function (r) {
      if (r.fecha !== hoyStr) return;
      const clave = normalizar(r.cliente) + '|' + String(r.tecnologia || '').toLowerCase();
      // Si el mismo mail salió más de una vez hoy, queda la hora del PRIMER envío: es la que
      // responde "¿a qué hora salió?" y la que sirve para medir si fue fuera de horario.
      if (!horaPorClienteTech[clave] || r.horaStr < horaPorClienteTech[clave]) {
        horaPorClienteTech[clave] = r.horaStr;
      }
    });
  } catch (e) {
    Logger.log("[WebApp] No se pudo leer el log de envíos para la matriz: " + e.message);
  }

  // --- Envíos hechos a mano (alarmas@ en copia): cuentan igual que los automáticos ---
  let manualesError = null;
  try {
    const idLogs = overrideSheetId || WEBAPP_LOGS_PROD_ID;
    _webappSincronizarEnviosManuales(idLogs, !!forzar);
    const hoyISO = Utilities.formatDate(new Date(), HORARIO_OPERATIVO_TZ, 'yyyy-MM-dd');
    _webappLeerEnviosManuales(SpreadsheetApp.openById(idLogs)).forEach(function (m) {
      if (m.fecha !== hoyISO) return;
      const clave = normalizar(m.cliente) + '|' + m.tecnologia.toLowerCase();
      if (!horaPorClienteTech[clave] || m.hora < horaPorClienteTech[clave]) {
        horaPorClienteTech[clave] = m.hora;
      }
    });
  } catch (e) {
    Logger.log("[WebApp] No se pudieron leer los envíos a mano para la matriz: " + e.message);
    manualesError = e.message;
  }

  // --- RVTools: se verifica en Drive, no por mail, y es semanal (ver la función) ---
  const rvtools = webapp_obtenerEstadoRVTools(!!forzar);
  const rvtoolsPorCliente = {};
  Object.keys(rvtools.clientes || {}).forEach(function (cli) {
    rvtoolsPorCliente[normalizar(cli)] = rvtools.clientes[cli];
  });

  // Un cliente aparece con dos nombres distintos según la fuente: el Índice guarda el de
  // operaciones ("Operaciones Banco Macro") y registrarEnvioMail() escribe el de empresa
  // ("Macro"). Sacar el prefijo "Operaciones " no alcanza, porque tampoco queda igual. Por eso
  // se prueban las dos claves: es el patrón de bug más frecuente del proyecto (AGENTS.md §6),
  // y cuando falla no rompe nada — simplemente el semáforo se queda sin la hora y nadie
  // entiende por qué.
  const buscarPorNombre = function (mapa, claves, sufijo) {
    for (let i = 0; i < claves.length; i++) {
      const k = claves[i] + (sufijo || '');
      if (mapa.hasOwnProperty(k)) return mapa[k];
    }
    return undefined;
  };

  // --- Armado del semáforo ---
  const clientes = (indice.clientes || []).map(function (cli) {
    const clavesCli = [normalizar(cli.empresa), normalizar(cli.nombre)].filter(function (k) { return !!k; });
    const tecs = {};
    let pendientes = 0;
    let enviados = 0;

    WEBAPP_TECHS_SEMAFORO.forEach(function (tech) {
      const key = tech.toLowerCase();
      const datosIndice = cli.tecnologias ? cli.tecnologias[key] : null;
      const contratado = !!(datosIndice && datosIndice.habilitado);

      if (!contratado) {
        tecs[tech] = { contratado: false, enviado: false, hora: null, fuente: null };
        return;
      }

      let enviado;
      let fuente;
      let pendienteEnVentana = false;
      let detalle = null;
      if (tech === 'RVTools') {
        // Sin dato (no hay carpeta en el Índice, o Drive falló) se deja en null y el front lo
        // pinta distinto de rojo: "no pude fijarme" no es "no se subió".
        const rv = buscarPorNombre(rvtoolsPorCliente, clavesCli);
        if (!rv || rv.estado === 'sin_dato') {
          enviado = null;
        } else {
          enviado = rv.estado === 'ok';
          pendienteEnVentana = rv.estado === 'pendiente';
        }
        detalle = rv ? rv.detalle : 'El cliente no figura con carpeta de RVTools en el Índice';
        fuente = 'drive';
      } else {
        // Salió si lo marca el Índice o si hay un envío de hoy en el log (automático o a
        // mano). El Índice no se entera de lo que se manda a mano, el log sí.
        enviado = !!(datosIndice && datosIndice.enviado) ||
          buscarPorNombre(horaPorClienteTech, clavesCli, '|' + key) !== undefined;
        fuente = 'mail';
      }

      tecs[tech] = {
        contratado: true,
        enviado: enviado,
        hora: buscarPorNombre(horaPorClienteTech, clavesCli, '|' + key) || null,
        fuente: fuente,
        pendienteEnVentana: pendienteEnVentana,
        detalle: detalle
      };

      if (enviado === true) enviados++;
      else if (enviado === false) pendientes++;
    });

    return {
      cliente: cli.nombre,
      empresa: cli.empresa,
      pod: cli.pod,
      fila: cli.fila,
      tecnologias: tecs,
      enviados: enviados,
      pendientes: pendientes
    };
  });

  let completos = 0;
  let conPendientes = 0;
  clientes.forEach(function (c) {
    if (c.pendientes > 0) conPendientes++;
    else completos++;
  });

  return {
    fecha: hoyStr,
    tecnologias: WEBAPP_TECHS_SEMAFORO,
    clientes: clientes,
    driveError: rvtools.error || null,
    manualesError: manualesError,
    driveCalculadoA: rvtools.calculadoA || null,
    resumen: {
      totalClientes: clientes.length,
      completos: completos,
      conPendientes: conPendientes,
      pctCompletos: clientes.length > 0 ? Math.round((completos / clientes.length) * 100) : 100
    }
  };
}


// Hora de corte comprometida con los clientes para el mail de operaciones, en minutos desde
// la medianoche (11:00). Un envío a las 11:00:00 justas está en horario; 11:00:01 ya no.
const WEBAPP_LIMITE_ENVIO_MINUTOS = 11 * 60;
const WEBAPP_CACHE_HORARIOS_SEGUNDOS = 1800; // 30 minutos
const WEBAPP_HORARIOS_DIAS_HISTORIA = 366;

// ─── Fechas y horas de los logs ──────────────────────────────────────────────────────────
// Compartidas por el histórico, el semáforo y los envíos a mano: si cada uno parseara a su
// manera, el mismo envío podría caer en días distintos según la pantalla (AGENTS.md §5).

function _webappPad2(n) { return (n < 10 ? '0' : '') + n; }

/** Fecha de una celda de log a 'yyyy-MM-dd'. Acepta Date, 'yyyy-MM-dd' y 'dd/MM/yyyy'. */
function _webappFechaISO(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor, HORARIO_OPERATIVO_TZ, 'yyyy-MM-dd');
  const s = String(valor || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + _webappPad2(+m[2]) + '-' + _webappPad2(+m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + _webappPad2(+m[2]) + '-' + _webappPad2(+m[1]);
  return null;
}

/** 'HH:mm[:ss]' a minutos desde la medianoche, o null si no se reconoce. */
function _webappMinutos(texto) {
  const m = String(texto || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]) + (m[3] ? (+m[3]) / 60 : 0);
}

function _webappEsFinDeSemana(fechaISO) {
  const p = fechaISO.split('-');
  const dia = new Date(+p[0], +p[1] - 1, +p[2]).getDay();
  return dia === 0 || dia === 6;
}

function _webappEsClienteDePrueba(cliente, pod) {
  const bajo = String(cliente || '').toLowerCase();
  return bajo.includes('testing') || bajo.startsWith('wpc -') || String(pod || '').toUpperCase() === 'WPC';
}

// ─── Envíos hechos a mano (con alarmas@ en copia) ────────────────────────────────────────
//
// GIRE y Tanzu se mandan a mano, así que no pasan por el Índice ni quedan en "Envío de
// Mails". Se acordó que quien los manda ponga en copia a alarmas@wetcom.com —la casilla con
// la que corre este web app— y respete el mismo asunto que los automáticos:
//
//   ⚠️ Operaciones Diarias y Semanales - Wetcom / Gire - vSphere - 25/09/2026
//   Operaciones semanales - Wetcom / Prisma - Tanzu - 25/09/2026
//
// Del asunto sale el cliente y la tecnología; del remitente, el operador; de la fecha del
// correo, la hora. Se guardan en su propia pestaña ("Envíos Manuales") y no en "Envío de
// Mails" a propósito: esa pestaña la lee también rellenarTareasProgramadas() del Índice, y
// sumarle filas desde acá haría que las Tareas Programadas se marquen según quién abrió el
// dashboard y cuándo. Una pestaña aparte no cambia nada de lo que ya corre.

const WEBAPP_CASILLA_CC_MANUALES = 'alarmas@wetcom.com';
const WEBAPP_DOMINIO_OPERADORES = '@wetcom.com';
const WEBAPP_TAB_ENVIOS_MANUALES = 'Envíos Manuales';
const WEBAPP_COLS_ENVIOS_MANUALES = ['Fecha', 'Hora', 'Cliente', 'Tecnología', 'POD', 'Estado', 'Operador', 'Asunto', 'Id Mensaje'];
// Cada cuánto se vuelve a mirar Gmail como máximo. Abrir el dashboard diez veces seguidas
// no tiene que hacer diez búsquedas.
const WEBAPP_SYNC_MANUALES_SEGUNDOS = 300;

const WEBAPP_TECH_CANONICA = { vsphere: 'vSphere', veeam: 'Veeam', nutanix: 'Nutanix', tanzu: 'Tanzu', horizon: 'Horizon', rvtools: 'RVTools' };

/** Nombre de tecnología tal como lo escribe el log automático ("vSphere/Horizon" -> "vSphere"). */
function _webappTechCanonica(tech) {
  const base = String(tech || '').trim().split('/')[0].trim();
  return WEBAPP_TECH_CANONICA[base.toLowerCase()] || base;
}

/**
 * Interpreta el asunto de un mail de operaciones. Devuelve null si no tiene el formato (o
 * si es una respuesta/reenvío: "RE:" de un cliente no es un envío nuestro).
 * @returns {{empresa:string, tecnologia:string, tipo:string, fecha:string, estado:string}|null}
 */
function _webappParsearAsuntoOperaciones(asunto) {
  const s = String(asunto || '').trim();
  if (/^(re|rv|fw|fwd|reenv\w*)\s*:/i.test(s)) return null;
  const m = s.match(/^(✅|⚠️?|❌)?\s*Operaciones\b(.*?)-\s*Wetcom\s*\/\s*(.+)$/i);
  if (!m) return null;
  const partes = m[3].split(/\s+-\s+/);
  if (partes.length < 3) return null;
  const fecha = partes.pop().trim();
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(fecha)) return null;
  const tecnologia = _webappTechCanonica(partes.pop());
  const empresa = partes.join(' - ').trim();
  if (!empresa || !tecnologia) return null;
  const icono = m[1] || '';
  const estado = icono === '✅' ? '🟢 Sin Anomalías'
    : icono === '❌' ? '🔴 Con Incidencias'
    : icono ? '🟡 Con Advertencias' : '—';
  return { empresa: empresa, tecnologia: tecnologia, tipo: m[2].trim(), fecha: fecha, estado: estado };
}

/** Saca el mail de "Nombre Apellido <nombre.apellido@wetcom.com>". */
function _webappEmailDe(remitente) {
  const s = String(remitente || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/**
 * Trae a la pestaña "Envíos Manuales" los mails de operaciones que llegaron a alarmas@ en
 * copia desde la última vez. Es incremental (busca desde el último registrado) e idempotente
 * (no repite un Id de mensaje), así que puede correr cuantas veces haga falta.
 *
 * Corre al abrir el dashboard, no con un trigger: si nadie mira, no gasta cuota.
 *
 * @param {string} sheetId Planilla de logs.
 * @param {boolean} [forzar] Ignorar el mínimo de 5 minutos entre búsquedas.
 * @returns {{nuevos:number, omitido:(string|undefined)}}
 */
function _webappSincronizarEnviosManuales(sheetId, forzar) {
  const cache = CacheService.getScriptCache();
  const marca = 'webapp_sync_manuales_v1_' + sheetId;
  if (!forzar && cache.get(marca)) return { nuevos: 0, omitido: 'reciente' };

  // Dos personas abriendo el dashboard a la vez no pueden anotar el mismo mail dos veces.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { nuevos: 0, omitido: 'ocupado' };
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    let tab = ss.getSheetByName(WEBAPP_TAB_ENVIOS_MANUALES);
    if (!tab) {
      tab = ss.insertSheet(WEBAPP_TAB_ENVIOS_MANUALES);
      tab.getRange(1, 1, 1, WEBAPP_COLS_ENVIOS_MANUALES.length).setValues([WEBAPP_COLS_ENVIOS_MANUALES])
        .setFontWeight('bold').setBackground('#1A5276').setFontColor('#FFFFFF');
      tab.setFrozenRows(1);
    }

    // Ids ya registrados y última fecha, para buscar solo lo nuevo.
    const ids = {};
    let ultimaISO = null;
    const ultimaFila = tab.getLastRow();
    if (ultimaFila > 1) {
      tab.getRange(2, 1, ultimaFila - 1, WEBAPP_COLS_ENVIOS_MANUALES.length).getValues().forEach(function (r) {
        if (r[8]) ids[String(r[8])] = true;
        const f = _webappFechaISO(r[0]);
        if (f && (!ultimaISO || f > ultimaISO)) ultimaISO = f;
      });
    }
    // Un día de margen por mails que llegan tarde; la primera vez, el último mes.
    const desde = ultimaISO
      ? new Date(new Date(ultimaISO + 'T12:00:00').getTime() - 86400000)
      : new Date(Date.now() - 30 * 86400000);
    const consulta = 'cc:' + WEBAPP_CASILLA_CC_MANUALES + ' from:' + WEBAPP_DOMINIO_OPERADORES.substring(1) +
      ' subject:Operaciones subject:Wetcom after:' + Utilities.formatDate(desde, HORARIO_OPERATIVO_TZ, 'yyyy/MM/dd');

    // POD y nombre de empresa como los tiene el Índice, así "Gire" del asunto y "GIRE" del
    // log automático terminan siendo el mismo cliente.
    const porEmpresa = {};
    try {
      (webapp_obtenerEstadoIndice().clientes || []).forEach(function (c) {
        const clave = String(c.empresa || '').toLowerCase().trim();
        if (clave && !porEmpresa[clave]) porEmpresa[clave] = { nombre: c.empresa, pod: c.pod };
      });
    } catch (e) {
      Logger.log('[WebApp] Envíos manuales: no se pudo leer el Índice para el POD: ' + e.message);
    }

    const nuevas = [];
    let inicio = 0;
    while (inicio < 500) {
      const hilos = GmailApp.search(consulta, inicio, 100);
      hilos.forEach(function (hilo) {
        hilo.getMessages().forEach(function (msg) {
          const id = msg.getId();
          if (ids[id]) return;
          const operador = _webappEmailDe(msg.getFrom());
          if (!operador.endsWith(WEBAPP_DOMINIO_OPERADORES) || operador === WEBAPP_CASILLA_CC_MANUALES) return;
          const destinos = (String(msg.getCc() || '') + ',' + String(msg.getTo() || '')).toLowerCase();
          if (destinos.indexOf(WEBAPP_CASILLA_CC_MANUALES) === -1) return;
          const datos = _webappParsearAsuntoOperaciones(msg.getSubject());
          if (!datos) return;

          const indice = porEmpresa[datos.empresa.toLowerCase()];
          const fecha = msg.getDate();
          ids[id] = true;
          nuevas.push([
            Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, 'yyyy-MM-dd'),
            Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, 'HH:mm:ss'),
            indice ? indice.nombre : datos.empresa,
            datos.tecnologia,
            indice ? indice.pod : '',
            datos.estado,
            operador,
            String(msg.getSubject() || '').substring(0, 250),
            id
          ]);
        });
      });
      if (hilos.length < 100) break;
      inicio += 100;
    }

    if (nuevas.length > 0) {
      nuevas.sort(function (a, b) { return (a[0] + a[1]).localeCompare(b[0] + b[1]); });
      tab.getRange(tab.getLastRow() + 1, 1, nuevas.length, WEBAPP_COLS_ENVIOS_MANUALES.length).setValues(nuevas);
      Logger.log('[WebApp] Envíos manuales: ' + nuevas.length + ' nuevo(s) registrado(s).');
    }
    cache.put(marca, '1', WEBAPP_SYNC_MANUALES_SEGUNDOS);
    return { nuevos: nuevas.length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Lee "Envíos Manuales". Si la pestaña todavía no existe (nadie mandó nada en copia), no es
 * un error: devuelve una lista vacía.
 * @returns {Array<{fecha:string, minutos:number, hora:string, cliente:string, tecnologia:string, pod:string, estado:string, operador:string}>}
 */
function _webappLeerEnviosManuales(ss) {
  const tab = ss.getSheetByName(WEBAPP_TAB_ENVIOS_MANUALES);
  if (!tab || tab.getLastRow() < 2) return [];
  const n = tab.getLastRow() - 1;
  const valores = tab.getRange(2, 1, n, 7).getValues();
  const horas = tab.getRange(2, 2, n, 1).getDisplayValues();
  const filas = [];
  valores.forEach(function (r, i) {
    const fecha = _webappFechaISO(r[0]);
    const minutos = _webappMinutos(horas[i][0]);
    if (!fecha || minutos === null || !r[2] || !r[3]) return;
    filas.push({
      fecha: fecha, minutos: minutos, hora: String(horas[i][0]).substring(0, 8),
      cliente: String(r[2]).trim(), tecnologia: String(r[3]).trim(), pod: String(r[4] || '').trim(),
      estado: String(r[5] || ''), operador: String(r[6] || '').trim().toLowerCase()
    });
  });
  return filas;
}

/**
 * Horario de envío del mail de operaciones: a qué hora le sale, en promedio, a cada cliente
 * el mail de cada tecnología, cuántos días salió después de las 11:00, y quién lo mandó.
 *
 * Junta dos fuentes: "Envío de Mails" (lo que manda el Índice; desde que el Índice registra
 * quién tildó, trae el operador en la columna K) y "Envíos Manuales" (lo que se manda a mano
 * con alarmas@ en copia).
 *
 * Devuelve los envíos crudos del último año —uno por cliente, tecnología y día hábil— y el
 * front agrupa por período y filtra. Así cambiar de semana a año, o elegir un cliente, no
 * vuelve a llamar al servidor: una sola lectura, cacheada 30 minutos (la historia de ayer
 * para atrás no cambia; el botón Actualizar la fuerza).
 *
 * Criterios:
 *   - Si el mismo mail salió más de una vez en el día (reenvío, o a mano y automático),
 *     cuenta el PRIMERO: es el que recibió el cliente a esa hora.
 *   - Sábados y domingos no cuentan: el compromiso de las 11 es de día hábil.
 *   - Se descartan las filas de testing / WPC, con el mismo criterio que el Índice.
 *
 * @param {string} [overrideSheetId] Planilla de logs (selector de entorno).
 * @param {boolean} [forzar] Ignorar la caché.
 * @returns {Object} envios: [fechaISO, cliente, tecnología, minutos, operador (-1 si no se
 *   sabe), origen (0 automático, 1 a mano)] — cliente/tecnología/operador son índices.
 */
function webapp_obtenerHorariosEnvio(overrideSheetId, forzar) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);

  const sheetId = overrideSheetId || WEBAPP_LOGS_PROD_ID;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'webapp_horarios_envio_v2_' + sheetId;
  if (!forzar) {
    const cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  const tz = HORARIO_OPERATIVO_TZ;
  const hoyISO = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const desdeISO = Utilities.formatDate(new Date(Date.now() - WEBAPP_HORARIOS_DIAS_HISTORIA * 86400000), tz, 'yyyy-MM-dd');
  const resultado = {
    limiteMinutos: WEBAPP_LIMITE_ENVIO_MINUTOS, hoy: hoyISO,
    clientes: [], tecnologias: [], operadores: [], envios: [], manualesError: null
  };

  // Primero se traen los envíos a mano nuevos. Si Gmail falla, el histórico se muestra igual
  // con lo que haya, pero avisando (AGENTS.md §7): no es lo mismo "no hubo" que "no pude ver".
  try {
    _webappSincronizarEnviosManuales(sheetId, !!forzar);
  } catch (e) {
    Logger.log('[WebApp] No se pudieron sincronizar los envíos a mano: ' + e.message);
    resultado.manualesError = e.message;
  }

  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(LOG_MAILS_TAB_NAME);
  if (!sheet) throw new Error('No existe la pestaña "' + LOG_MAILS_TAB_NAME + '" en la planilla de logs.');

  const idxCliente = {};
  const idxTech = {};
  const idxOperador = {};
  const primerEnvio = {};
  const claveCliente = function (nombre) {
    return String(nombre || '').toLowerCase().replace(/^operaciones\s+/i, '').trim();
  };
  const indiceDe = function (mapa, lista, clave, valor) {
    if (!mapa.hasOwnProperty(clave)) { mapa[clave] = lista.length; lista.push(valor); }
    return mapa[clave];
  };

  const agregar = function (fecha, minutos, cliente, tech, pod, operador, origen) {
    if (!fecha || fecha < desdeISO || fecha > hoyISO || _webappEsFinDeSemana(fecha)) return;
    if (minutos === null || !cliente || !tech || _webappEsClienteDePrueba(cliente, pod)) return;

    const kCli = claveCliente(cliente);
    const iCli = indiceDe(idxCliente, resultado.clientes, kCli, { nombre: cliente, pod: pod });
    // El POD de un cliente puede cambiar: queda el del envío más reciente.
    if (pod) resultado.clientes[iCli].pod = pod;
    const iTech = indiceDe(idxTech, resultado.tecnologias, tech, tech);
    const iOp = operador ? indiceDe(idxOperador, resultado.operadores, operador, operador) : -1;

    const clave = fecha + '|' + iCli + '|' + iTech;
    const redondeado = Math.round(minutos * 100) / 100;
    const fila = [fecha, iCli, iTech, redondeado, iOp, origen];
    if (primerEnvio.hasOwnProperty(clave)) {
      if (redondeado < primerEnvio[clave][3]) {
        const i = resultado.envios.indexOf(primerEnvio[clave]);
        resultado.envios[i] = fila;
        primerEnvio[clave] = fila;
      }
    } else {
      primerEnvio[clave] = fila;
      resultado.envios.push(fila);
    }
  };

  // --- Automáticos ("Envío de Mails") ---
  // Fecha con getValues (llega como Date, sin ambigüedad dd/MM vs MM/dd) y hora con
  // getDisplayValues: una celda de solo hora es una fecha de 1899, y formatearla con zona
  // horaria puede correrla por el huso histórico de esa época.
  const ultimaFila = sheet.getLastRow();
  if (ultimaFila >= 2) {
    // Hasta la K (Operador) si existe: las filas viejas no la tienen y quedan sin operador.
    const columnas = Math.min(Math.max(sheet.getLastColumn(), 6), 11);
    const valores = sheet.getRange(2, 1, ultimaFila - 1, columnas).getValues();
    const horasTexto = sheet.getRange(2, 2, ultimaFila - 1, 1).getDisplayValues();
    for (let i = 0; i < valores.length; i++) {
      const r = valores[i];
      agregar(_webappFechaISO(r[0]), _webappMinutos(horasTexto[i][0]),
        String(r[3] || '').trim(), _webappTechCanonica(r[4]), String(r[5] || '').trim(),
        columnas >= 11 ? String(r[10] || '').trim().toLowerCase() : '', 0);
    }
  }

  // --- A mano ("Envíos Manuales") ---
  _webappLeerEnviosManuales(ss).forEach(function (m) {
    agregar(m.fecha, m.minutos, m.cliente, m.tecnologia, m.pod, m.operador, 1);
  });

  // La caché admite 100 KB por clave. Con un año de historia el resultado puede pasarse; en
  // ese caso se sirve igual, solo que sin cachear (se loguea para saber que está pasando).
  try {
    const json = JSON.stringify(resultado);
    if (json.length < 95000) cache.put(cacheKey, json, WEBAPP_CACHE_HORARIOS_SEGUNDOS);
    else Logger.log('[WebApp] Horarios de envío sin cachear: ' + json.length + ' bytes (límite 100 KB).');
  } catch (e) {
    Logger.log('[WebApp] No se pudo cachear horarios de envío: ' + e.message);
  }
  return resultado;
}

// ─── Salidas del Horario de Envío: PDF por cliente y resumen a Slack ─────────────────────
//
// Ninguna de las dos recalcula promedios: reciben los números ya calculados en el navegador
// por las mismas funciones que pintan la pantalla. Así el PDF, Slack y el dashboard no
// pueden decir horas distintas para el mismo cliente (AGENTS.md §5). Acá solo se valida,
// se da formato y se envía.

// Webhook del canal interno donde cae el resumen. Va en Script Properties (AGENTS.md §9), y
// es una propiedad propia a propósito: no reusar un webhook de POD evita que un resumen
// "de prueba" termine en el canal de un POD sin que nadie lo haya decidido.
const WEBAPP_PROP_WEBHOOK_HORARIOS = 'SLACK_WEBHOOK_REPORTE_HORARIOS';

function _webappTexto(valor, max) {
  return String(valor === undefined || valor === null ? '' : valor).substring(0, max || 200);
}

function _webappEscaparHtml(valor) {
  return _webappTexto(valor, 500)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Slack interpreta <...> como links y menciones (<!channel>). Escapar evita que el nombre
// de un cliente dispare una mención a todo el canal.
function _webappEscaparSlack(valor) {
  return _webappTexto(valor, 300).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _webappEntero(valor) {
  const n = parseInt(valor, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

function _webappHora(valor) {
  const s = _webappTexto(valor, 5);
  return /^\d{2}:\d{2}$/.test(s) ? s : '--:--';
}

/**
 * Arma el PDF del horario de envío de UN cliente.
 * @param {Object} datos Lo calculado por generarPdfHorarios() en el front.
 * @returns {{nombre: string, base64: string}}
 */
function webapp_generarPdfHorarios(datos) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);
  if (!datos || !datos.cliente) throw new Error('Falta el cliente.');

  const verde = '#109E58', rojo = '#C0392B', gris = '#5B6B63', borde = '#E3E9E6';
  const color = function (tarde) { return tarde ? rojo : verde; };
  const envios = _webappEntero(datos.envios);
  const fuera = _webappEntero(datos.fuera);
  const promedio = datos.promedio ? _webappHora(datos.promedio) : '--:--';

  // Solo se acepta un PNG en base64: es lo único que produce getImageURI().
  const imagen = (typeof datos.imagen === 'string' && datos.imagen.length < 3000000 &&
    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(datos.imagen)) ? datos.imagen : null;

  const filasTech = (Array.isArray(datos.tecnologias) ? datos.tecnologias : []).slice(0, 20).map(function (t) {
    const n = _webappEntero(t.n), f = _webappEntero(t.fuera);
    return '<tr>' +
      '<td style="padding:8px 10px; border-bottom:1px solid ' + borde + ';">' + _webappEscaparHtml(t.tech) + '</td>' +
      '<td style="padding:8px 10px; border-bottom:1px solid ' + borde + '; text-align:center; font-weight:bold; color:' + color(!!t.tarde) + ';">' + _webappHora(t.promedio) + '</td>' +
      '<td style="padding:8px 10px; border-bottom:1px solid ' + borde + '; text-align:center;">' + n + '</td>' +
      '<td style="padding:8px 10px; border-bottom:1px solid ' + borde + '; text-align:center; color:' + (f > 0 ? rojo : gris) + ';">' + f + ' de ' + n + '</td>' +
      '</tr>';
  }).join('');

  const kpi = function (titulo, valor, colorValor) {
    return '<td width="33%" style="padding:12px; border:1px solid ' + borde + '; text-align:center;">' +
      '<div style="font-size:10px; color:' + gris + '; text-transform:uppercase; letter-spacing:1px;">' + titulo + '</div>' +
      '<div style="font-size:22px; font-weight:bold; color:' + colorValor + '; margin-top:4px;">' + valor + '</div></td>';
  };

  const generado = Utilities.formatDate(new Date(), HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy HH:mm');
  const html =
    '<html><head><meta charset="utf-8"></head>' +
    '<body style="font-family: Arial, Helvetica, sans-serif; color:#12211A; font-size:12px;">' +
    '<table width="100%" cellspacing="0" cellpadding="0"><tr>' +
    '<td style="background:' + verde + '; color:#fff; padding:14px 18px;">' +
    '<div style="font-size:11px; letter-spacing:1px;">WETCOM · WETCOM PROACTIVE CENTER</div>' +
    '<div style="font-size:18px; font-weight:bold; margin-top:4px;">Horario de envío del reporte de operaciones</div>' +
    '</td></tr></table>' +
    '<h1 style="font-size:22px; margin:18px 0 2px 0;">' + _webappEscaparHtml(datos.cliente) + '</h1>' +
    '<div style="color:' + gris + '; margin-bottom:16px;">' +
    (datos.pod ? _webappEscaparHtml(datos.pod) + ' · ' : '') +
    _webappEscaparHtml(datos.periodo) + ': del ' + _webappEscaparHtml(datos.desde) + ' al ' + _webappEscaparHtml(datos.hasta) +
    '</div>' +
    '<table width="100%" cellspacing="6" cellpadding="0"><tr>' +
    kpi('Hora promedio de envío', promedio, datos.promedio ? color(!!datos.promedioTarde) : gris) +
    kpi('Envíos en el período', String(envios), '#12211A') +
    kpi('Después de las 11:00', fuera + ' de ' + envios, fuera > 0 ? rojo : verde) +
    '</tr></table>' +
    (imagen ? '<div style="margin:18px 0 6px 0; font-weight:bold;">Evolución de la hora promedio</div>' +
      '<img src="' + imagen + '" width="680" />' : '') +
    '<div style="margin:18px 0 6px 0; font-weight:bold;">Por tecnología</div>' +
    '<table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ' + borde + ';">' +
    '<tr style="background:#12211A; color:#fff;">' +
    '<th style="padding:8px 10px; text-align:left;">Tecnología</th><th style="padding:8px 10px;">Hora promedio</th>' +
    '<th style="padding:8px 10px;">Envíos</th><th style="padding:8px 10px;">Después de las 11:00</th></tr>' +
    (filasTech || '<tr><td colspan="4" style="padding:10px; color:' + gris + ';">Sin envíos en el período.</td></tr>') +
    '</table>' +
    '<p style="color:' + gris + '; font-size:10px; margin-top:18px;">' +
    'Se toma la hora del primer envío de cada día hábil (los reenvíos y los fines de semana no cuentan). ' +
    'En rojo, lo que en promedio sale después de las 11:00. Generado el ' + generado + '.</p>' +
    '</body></html>';

  const nombreSeguro = _webappTexto(datos.cliente, 80).replace(/[\\/:*?"<>|]+/g, '-').trim();
  const nombre = 'Horario de envio - ' + nombreSeguro + ' - ' +
    _webappTexto(datos.desde, 10).replace(/\//g, '-') + ' a ' + _webappTexto(datos.hasta, 10).replace(/\//g, '-') + '.pdf';

  const pdf = Utilities.newBlob(html, 'text/html', 'reporte.html').getAs('application/pdf').setName(nombre);
  return { nombre: nombre, base64: Utilities.base64Encode(pdf.getBytes()) };
}

/**
 * Manda a Slack el resumen del horario de envío agrupado por POD.
 * @param {Object} datos Lo calculado por prepararSlackHorarios() en el front.
 * @returns {{ok: boolean}}
 */
function webapp_enviarResumenHorariosSlack(datos) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAutorizacion(usuario);
  if (!datos || !Array.isArray(datos.pods) || datos.pods.length === 0) throw new Error('No hay datos para enviar.');

  const webhook = PropertiesService.getScriptProperties().getProperty(WEBAPP_PROP_WEBHOOK_HORARIOS);
  if (!webhook) {
    throw new Error('Falta configurar la Script Property "' + WEBAPP_PROP_WEBHOOK_HORARIOS +
      '" con el webhook del canal donde tiene que llegar el resumen.');
  }

  const envios = _webappEntero(datos.envios), fuera = _webappEntero(datos.fuera);
  let texto = '🕚 *Horario de envío del mail de operaciones*\n' +
    _webappEscaparSlack(datos.periodo) + ': del ' + _webappEscaparSlack(datos.desde) + ' al ' + _webappEscaparSlack(datos.hasta) +
    (datos.filtros ? ' · filtro: ' + _webappEscaparSlack(datos.filtros) : '') + '\n' +
    'Promedio general: *' + _webappHora(datos.promedio) + '* ' + (datos.promedioTarde ? '🔴' : '🟢') +
    ' · ' + fuera + ' de ' + envios + ' envíos después de las 11:00\n';

  datos.pods.slice(0, 20).forEach(function (pod) {
    texto += '\n*' + _webappEscaparSlack(pod.pod) + '*\n';
    (Array.isArray(pod.clientes) ? pod.clientes : []).slice(0, 100).forEach(function (cli) {
      const techs = Array.isArray(cli.tecnologias) ? cli.tecnologias.slice(0, 10) : [];
      const algunaTarde = techs.some(function (t) { return !!t.tarde; });
      const partes = techs.map(function (t) {
        const hora = _webappHora(t.promedio);
        const f = _webappEntero(t.fuera), n = _webappEntero(t.n);
        return _webappEscaparSlack(t.tech) + ' ' + (t.tarde ? '*' + hora + '*' : hora) +
          (f > 0 ? ' (' + f + ' de ' + n + ' tarde)' : '');
      });
      texto += (algunaTarde ? '🔴 ' : '🟢 ') + _webappEscaparSlack(cli.cliente) + ' — ' + partes.join(' · ') + '\n';
    });
  });

  if (texto.length > 39000) texto = texto.substring(0, 39000) + '\n_… mensaje recortado por el límite de Slack._';

  const respuesta = fetchWithRetries(webhook, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: texto })
  });
  // Nunca fallar en silencio (AGENTS.md §7): si Slack no lo aceptó, el botón tiene que decirlo.
  const codigo = respuesta ? respuesta.getResponseCode() : null;
  if (codigo !== 200) {
    const cuerpo = respuesta ? _webappTexto(respuesta.getContentText(), 200) : 'sin respuesta';
    Logger.log('[WebApp] Slack rechazó el resumen de horarios: HTTP ' + codigo + ' ' + cuerpo);
    throw new Error('Slack respondió HTTP ' + codigo + ': ' + cuerpo);
  }
  Logger.log('[WebApp] Resumen de horarios enviado a Slack por ' + usuario + '.');
  return { ok: true };
}
