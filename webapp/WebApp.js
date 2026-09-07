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
    const logSheetId = overrideSheetId || PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID") || (typeof LOG_SHEET_ID !== 'undefined' ? LOG_SHEET_ID : null);
    if (!logSheetId) return resultados;
    
    const ss = SpreadsheetApp.openById(logSheetId);
    
    // Función auxiliar para leer y formatear una hoja
    function procesarHoja(nombreHoja, mapeador) {
      const sheet = ss.getSheetByName(nombreHoja);
      if (!sheet) return [];
      const data = sheet.getDataRange().getValues();
      if (data.length <= 1) return [];
      
      const rows = data.slice(1);
      // Ordenar por la primera columna (Fecha/Timestamp) descendente
      rows.sort(function(a, b) {
        const d1 = new Date(a[0]).getTime();
        const d2 = new Date(b[0]).getTime();
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
      let d = r[11] ? new Date(r[11]) : (r[0] ? new Date(r[0]) : new Date());
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
      let d = r[0] ? new Date(r[0]) : new Date();
      return {
        hora: Utilities.formatDate(d, HORARIO_OPERATIVO_TZ, 'dd/MM HH:mm'),
        operacion: r[2] || "",
        origen: r[3] || "",
        cliente: r[4] || "",
        error: r[5] || "",
        detalle: r[6] || ""
      };
    });

    // 3. Envío de Mails
    resultados.envioMails = procesarHoja("Envío de Mails", function(r) {
      let horaStr = r[1];
      if (r[1] instanceof Date) {
        horaStr = Utilities.formatDate(r[1], HORARIO_OPERATIVO_TZ, 'HH:mm:ss');
      }
      return {
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
        if (!nombreOps || nombreOps.toLowerCase().includes("testing") || nombreOps.toLowerCase().startsWith("wpc -")) {
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
            horizon: { habilitado: tieneHorizon }
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
