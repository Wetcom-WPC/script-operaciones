/**
 * Servicio encargado exclusivamente de parsear texto de alarmas y extraer 
 * metadatos (Origen, Cluster, Target, Nombre y Summary).
 * Aplica expresiones regulares complejas, liberando de esta carga al procesador central.
 */
const AlarmParser = {

  extraerNombreYResumenAlarma: function(summary, mapaAlarmas, warnings) {
    let cleanSummary = summary ? summary.toString().trim() : '';

    // Normaliza las variantes del identificador de alarma ("[Alarm foo]", "[[alarm] foo]")
    // a la forma canónica "[alarm.foo]", sin importar si están al inicio exacto o tienen
    // espacios invisibles previos.
    //
    // El (?!\.) es imprescindible: sin él la regex también matchea lo que YA está en la
    // forma canónica ("[alarm.CertificateStatusAlarm]") y le antepone un segundo punto,
    // dejando "[alarm..CertificateStatusAlarm]". Ese punto de más se filtra después al
    // nombre de la alarma y al detalle que se publica: en SOPFALABEL-26796 el detalle
    // salía como ".CertificateStatusAlarm] Certificate 'O=...'".
    cleanSummary = cleanSummary.replace(/\[\[?alarm\]?\s*(?!\.)([^\]]+)\]/i, '[alarm.$1]');

    const interceptors = [
      {
        regex: /(Lost path redundancy to storage device|Path redundancy to storage device|Lost connectivity to storage device)\s+(naa\..*)/i,
        action: (match) => {
          const alarmaNombre = match[1].trim(); 
          let summaryResto = "";
          if (alarmaNombre.toLowerCase().includes('path redundancy')) {
            summaryResto = "storage device " + match[2];
          } else {
            summaryResto = match[1] + " " + match[2];
          }
          return { alarmaNombre, summaryResto };
        }
      },
      {
        regex: /(Host\s+.*?\s+is not responding)/i,
        action: (match) => ({ alarmaNombre: "Host is not responding", summaryResto: match[1] })
      },
      {
        regex: /(Lost connection to server)\s+(.*)/i,
        action: (match) => ({ alarmaNombre: "Lost connection to server", summaryResto: match[1] + " " + match[2] })
      },
      {
        regex: /(vSphere HA initiated a failover action)\s+(.*)/i,
        action: (match) => ({ alarmaNombre: "vSphere HA initiated a failover action", summaryResto: match[2].trim() })
      },
      {
        regex: /(vSAN Health Test)\s+(.*)/i,
        action: (match) => ({ alarmaNombre: "vSAN Health Test", summaryResto: match[2].trim() })
      },
      {
        regex: /(Insufficient resources to satisfy vSphere HA failover level)\s*(.*)/i,
        action: (match) => ({ alarmaNombre: "Insufficient resources to satisfy vSphere HA failover level", summaryResto: match[2].trim() })
      },
      {
        regex: /(Hardware Sensor Status.*)/i,
        action: (match) => ({ alarmaNombre: "Hardware Sensor Status", summaryResto: match[1].trim() })
      }
    ];

    let alarmaNombre = "Nombre de alarma no encontrado";
    let summaryResto = cleanSummary;
    let matchFound = false;

    for (let interceptor of interceptors) {
      const match = cleanSummary.match(interceptor.regex);
      if (match) {
        const result = interceptor.action(match);
        alarmaNombre = result.alarmaNombre;
        summaryResto = result.summaryResto;
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      const patronesEspecificos = [
        /.*?Alarm\s+'?(.*?)'?\s+on/i, 
        // El (?!\[?alarm\.) evita que este patrón, que es el genérico
        // "<target> - <texto de la alarma>", se coma un identificador canónico que ya
        // tiene su propio patrón más abajo. Sin él, en "Datacenters - [alarm.X] ..."
        // cortaba en el punto de "[alarm." y devolvía "[alarm" como nombre de alarma, con
        // lo que TODAS las alarmas de esa forma colapsaban a un mismo nombre: ver
        // SOPFALABEL-26796, que se publicó como alarma de licencia siendo de certificado.
        /^(?:[^\s]+\s+-\s+)(?!\[?alarm\.)(.*?)(?:\s+on\s+[^.]*)?(?:\.|$)/i,
        /\[alarm\.StorageConnectivityAlarm\] .*?(Lost connection|Path redundancy)(?: to|)/i, 
        /\[VMware vCenter - Alarm alarm\.(\S+)\]/i,
        /\[(.+?)\] Alarm '(.*?)' on/i,
        /\[?alarm\.([^\]\s]+)\]?/i, 
        /\[Failed\] (\S+)/i,
        /Alert Email Digest: (\S+)/i
      ];
      
      for (let regex of patronesEspecificos) {
        const match = cleanSummary.match(regex);
        if (match) {
          alarmaNombre = match[2] || match[1] || alarmaNombre;
          // El detalle es lo que queda del summary al quitarle el pedazo que identificó a
          // la alarma. Si ese pedazo venía en el medio ("Datacenters - [alarm.X] ..."), lo
          // que queda delante es el target, que ya se publica en su propia fila: se
          // descarta para que el detalle no lo repita.
          const antes = cleanSummary.slice(0, match.index);
          const despues = cleanSummary.slice(match.index + match[0].length);
          const prefijo = /\s+-\s+$/.test(antes) ? '' : antes;

          summaryResto = `${prefijo} ${despues}`.replace(/\s{2,}/g, ' ').trim();
          summaryResto = summaryResto.replace(/^-\s*/, '');
          matchFound = true;
          break;
        }
      }
    }

    if (!matchFound) {
      const matchAlertA = cleanSummary.match(/Alert A\d{4}/i);
      if (matchAlertA) {
        summaryResto = cleanSummary.replace(matchAlertA[0], '').trim();
        alarmaNombre = "Alert A####";
        matchFound = true;
      } else {
        const matchGeneral = cleanSummary.match(/\[(.*?)\]/i);
        if (matchGeneral) {
          summaryResto = cleanSummary.replace(matchGeneral[0], '').trim();
          alarmaNombre = matchGeneral[1];
        }
      }
    }

    // Proceso de cruce con Mapa (Sin reglas hardcodeadas)
    const alarmaProcesada = this.resolverNombreAlarma(alarmaNombre, mapaAlarmas, warnings, summary);

    return { alarma: alarmaProcesada, summaryResto };
  },

  /**
   * Cruza un nombre de alarma crudo contra la hoja "Tipos de Alarmas".
   * Compartido por todos los parsers para que la resolución del nombre sea idéntica
   * en cualquier dialecto.
   *
   * Contempla el caso de las filas cargadas con el texto placeholder (ej: "Configurar en Excel"):
   * son alarmas dadas de alta pero todavía sin traducir. Si se devolviera ese valor tal cual,
   * TODAS las alarmas pendientes aparecerían en Slack bajo un mismo bullet llamado
   * "Configurar en Excel" y agrupadas entre sí. En vez de eso se muestra el nombre original
   * y se deja un warning. Cuando alguien complete la columna B de la planilla, empieza a
   * funcionar solo, sin tocar código.
   *
   * @param {string} alarmaNombre    Nombre crudo extraído del summary.
   * @param {Object} mapaAlarmas     Diccionario de la hoja "Tipos de Alarmas".
   * @param {Array}  warnings        Acumulador de avisos (se muta).
   * @param {string} summaryOriginal Summary completo, sólo para el texto del warning.
   * @return {string} Nombre de alarma a mostrar.
   */
  resolverNombreAlarma: function(alarmaNombre, mapaAlarmas, warnings, summaryOriginal) {
    const normalizar = (txt) => (txt || '').toString().replace(/'/g, '').toLowerCase().trim();
    const alarmaNormalizada = normalizar(alarmaNombre);

    const alarmaEncontrada = Object.keys(mapaAlarmas || {}).find(key =>
      normalizar(key) === alarmaNormalizada
    );

    if (!alarmaEncontrada) {
      warnings.push(`Alarma no encontrada para el summary "${summaryOriginal}"`);
      return `Alarma desconocida [${alarmaNombre}]`;
    }

    const valorMapeado = mapaAlarmas[alarmaEncontrada];
    const placeholder = Config.PLACEHOLDER_TIPO_ALARMA;

    // Comparación por prefijo: la planilla usa variantes numeradas ("Configurar en Excel 2")
    if (placeholder && normalizar(valorMapeado).indexOf(normalizar(placeholder)) === 0) {
      warnings.push(`Tipo de alarma pendiente de configurar en la planilla: "${alarmaNombre}"`);
      return alarmaNombre;
    }

    return valorMapeado;
  },

  /**
   * Corte de un valor: hasta el fin de línea, el fin del texto, o la próxima etiqueta
   * conocida del cuerpo.
   *
   * Lo último es imprescindible. Jira aplana la description desde ADF uniendo los
   * párrafos con un ESPACIO, así que un cuerpo que en la UI se ve en varias líneas puede
   * llegar sin saltos. Cortando sólo por '\n' o fin de texto, un campo como vCenter se
   * termina llevando puesto todo el resto del cuerpo como si fuera su valor.
   */
  CORTE_VALOR: '(?=\\n|$|\\s(?:vCenter|Cluster Name|Target|Previous Status|New Status|Alarm Definition|Description|Descripcion|Recomendacion)\\s*:)',

  extraerOrigen: function(description, summary) {
    const origen = { vCenter: 'Desconocido', cluster: 'Desconocido', target: 'Target no encontrado' };

    const vCenterMatch = description.match(new RegExp('vCenter\\s*:?\\s*(.*?)' + this.CORTE_VALOR, 'i'));
    if (vCenterMatch && vCenterMatch[1].trim() !== '') {
      origen.vCenter = vCenterMatch[1].trim();
    }

    const clusterMatch = description.match(new RegExp('Cluster Name\\s*:?\\s*(.*?)' + this.CORTE_VALOR, 'i'));
    if (clusterMatch && clusterMatch[1].trim() !== '') {
      origen.cluster = clusterMatch[1].trim();
    }

    // (?:^|\s) antes de "Target": sin esto, "SubTarget:" matchea igual (la etiqueta es una
    // subcadena de otra palabra), y el valor de la etiqueta ajena se toma como si fuera el
    // target real.
    const targetMatch = description.match(new RegExp('(?:^|\\s)Target:?\\s*(.*?)' + this.CORTE_VALOR, 'i'));
    if (targetMatch && targetMatch[1].trim() !== '') {
      origen.target = targetMatch[1].trim();
    } else if (summary) {
      const summaryMatch = summary.match(/^(.*?)\s+-\s+(?:vSAN|vSphere|Host|Alarm|\[|Lost|Path|Insufficient|Hardware)/i);
      if (summaryMatch) origen.target = summaryMatch[1].trim();
      else {
        const fallbackMatch = summary.match(/^(.+?)\s+-/i);
        if (fallbackMatch) origen.target = fallbackMatch[1].trim();
      }
    }
    
    return origen;
  }
};
