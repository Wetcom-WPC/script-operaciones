/**
 * Lógica de negocio principal para procesar e interpretar las alarmas
 */
const AlarmProcessor = {
  
  procesarAlarmas: function(tickets, mappings) {
    const errores = [];
    const mensajesProcesados = {};
    const alarmasSilenciadas = [];
    // Se acumulan primero y se agrupan al final, porque la deduplicación por cobertura
    // necesita ver el lote completo para saber cuál de las copias conviene conservar.
    const candidatas = [];

    tickets.forEach((ticket, index) => {
      const warnings = [];
      try {
        if (!ticket.key) throw new Error(`Clave faltante`);
        if (!ticket.created || isNaN(ticket.created.getTime())) throw new Error(`Fecha inválida o faltante`);

        let cliente = this._obtenerClaveCliente(ticket.key, mappings.mapaClientes);
        if (cliente.includes('No encontrado')) {
          warnings.push(`Cliente no encontrado para la clave "${ticket.key}"`);
          cliente = 'Cliente Desconocido';
        }

        let pod = ticket.pod;
        if (!pod || pod === 'POD Desconocido') {
          // Sin POD ninguna regla de Excepciones puede matchear (las reglas viven en hojas
          // por POD), así que la alarma quedaría imposible de silenciar. La hoja Clientes ya
          // declara a qué POD pertenece cada proyecto, así que se usa como respaldo cuando
          // Jira no trae el custom field: tickets cargados a mano, proyectos de prueba o
          // automatizaciones que no lo setean.
          const podDePlanilla = this._obtenerPodDePlanilla(ticket.key, mappings.mapaPodsClientes);
          if (podDePlanilla) {
            pod = podDePlanilla;
            warnings.push(`POD tomado de la hoja Clientes ("${pod}"): el ticket "${ticket.key}" no lo trae en el custom field de Jira`);
          } else {
            warnings.push(`POD no encontrado para el ticket "${ticket.key}" en el custom field de Jira`);
            pod = 'POD Desconocido';
          }
        }

        // El registry elige el parser según el dialecto del ticket y devuelve
        // siempre el mismo modelo canónico, así que de acá para abajo da igual
        // si la alarma vino del formato viejo o del nuevo.
        const parseada = AlarmParserRegistry.parsear(ticket, mappings, warnings);
        if (!parseada.incluir) return;

        const alarmaProcesada = parseada.alarma;
        let origen = parseada.origen;
        let summaryResto = parseada.summaryResto;

        // Política transversal: descartes por diseño y falsos positivos, sin importar el dialecto.
        if (this._debeExcluirse(alarmaProcesada, ticket.summary)) return;

        if (parseada.usaFormattersLegacy) {
          const formato = this._formatearAlarmaPorTipo(alarmaProcesada, summaryResto, origen.target, ticket.description);
          if (!formato.incluir) return; // Si debe excluirse (Ej. Falso positivo) no hace nada

          origen.target = formato.nuevoTarget;
          origen.etiquetaTarget = formato.etiquetaTarget;
          summaryResto = formato.nuevoSummary;
        } else if (!origen.etiquetaTarget && origen.target) {
          // Red de seguridad: un parser nuevo debería rotular siempre su objeto.
          origen.etiquetaTarget = this._inferirEtiquetaTarget(origen.target);
        }

        // Filtrado por reglas de Excepciones dinámicas
        const excepcion = this._verificarExcepcion(pod, cliente, alarmaProcesada, origen, summaryResto, mappings.reglasExcepcion);
        if (excepcion.matcheada) {
          alarmasSilenciadas.push({ log: excepcion.log, ticketKey: ticket.key, idExcepcion: excepcion.idExcepcion });
          return; // La alarma cae dentro de una ventana de mantenimiento o excepción, se omite.
        }

        candidatas.push({
          pod: pod,
          cliente: cliente,
          alarma: alarmaProcesada,
          origen: origen,
          summaryResto: summaryResto,
          created: ticket.created,
          warnings: warnings,
          ticketKey: ticket.key,
          clave: this._claveDeduplicacion(pod, cliente, alarmaProcesada, origen)
        });

      } catch (err) {
        // Las alarmas ya no vienen de una planilla, sino de la API de Jira: no hay ninguna
        // fila real a la que referirse. Se identifica por la key del ticket y, sólo si ni
        // eso está disponible (el propio caso de "Clave faltante"), por su posición en el
        // lote — nunca como si fuera un número de fila de Excel.
        const identificador = ticket.key || `elemento #${index + 1} del lote`;
        errores.push(`Ticket ${identificador}: ${err.message}`);
        Logger.log(`Error procesando ticket ${identificador}: ${err.message}`);
      }
    });

    const { conservadas, descartadas } = this._descartarDuplicadosPorCobertura(candidatas);

    descartadas.forEach(d => {
      Logger.log(`Duplicada por cobertura: se omite ${d.ticketKey} (${d.origen.cobertura}) - "${d.alarma}" sobre ${d.origen.target}`);
    });

    conservadas.forEach(c => {
      this._agruparMensaje(c, this._claveOrigen(c.origen), mensajesProcesados);
    });

    return { mensajesProcesados, errores, alarmasSilenciadas, duplicadasDescartadas: descartadas };
  },

  /**
   * Clave de identidad para decidir si dos alarmas son "la misma".
   * Devuelve null cuando la alarma no debe participar de la deduplicación.
   *
   * Deliberadamente NO incluye vCenter ni Cluster: la copia que llega por el canal 24x7
   * suele traer menos datos de ubicación que la del 9x5, y si se compararan esos campos
   * nunca se reconocerían como la misma alarma.
   */
  _claveDeduplicacion: function(pod, cliente, alarma, origen) {
    // Sin cobertura no hay con qué desempatar: las del formato histórico quedan afuera.
    if (!origen || !origen.cobertura) return null;

    const target = (origen.target || '').toString().toLowerCase().trim();

    // Si no se pudo identificar el objeto afectado, no hay forma de afirmar que sean la
    // misma alarma. Ante la duda se informan las dos: perder una alarma es mucho peor
    // que mostrarla repetida.
    if (!target || target.indexOf('desconocido') !== -1 || target.indexOf('no encontrado') !== -1) return null;

    return [pod, cliente, alarma, target].join('||').toLowerCase();
  },

  /**
   * Cuando la misma alarma sobre el mismo objeto llega por varias coberturas, conserva
   * únicamente la de mayor prioridad según Config.PRIORIDAD_COBERTURA.
   *
   * Los duplicados de la MISMA cobertura no se tocan: se siguen agrupando como siempre
   * (un solo ítem con su rango de fechas).
   */
  _descartarDuplicadosPorCobertura: function(candidatas) {
    const prioridad = Config.PRIORIDAD_COBERTURA || [];
    if (prioridad.length < 2) return { conservadas: candidatas, descartadas: [] };

    // Las coberturas no listadas quedan últimas: ante algo desconocido, preferimos las conocidas.
    const rango = (cobertura) => {
      const i = prioridad.indexOf(cobertura);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };

    const mejorRango = {};
    candidatas.forEach(c => {
      if (!c.clave) return;
      const r = rango(c.origen.cobertura);
      if (mejorRango[c.clave] === undefined || r < mejorRango[c.clave]) mejorRango[c.clave] = r;
    });

    const conservadas = [];
    const descartadas = [];

    candidatas.forEach(c => {
      // Se descarta sólo si otra copia tiene una cobertura ESTRICTAMENTE mejor
      if (c.clave && rango(c.origen.cobertura) > mejorRango[c.clave]) {
        descartadas.push(c);
      } else {
        conservadas.push(c);
      }
    });

    return { conservadas, descartadas };
  },

  /**
   * Clave con la que `mensajesProcesados[pod][cliente][alarma]` agrupa por origen
   * (vCenter/cluster/target/etiqueta/cobertura). MessageFormatter la vuelve a parsear con
   * `JSON.parse` para leer esos campos al renderizar.
   *
   * Con `JSON.stringify(origen)` a secas, dos objetos con las mismas claves pero insertadas
   * en otro orden (ej: un parser que agrega `etiquetaTarget` antes de `cobertura` y otro que
   * lo hace después) generan strings distintos y la misma alarma termina en dos grupos en
   * vez de uno, sin que nadie lo haya decidido así. Ordenar las claves antes de serializar
   * lo vuelve una decisión explícita en vez de un efecto colateral del orden de inserción.
   */
  _claveOrigen: function(origen) {
    return JSON.stringify(origen, Object.keys(origen).sort());
  },

  _obtenerClaveCliente: function(key, mapaClientes) {
    const codigoCliente = key.split('-')[0];
    return mapaClientes[codigoCliente] || `No encontrado (${codigoCliente})`;
  },

  /**
   * POD declarado en la hoja Clientes para el proyecto de Jira del ticket (Ej: WST → WPC).
   * Devuelve null si la planilla no lo declara, para que quien llame decida el fallback.
   */
  _obtenerPodDePlanilla: function(key, mapaPodsClientes) {
    if (!mapaPodsClientes) return null;
    const codigoCliente = key.split('-')[0];
    return mapaPodsClientes[codigoCliente] || null;
  },

  /**
   * Descartes que aplican a cualquier dialecto: los tipos ignorados por diseño
   * y cualquier alarma marcada como falso positivo.
   */
  _debeExcluirse: function(tipoAlarma, summaryOriginal) {
    const alarmasExcluir = Config.ALARMAS_IGNORADAS_POR_DEFECTO || [];
    const nombre = (tipoAlarma || '').toString();

    // Coincidencia exacta con los estáticos
    if (alarmasExcluir.includes(nombre)) return true;

    // "falso positivo" en cualquier parte del nombre resuelto O del summary crudo.
    // Mirar también el summary es imprescindible: antes estas alarmas se filtraban de
    // rebote (el nombre no se encontraba en la planilla y quedaba como
    // "Alarma desconocida [... Falso positivo ...]"). Al resolverse bien el nombre,
    // ese efecto colateral desaparece y sin este chequeo se colarían a Slack.
    const textoBuscable = `${nombre} ${summaryOriginal || ''}`.toLowerCase();
    return textoBuscable.includes('falso positivo');
  },

  /**
   * Deduce cómo rotular el objeto afectado cuando el parser no lo definió.
   * Los parsers de formatos nuevos deberían rotularlo ellos y no depender de esto.
   */
  _inferirEtiquetaTarget: function(target) {
    const lowerTarget = (target || '').toString().toLowerCase();

    if (lowerTarget.startsWith('esx') || lowerTarget.includes('host')) return 'Host';
    if (lowerTarget.startsWith('cl-') || lowerTarget.includes('cluster')) return 'Cluster';
    if (lowerTarget.startsWith('ds-') || lowerTarget.includes('datastore')) return 'Datastore';
    return 'Recurso Afectado';
  },

  _formatearAlarmaPorTipo: function(tipoAlarma, summaryResto, target, description) {
    if (this._debeExcluirse(tipoAlarma)) {
      return { incluir: false };
    }

    let resultado;
    // Implementación de Patrón Strategy: Busca el formateador, si no existe devuelve por defecto.
    // hasOwnProperty explícito: tipoAlarma sale de la hoja "Tipos de Alarmas", y un valor
    // como "constructor" no debe resolver contra el prototipo de Object.
    if (Object.prototype.hasOwnProperty.call(AlarmFormatters.manejadores, tipoAlarma)) {
      resultado = AlarmFormatters.manejadores[tipoAlarma](summaryResto, target, description);
    } else {
      resultado = { incluir: true, nuevoTarget: target, nuevoSummary: summaryResto };
    }

    if (resultado.incluir && !resultado.etiquetaTarget && resultado.nuevoTarget) {
      resultado.etiquetaTarget = this._inferirEtiquetaTarget(resultado.nuevoTarget);
    }

    return resultado;
  },

  /**
   * Vuelca una candidata en `mensajesProcesados[pod][cliente][alarma][target]`.
   *
   * Recibe la candidata entera en vez de sus campos sueltos: ya venía con ocho parámetros
   * posicionales y la key del ticket habría sido el noveno.
   */
  _agruparMensaje: function(candidata, target, mensajesProcesados) {
    const { pod, cliente, alarma, created, warnings, summaryResto, ticketKey } = candidata;

    if (!mensajesProcesados[pod]) mensajesProcesados[pod] = {};
    if (!mensajesProcesados[pod][cliente]) mensajesProcesados[pod][cliente] = {};
    if (!mensajesProcesados[pod][cliente][alarma]) mensajesProcesados[pod][cliente][alarma] = {};
    if (!mensajesProcesados[pod][cliente][alarma][target]) mensajesProcesados[pod][cliente][alarma][target] = [];

    mensajesProcesados[pod][cliente][alarma][target].push({
      created,
      warnings: warnings.length > 0 ? warnings.join(', ') : null,
      summaryResto,
      // La usa MessageFormatter para enlazar los tickets junto al nombre del cliente.
      ticketKey
    });
  },

  _verificarExcepcion: function(pod, cliente, tipoAlarma, origen, summaryResto, reglas) {
    if (!reglas || reglas.length === 0) return { matcheada: false };
    
    const ahora = new Date();

    for (let i = 0; i < reglas.length; i++) {
      const regla = reglas[i];
      
      // 1. Validar Caducidad
      if (regla.validaHasta && regla.validaHasta < ahora) continue;
      
      // 2. Validar POD
      const p1 = pod.toString().toUpperCase().replace(/POD/g, '').trim();
      const p2 = regla.pod.toString().toUpperCase().replace(/POD/g, '').trim();
      if (regla.pod !== 'TODOS' && p1 !== p2) continue;
      
      // 3. Validar Cliente (normalizado como el POD: mayúsculas/minúsculas y espacios de
      // más no deberían hacer fallar una regla cargada a mano)
      const cliente1 = cliente.toString().trim().toUpperCase();
      const cliente2 = regla.cliente.toString().trim().toUpperCase();
      if (regla.cliente !== 'TODOS' && cliente1 !== cliente2) continue;

      // 4. Validar Tipo Alarma (misma normalización)
      const tipo1 = tipoAlarma.toString().trim().toUpperCase();
      const tipo2 = regla.tipoAlarma.toString().trim().toUpperCase();
      if (regla.tipoAlarma !== 'TODAS' && tipo1 !== tipo2) continue;
      
      // 5. Validar Campo y Condición
      if (regla.campo !== 'CUALQUIERA' && regla.valor !== '') {
        let valorAComparar = '';
        if (regla.campo === 'vCenter') {
          valorAComparar = origen.vCenter;
        } else if (regla.campo === 'Cluster') {
          // Si el Target fue etiquetado dinámicamente como Cluster, usamos el target. Sino, el cluster extraído.
          valorAComparar = (origen.etiquetaTarget === 'Cluster') ? origen.target : origen.cluster;
        } else if (regla.campo === 'Host' || regla.campo === 'Target') {
          valorAComparar = origen.target;
        } else if (regla.campo === 'Datastore') {
          valorAComparar = `${origen.target || ''} ${summaryResto || ''}`;
        }
        
        valorAComparar = (valorAComparar || '').toLowerCase();
        const valorRegla = regla.valor.toLowerCase();
        
        let coincidencia = false;
        switch (regla.condicion.toLowerCase()) {
          case 'contiene':
            coincidencia = valorAComparar.includes(valorRegla);
            break;
          case 'empieza con':
            coincidencia = valorAComparar.startsWith(valorRegla);
            break;
          case 'termina con':
            coincidencia = valorAComparar.endsWith(valorRegla);
            break;
          case 'igual a':
          case 'coincidencia exacta':
            coincidencia = (valorAComparar === valorRegla);
            break;
          default:
            coincidencia = valorAComparar.includes(valorRegla); // Fallback
        }
        
        if (!coincidencia) continue;
      }
      
      // Si llega acá, matcheó todo
      const etiqueta = origen.etiquetaTarget || 'Target';
      return {
        matcheada: true,
        // El ID viaja aparte del log: el log está escrito para Slack (con markdown) y el
        // cierre en Jira necesita el dato limpio, sin tener que rasparlo de un texto.
        idExcepcion: regla.id,
        log: `Alarma silenciada por Excepción ID: *${regla.id}* | Cliente: ${cliente} | Alarma: ${tipoAlarma} | ${etiqueta}: ${origen.target || 'N/A'}`
      };
    }
    
    return { matcheada: false };
  }
};
