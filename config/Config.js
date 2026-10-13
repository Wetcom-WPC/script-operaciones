/**
 * Configuración central del script
 */
const Config = {
  // Valores admitidos para el entorno. Se exponen como constantes para que nadie tenga
  // que repetir el string suelto y para que un typo rompa en la carga, no en producción.
  ENTORNO_TESTING: 'TESTING',
  ENTORNO_PRODUCCION: 'PRODUCCION',

  // Cache del entorno ya resuelto. PropertiesService es una llamada de red encubierta y
  // el entorno se consulta muchas veces por corrida.
  _entornoCacheado: null,

  /**
   * Entorno actual, leído de la Script Property "ENTORNO" (TESTING | PRODUCCION).
   *
   * Vive en las propiedades del script y no en este archivo para que el MISMO código
   * corra en alarmas-testing y en alarmas-produccion sin editar nada: antes, pasar a
   * producción implicaba tocar una constante versionada, y un push con el valor
   * equivocado mandaba las alarmas reales al canal de pruebas (o al revés).
   *
   * Si la property falta o trae un valor no reconocido se asume TESTING. Es el lado
   * seguro: ante una configuración rota preferimos no publicar en los canales
   * productivos ni escribir en los tickets de los clientes.
   */
  get ENTORNO() {
    if (this._entornoCacheado) return this._entornoCacheado;

    let valor = null;
    try {
      valor = PropertiesService.getScriptProperties().getProperty('ENTORNO');
    } catch (e) {
      Logger.log(`No se pudo leer la Script Property "ENTORNO": ${e.message}`);
    }

    // Se aceptan las variantes razonables para que un "PROD" tipeado de memoria no
    // degrade el script a testing sin que nadie lo note.
    const normalizado = (valor || '').toString().trim().toUpperCase();
    const esProd = ['PRODUCCION', 'PRODUCCIÓN', 'PROD'].indexOf(normalizado) !== -1;

    if (!esProd && normalizado !== this.ENTORNO_TESTING) {
      Logger.log(`Script Property "ENTORNO" ausente o no reconocida ("${valor}"). Se asume ${this.ENTORNO_TESTING}.`);
    }

    this._entornoCacheado = esProd ? this.ENTORNO_PRODUCCION : this.ENTORNO_TESTING;
    return this._entornoCacheado;
  },

  /** Único lugar donde se decide si estamos en producción. */
  esProduccion: function() {
    return this.ENTORNO === this.ENTORNO_PRODUCCION;
  },

  // Configuración de Jira
  JIRA_BASE_URL: "wetcom.atlassian.net",
  JIRA_FILTER_ID: "23855",
  JIRA_POD_FIELD_ID: "customfield_12331", // Extraído al archivo de Configuración

  // Nombres de hojas de cálculo
  SHEET_CLIENTES: 'Clientes',
  SHEET_TIPOS_ALARMAS: 'Tipos de Alarmas',
  SHEET_CORREOS_CLIENTES: 'Correos Clientes',
  SHEET_CORREOS_PODS: 'Correos Guardias',
  SHEET_EXCEPCIONES: 'Excepciones',

  // Correo por defecto si un POD no tiene configuración asignada
  EMAIL_FALLBACK: "wpc@wetcom.com",

  // Lista de nombres de alarma que se descartan automáticamente por diseño
  ALARMAS_IGNORADAS_POR_DEFECTO: ['Alarma de vROps', 'Alarma de vRO'],

  // Texto con el que se dan de alta en "Tipos de Alarmas" las filas todavía sin traducir.
  // Se compara por PREFIJO, así que también cubre variantes numeradas de la planilla
  // ("Configurar en Excel 2", "Configurar en Excel 3", ...). Mientras la columna B
  // empiece con este texto, se muestra el nombre original de la alarma.
  // Ver AlarmParser.resolverNombreAlarma.
  PLACEHOLDER_TIPO_ALARMA: 'Configurar en Excel',

  // Prefijos de "sobre" que el equipo nuevo antepone al ${ALERT_DEFINITION} en el summary
  // (ej: "9x5 - Operations - ", "24x7 Wetcom - ").
  //
  // Los grupos de captura son parte del contrato con AlarmEnvelope:
  //   grupo 1 = cobertura contratada (9x5 / 24x7)   → se muestra como rótulo en Slack
  //   grupo 2 = origen emisor (vCenter / Operations / Wetcom)
  //
  // El prefijo NO se usa para rutear parsers: el ruteo va por la estructura de la
  // description (ver AlarmParserRegistry), para que un cambio de prefijo no rompa nada.
  PREFIJOS_SOBRE_ALARMA: [
    /^\s*(9x5|24x7)\s*-?\s*(vCenter|Operations|Wetcom)\s*-\s*/i
  ],

  // Mostrar la cobertura (9x5 / 24x7) como rótulo encima de cada alarma.
  // Apagado: el mensaje del NOC no lo lleva. Ponelo en true si alguna vez se quiere ver.
  // Ojo: esto controla SÓLO el texto. La separación en bloques por cobertura se mantiene
  // igual, porque es lo que evita que una misma alarma recibida bajo dos contratos
  // distintos se mezcle en un único ítem.
  MOSTRAR_ROTULO_COBERTURA: false,

  // Orden de preferencia cuando la MISMA alarma sobre el MISMO objeto llega por más de una
  // cobertura (las dos reglas de automatización disparan sobre el mismo evento). Se informa
  // una sola vez, la de la cobertura que aparezca primero en esta lista.
  // Las alarmas del formato histórico no traen cobertura y nunca se deduplican.
  PRIORIDAD_COBERTURA: ['9x5', '24x7'],

  // Alarmas cuyo título ya es suficientemente explícito y no necesitan que se publique
  // la descripción de vROps (suele ser un párrafo genérico y largo).
  // Se puede escribir tanto el nombre traducido de la planilla como el original en inglés.
  ALARMAS_SIN_DESCRIPCION: [
    'Alarma de desconexión de host',
    'Host has lost connection to vCenter Server'
  ],

  // Cerrar en Jira las alarmas que el motor de Excepciones silencia.
  // Silenciar siempre significó "no publicarla en el resumen del POD"; con esto además
  // se transiciona el ticket, para que no quede abierto sin dueño.
  // Ponelo en false para volver al comportamiento anterior (silenciar sin tocar Jira).
  // OJO: aplica en TESTING y en PROD por igual, porque el Jira es el mismo en los dos.
  CERRAR_ALARMAS_SILENCIADAS: true,

  // Cómo ubicar la transición de cierre dentro del workflow de Jira.
  // Se busca primero por el nombre de la transición y, si no aparece, por el nombre del
  // estado destino. Tener las dos vías evita que un rename en el workflow rompa el cierre
  // en silencio. Ver JiraService._elegirTransicionDeCierre.
  JIRA_TRANSICION_CIERRE: {
    nombre: 'Cerrar Alarma',
    estadoDestino: 'Cerrada'
  },

  // Nota interna que se deja en el ticket al cerrarlo, para que quede trazable quién lo cerró
  // y por qué. `{idExcepcion}` se reemplaza por el ID de la regla que silenció la alarma.
  // Si el comentario falla, el cierre igual se da por bueno.
  JIRA_COMENTARIO_CIERRE: 'Alarma cerrada automáticamente por excepción: {idExcepcion}',

  // ID de la carpeta en Google Drive donde se guardarán los borradores (.json)
  get ID_CARPETA_BORRADORES() {
    return this.esProduccion()
      ? this.getPropiedad("CARPETA_BORRADORES_PROD")
      : this.getPropiedad("CARPETA_BORRADORES_TESTING");
  },

  // WebApp que genera los borradores de correo (el enlace "Generar correo para ..." que se
  // publica en Slack). Cada entorno tiene el suyo, igual que los webhooks de Slack y la
  // carpeta de borradores.
  //
  // No es un detalle cosmético: el WebApp corre DENTRO del proyecto dueño del deployment,
  // así que resuelve DataRepository contra la planilla a la que ESE proyecto está atado.
  // Mientras hubo un único valor apuntando a alarmas-testing, los enlaces publicados por
  // producción abrían el WebApp de testing y los destinatarios del correo salían de la
  // planilla de testing.
  //
  // Va en Script Properties y no en el código por el mismo motivo que el resto del
  // interruptor de entorno: es un identificador de infraestructura de cada proyecto, no
  // código. Republicar el WebApp no debería obligar a commitear.
  //
  // Si hay que republicar, conviene reusar el id existente con
  // `clasp create-deployment -i <deploymentId>`: saca una versión nueva sin cambiar la URL,
  // así los enlaces que ya están en Slack siguen funcionando y no hay que tocar la property.
  get URL_WEB_APP() {
    return this.esProduccion()
      ? this.getPropiedad("URL_WEB_APP_PROD")
      : this.getPropiedad("URL_WEB_APP_TESTING");
  },

  /**
   * Obtiene una propiedad de script de forma segura.
   * Si no existe en PropertiesService, lanza un error crítico.
   */
  getPropiedad: function(clave) {
    const props = PropertiesService.getScriptProperties();
    const valor = props.getProperty(clave);
    if (!valor) {
      throw new Error(`Configuración faltante: La clave secreta '${clave}' no se encontró en PropertiesService.`);
    }
    return valor;
  },

  obtenerWebhookSlack: function() {
    return this.esProduccion()
      ? this.getPropiedad("SLACK_WEBHOOK_PROD")
      : this.getPropiedad("SLACK_WEBHOOK_TESTING");
  },

  /**
   * Webhook del canal de logs de excepciones (alarmas silenciadas y resultado del cierre
   * automático en Jira).
   *
   * Antes SlackService apuntaba siempre a SLACK_WEBHOOK_TESTING, así que en producción
   * estos avisos —incluido el "no se pudo cerrar el ticket"— caían en el canal de pruebas,
   * donde nadie los mira.
   */
  obtenerWebhookLogs: function() {
    return this.esProduccion()
      ? this.getPropiedad("SLACK_WEBHOOK_LOGS_PROD")
      : this.getPropiedad("SLACK_WEBHOOK_LOGS_TESTING");
  },

  get SLACK_WEBHOOK_GUARDIA() {
    return this.getPropiedad('SLACK_WEBHOOK_GUARDIA');
  },

  obtenerTokenJira: function() {
    return this.getPropiedad("JIRA_AUTH_TOKEN");
  }
};
