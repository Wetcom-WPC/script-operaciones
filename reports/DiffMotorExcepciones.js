/**
 * ======================================================================
 * COMPARADOR DEL MOTOR DE EXCEPCIONES — PRODUCCIÓN vs. PLAYGROUND
 * ======================================================================
 *
 * `procesarReglasExcepciones` (core/ClientConfigService.js) se reescribió en Playground
 * y lo consumen TODAS las operaciones, no sólo snapshots. Siete cambios de comportamiento
 * mueven el resultado en direcciones opuestas: algunos activan excepciones que hoy están
 * inertes (menos tickets) y otros desactivan comodines accidentales (más tickets).
 *
 * Esta herramienta responde, sobre las planillas reales y sin tocarlas, la única pregunta
 * que importa antes de promover a producción: para qué cliente y en qué pestaña cambia el
 * set de reglas efectivas, y por qué. Si da diferencias, que sean decisiones tomadas y no
 * efectos colaterales.
 *
 * ES DE SOLO LECTURA. No escribe en las planillas de los clientes, no toca Jira, no manda
 * correos ni Slack. Concretamente: `procesarReglasExcepciones` desactiva filas vencidas
 * escribiendo "NO" en la columna F cuando recibe la hoja, así que acá se la llama con
 * `null` a propósito (ver AGENTS.md §8: una herramienta de diagnóstico no modula estado).
 *
 * Borrar este archivo una vez promovido el cambio a producción: su único motivo de existir
 * es la ventana en la que las dos versiones conviven.
 */

/**
 * Compara, pestaña por pestaña, las reglas que produce el parser productivo contra las que
 * produce el de Playground.
 *
 * @param {Object} [opciones]
 * @param {string} [opciones.cliente] Acota la corrida a un cliente (coincidencia parcial, sin
 *   distinguir mayúsculas). Sin esto recorre todas las planillas del Índice Maestro.
 * @param {number} [opciones.minutosMax=4.5] Presupuesto de tiempo. Apps Script corta a los 6
 *   minutos: al llegar al límite se detiene ordenadamente y dice por dónde seguir.
 * @param {boolean} [opciones.soloDiferencias=true] En false lista también las pestañas iguales.
 * @returns {Object} Resumen con el detalle de cada diferencia encontrada.
 */
function manual_compararMotorExcepciones(opciones = {}) {
  const t0 = Date.now();
  const limiteMs = (opciones.minutosMax || 4.5) * 60 * 1000;
  const filtroCliente = opciones.cliente ? String(opciones.cliente).trim().toLowerCase() : null;
  const soloDiferencias = opciones.soloDiferencias !== false;

  Logger.log('=== COMPARADOR DEL MOTOR DE EXCEPCIONES (solo lectura) ===');

  if (typeof procesarReglasExcepciones !== 'function') {
    Logger.log('FATAL: no existe procesarReglasExcepciones en este proyecto.');
    return { status: 'ERROR', motivo: 'SIN_PARSER_NUEVO' };
  }

  const planillas = _obtenerPlanillasExcepcionesUnicas();
  if (!planillas.length) {
    Logger.log('No se encontró ninguna planilla de excepciones en el Índice Maestro.');
    return { status: 'SIN_DATOS' };
  }

  const diferencias = [];
  const tallyMotivos = {};
  let pestanasLeidas = 0, pestanasConDiferencia = 0, planillasRecorridas = 0;
  let cortadoEn = null;

  for (const planilla of planillas) {
    const clientes = planilla.clientes.join(' / ') || '(sin nombre)';

    if (filtroCliente && clientes.toLowerCase().indexOf(filtroCliente) === -1) continue;

    if (Date.now() - t0 > limiteMs) {
      cortadoEn = clientes;
      Logger.log(`\n[TIEMPO] Presupuesto agotado antes de "${clientes}". Volver a correr con {cliente: "..."} para seguir desde ahí.`);
      break;
    }

    planillasRecorridas++;
    let hojas;
    try {
      hojas = SpreadsheetApp.openById(planilla.fileId).getSheets();
    } catch (e) {
      Logger.log(`[AVISO] ${clientes}: no se pudo abrir la planilla (${e.message}).`);
      continue;
    }

    for (const hoja of hojas) {
      const pestana = hoja.getName();
      let datos;
      try {
        datos = hoja.getDataRange().getValues();
      } catch (e) {
        Logger.log(`[AVISO] ${clientes} / "${pestana}": no se pudo leer (${e.message}).`);
        continue;
      }
      if (!datos || datos.length < 2) continue;

      pestanasLeidas++;

      // `null` como hoja: ninguno de los dos parsers escribe nada.
      const viejo = _parserExcepcionesProduccion(datos);
      const nuevo = procesarReglasExcepciones(datos, null);

      const motivos = _motivosDeDivergencia(datos);
      const cambioGrupos = _compararGrupos(viejo, nuevo);

      if (!motivos.length && !cambioGrupos.hayCambio) {
        if (!soloDiferencias) Logger.log(`   = ${clientes} / "${pestana}": sin cambios.`);
        continue;
      }

      pestanasConDiferencia++;
      diferencias.push({ cliente: clientes, pestana: pestana, motivos: motivos, grupos: cambioGrupos });

      Logger.log(`\n>> ${clientes} / pestaña "${pestana}"`);
      Logger.log(`   reglas efectivas: ${Object.keys(viejo).length} (prod) -> ${Object.keys(nuevo).length} (nuevo)`);

      if (cambioGrupos.soloViejo.length) Logger.log(`   dejan de existir: ${cambioGrupos.soloViejo.join(', ')}`);
      if (cambioGrupos.soloNuevo.length) Logger.log(`   aparecen:         ${cambioGrupos.soloNuevo.join(', ')}`);
      if (cambioGrupos.modificados.length) Logger.log(`   cambian:          ${cambioGrupos.modificados.join(', ')}`);

      motivos.forEach(m => {
        tallyMotivos[m.motivo] = (tallyMotivos[m.motivo] || 0) + 1;
        Logger.log(`   fila ${m.fila}: ${m.motivo} — ${m.detalle}`);
        Logger.log(`              efecto: ${m.efecto}`);
      });
    }
  }

  Logger.log('\n=== RESUMEN ===');
  Logger.log(`planillas recorridas: ${planillasRecorridas}   pestañas leídas: ${pestanasLeidas}   con diferencias: ${pestanasConDiferencia}`);
  if (!Object.keys(tallyMotivos).length) {
    Logger.log('Ninguna fila real dispara los cambios de comportamiento: el reemplazo del parser es transparente sobre los datos de hoy.');
  } else {
    Logger.log('motivos encontrados (cantidad de filas):');
    Object.keys(tallyMotivos).sort().forEach(k => Logger.log(`   ${k}: ${tallyMotivos[k]}`));
  }
  if (cortadoEn) Logger.log(`INCOMPLETO: se cortó por tiempo en "${cortadoEn}".`);
  Logger.log(`(${Math.round((Date.now() - t0) / 1000)} s)`);

  return {
    status: cortadoEn ? 'INCOMPLETO' : 'OK',
    planillasRecorridas, pestanasLeidas, pestanasConDiferencia,
    tallyMotivos, diferencias, cortadoEn
  };
}

/**
 * Atajo para mirar un cliente puntual sin recorrer todo el Índice.
 */
function manual_compararMotorExcepcionesDeCliente(nombreCliente) {
  return manual_compararMotorExcepciones({ cliente: nombreCliente, soloDiferencias: false });
}

// ======================================================================
// COPIA CONGELADA DEL PARSER PRODUCTIVO
// ======================================================================

/**
 * Réplica exacta del agrupamiento de `procesarReglasExcepciones` tal como está hoy en `main`
 * (Ops Operativo), recortada a la parte que agrupa reglas: se omite el barrido de
 * vencimientos porque es idéntico en las dos versiones y es el único que escribe.
 *
 * Sí, esto duplica lógica, que es justo lo que AGENTS.md §5 prohíbe. La diferencia es que no
 * es una segunda implementación en el camino de ejecución: es una foto de una versión
 * concreta, que existe únicamente para poder compararla contra la nueva. Nadie debe llamarla
 * desde el flujo normal, y se va con este archivo cuando el cambio esté promovido.
 */
function _parserExcepcionesProduccion(rawExceptionData) {
  const exceptionData = rawExceptionData.slice(1);
  const activas = exceptionData.filter(row => (row[5] != null ? String(row[5]) : '').toUpperCase() === 'SI');
  const grupos = {};

  activas.forEach(row => {
    const exceptionId = row[0];
    if (!grupos[exceptionId]) grupos[exceptionId] = [];
    grupos[exceptionId].push({
      column: row[1],
      matchType: row[2],
      values: (row[3] != null ? String(row[3]) : '').split(',').map(v => v.trim().toLowerCase()),
      ageLimit:  (row[6] !== undefined && row[6] !== '') ? Number(row[6]) : null,
      sizeLimit: (row[7] !== undefined && row[7] !== '') ? Number(row[7]) : null,
      qtyLimit:  (row[8] !== undefined && row[8] !== '') ? Number(row[8]) : null,
      sizeType:  (row[9]  != null ? String(row[9])  : '').toLowerCase(),
      criterio:  (row[10] != null ? String(row[10]) : '').toLowerCase()
    });
  });

  return grupos;
}

// ======================================================================
// DETECCIÓN DE LOS CAMBIOS DE COMPORTAMIENTO, FILA POR FILA
// ======================================================================

/**
 * Revisa cada fila y devuelve qué cambios del parser nuevo la afectan, con el efecto concreto
 * sobre los tickets. Decir "esta pestaña cambió" no alcanza: hay que poder mirar la fila y
 * decidir si el cambio es el deseado.
 *
 * @param {Array<Array<any>>} rawExceptionData Datos crudos de la pestaña (con encabezado).
 * @returns {Array<{fila: number, motivo: string, detalle: string, efecto: string}>}
 */
function _motivosDeDivergencia(rawExceptionData) {
  const filas = rawExceptionData.slice(1);
  const motivos = [];
  const texto = (v) => (v != null ? String(v) : '');

  filas.forEach((row, i) => {
    const nroFila = i + 2; // +1 por el encabezado, +1 porque las filas de la hoja arrancan en 1
    const activaCruda = texto(row[5]);
    const activaVieja = activaCruda.toUpperCase() === 'SI';
    const activaNueva = activaCruda.trim().toUpperCase() === 'SI';

    if (activaNueva && !activaVieja) {
      motivos.push({
        fila: nroFila, motivo: 'ACTIVA_POR_TRIM',
        detalle: `la columna F dice "${activaCruda}" (con espacios), que hoy no cuenta como SI`,
        efecto: 'la regla pasa a estar ACTIVA: el cliente puede dejar de recibir alertas que hoy sí recibe'
      });
    }
    if (!activaNueva) return; // El resto de los cambios sólo aplica a filas activas.

    const col = texto(row[1]);
    if (col.trim() === '') {
      motivos.push({
        fila: nroFila, motivo: 'FILA_IGNORADA_SIN_COLUMNA',
        detalle: `activa pero sin "Columna del Reporte" (ID "${texto(row[0]).trim()}")`,
        efecto: 'hoy esta fila hace fallar TODO su grupo (las filas de un mismo ID se evalúan con AND); al descartarla, el resto del grupo se activa y pueden dejar de llegar alertas'
      });
      return;
    }
    if (col !== col.trim()) {
      motivos.push({
        fila: nroFila, motivo: 'COLUMNA_CON_ESPACIOS',
        detalle: `la columna del reporte es "${col}" (con espacios al borde)`,
        efecto: 'hoy no matchea ningún encabezado y la regla queda inerte; recortada, empieza a aplicar'
      });
    }

    if (texto(row[0]).trim() === '') {
      motivos.push({
        fila: nroFila, motivo: 'ID_VACIO_SEPARADO',
        detalle: 'fila activa sin ID de excepción',
        efecto: 'hoy todas las filas sin ID caen en un único grupo unido por AND (normalmente imposible de cumplir); ahora cada una es una regla independiente y aplica sola'
      });
    }

    const valores = texto(row[3]);
    if (valores.trim() !== '') {
      const generaVacio = valores.split(',').map(v => v.trim()).some(v => v === '');
      if (generaVacio) {
        motivos.push({
          fila: nroFila, motivo: 'VALOR_VACIO_COMODIN',
          detalle: `los valores "${valores}" generan un valor vacío (coma suelta o al final)`,
          efecto: 'hoy ese valor vacío matchea CUALQUIER fila del reporte y silencia todo; al eliminarlo van a volver a aparecer alertas legítimas'
        });
      }
      if (valores.indexOf(';') !== -1 || valores.indexOf('\n') !== -1 || valores.indexOf('\r') !== -1) {
        motivos.push({
          fila: nroFila, motivo: 'SEPARADOR_NUEVO',
          detalle: 'los valores usan ; o salto de línea como separador',
          efecto: 'hoy se leen como UN valor largo que no matchea nada; ahora se separan y cada uno aplica'
        });
      }
    }

    [[6, 'AGE'], [7, 'SIZE'], [8, 'QTY']].forEach(par => {
      const idx = par[0], nombre = par[1];
      const v = row[idx];
      if (v === undefined || v === null || v === '') return;
      if (String(v).trim() === '') {
        motivos.push({
          fila: nroFila, motivo: 'LIMITE_BLANCO_A_NULL',
          detalle: `el umbral ${nombre} tiene sólo espacios`,
          efecto: `hoy se interpreta como ${nombre}=0, que con comparaciones >= matchea todo; ahora queda sin umbral`
        });
      }
    });
  });

  return motivos;
}

/**
 * Compara los dos objetos de grupos y dice qué IDs aparecen, desaparecen o cambian.
 */
function _compararGrupos(viejo, nuevo) {
  // Sin recortar espacios a propósito: " Name " y "Name" producen reglas distintas (una
  // inerte y la otra activa), así que acá tienen que contar como un cambio.
  const canon = (grupo) => JSON.stringify((grupo || []).map(c => [
    String(c.column == null ? '' : c.column), String(c.matchType == null ? '' : c.matchType),
    (c.values || []).slice().sort(), c.ageLimit, c.sizeLimit, c.qtyLimit, c.sizeType, c.criterio
  ]));

  const idsViejo = Object.keys(viejo || {});
  const idsNuevo = Object.keys(nuevo || {});

  const soloViejo = idsViejo.filter(id => idsNuevo.indexOf(id) === -1);
  const soloNuevo = idsNuevo.filter(id => idsViejo.indexOf(id) === -1);
  const modificados = idsViejo
    .filter(id => idsNuevo.indexOf(id) !== -1)
    .filter(id => canon(viejo[id]) !== canon(nuevo[id]));

  return {
    hayCambio: soloViejo.length > 0 || soloNuevo.length > 0 || modificados.length > 0,
    soloViejo, soloNuevo, modificados
  };
}
