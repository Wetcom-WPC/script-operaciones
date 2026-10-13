/**
 * Parser del formato histórico (alarmas nativas de vCenter reenviadas por correo).
 *
 * Es un envoltorio fino sobre AlarmParser: no reimplementa nada. Existe para que
 * el formato viejo entre al registry como una estrategia más, y para dejarlo como
 * FALLBACK universal — si ningún parser específico reconoce un ticket, cae acá y
 * el comportamiento es exactamente el de siempre.
 *
 * No agregues acá lógica de formatos nuevos: creá un parser propio.
 */
const LegacyVCenterParser = {

  nombre: 'Legacy vCenter',

  /** Prioridad 0: siempre se evalúa último. */
  prioridad: 0,

  /** Acepta cualquier cosa. Es el default del Chain of Responsibility. */
  puedeParsear: function() {
    return true;
  },

  parsear: function(ticket, mappings, warnings) {
    // El equipo nuevo también reenvía alarmas nativas de vCenter, anteponiéndoles su
    // prefijo (ej: "9x5 - vCenter - alarm.StorageConnectivityAlarm"). Si no se quita,
    // las regex de AlarmParser cortan mal el nombre (queda "vCenter - alarm") y el
    // cruce contra la hoja "Tipos de Alarmas" falla siempre.
    const sobre = AlarmEnvelope.desensobrar(ticket.summary);
    const summaryLimpio = sobre.summary;

    const { alarma, summaryResto } = this._resolverAlarma(summaryLimpio, ticket, mappings, warnings);

    const origen = AlarmParser.extraerOrigen(ticket.description, summaryLimpio);

    if (origen.target === 'Target no encontrado') {
      warnings.push(`Target no encontrado en la descripción/summary "${ticket.summary}"`);
      origen.target = 'Target Desconocido';
    }

    // Sólo se agrega si existe, para que las alarmas del formato histórico conserven
    // exactamente la misma forma de `origen` que venían teniendo.
    if (sobre.cobertura) origen.cobertura = sobre.cobertura;

    return {
      incluir: true,
      alarma: alarma,
      origen: origen,
      summaryResto: this._resolverDetalle(summaryResto, ticket.description),
      // Los AlarmFormatters están escritos contra este dialecto, así que sí aplican.
      usaFormattersLegacy: true
    };
  },

  /**
   * Resuelve el nombre de la alarma con dos intentos.
   *
   * En el formato histórico el summary traía el ID de la alarma Y el texto descriptivo
   * juntos, y la planilla "Tipos de Alarmas" quedó indexada por ese texto descriptivo
   * (ej: "Path redundancy to storage device", "vSAN Health Test").
   *
   * Cuando el equipo nuevo reenvía la misma alarma, el summary queda sólo con el ID
   * (ej: "alarm.vsan.health.test.stretchedcluster.siteconnectivity") y el texto se mueve
   * a la sección "Description:" del cuerpo. Por eso, si el summary no da un nombre
   * conocido, se reintenta sobre esa sección con el MISMO extractor.
   *
   * Ventaja concreta: la alarma vieja y la nueva resuelven al mismo nombre, así que se
   * agrupan juntas en Slack en vez de aparecer como dos alarmas distintas, y no hay que
   * cargar filas nuevas en la planilla.
   */
  _resolverAlarma: function(summaryLimpio, ticket, mappings, warnings) {
    const primerIntento = this._intentar(summaryLimpio, mappings);

    if (!this._esDesconocida(primerIntento.alarma)) {
      warnings.push.apply(warnings, primerIntento.warnings);
      return primerIntento;
    }

    const bloque = this._extraerBloqueDescription(ticket.description);
    if (bloque) {
      const segundoIntento = this._intentar(bloque, mappings);
      if (!this._esDesconocida(segundoIntento.alarma)) {
        warnings.push.apply(warnings, segundoIntento.warnings);
        return segundoIntento;
      }
    }

    // Ninguno reconoció: se reporta el fallo del summary, que es el caso histórico.
    warnings.push(`Alarma no encontrada para el summary "${ticket.summary}"`);
    return primerIntento;
  },

  /** Corre el extractor sobre un texto sin contaminar el acumulador real de warnings. */
  _intentar: function(texto, mappings) {
    const warningsLocales = [];
    const resultado = AlarmParser.extraerNombreYResumenAlarma(texto, mappings.mapaAlarmas, warningsLocales);

    return {
      alarma: resultado.alarma,
      summaryResto: resultado.summaryResto,
      // Se descarta el "Alarma no encontrada" local: lo decide _resolverAlarma con la
      // visión de los dos intentos. El resto de avisos (ej: pendiente de configurar) se conserva.
      warnings: warningsLocales.filter(w => w.indexOf('Alarma no encontrada') !== 0)
    };
  },

  _esDesconocida: function(alarma) {
    return (alarma || '').toString().indexOf('Alarma desconocida') === 0;
  },

  /**
   * Devuelve el texto de la sección "Description:" del cuerpo, o null si no existe.
   *
   * OJO con el anclaje: NO se puede exigir un salto de línea antes de la etiqueta.
   * Jira entrega la description en ADF y JiraService une los párrafos de nivel superior
   * con un ESPACIO, así que un cuerpo que en la UI se ve en varias líneas puede llegar
   * como un único renglón. Anclar a `\n` hacía que el detalle se perdiera en producción.
   */
  _extraerBloqueDescription: function(description) {
    const texto = description ? description.toString() : '';
    const match = texto.match(/(?:^|\s)Description\s*:\s*([\s\S]+)$/i);
    if (!match) return null;

    const bloque = match[1].trim();
    return bloque !== '' ? bloque : null;
  },

  /**
   * En el formato reenviado por el equipo nuevo, el summary trae únicamente el ID de la
   * alarma (ej: "alarm.vsan.health.test.stretchedcluster.siteconnectivity") y el texto
   * legible queda en la sección "Description:" del cuerpo. Al quitarle el ID, el resto
   * del summary queda vacío y se perdería el detalle.
   *
   * Sólo se recurre al cuerpo cuando el summary no dejó nada: así los tickets del formato
   * histórico siguen comportándose exactamente igual que siempre.
   */
  _resolverDetalle: function(summaryResto, description) {
    if (summaryResto && summaryResto.toString().trim() !== '') return summaryResto;
    return this._extraerBloqueDescription(description) || summaryResto;
  }
};
