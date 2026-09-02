/**
 * @fileoverview Lectura de la bandeja de alarmas@ para el panel web (webapp/Index.html).
 *
 * POR QUÉ EXISTE
 * Los reportes llegan a una casilla a la que solo acceden el Tech Lead y el SDM. El resto del
 * equipo no puede mirar en qué estado quedó cada correo cuando algo falla. Este módulo arma
 * ese panorama del DÍA y lo deja en caché, para que abrir el panel no cueste una pasada
 * completa por Gmail cada vez.
 *
 * COSTO
 * Un escaneo son 4 búsquedas de Gmail + una pasada por cada hilo encontrado. Es la operación
 * cara del panel: por eso solo se dispara desde el botón "Actualizar", nunca al abrir la
 * página (el `doGet` sirve lo que haya en caché).
 */

/** Clave base en CacheService. Subir el sufijo invalida lo cacheado si cambia el formato. */
const WEBAPP_CACHE_KEY = 'WEBAPP_BANDEJA_V1';

/** 6 horas: el máximo que admite CacheService. La antigüedad se muestra siempre en pantalla. */
const WEBAPP_CACHE_TTL_SEG = 21600;

/**
 * Tope de hilos por búsqueda, por defecto.
 *
 * No es un límite de Gmail (su search admite hasta 500): es un techo de costo. Cada hilo que
 * entra en el listado cuesta abrir sus mensajes, sus adjuntos y sus etiquetas, y el escaneo
 * entero tiene que caber en los 6 minutos que dura una llamada de `google.script.run`. En una
 * casilla con el volumen de alarmas@, las columnas de "Sin leer" y "Procesado" chocan contra
 * este tope casi todos los días — por eso cada columna avisa cuando quedó cortada.
 *
 * Las columnas que importan para debuggear (Error y Pendiente) no se acercan nunca.
 *
 * Configurable en caliente vía la Script Property "WEBAPP_MAX_HILOS_COLUMNA", sin volver a
 * desplegar. Subirlo hace el botón "Actualizar" más lento; el techo útil ronda los 500.
 */
const WEBAPP_MAX_HILOS_POR_COLUMNA_DEFAULT = 1000;

/** @returns {number} Tope vigente (Script Property, o el default si no está seteada). */
function webapp_maxHilosPorColumna() {
  const valor = PropertiesService.getScriptProperties().getProperty('WEBAPP_MAX_HILOS_COLUMNA');
  const parsed = parseInt(valor, 10);
  return (valor !== null && !isNaN(parsed) && parsed > 0)
    ? Math.min(parsed, 500)
    : WEBAPP_MAX_HILOS_POR_COLUMNA_DEFAULT;
}

/**
 * Presupuesto de tiempo del escaneo. Una llamada de `google.script.run` muere a los 6 minutos
 * sin devolver nada; cortando antes se devuelve un resultado parcial marcado como truncado,
 * que es más útil que un error.
 */
const WEBAPP_PRESUPUESTO_MS = 240000;

/**
 * Caracteres por fragmento de caché. CacheService corta en 100 KB por clave y un carácter
 * acentuado ocupa hasta 3 bytes en UTF-8: 30.000 caracteres nunca superan ese techo.
 */
const WEBAPP_CACHE_CHUNK = 30000;

/**
 * Las cuatro columnas del panel, en orden de pipeline (no en orden alfabético): un reporte
 * entra sin leer, queda PENDIENTE mientras se reintenta, y termina en PROCESADO o en ERROR.
 * @returns {Array<{id: string, titulo: string, descripcion: string, query: string}>}
 */
/**
 * Convierte un nombre de etiqueta como "[OPS-PROCESADO]" al formato que GmailApp.search()
 * entiende: los corchetes se reemplazan por guiones porque así los almacena Gmail internamente.
 * @param {string} labelName
 * @returns {string}
 */
function webapp_labelQuery(labelName) {
  // Gmail almacena "[OPS-PROCESADO]" como "-OPS-PROCESADO-" para búsquedas
  return 'label:' + labelName.replace(/\[/g, '').replace(/\]/g, '').replace(/\s+/g, '-');
}

function webapp_definicionDeColumnas() {
  return [
    {
      id: 'SIN_LEER',
      titulo: 'Sin leer',
      descripcion: 'Llegaron hoy y el ciclo todavía no los tocó.',
      query: 'is:unread'
    },
    {
      id: 'ERROR',
      titulo: 'Error',
      descripcion: 'Apartados para revisión manual: reintentar no los arregla.',
      query: webapp_labelQuery(OPS_LABEL_ERROR)
    },
    {
      id: 'PENDIENTE',
      titulo: 'Pendiente',
      descripcion: 'Falló algo transitorio; se reintentan en el próximo ciclo.',
      query: webapp_labelQuery(OPS_LABEL_PENDIENTE)
    },
    {
      id: 'PROCESADO',
      titulo: 'Procesado',
      descripcion: 'Terminados: ticket gestionado y archivo en Drive.',
      query: webapp_labelQuery(OPS_LABEL_PROCESADO)
    }
  ];
}

/**
 * Medianoche de hoy en el huso operativo.
 *
 * El manifiesto del proyecto fija `timeZone` en el mismo huso que `HORARIO_OPERATIVO_TZ`, así
 * que la fecha local del script YA es la de Buenos Aires y `new Date(...)` la interpreta bien.
 * Se recalcula igual a partir del huso explícito para que un cambio en el manifiesto no
 * desplace el corte del día sin que nadie se entere.
 *
 * @returns {Date}
 */
function webapp_inicioDelDia() {
  const hoyStr = Utilities.formatDate(new Date(), HORARIO_OPERATIVO_TZ, 'yyyy/MM/dd');
  return new Date(hoyStr + ' 00:00:00');
}

/**
 * Recorre las cuatro búsquedas y arma la foto del día.
 *
 * Los hilos se enriquecen UNA sola vez aunque aparezcan en varias columnas (un correo sin leer
 * puede estar además en [OPS-PENDIENTE]): las columnas guardan ids y el detalle vive en un
 * único mapa `items`.
 *
 * @returns {Object} Estructura lista para cachear y para pintar en el cliente.
 */
function webapp_escanearBandeja() {
  const inicio = Date.now();
  const hoyStr = Utilities.formatDate(new Date(), HORARIO_OPERATIVO_TZ, 'yyyy/MM/dd');
  const desde = webapp_inicioDelDia();

  // Los contadores de reintento viven como Script Properties sueltas (una por hilo). Se traen
  // todas de un saque: leerlas de a una sería una llamada al servicio por cada correo listado.
  const propiedades = PropertiesService.getScriptProperties().getProperties();

  const items = {};
  const columnas = [];
  const tope = webapp_maxHilosPorColumna();
  let truncado = false;

  webapp_definicionDeColumnas().forEach(function (columna) {
    const consulta = columna.query + ' after:' + hoyStr;
    let hilos = [];
    try {
      hilos = GmailApp.search(consulta, 0, tope);
    } catch (e) {
      Logger.log('[WebApp] Falló la búsqueda "' + consulta + '": ' + e.message);
    }

    // Si la búsqueda vuelve justo con el tope, Gmail cortó el resultado: el total de esta
    // columna es un piso, no un número real. Se marca por columna y no solo en global para que
    // la interfaz pueda mostrar "150+" en la que corresponda — un "150" a secas se lee como un
    // conteo exacto y confunde, sobre todo cuando dos columnas dan el mismo número.
    let truncada = hilos.length >= tope;

    const ids = [];
    hilos.forEach(function (hilo) {
      if (Date.now() - inicio > WEBAPP_PRESUPUESTO_MS) {
        truncada = true;
        return;
      }
      try {
        const id = hilo.getId();
        if (!items[id]) {
          // `after:` de Gmail resuelve por día y puede colar correos del borde. El filtro real
          // del "solo hoy" que pidió el pedido se hace adentro, contra la fecha del mensaje.
          const item = webapp_describirHilo(hilo, desde, propiedades);
          if (!item) return;
          items[id] = item;
        }
        ids.push(id);
      } catch (e) {
        Logger.log('[WebApp] No se pudo describir un hilo de "' + columna.id + '": ' + e.message);
      }
    });

    if (truncada) truncado = true;

    columnas.push({
      id: columna.id,
      titulo: columna.titulo,
      descripcion: columna.descripcion,
      total: ids.length,
      truncada: truncada,
      ids: ids
    });
  });

  return {
    generado: new Date().toISOString(),
    generadoPor: webapp_usuarioActual(),
    fecha: Utilities.formatDate(new Date(), HORARIO_OPERATIVO_TZ, 'dd/MM/yyyy'),
    tope: tope,
    truncado: truncado,
    duracionMs: Date.now() - inicio,
    columnas: columnas,
    items: items
  };
}

/**
 * Convierte un hilo de Gmail en el objeto plano que consume la interfaz.
 * @param {GoogleAppsScript.Gmail.GmailThread} hilo
 * @param {Date} desde Corte del día: si el último mensaje es anterior, el hilo se descarta.
 * @param {Object<string,string>} propiedades Script Properties ya leídas (contadores de reintento).
 * @returns {Object|null} `null` si el hilo no es de hoy o no tiene mensajes.
 */
function webapp_describirHilo(hilo, desde, propiedades) {
  const cantidad = hilo.getMessageCount();
  if (cantidad === 0) return null;

  const mensajes = hilo.getMessages();
  const ultimo = mensajes[mensajes.length - 1];
  const fecha = ultimo.getDate();
  if (fecha < desde) return null;

  const id = hilo.getId();
  const reintentos = Number(propiedades[_PROP_PREFIX_REINTENTOS + id]) || 0;

  let adjuntos = [];
  try {
    adjuntos = ultimo.getAttachments({ includeInlineImages: false }).map(function (a) {
      return a.getName();
    });
  } catch (e) {
    // Un adjunto ilegible (o un correo enorme) no debe tumbar el listado entero.
    Logger.log('[WebApp] No se pudieron leer los adjuntos del hilo ' + id + ': ' + e.message);
  }

  let etiquetas = [];
  try {
    etiquetas = hilo.getLabels().map(function (l) { return l.getName(); });
  } catch (e) {
    Logger.log('[WebApp] No se pudieron leer las etiquetas del hilo ' + id + ': ' + e.message);
  }

  const remitente = webapp_partirRemitente(ultimo.getFrom());

  return {
    id: id,
    asunto: ultimo.getSubject() || '(sin asunto)',
    remitente: remitente.nombre,
    remitenteEmail: remitente.email,
    hora: Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, 'HH:mm'),
    mensajes: cantidad,
    sinLeer: hilo.isUnread(),
    adjuntos: adjuntos,
    etiquetas: etiquetas.filter(function (n) { return n.indexOf('[OPS-') === 0; }),
    reintentos: reintentos
  };
}

/**
 * Separa `"Soporte vSphere" <alertas@cliente.com>` en nombre y dirección.
 * @param {string} from
 * @returns {{nombre: string, email: string}}
 */
function webapp_partirRemitente(from) {
  const texto = String(from || '').trim();
  const match = texto.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return {
      nombre: match[1].replace(/^"|"$/g, '').trim() || match[2],
      email: match[2].trim()
    };
  }
  return { nombre: texto, email: texto };
}

// --- Caché ---------------------------------------------------------------------------------
// CacheService corta en 100 KB por clave y un día cargado supera ese tamaño sin problema. Se
// guarda partido en fragmentos con una clave "_meta" que dice cuántos son: si falta alguno
// (expiró, o se desalojó por presión de caché) se devuelve null y el panel pide actualizar,
// en vez de devolver medio JSON.

/**
 * @param {Object} datos Estructura devuelta por webapp_escanearBandeja().
 */
function webapp_cacheGuardar(datos) {
  const cache = CacheService.getScriptCache();
  const texto = JSON.stringify(datos);
  const partes = Math.max(1, Math.ceil(texto.length / WEBAPP_CACHE_CHUNK));
  const mapa = {};
  for (let i = 0; i < partes; i++) {
    mapa[WEBAPP_CACHE_KEY + '_' + i] = texto.substring(i * WEBAPP_CACHE_CHUNK, (i + 1) * WEBAPP_CACHE_CHUNK);
  }
  mapa[WEBAPP_CACHE_KEY + '_meta'] = String(partes);
  try {
    cache.putAll(mapa, WEBAPP_CACHE_TTL_SEG);
  } catch (e) {
    // Que no se pueda cachear no invalida el resultado: se devuelve igual, sin caché.
    Logger.log('[WebApp] No se pudo guardar la bandeja en caché: ' + e.message);
  }
}

/**
 * @returns {Object|null} La última foto cacheada, o null si no hay o quedó incompleta.
 */
function webapp_cacheLeer() {
  const cache = CacheService.getScriptCache();
  const meta = cache.get(WEBAPP_CACHE_KEY + '_meta');
  if (!meta) return null;

  const partes = parseInt(meta, 10);
  if (!partes || partes < 1) return null;

  const claves = [];
  for (let i = 0; i < partes; i++) claves.push(WEBAPP_CACHE_KEY + '_' + i);

  const mapa = cache.getAll(claves);
  let texto = '';
  for (let i = 0; i < claves.length; i++) {
    const parte = mapa[claves[i]];
    if (parte === null || parte === undefined) return null;
    texto += parte;
  }

  try {
    return JSON.parse(texto);
  } catch (e) {
    Logger.log('[WebApp] La bandeja cacheada no se pudo parsear: ' + e.message);
    return null;
  }
}

/** Borra la foto cacheada. Útil desde el editor si el formato quedó viejo. */
function webapp_cacheLimpiar() {
  const cache = CacheService.getScriptCache();
  const meta = cache.get(WEBAPP_CACHE_KEY + '_meta');
  const claves = [WEBAPP_CACHE_KEY + '_meta'];
  const partes = parseInt(meta, 10) || 0;
  for (let i = 0; i < partes; i++) claves.push(WEBAPP_CACHE_KEY + '_' + i);
  cache.removeAll(claves);
  Logger.log('[WebApp] Caché de la bandeja limpiada (' + partes + ' fragmento/s).');
}
