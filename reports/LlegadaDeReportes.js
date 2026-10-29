/**
 * @fileoverview A qué hora llega cada reporte que mandan los vRO / vROps / Veeam ONE de los
 * clientes.
 *
 * POR QUÉ EXISTE
 * La auditoría diaria (ReportesFaltantes.js) solo anota los reportes que FALTARON. Cuando el
 * reporte llega bien no queda registro de a qué hora, así que no se puede ver el caso que más
 * importa: el reporte que sigue llegando pero cada vez más tarde, porque el script del cliente
 * se degrada antes de romperse del todo. Cuando deja de llegar, el día ya se perdió; cuando
 * empieza a correrse, todavía se está a tiempo.
 *
 * POR QUÉ SE GUARDA Y NO SE CALCULA CADA VEZ
 * Reconstruir esto desde Gmail tarda más de 3 minutos para 5 días, y la búsqueda se trunca:
 * Gmail devuelve lo más reciente primero, así que los días viejos se pierden y aparecen como
 * si no hubiera llegado nada. Por eso se registra una vez por día, en una pestaña, y el
 * dashboard lee de ahí.
 *
 * LA HORA SALE DEL CORREO, NO DEL ARCHIVO EN DRIVE
 * La fecha del archivo es cuándo NOSOTROS lo archivamos: una demora de nuestro ciclo
 * aparecería como un retraso del cliente, y mandaríamos a revisar una tecnología que está bien.
 */

const LLEGADAS_TAB = "Llegada de Reportes";
// "Asunto real" es el ULTIMO a proposito: agregar al final deja intactas las filas ya
// escritas y las posiciones que lee el resto del codigo.
//
// POR QUE HIZO FALTA
// "Reporte" no guarda el asunto del correo sino el del PROCESSOR que lo matcheo. El 29/10/2026
// Petersen mando cinco correos distintos —"DRP - Affinity Rules Santa Cruz", "... BERSA",
// "... San Juan", "... Santa Fe" y el "Affinity Rules" del parque comun— y los cinco quedaron
// registrados como "Affinity Rules". No habia forma de saber cual de los cinco falto.
//
// "Reporte" se mantiene igual y sigue siendo lo que AGRUPA en el panel: si se mostrara el
// asunto real, cada estado ("(SUCCESS)", "(ERROR)") abriria su propia fila y la tabla se
// llenaria de lineas de una sola llegada.
const LLEGADAS_COLS = ["Fecha", "Hora", "Minutos", "Origen", "Remitente", "Cliente", "Reporte", "Tarde", "ID mensaje", "Asunto real"];

// Lo que queda en "Asunto real" cuando el correo ya no existe en Gmail (se borro, o se movio a
// una cuenta que no vemos). Es una marca, no un asunto: llegadasLeer() la trata como si la celda
// estuviera vacia y cae al nombre del processor. Existe para que el relleno no vuelva a buscar
// eternamente los mismos correos que no va a encontrar.
const LLEGADAS_ASUNTO_NO_RECUPERABLE = "(no recuperable)";

// El acuerdo con el equipo: todos los reportes tienen que llegar automáticamente antes de esta
// hora. Más tarde significa que alguien lo ejecutó a mano, o que el script del cliente se atrasó.
const LLEGADAS_HORA_LIMITE_MIN = 8 * 60 + 30;   // 08:30

// Cuántos asuntos entran en una misma consulta de Gmail. De a uno tardaba más de los 6 minutos
// que da Apps Script; agrupados con OR son unas pocas consultas.
const LLEGADAS_ASUNTOS_POR_CONSULTA = 8;
const LLEGADAS_HILOS_POR_CONSULTA = 450;

// Tope de días hacia atrás cuando hubo un hueco (nadie abrió el dashboard en varios días).
const LLEGADAS_DIAS_MAX = 10;

// Cuándo se miró Gmail por última vez. Es una marca DISTINTA de "cuándo se leyó la pestaña":
// el dashboard lee la pestaña cada vez que alguien entra, pero los correos nuevos solo
// aparecen cuando corre el registro. Sin esta marca, el panel decía "Actualizado 09:14"
// mostrando datos de ayer, porque esa hora era la de la lectura y no la de la búsqueda.
const LLEGADAS_PROP_ULTIMO_REGISTRO = "LLEGADAS_ULTIMO_REGISTRO";

// Presupuesto del registro programado. Más largo que el del botón del dashboard (90 s) porque
// acá nadie está esperando frente a la pantalla, y más corto que los 6 minutos de Apps Script
// para que un corte quede logueado en vez de morir por timeout.
const LLEGADAS_SEGUNDOS_PROGRAMADO = 300;

/** Cuándo terminó el último registro, en milisegundos, o null si nunca corrió. */
function llegadasUltimoRegistroMs() {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(LLEGADAS_PROP_ULTIMO_REGISTRO);
    const n = v ? Number(v) : 0;
    return n > 0 ? n : null;
  } catch (e) {
    return null;
  }
}

/** Deja la marca de que recién se miró Gmail. Nunca hace fallar al que la llama. */
function _llegadasMarcarRegistro() {
  try {
    PropertiesService.getScriptProperties()
      .setProperty(LLEGADAS_PROP_ULTIMO_REGISTRO, String(Date.now()));
  } catch (e) {
    Logger.log("[Llegadas] No se pudo guardar la marca de último registro: " + e.message);
  }
}

/**
 * Registro periódico, pensado para un activador cada 2 horas.
 *
 * POR QUÉ EXISTE
 * Hasta ahora los correos solo se miraban cuando alguien apretaba "Actualizar" en el
 * dashboard. Quien entraba veía la pestaña vacía —o con lo de la última vez que alguien
 * se acordó de apretar— y tenía que esperar la búsqueda de Gmail para ver el día de hoy.
 * Con esto, la información ya está cuando entra; el botón queda para "lo quiero más fresco".
 *
 * No recibe parámetros a propósito: un activador le pasa el evento, y llegadasRegistrar()
 * interpretaría ese objeto como "cuántos días mirar".
 */
function registrarLlegadasProgramado() {
  const r = llegadasRegistrar(null, LLEGADAS_SEGUNDOS_PROGRAMADO);
  Logger.log("[Llegadas] Registro programado: " + r.nuevos + " nueva(s) en " + r.dias + " día(s)" +
    (r.cortado ? " | ⚠️ cortado por tiempo, se retoma en la próxima corrida" : ""));
  return r;
}

/**
 * El sistema que mandó el reporte, deducido del remitente.
 *
 * Es una inferencia, no un dato: sale de cómo está escrita la casilla. El mismo reporte llega
 * de vRO en un cliente y de vROps en otro (Cabal manda "VMs con snapshots" desde
 * vmwareoperations@ y Comafi desde vro@), así que el tipo de reporte no sirve para saberlo.
 * Si alguna casilla no encaja, cae en "Otro" y se sigue viendo igual: no se pierde la fila.
 */
function llegadasOrigenDelRemitente(remitente) {
  const r = String(remitente || "").toLowerCase().split("@")[0];

  // Veeam primero: "veeam-onemonitor" tiene "one" y "monitor", y sin este orden caeria en vROps.
  if (r.indexOf("veeam") !== -1 || r.indexOf("backup") !== -1) {
    // Veeam ONE y Veeam Backup & Replication son dos productos distintos y cada uno manda sus
    // propios reportes, asi que no pueden compartir origen. Antes todo lo que dijera "veeam"
    // caia en "Veeam ONE", y por eso los Malware Detection Logs de Balanz —que los genera
    // Backup & Replication desde veeam@balanz.com— figuraban como Veeam ONE.
    //
    // La casilla de Veeam ONE se reconoce porque dice "one" (veeam-onemonitor@, veeamone@).
    // Si aparece alguna que no lo diga, se agrega acá: es preferible que caiga en "Veeam" y
    // se corrija, a que todo vuelva a mezclarse en una sola bolsa.
    return /one/.test(r) ? "Veeam ONE" : "Veeam";
  }

  // vROps: las casillas de vRealize/Aria Operations.
  if (r.indexOf("vrops") !== -1 || r.indexOf("operations") !== -1) return "vROps";

  // vRO: las de Orchestrator. "ochestrator" es un error de tipeo real en una casilla del
  // Banco de San Juan (vRealizeOchestrator@), no un descuido de este codigo.
  if (r.indexOf("orchestrator") !== -1 || r.indexOf("ochestrator") !== -1 || r.indexOf("vro") !== -1) {
    return "vRO";
  }

  // Varias casillas no dicen nada del sistema que las manda (monitoreocloud@, senderwetcom@,
  // usrvmwareintegration@). Para esas, el que decide es el nombre del reporte: ver
  // llegadasOrigen().
  return "Otro";
}

/**
 * El origen de una llegada: qué sistema GENERA ese reporte.
 *
 * Manda el TIPO DE REPORTE, no la casilla. El tipo de reporte determina qué sistema lo generó:
 * "Alertas de vSphere", "Affinity Rules", "VMs con preguntas" y "Discos montados en proxy"
 * solo los produce vRO, salga de la casilla que salga. La casilla es apenas el buzón por el
 * que viajó, y su nombre no prueba nada: el Banco de Entre Ríos manda esos cuatro desde una
 * casilla que dice "operations", y durante un tiempo figuraron como vROps por eso.
 *
 * La fuente es TECNOLOGIA_POR_OPERACION (core/ExecutionLogger.js), el mismo mapa alineado con
 * la carpeta donde vive cada procesador que usa el resto del proyecto. Así "Origen" acá
 * significa lo mismo que "Tecnología" en Reportes Faltantes, en vez de ser dos ideas distintas
 * con nombres parecidos. Se reusa _deducirTecnologia en lugar de escribir otro mapeo: un
 * segundo mapa que haga lo mismo es el patrón que ya rompió cosas dos veces acá (AGENTS.md §5).
 *
 * La casilla queda como RED DE CONTENCIÓN, solo para los reportes que no están en el mapa.
 *
 * Qué se pierde: un reporte que exista en el mapa va a mostrar siempre la misma tecnología,
 * aunque algún cliente lo mande desde otro sistema. Si aparece un caso así, se arregla en el
 * mapa (o moviendo el procesador de carpeta), que es donde vive la verdad — no acá.
 *
 * Esto NO afecta la detección de patrones, que se sigue calculando por casilla remitente: un
 * sitio caído se detecta igual.
 *
 * @param {string} remitente
 * @param {string} reporte Asunto/tipo de reporte, tal como se registró.
 * @returns {string}
 */
function llegadasOrigen(remitente, reporte) {
  const porCasilla = llegadasOrigenDelRemitente(remitente);

  // Para los reportes que SÍ pueden venir de más de un sistema, la casilla es el único dato
  // que los distingue y por eso gana.
  if (porCasilla !== "Otro" && _llegadasReporteAmbiguo(reporte)) return porCasilla;

  try {
    const porReporte = _deducirTecnologia(reporte);
    if (porReporte && porReporte !== "Otro") return porReporte;
  } catch (e) {
    Logger.log("[Llegadas] No se pudo deducir el origen por el nombre del reporte: " + e.message);
  }
  return porCasilla;
}

// Reportes que un cliente manda desde vRO y otro desde vROps. Son la excepción: para el resto
// el tipo de reporte determina el sistema, y la carpeta del procesador es la fuente.
//
// Hoy está "VMs con snapshots": Macro lo manda desde vRO y Cabal, YPF, Falabella y Comafi
// desde vROps. Si se tratara como los demás, los cinco dirían lo mismo y se perdería
// justamente la diferencia que importa.
//
// Antes de sumar uno acá, confirmar que de verdad sale de dos sistemas distintos. Si solo
// cambia el NOMBRE de la casilla, no es ambiguo: es una casilla mal bautizada, y ahí tiene que
// ganar el mapa (fue el caso del Banco de Entre Ríos, que manda reportes de vRO desde una
// casilla que dice "operations").
const LLEGADAS_REPORTES_AMBIGUOS = [
  "VMs con snapshots"
];

/** ¿Este reporte puede venir de más de un sistema según el cliente? */
function _llegadasReporteAmbiguo(reporte) {
  const r = String(reporte || "").toLowerCase();
  return LLEGADAS_REPORTES_AMBIGUOS.some(function (a) { return r.indexOf(a.toLowerCase()) !== -1; });
}

/** 'Nombre <mail@dominio>' -> 'mail@dominio' */
function llegadasEmailDe(from) {
  const s = String(from || "");
  return (s.match(/<(.+)>/) || [null, s])[1].trim().toLowerCase();
}

/**
 * Remitente -> nombre de cliente, leído del Índice real.
 *
 * No usa DriveClientIndexSingleton a propósito: ese lee MASTER_INDEX_SHEET_ID de las Script
 * Properties, que en Playground apunta a un Índice de prueba con 3 clientes. Acá se lee el
 * Índice real por ID, el mismo que usa el resto del dashboard.
 */
function llegadasMapaClientes() {
  const mapa = { exactos: {}, dominios: {} };
  try {
    const ss = SpreadsheetApp.openById(WEBAPP_INDICE_SPREADSHEET_ID);
    const hoja = ss.getSheetByName("Sheet1") || ss.getSheets()[0];
    if (hoja.getLastRow() < 2) return mapa;

    // A = remitente(s), B = "Operaciones <Cliente>", I = PODs, L = nombre corto del cliente.
    hoja.getRange(2, 1, hoja.getLastRow() - 1, 12).getValues().forEach(function (fila) {
      const entrada = {
        cliente: String(fila[11] || "").trim() || String(fila[1] || "").trim(),
        pod: String(fila[8] || "").trim()
      };
      if (!entrada.cliente) return;

      String(fila[0] || "").split(",").forEach(function (r) {
        const v = r.trim().toLowerCase();
        if (!v) return;
        // El Índice carga casi todos los remitentes como DOMINIO ("@bancosantacruz.com") y no
        // como casilla completa. Era lo que hacía fallar el mapeo: se buscaba
        // "vrops@bancosantacruz.com" contra "@bancosantacruz.com" y no coincidía nunca.
        if (v.charAt(0) === "@") {
          const dominio = v.substring(1);
          if (!mapa.dominios[dominio]) mapa.dominios[dominio] = entrada;
        } else if (v.indexOf("@") !== -1) {
          mapa.exactos[v] = entrada;
        }
      });
    });
  } catch (e) {
    Logger.log("[Llegadas] No se pudo leer el Índice para mapear remitentes: " + e.message);
  }
  return mapa;
}

/**
 * Cliente y POD de un remitente.
 *
 * Primero busca la casilla exacta y después por dominio. Si varios dominios encajan se queda
 * con el más específico: "vroprisma@serv.externos.prismamp.com" tiene que resolver contra
 * "@prismamp.com", pero si algún día se carga "@serv.externos.prismamp.com" tiene que ganar ese.
 *
 * @returns {{cliente:string, pod:string}} cliente vacío si no se pudo resolver.
 */
function llegadasResolverCliente(remitente, mapa) {
  const mail = String(remitente || "").toLowerCase().trim();
  if (!mail || !mapa) return { cliente: "", pod: "" };
  if (mapa.exactos[mail]) return mapa.exactos[mail];

  const dominio = mail.split("@")[1] || "";
  if (!dominio) return { cliente: "", pod: "" };

  let mejor = null;
  Object.keys(mapa.dominios).forEach(function (d) {
    // Coincide el dominio entero, o es un subdominio suyo ("serv.externos.prismamp.com" cae
    // bajo "prismamp.com"). Sin el punto, "mibancosantafe.com" matchearía "bancosantafe.com".
    if (dominio === d || dominio.slice(-(d.length + 1)) === "." + d) {
      if (!mejor || d.length > mejor.length) mejor = d;
    }
  });
  return mejor ? mapa.dominios[mejor] : { cliente: "", pod: "" };
}

function _llegadasTab(crearSiFalta) {
  const ss = SpreadsheetApp.openById(WEBAPP_LOGS_PROD_ID);
  let tab = ss.getSheetByName(LLEGADAS_TAB);
  if (!tab && crearSiFalta) {
    tab = ss.insertSheet(LLEGADAS_TAB);
    tab.getRange(1, 1, 1, LLEGADAS_COLS.length).setValues([LLEGADAS_COLS])
      .setFontWeight("bold").setBackground("#1A5276").setFontColor("#FFFFFF");
    tab.setFrozenRows(1);
    return tab;
  }

  // La pestana se creo antes de que existiera "Asunto real". Se le completa el encabezado que
  // falta en vez de pedir que alguien se acuerde de agregarlo a mano: si el encabezado no
  // estuviera, la columna quedaria sin nombre y nadie sabria que es al abrir la planilla.
  // Las filas viejas se quedan sin ese dato, que es correcto: no lo tuvimos cuando se
  // escribieron, y llegadasLeer() cae al nombre del processor para esas.
  if (tab && crearSiFalta && tab.getLastColumn() < LLEGADAS_COLS.length) {
    // Primero que la columna EXISTA. Una hoja nueva trae 26 de sobra, pero una recortada a
    // mano puede tener justo las que se usaban.
    if (tab.getMaxColumns() < LLEGADAS_COLS.length) {
      tab.insertColumnsAfter(tab.getMaxColumns(), LLEGADAS_COLS.length - tab.getMaxColumns());
    }
    const desde = tab.getLastColumn() + 1;
    const faltan = LLEGADAS_COLS.slice(desde - 1);
    tab.getRange(1, desde, 1, faltan.length).setValues([faltan])
      .setFontWeight("bold").setBackground("#1A5276").setFontColor("#FFFFFF");
    Logger.log("[Llegadas] Se agrego(aron) " + faltan.length + " columna(s) nueva(s) a la pestana: " + faltan.join(", "));
  }
  return tab;
}

/**
 * Cuantas columnas se pueden leer sin que la planilla tire excepcion.
 *
 * Pedir un rango mas ancho del que la hoja tiene fisicamente no devuelve celdas vacias: falla.
 * Como llegadasLeer() corre en cada carga del panel, una columna de menos dejaria la pantalla
 * entera sin datos. Se lee lo que hay y los campos que falten quedan en blanco.
 */
function _llegadasAnchoLegible(tab) {
  return Math.min(LLEGADAS_COLS.length, tab.getMaxColumns());
}

/** La fecha más nueva ya registrada, en formato yyyy-MM-dd, o null si la pestaña está vacía. */
function llegadasUltimaFechaRegistrada() {
  const tab = _llegadasTab(false);
  if (!tab || tab.getLastRow() < 2) return null;
  const fechas = tab.getRange(2, 1, tab.getLastRow() - 1, 1).getValues();
  let max = null;
  fechas.forEach(function (f) {
    const v = f[0] instanceof Date ? Utilities.formatDate(f[0], HORARIO_OPERATIVO_TZ, "yyyy-MM-dd") : String(f[0] || "");
    if (v && (!max || v > max)) max = v;
  });
  return max;
}

/**
 * Registra en la pestaña las llegadas de los últimos días. Es idempotente: cada correo se
 * identifica por su id de mensaje, así que correrlo de más no duplica nada.
 *
 * @param {number} [dias] Cuántos días mirar. Si no se pasa, se deduce de lo ya registrado.
 * @param {number} [segundosMax] Presupuesto de tiempo. Corta y avisa en vez de morir por timeout.
 * @returns {{nuevos:number, dias:number, truncadas:number, cortado:boolean}}
 */
function llegadasRegistrar(dias, segundosMax) {
  const comenzoEn = Date.now();
  const presupuesto = segundosMax || 240;

  if (!dias) {
    const ultima = llegadasUltimaFechaRegistrada();
    if (!ultima) {
      // Primera corrida: se mira SOLO el día de hoy. No se reconstruye historial hacia atrás a
      // propósito. La búsqueda de Gmail devuelve lo más reciente primero y se trunca sin avisar,
      // así que los días viejos quedarían a medias y no habría forma de distinguir "no llegó" de
      // "no lo miré". El historial arranca el día que esto corre por primera vez.
      Logger.log("[Llegadas] Primera corrida: se registra desde hoy en adelante.");
      dias = 1;
    } else {
      const diasDesde = Math.ceil((Date.now() - new Date(ultima + "T00:00:00").getTime()) / 86400000);
      // Siempre se re-mira el último día registrado: puede haber llegado algo después del corte.
      dias = Math.max(1, Math.min(diasDesde + 1, LLEGADAS_DIAS_MAX));
    }
  }

  const desde = new Date(Date.now() - dias * 86400000);
  const desdeISO = Utilities.formatDate(desde, HORARIO_OPERATIVO_TZ, "yyyy-MM-dd");
  const desdeStr = Utilities.formatDate(desde, HORARIO_OPERATIVO_TZ, "yyyy/MM/dd");

  const tab = _llegadasTab(true);
  // Solo los ids del tramo que se va a mirar: cargar todos haría más lenta cada corrida a
  // medida que la pestaña crece.
  const yaRegistrados = {};
  if (tab.getLastRow() > 1) {
    const datos = tab.getRange(2, 1, tab.getLastRow() - 1, _llegadasAnchoLegible(tab)).getValues();
    datos.forEach(function (r) {
      const f = r[0] instanceof Date ? Utilities.formatDate(r[0], HORARIO_OPERATIVO_TZ, "yyyy-MM-dd") : String(r[0] || "");
      if (f >= desdeISO && r[8]) yaRegistrados[String(r[8])] = true;
    });
  }

  const clientes = llegadasMapaClientes();
  const asuntos = obtenerAsuntosConProcessor();
  const filas = [];
  let truncadas = 0;
  let cortado = false;

  for (let i = 0; i < asuntos.length; i += LLEGADAS_ASUNTOS_POR_CONSULTA) {
    if ((Date.now() - comenzoEn) / 1000 > presupuesto) {
      cortado = true;
      Logger.log("[Llegadas] Corte por tiempo: quedaron " + (asuntos.length - i) + " tipo(s) de reporte sin mirar.");
      break;
    }
    const grupo = asuntos.slice(i, i + LLEGADAS_ASUNTOS_POR_CONSULTA);
    const consulta = "(" + grupo.map(function (a) { return 'subject:"' + a + '"'; }).join(" OR ") +
      ") has:attachment after:" + desdeStr;

    let hilos;
    try {
      hilos = GmailApp.search(consulta, 0, LLEGADAS_HILOS_POR_CONSULTA);
    } catch (e) {
      Logger.log("[Llegadas] Falló la consulta del grupo " + (i / LLEGADAS_ASUNTOS_POR_CONSULTA + 1) + ": " + e.message);
      continue;
    }
    if (hilos.length >= LLEGADAS_HILOS_POR_CONSULTA) truncadas++;

    GmailApp.getMessagesForThreads(hilos).forEach(function (mensajes) {
      mensajes.forEach(function (m) {
        const fecha = m.getDate();
        if (fecha < desde) return;
        const asuntoMsg = String(m.getSubject() || "");
        const reporte = grupo.filter(function (a) { return asuntoMsg.indexOf(a) !== -1; })[0];
        if (!reporte) return;

        const id = m.getId();
        if (yaRegistrados[id]) return;
        yaRegistrados[id] = true;

        const remitente = llegadasEmailDe(m.getFrom());
        const minutos = Number(Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, "H")) * 60 +
          Number(Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, "m"));
        filas.push([
          Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, "yyyy-MM-dd"),
          Utilities.formatDate(fecha, HORARIO_OPERATIVO_TZ, "HH:mm"),
          minutos,
          llegadasOrigen(remitente, reporte),
          remitente,
          llegadasResolverCliente(remitente, clientes).cliente,
          reporte,
          minutos > LLEGADAS_HORA_LIMITE_MIN ? "Sí" : "No",
          id,
          asuntoMsg
        ]);
      });
    });
  }

  if (filas.length) {
    const candado = LockService.getScriptLock();
    try {
      candado.waitLock(30000);
      tab.getRange(tab.getLastRow() + 1, 1, filas.length, LLEGADAS_COLS.length).setValues(filas);
    } catch (e) {
      Logger.log("[Llegadas] No se pudieron guardar las llegadas: " + e.message);
      return { nuevos: 0, dias: dias, truncadas: truncadas, cortado: cortado };
    } finally {
      try { candado.releaseLock(); } catch (e) {}
    }
  }

  // La marca va acá y no en cada llamador: el botón del dashboard, el activador y la
  // herramienta manual tienen que dejarla igual, y tres copias de esto es el §5 esperando.
  // En el camino de error de guardado NO se marca: si las filas no se guardaron, decir que
  // "se actualizó recién" sería mentirle a quien mira el panel.
  _llegadasMarcarRegistro();

  Logger.log("[Llegadas] " + filas.length + " llegada(s) nueva(s) en los últimos " + dias + " día(s)" +
    (truncadas ? " | ⚠️ " + truncadas + " consulta(s) llegaron al tope: faltan los días más viejos" : ""));
  return { nuevos: filas.length, dias: dias, truncadas: truncadas, cortado: cortado };
}

/**
 * Lo registrado desde una fecha, para el dashboard.
 * @returns {Array<{fecha,hora,minutos,origen,remitente,cliente,reporte,tarde,diaSemana}>}
 */
function llegadasLeer(desdeISO) {
  const tab = _llegadasTab(false);
  if (!tab || tab.getLastRow() < 2) return [];
  const datos = tab.getRange(2, 1, tab.getLastRow() - 1, _llegadasAnchoLegible(tab)).getValues();
  // El cliente y el POD se resuelven acá y no se toman de la columna guardada: así, si el
  // Índice cambia (o si se arregla un mapeo que estaba mal), las filas viejas se muestran
  // bien sin tener que reprocesar nada.
  const mapa = llegadasMapaClientes();
  const out = [];
  datos.forEach(function (r) {
    const fecha = r[0] instanceof Date ? Utilities.formatDate(r[0], HORARIO_OPERATIVO_TZ, "yyyy-MM-dd") : String(r[0] || "");
    if (!fecha || (desdeISO && fecha < desdeISO)) return;
    const partes = fecha.split("-");
    const remitente = String(r[4] || "");
    const quien = llegadasResolverCliente(remitente, mapa);
    out.push({
      fecha: fecha,
      hora: r[1] instanceof Date ? Utilities.formatDate(r[1], HORARIO_OPERATIVO_TZ, "HH:mm") : String(r[1] || ""),
      minutos: Number(r[2]) || 0,
      // El origen se vuelve a deducir acá y no se toma de la columna guardada, igual que el
      // cliente y el POD: es una inferencia, no un dato del correo. Así, cuando se corrige el
      // mapeo, las filas ya registradas se arreglan solas sin reprocesar nada.
      origen: llegadasOrigen(remitente, String(r[6] || "")),
      remitente: remitente,
      // Si no se puede resolver se muestra el mail: nunca una fila sin identificar.
      cliente: quien.cliente || String(r[5] || "") || remitente,
      pod: quien.pod || "",
      reporte: String(r[6] || ""),
      // El asunto tal como vino. Es lo unico que distingue "DRP - Affinity Rules Santa Cruz"
      // de las otras tres variantes y del parque comun. Las filas sin asunto —las anteriores a
      // esta columna, y las que el relleno no pudo recuperar— caen al nombre del processor, que
      // es lo mismo que se usaba antes.
      asunto: _llegadasAsuntoUtil(r[9]) || String(r[6] || ""),
      tarde: String(r[7] || "") === "Sí",
      // 0 = domingo. Se calcula acá y no en el navegador para que no dependa de la zona
      // horaria de la máquina de quien mire el dashboard.
      diaSemana: new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2])).getDay()
    });
  });
  return out;
}

/** El asunto guardado, o cadena vacia si no hay uno de verdad. */
function _llegadasAsuntoUtil(valor) {
  const a = String(valor || "").trim();
  return a === LLEGADAS_ASUNTO_NO_RECUPERABLE ? "" : a;
}

/**
 * Completa "Asunto real" en las filas registradas antes de que esa columna existiera.
 *
 * POR QUE EL DATO NO SE PERDIO
 * Cada fila guarda el ID del mensaje de Gmail, asi que el asunto es recuperable. Lo que no se
 * puede es pedirlo de a uno: son miles de filas y GmailApp.getMessageById() es una llamada por
 * fila. Se rehace la MISMA busqueda que hace el registro —unas pocas consultas por dia— y de ahi
 * sale un mapa id -> asunto para todas las filas de ese dia juntas.
 *
 * POR QUE DIA POR DIA Y DEL MAS NUEVO AL MAS VIEJO
 * Gmail trunca las busquedas grandes sin avisar, asi que un rango largo perderia resultados en
 * silencio. Y el panel muestra por defecto los ultimos dias: empezando por los recientes, la
 * primera corrida ya deja utilizable lo que la gente mira.
 *
 * ES REANUDABLE Y NO DUPLICA NADA
 * Salta los dias que ya estan completos, asi que se puede correr las veces que haga falta. Lo que
 * no aparece en Gmail queda marcado como no recuperable para no volver a buscarlo.
 *
 * @param {number} [segundosMax] Presupuesto de tiempo. Corta y avisa en vez de morir por timeout.
 * @returns {{completadas:number, noRecuperables:number, diasHechos:number, diasPendientes:number, cortado:boolean}}
 */
function llegadasCompletarAsuntos(segundosMax) {
  const comenzoEn = Date.now();
  const presupuesto = segundosMax || 300;
  const salida = { completadas: 0, noRecuperables: 0, diasHechos: 0, diasPendientes: 0, cortado: false };

  const tab = _llegadasTab(true);
  if (!tab || tab.getLastRow() < 2) return salida;
  if (tab.getMaxColumns() < LLEGADAS_COLS.length) return salida;

  const filas = tab.getRange(2, 1, tab.getLastRow() - 1, LLEGADAS_COLS.length).getValues();

  const porFecha = {};
  const columnaAsunto = filas.map(function (r) { return String(r[9] || ""); });
  filas.forEach(function (r, i) {
    if (String(r[9] || "").trim()) return;
    const fecha = r[0] instanceof Date
      ? Utilities.formatDate(r[0], HORARIO_OPERATIVO_TZ, "yyyy-MM-dd")
      : String(r[0] || "");
    if (!fecha || !r[8]) return;
    if (!porFecha[fecha]) porFecha[fecha] = [];
    porFecha[fecha].push(i);
  });

  const fechas = Object.keys(porFecha).sort().reverse();
  salida.diasPendientes = fechas.length;
  if (!fechas.length) {
    Logger.log("[Llegadas] No hay filas sin asunto: el relleno ya esta completo.");
    return salida;
  }
  Logger.log("[Llegadas] Dias con filas sin asunto: " + fechas.length);

  const asuntos = obtenerAsuntosConProcessor();
  let huboCambios = false;

  for (let f = 0; f < fechas.length; f++) {
    if ((Date.now() - comenzoEn) / 1000 > presupuesto) {
      salida.cortado = true;
      Logger.log("[Llegadas] Corte por tiempo: quedan " + (fechas.length - f) + " dia(s). Volve a correrla.");
      break;
    }
    const fecha = fechas[f];
    const mapa = _llegadasAsuntosDelDia(fecha, asuntos);

    porFecha[fecha].forEach(function (i) {
      const id = String(filas[i][8]);
      if (mapa[id]) {
        columnaAsunto[i] = mapa[id];
        salida.completadas++;
      } else {
        columnaAsunto[i] = LLEGADAS_ASUNTO_NO_RECUPERABLE;
        salida.noRecuperables++;
      }
    });
    huboCambios = true;
    salida.diasHechos++;
    salida.diasPendientes--;
  }

  if (huboCambios) {
    const candado = LockService.getScriptLock();
    try {
      candado.waitLock(30000);
      // Una sola escritura para toda la columna: hacerlo fila por fila tardaria mas que la
      // propia busqueda en Gmail.
      tab.getRange(2, 10, columnaAsunto.length, 1)
        .setValues(columnaAsunto.map(function (v) { return [v]; }));
    } catch (e) {
      Logger.log("[Llegadas] No se pudo guardar el relleno de asuntos: " + e.message);
      return salida;
    } finally {
      try { candado.releaseLock(); } catch (e) {}
    }
  }

  Logger.log("[Llegadas] Relleno: " + salida.completadas + " completada(s), " +
    salida.noRecuperables + " sin correo en Gmail, " + salida.diasHechos + " dia(s) hechos, " +
    salida.diasPendientes + " pendiente(s).");
  return salida;
}

/**
 * Mapa id de mensaje -> asunto, para un dia.
 *
 * Usa la misma consulta que el registro (los asuntos con processor, agrupados con OR y acotados
 * a ese dia) en vez de pedir mensaje por mensaje: son unas pocas llamadas en lugar de una por
 * fila.
 */
function _llegadasAsuntosDelDia(fechaISO, asuntos) {
  const mapa = {};
  const dia = new Date(fechaISO + "T12:00:00");
  const desde = Utilities.formatDate(dia, HORARIO_OPERATIVO_TZ, "yyyy/MM/dd");
  const hasta = Utilities.formatDate(new Date(dia.getTime() + 86400000), HORARIO_OPERATIVO_TZ, "yyyy/MM/dd");

  for (let i = 0; i < asuntos.length; i += LLEGADAS_ASUNTOS_POR_CONSULTA) {
    const grupo = asuntos.slice(i, i + LLEGADAS_ASUNTOS_POR_CONSULTA);
    const consulta = "(" + grupo.map(function (a) { return "subject:\"" + a + "\""; }).join(" OR ") +
      ") has:attachment after:" + desde + " before:" + hasta;
    try {
      GmailApp.getMessagesForThreads(GmailApp.search(consulta, 0, LLEGADAS_HILOS_POR_CONSULTA))
        .forEach(function (mensajes) {
          mensajes.forEach(function (m) { mapa[m.getId()] = String(m.getSubject() || ""); });
        });
    } catch (e) {
      Logger.log("[Llegadas] Fallo la consulta del " + fechaISO + ": " + e.message);
    }
  }
  return mapa;
}

// =================================================================
// QUE SE ESPERABA Y EN QUE ESTADO ESTA
// =================================================================
//
// Hasta aca el modulo solo sabia de lo que LLEGO. Un reporte que no llega no deja ninguna
// fila, asi que para poder mostrarlo hay que cruzar contra una lista de lo esperado.
//
// Esa lista es la pestana "Reportes Faltantes" del Indice, la MISMA que usa la auditoria
// diaria, y la decision de "le toca hoy" la toma debeLlegarHoy() de ReportesFaltantes.js: la
// misma funcion, no una copia. Dos implementaciones de la frecuencia es el patron que ya
// rompio cosas dos veces en este proyecto (AGENTS.md seccion 5).

const LLEGADAS_TAB_ESPERADOS = "Reportes Faltantes";

/** Los estados posibles de un reporte en un dia. El panel les pone color a estos nombres. */
const LLEGADAS_ESTADO = {
  LLEGO: "llego",
  PENDIENTE: "pendiente",
  NO_LLEGO: "no-llego",
  NO_SE_ESPERA: "no-se-espera"
};

/**
 * Todos los reportes esperados, con una marca de si les toca llegar en esa fecha.
 *
 * Devuelve TODOS y no solo los del dia a proposito: los que hoy no corresponden son los que el
 * panel muestra en gris. Sin ellos, un reporte semanal desapareceria de la pantalla los otros
 * cuatro dias y no habria forma de distinguir "hoy no toca" de "no esta configurado".
 *
 * Lee del Indice REAL (WEBAPP_INDICE_SPREADSHEET_ID) y no de MASTER_INDEX_SHEET_ID: en
 * Playground esa property apunta al Indice de testing, que tiene 3 clientes, y el dashboard
 * vive en Playground pero mira produccion.
 *
 * @param {Date} fecha
 * @returns {Array<{cliente:string, reporte:string, frecuencia:string, carpeta:string, pod:string, hoy:boolean}>}
 */
function llegadasEsperados(fecha) {
  const ss = SpreadsheetApp.openById(WEBAPP_INDICE_SPREADSHEET_ID);
  const hoja = ss.getSheetByName(LLEGADAS_TAB_ESPERADOS);
  if (!hoja) {
    throw new Error('No existe la pestana "' + LLEGADAS_TAB_ESPERADOS + '" en el Indice. ' +
      'Sin esa lista no hay forma de saber que se esperaba.');
  }
  if (hoja.getLastRow() < 2) return [];

  const dia = new Date(fecha.getTime());
  dia.setHours(0, 0, 0, 0);
  const laborable = !esDiaNoLaborable(dia);

  const out = [];
  // A Cliente | B Identificador Reporte | C ID Carpeta Raiz | D Frecuencia | E Fecha Origen | F POD
  hoja.getRange(2, 1, hoja.getLastRow() - 1, 6).getValues().forEach(function (fila) {
    const cliente = String(fila[0] || "").trim();
    const reporte = String(fila[1] || "").trim();
    const frecuencia = fila[3];
    if (!cliente || !reporte || !frecuencia) return;

    let hoy = false;
    try {
      // Un sabado, un domingo o un feriado no se espera NADA, por mas que la frecuencia diga
      // "Diario": ningun cliente los manda. Es la misma condicion que frena la auditoria.
      hoy = laborable && debeLlegarHoy(frecuencia, fila[4] ? new Date(fila[4]) : null, dia);
    } catch (e) {
      Logger.log("[Llegadas] Frecuencia de " + cliente + " / " + reporte + ": " + e.message);
    }

    out.push({
      cliente: cliente,
      reporte: reporte,
      frecuencia: String(frecuencia).trim(),
      // La carpeta raiz de Drive del cliente: es lo que permite preguntarle a Drive si el
      // archivo esta, que es la fuente de verdad de si el reporte existe o no.
      carpeta: String(fila[2] || "").trim(),
      pod: _webappNormalizarPod(fila[5]),
      hoy: hoy
    });
  });
  return out;
}

/**
 * En que estado esta cada reporte esperado, para una fecha.
 *
 * LA FUENTE ES DRIVE, NO EL LOG NI EL MAIL
 * La pregunta que contesta el panel es "esta el reporte?", y eso se responde mirando si el
 * archivo quedo archivado. Es la unica fuente que no miente en los tres casos que importan:
 *
 *   - Un reporte subido A MANO esta bien y existe. El registro del mail no lo ve, asi que
 *     mirando solo el mail saldria en rojo un reporte que esta. Le pasa a GIRE todos los dias.
 *   - El nombre del archivo trae la identidad COMPLETA ("DRP - Affinity Rules Santa Fe"),
 *     mientras que el log de Estado Final guarda el nombre generico de la operacion y las
 *     cinco variantes de Petersen quedan indistinguibles.
 *   - Si el archivo esta, paso por donde haya pasado: no hace falta saber por que camino.
 *
 * EL MAIL NO SE TIRA: PASA A SER LA CAUSA
 * Cuando el archivo NO esta, lo que dice el registro de llegadas es de quien es el problema:
 *
 *     sin archivo + sin correo    -> el cliente no mando nada
 *     sin archivo + correo 07:02  -> llego y NOSOTROS no lo procesamos
 *
 * Ese renglon es el de mas valor de todo el modulo y se perderia mirando una sola fuente.
 *
 * Se reusa verificarEnDrive() de ReportesFaltantes.js en vez de escribir otra busqueda: ya
 * resuelve la carpeta del dia, los alias de nombre de cliente (Dorinka/Walmart,
 * Falabella/Sodimac) y cachea el listado por cliente y por dia (AGENTS.md seccion 5).
 *
 * @param {string} fechaISO yyyy-MM-dd
 * @param {Array} llegadas Lo que devuelve llegadasLeer().
 * @param {number} [minutosAhora] Minutos desde medianoche, para decidir pendiente vs no esta.
 * @returns {Array<{cliente,pod,reporte,frecuencia,estado,causa,hora,verificado}>}
 */
function llegadasEstadoDelDia(fechaISO, llegadas, minutosAhora) {
  const dia = new Date(fechaISO + "T12:00:00");
  const esperados = llegadasEsperados(dia);
  const delDia = (llegadas || []).filter(function (l) { return l.fecha === fechaISO; });
  const corte = typeof minutosAhora === "number" ? minutosAhora : 24 * 60;
  let fallosDrive = 0;

  const salida = esperados.map(function (e) {
    const base = {
      cliente: e.cliente, pod: e.pod, reporte: e.reporte, frecuencia: e.frecuencia,
      causa: "", hora: "", verificado: true
    };

    // Lo que hoy no toca no se consulta en Drive: son 170 consultas que no cambian nada.
    if (!e.hoy) {
      base.estado = LLEGADAS_ESTADO.NO_SE_ESPERA;
      return base;
    }

    // El correo correspondiente, si lo hubo. Se usa tanto para la hora del verde como para la
    // causa del rojo. Gana el mas temprano: importa cuando estuvo disponible, no la ultima copia.
    let correo = null;
    delDia.forEach(function (l) {
      if (!_llegadasMismoCliente(l.cliente, e.cliente)) return;
      if (!llegadasMismoReporte(l.asunto || l.reporte, e.reporte)) return;
      if (!correo || l.minutos < correo.minutos) correo = l;
    });
    if (correo) base.hora = correo.hora;

    let enDrive = false;
    if (e.carpeta) {
      try {
        enDrive = verificarEnDrive(e.carpeta, e.reporte, dia, e.cliente);
      } catch (err) {
        // Que falle una consulta a Drive no puede pintar de rojo un reporte que capaz esta.
        // La fila queda marcada como no verificada y cae a lo que diga el correo.
        base.verificado = false;
        fallosDrive++;
      }
    } else {
      base.verificado = false;
    }

    if (enDrive) {
      base.estado = LLEGADAS_ESTADO.LLEGO;
      // Un archivo sin correo es un reporte subido a mano. No es un problema, pero conviene
      // que se vea: significa que alguien tuvo que hacerlo.
      if (!correo) base.causa = "subido a mano";
      return base;
    }

    if (!base.verificado) {
      base.estado = correo ? LLEGADAS_ESTADO.LLEGO : LLEGADAS_ESTADO.PENDIENTE;
      base.causa = "no se pudo verificar en Drive";
      return base;
    }

    if (corte <= LLEGADAS_HORA_LIMITE_MIN) {
      base.estado = LLEGADAS_ESTADO.PENDIENTE;
      base.causa = correo ? "el correo llego, falta procesarlo" : "";
      return base;
    }

    base.estado = LLEGADAS_ESTADO.NO_LLEGO;
    base.causa = correo ? "procesar" : "cliente";
    return base;
  });

  if (fallosDrive) {
    Logger.log("[Llegadas] " + fallosDrive + " consulta(s) a Drive fallaron: esas filas se " +
      "muestran segun el correo y quedan marcadas como no verificadas.");
  }
  return salida;
}

/**
 * Si dos nombres de cliente son el mismo cliente.
 *
 * Los dos lados lo escriben distinto: el registro de llegadas usa el nombre corto de la
 * columna L del Indice ("Petersen") y la pestana de esperados lo escribe a mano ("Operaciones
 * Petersen Corp"). Se comparan normalizados y alcanza con que uno contenga al otro.
 *
 * Se apoya en normalizarTextoReporte() en vez de normalizar de nuevo: es la misma idea de
 * "comparar sin que molesten tildes ni puntuacion" que ya vive en ReportesFaltantes.js.
 */
function _llegadasMismoCliente(a, b) {
  const x = normalizarTextoReporte(String(a || ""));
  const y = normalizarTextoReporte(String(b || ""));
  if (!x || !y) return false;
  return x === y || x.indexOf(y) !== -1 || y.indexOf(x) !== -1;
}

// =================================================================
// PATRONES ATENDIDOS
// =================================================================
//
// Marcar un patrón como atendido NO lo da por resuelto: deja constancia de que alguien lo vio
// y de qué hizo. Si el problema vuelve, vuelve a aparecer, y entonces el historial muestra que
// ya se había intentado arreglar. Esa es justamente la información útil: un patrón que se
// marcó tres veces y volvió tres veces no es un descuido del equipo, es algo que no se está
// pudiendo resolver por ese camino.
//
// Por eso nada se borra ni se oculta para siempre: la marca tiene fecha, y vale solo para la
// evidencia que existía hasta ese momento.

const PATRONES_TAB = "Patrones Atendidos";
const PATRONES_COLS = ["Cuándo", "Quién", "Tipo", "Cliente", "Remitente", "Reporte",
  "Hasta la evidencia del", "Qué se hizo"];

function _patronesTab(crearSiFalta) {
  const ss = SpreadsheetApp.openById(WEBAPP_LOGS_PROD_ID);
  let tab = ss.getSheetByName(PATRONES_TAB);
  if (!tab && crearSiFalta) {
    tab = ss.insertSheet(PATRONES_TAB);
    tab.getRange(1, 1, 1, PATRONES_COLS.length).setValues([PATRONES_COLS])
      .setFontWeight("bold").setBackground("#1A5276").setFontColor("#FFFFFF");
    tab.setFrozenRows(1);
    tab.setColumnWidth(8, 420);
  }
  return tab;
}

/** La clave de un patrón: el tipo más la casilla y el reporte en los que se detectó. */
function patronesClave(tipo, remitente, reporte) {
  return [String(tipo || ""), String(remitente || "").toLowerCase(), String(reporte || "")].join("|");
}

/**
 * Deja constancia de que alguien se ocupó de un patrón.
 *
 * @param {string} evidenciaHasta Fecha (yyyy-MM-dd) de la última evidencia que tenía el patrón
 *   cuando se marcó. Es lo que permite que el patrón vuelva a aparecer si después pasa algo
 *   nuevo, en vez de quedar tapado para siempre.
 */
function patronesMarcarAtendido(tipo, remitente, reporte, cliente, evidenciaHasta, nota, usuario) {
  if (!tipo || !remitente || !reporte) throw new Error("Falta identificar el patrón.");
  const tab = _patronesTab(true);
  const candado = LockService.getScriptLock();
  try {
    candado.waitLock(20000);
  } catch (e) {
    throw new Error("Hay otra escritura en curso, probá de nuevo en unos segundos.");
  }
  try {
    tab.getRange(tab.getLastRow() + 1, 1, 1, PATRONES_COLS.length).setValues([[
      new Date(), usuario || "", tipo, cliente || "", String(remitente).toLowerCase(), reporte,
      evidenciaHasta || "", _webappTextoSeguroParaCelda(String(nota || "").substring(0, 500))
    ]]);
    tab.getRange(2, 1, tab.getLastRow() - 1, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
  } finally {
    try { candado.releaseLock(); } catch (e) {}
  }
  return true;
}

/**
 * Todo lo marcado, en orden. Devuelve la lista completa (el historial) y, por clave, la marca
 * más reciente, que es contra la que se compara si el patrón volvió.
 */
function patronesAtendidosLeer() {
  const salida = { historial: [], ultima: {} };
  const tab = _patronesTab(false);
  if (!tab || tab.getLastRow() < 2) return salida;

  tab.getRange(2, 1, tab.getLastRow() - 1, PATRONES_COLS.length).getValues().forEach(function (r) {
    const cuando = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(cuando.getTime())) return;
    const item = {
      cuando: Utilities.formatDate(cuando, HORARIO_OPERATIVO_TZ, "dd/MM/yyyy HH:mm"),
      cuandoISO: Utilities.formatDate(cuando, HORARIO_OPERATIVO_TZ, "yyyy-MM-dd"),
      quien: String(r[1] || ""),
      tipo: String(r[2] || ""),
      cliente: String(r[3] || ""),
      remitente: String(r[4] || ""),
      reporte: String(r[5] || ""),
      evidenciaHasta: r[6] instanceof Date
        ? Utilities.formatDate(r[6], HORARIO_OPERATIVO_TZ, "yyyy-MM-dd")
        : String(r[6] || ""),
      nota: String(r[7] || "").replace(/^'(?=[=+\-@])/, "")
    };
    item.clave = patronesClave(item.tipo, item.remitente, item.reporte);
    salida.historial.push(item);
    // Se queda con la más reciente: es la que decide si el patrón sigue atendido.
    const previa = salida.ultima[item.clave];
    if (!previa || item.cuandoISO >= previa.cuandoISO) salida.ultima[item.clave] = item;
  });

  salida.historial.reverse();   // lo más nuevo primero
  return salida;
}

/** Llamado desde el dashboard al tildar un patrón. */
function webapp_marcarPatronAtendido(datos) {
  const usuario = webapp_usuarioActual();
  webapp_exigirAdmin(usuario);
  const d = datos || {};
  patronesMarcarAtendido(d.tipo, d.remitente, d.reporte, d.cliente, d.evidenciaHasta, d.nota, usuario);
  return { ok: true, atendidos: patronesAtendidosLeer() };
}

// =================================================================
// CRUCE ENTRE LO ESPERADO Y LO QUE LLEGO
// =================================================================

/**
 * Si el asunto de un correo corresponde al reporte esperado de la pestana "Reportes Faltantes".
 *
 * POR QUE NO ALCANZA coincideNombreReporte() SOLO
 * Esa funcion nacio para comparar el esperado contra un NOMBRE DE ARCHIVO en Drive, y ahi el
 * archivo siempre trae el nombre completo o mas. Por eso exige que TODAS las palabras del
 * esperado aparezcan en el real.
 *
 * Contra un ASUNTO DE MAIL la relacion se da vuelta: el esperado es el que trae palabras de
 * mas. El Indice escribe "Veeam - VMs protegidas" o "VMs protegidas por Veeam" y el correo
 * dice apenas "VMs protegidas". Medido el 29/10/2026, eso solo explicaba la mitad de los 63
 * correos que no cruzaban con ningun esperado — y cada uno de esos habria sido un rojo falso
 * en el panel.
 *
 * La solucion es mirar en las DOS direcciones: alcanza con que uno de los dos nombres este
 * contenido en el otro. Se sigue apoyando en coincideNombreReporte() para no reimplementar la
 * normalizacion ni la proteccion de DRP (AGENTS.md seccion 5).
 *
 * QUE SE PIERDE
 * Un esperado muy corto puede quedar contenido en un asunto que no le corresponde. Es el
 * precio de no tener un identificador comun entre las dos listas; el dia que exista, esto se
 * reemplaza por una comparacion exacta.
 *
 * @param {string} asunto Como vino el correo.
 * @param {string} esperado Identificador de la pestana "Reportes Faltantes".
 * @returns {boolean}
 */
function llegadasMismoReporte(asunto, esperado) {
  if (!asunto || !esperado) return false;

  // La guarda de DRP se aplica en las dos direcciones. Un reporte DRP y su equivalente comun
  // tienen nombres casi iguales ("DRP - Alertas de vSphere San Juan" contra "Alertas de
  // vSphere"), asi que sin esto se cruzarian entre si y cada uno taparia la falta del otro.
  const asuntoDrp = normalizarTextoReporte(asunto).indexOf("drp") !== -1;
  const esperadoDrp = normalizarTextoReporte(esperado).indexOf("drp") !== -1;
  if (asuntoDrp !== esperadoDrp) return false;

  return coincideNombreReporte(asunto, esperado) || coincideNombreReporte(esperado, asunto);
}
