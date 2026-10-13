/**
 * Parser del formato estandarizado nuevo (alertas de vROps / Aria Operations).
 *
 * La description viene como una lista de pares "Etiqueta: valor". Qué etiquetas
 * aparecen depende de la Categoría del objeto (Host, vSAN Cluster, Capacity Disk...),
 * y esas categorías están declaradas en VropsCategorias.js.
 *
 * DECISIÓN DE DISEÑO IMPORTANTE
 * No parsea línea por línea. Jira convierte la description a ADF y, según cómo la
 * arme la automatización, JiraService puede devolverla con saltos de línea reales o
 * con todos los campos colapsados en un renglón único. Por eso el troceo se hace
 * buscando las etiquetas conocidas dentro del texto: funciona igual en ambos casos.
 */
const VropsStandardParser = {

  nombre: 'vROps Estandarizado',

  /** Se evalúa antes que el legacy (que es el fallback con prioridad 0). */
  prioridad: 100,

  /**
   * Ruteo por ESTRUCTURA de la description, no por el prefijo del summary.
   * Así, si el equipo cambia los prefijos, el ruteo no se rompe; y un ticket con
   * prefijo nuevo pero payload viejo cae solo al parser legacy.
   */
  puedeParsear: function(ticket) {
    if (!ticket || !ticket.description) return false;

    const campos = this._extraerCampos(ticket.description);

    // La etiqueta testigo va en castellano ("Descripcion:"), mientras que el cuerpo
    // legacy de vCenter usa "Description:" en inglés. No se pisan entre sí.
    if (!campos[VropsCategorias.ETIQUETA_TESTIGO]) return false;

    // Bien formada: trae una categoría reconocible.
    if (VropsCategorias.detectar(campos)) return true;

    // Sin categoría es una alarma del formato nuevo con el template mal aplicado.
    // Igual la tomamos para poder marcarla, salvo que el cuerpo sea claramente legacy.
    return !this._pareceCuerpoLegacy(ticket.description);
  },

  parsear: function(ticket, mappings, warnings) {
    const campos = this._extraerCampos(ticket.description);
    const categoria = VropsCategorias.detectar(campos);
    const sobre = AlarmEnvelope.desensobrar(ticket.summary);
    const nombreCrudo = this._limpiarNombreAlarma(sobre.summary);

    if (!categoria) {
      return this._parsearVarianteProsa(ticket, nombreCrudo, sobre, mappings, warnings);
    }

    const alarma = AlarmParser.resolverNombreAlarma(nombreCrudo, mappings.mapaAlarmas, warnings, ticket.summary);
    const origen = {
      vCenter: campos[VropsCategorias.ETIQUETA_VCENTER] || 'Desconocido',
      cluster: (categoria.campoCluster && campos[categoria.campoCluster]) || 'Desconocido',
      target: campos[categoria.etiquetaObjeto] || 'Target Desconocido',
      etiquetaTarget: categoria.etiquetaTarget
    };
    if (sobre.cobertura) origen.cobertura = sobre.cobertura;

    if (origen.target === 'Target Desconocido') {
      warnings.push(`Objeto no encontrado en la description (categoría ${categoria.nombre}) para "${ticket.summary}"`);
    }

    return {
      incluir: true,
      alarma: alarma,
      origen: origen,
      summaryResto: this._construirDetalle(categoria, campos, alarma, nombreCrudo),
      // El formato nuevo trae su propia estructura: los AlarmFormatters legacy
      // están escritos contra el texto del formato viejo y acá sólo harían daño.
      usaFormattersLegacy: false
    };
  },

  /**
   * Caso "template mal aplicado en vROps": la alarma es del formato nuevo (trae la
   * etiqueta "Descripcion:") pero no llegó ninguno de los campos estructurados, así
   * que no hay de dónde sacar el objeto afectado.
   *
   * Se marca explícitamente en lugar de intentar adivinar con expresiones regulares
   * contra la prosa: ese texto es un template roto que el equipo emisor va a corregir,
   * y parsearlo sería escribir código con fecha de vencimiento. El operador la completa
   * a mano desde el ticket de Jira.
   */
  /**
   * Variante en prosa del formato nuevo. En lugar de campos rotulados, el objeto y su
   * ubicación vienen redactados dentro de una frase:
   *
   *   "Alerta reportada en esxi023-lom.macro.com.ar ubicado en cl-gp-paclom-02.
   *    Descripcion: ... Recomendacion: ..."
   *
   * Es la forma que usa el canal 24x7. La descripción sí viene rotulada, así que sólo
   * hay que rescatar objeto y cluster de la frase inicial.
   */
  _parsearVarianteProsa: function(ticket, nombreCrudo, sobre, mappings, warnings) {
    // Queda registrado en el log: si esta variante desaparece, conviene poder saberlo.
    warnings.push(`Alarma en formato prosa (sin campos estructurados) en "${ticket.summary}"`);

    const campos = this._extraerCampos(ticket.description);
    const prosa = this._rescatarDeProsa(ticket.description);
    const alarma = AlarmParser.resolverNombreAlarma(nombreCrudo, mappings.mapaAlarmas, warnings, ticket.summary);

    const origen = {
      // Esta variante no informa el vCenter: no hay de dónde sacarlo.
      vCenter: 'Desconocido',
      cluster: prosa.cluster || 'Desconocido',
      // Si no se pudo rescatar el objeto se cae a la clave de Jira, para que el bloque no
      // quede sin ninguna línea visible (MessageFormatter oculta los "Desconocido") y el
      // detalle no aparezca colgando debajo de la alarma anterior, como si fuera de ella.
      target: prosa.objeto || ticket.key,
      // Todas las alarmas observadas con esta variante son de host. Si aparecieran de otro
      // tipo, conviene sacar esta línea y dejar que AlarmProcessor deduzca la etiqueta.
      etiquetaTarget: prosa.objeto ? 'Host' : 'Ticket'
    };
    if (sobre.cobertura) origen.cobertura = sobre.cobertura;

    return {
      incluir: true,
      alarma: alarma,
      origen: origen,
      summaryResto: this._descripcionComoDetalle(campos, alarma, nombreCrudo),
      usaFormattersLegacy: false
    };
  },

  /**
   * Devuelve la descripción lista para publicar, o null si no corresponde mostrarla.
   * Se omite cuando repite el nombre de la alarma (habitual en la variante en prosa)
   * o cuando la alarma está listada en Config.ALARMAS_SIN_DESCRIPCION.
   */
  _descripcionComoDetalle: function(campos, alarma, nombreCrudo) {
    const descripcion = campos[VropsCategorias.ETIQUETA_TESTIGO];
    if (!descripcion) return null;
    if (this._descripcionSilenciada(alarma, nombreCrudo)) return null;

    // Se descartan TODOS los puntos finales, no uno: el template concatena un punto al
    // valor y muchas descripciones ya venían con el suyo, quedando "... physical NIC..".
    const normalizar = (t) => (t || '').toString().toLowerCase().replace(/[\s.]+$/, '').trim();
    if (normalizar(descripcion) === normalizar(nombreCrudo)) return null;

    // El template concatena un punto al valor, que muchas veces ya venía con uno
    return descripcion.replace(/\s*\n\s*/g, ' ').replace(/\.{2,}\s*$/, '.').trim();
  },

  /** ¿La alarma está configurada para publicarse sin su descripción? */
  _descripcionSilenciada: function(alarma, nombreCrudo) {
    const lista = Config.ALARMAS_SIN_DESCRIPCION || [];
    if (lista.length === 0) return false;

    const normalizar = (t) => (t || '').toString().toLowerCase().trim();
    const candidatos = [normalizar(alarma), normalizar(nombreCrudo)];

    return lista.some(item => candidatos.indexOf(normalizar(item)) !== -1);
  },

  /**
   * Rescata objeto y cluster de la frase inicial de la variante en prosa.
   * @return {{objeto: string|null, cluster: string|null}}
   */
  _rescatarDeProsa: function(descripcion) {
    const texto = descripcion ? descripcion.toString() : '';
    const vacio = { objeto: null, cluster: null };

    const match = texto.match(/Alerta reportada en\s+(.+?)\s+ubicado en\s+(.+?)\s*\.(?=\s|$)/i);
    if (!match) return vacio;

    const objeto = match[1].trim();
    const cluster = match[2].trim();

    return {
      objeto: this._esValorUtil(objeto) ? objeto : null,
      cluster: this._esValorUtil(cluster) ? cluster : null
    };
  },

  /**
   * Firma inconfundible del cuerpo legacy de vCenter. Se usa como salvaguarda para no
   * quedarnos con un ticket viejo que casualmente traiga una etiqueta parecida.
   */
  _pareceCuerpoLegacy: function(descripcion) {
    const texto = descripcion ? descripcion.toString() : '';
    return /(^|\s)Previous Status\s*:/i.test(texto) || /(^|\s)Alarm Definition\s*:/i.test(texto);
  },

  /**
   * Normaliza el nombre ya desensobrado para poder cruzarlo con la planilla.
   * Saca el punto final, porque el summary de Jira suele traerlo y la hoja no.
   */
  _limpiarNombreAlarma: function(summary) {
    const nombre = summary ? summary.toString().trim() : '';
    return nombre.replace(/\s*\.\s*$/, '').trim();
  },

  /**
   * Trocea la description en un diccionario Etiqueta → valor.
   * Ante etiquetas repetidas gana la primera aparición: si el texto de una
   * Descripcion contuviera algo como "Cluster: x", no pisa al campo real.
   */
  _extraerCampos: function(descripcion) {
    const texto = descripcion ? descripcion.toString() : '';
    if (!texto) return {};

    const etiquetas = VropsCategorias.vocabulario();
    const alternativas = etiquetas.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const patron = new RegExp('(^|\\s)(' + alternativas + ')\\s*:\\s*', 'gi');

    // 1. Ubicar todas las marcas de etiqueta con sus posiciones
    const marcas = [];
    let m;
    while ((m = patron.exec(texto)) !== null) {
      marcas.push({
        etiqueta: m[2],
        inicioEtiqueta: m.index + m[1].length,
        inicioValor: patron.lastIndex
      });
      if (patron.lastIndex === m.index) patron.lastIndex++; // guarda anti bucle infinito
    }

    // 2. El valor de cada marca llega hasta donde arranca la siguiente
    const campos = {};
    for (let i = 0; i < marcas.length; i++) {
      const hasta = (i + 1 < marcas.length) ? marcas[i + 1].inicioEtiqueta : texto.length;
      const valor = texto.substring(marcas[i].inicioValor, hasta).trim();
      const canonica = this._canonizarEtiqueta(marcas[i].etiqueta, etiquetas);

      if (campos[canonica] === undefined && this._esValorUtil(valor)) {
        campos[canonica] = valor;
      }
    }

    return campos;
  },

  /** Devuelve la etiqueta con la capitalización del catálogo (el match es case-insensitive). */
  _canonizarEtiqueta: function(encontrada, etiquetas) {
    const buscada = encontrada.toLowerCase();
    for (let i = 0; i < etiquetas.length; i++) {
      if (etiquetas[i].toLowerCase() === buscada) return etiquetas[i];
    }
    return encontrada;
  },

  /**
   * Descarta valores que no aportan: vacíos, y sobre todo variables de vROps que
   * no resolvieron y llegan literales como "${VMWARE|HostSystem|summary|parentCluster}".
   */
  _esValorUtil: function(valor) {
    if (!valor) return false;
    const limpio = valor.trim();
    if (limpio === '') return false;
    if (limpio.indexOf('${') !== -1) return false;
    const descartables = ['n/a', 'null', 'undefined', '-', 'unknown', 'desconocido'];
    return descartables.indexOf(limpio.toLowerCase()) === -1;
  },

  /**
   * Arma el bloque de detalle. Sale como texto multilínea porque MessageFormatter
   * ya parte por '\n' y renderiza cada línea como un bullet, tanto en Slack como en HTML.
   * Gracias a eso el formato nuevo no obliga a tocar la capa de presentación.
   */
  _construirDetalle: function(categoria, campos, alarma, nombreCrudo) {
    const lineas = [];
    const ocultarDescripcion = this._descripcionSilenciada(alarma, nombreCrudo);

    categoria.detalles.forEach(etiqueta => {
      const valor = campos[etiqueta];
      if (!valor) return;
      if (etiqueta === VropsCategorias.ETIQUETA_TESTIGO && ocultarDescripcion) return;

      // Un campo = un bullet. Los saltos de línea internos del valor se colapsan porque
      // MessageFormatter parte por '\n', y si no, un campo de varias líneas (típico en
      // Recomendacion) se rompería en bullets sueltos sin rótulo.
      const valorPlano = valor.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

      if (etiqueta === VropsCategorias.ETIQUETA_TESTIGO) {
        lineas.push(valorPlano); // la descripción es el texto principal, va sin rótulo
      } else {
        lineas.push(`${etiqueta}: ${valorPlano}`);
      }
    });

    return lineas.length > 0 ? lineas.join('\n') : null;
  }
};
