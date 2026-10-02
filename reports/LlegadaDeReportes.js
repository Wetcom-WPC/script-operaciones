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
const LLEGADAS_COLS = ["Fecha", "Hora", "Minutos", "Origen", "Remitente", "Cliente", "Reporte", "Tarde", "ID mensaje"];

// El acuerdo con el equipo: todos los reportes tienen que llegar automáticamente antes de esta
// hora. Más tarde significa que alguien lo ejecutó a mano, o que el script del cliente se atrasó.
const LLEGADAS_HORA_LIMITE_MIN = 8 * 60 + 30;   // 08:30

// Cuántos asuntos entran en una misma consulta de Gmail. De a uno tardaba más de los 6 minutos
// que da Apps Script; agrupados con OR son unas pocas consultas.
const LLEGADAS_ASUNTOS_POR_CONSULTA = 8;
const LLEGADAS_HILOS_POR_CONSULTA = 450;

// Tope de días hacia atrás cuando hubo un hueco (nadie abrió el dashboard en varios días).
const LLEGADAS_DIAS_MAX = 10;

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
  if (r.indexOf("veeam") !== -1 || r.indexOf("backup") !== -1) return "Veeam ONE";

  // vROps: las casillas de vRealize/Aria Operations.
  if (r.indexOf("vrops") !== -1 || r.indexOf("operations") !== -1) return "vROps";

  // vRO: las de Orchestrator. "ochestrator" es un error de tipeo real en una casilla del
  // Banco de San Juan (vRealizeOchestrator@), no un descuido de este codigo.
  if (r.indexOf("orchestrator") !== -1 || r.indexOf("ochestrator") !== -1 || r.indexOf("vro") !== -1) {
    return "vRO";
  }

  // Varias casillas no dicen nada del sistema que las manda (monitoreocloud@, senderwetcom@,
  // usrvmwareintegration@). Quedan en "Otro" y se siguen viendo igual: para eso estan los
  // filtros por cliente y por reporte, que si son datos y no inferencias.
  return "Otro";
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
  }
  return tab;
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
    const datos = tab.getRange(2, 1, tab.getLastRow() - 1, LLEGADAS_COLS.length).getValues();
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
          llegadasOrigenDelRemitente(remitente),
          remitente,
          llegadasResolverCliente(remitente, clientes).cliente,
          reporte,
          minutos > LLEGADAS_HORA_LIMITE_MIN ? "Sí" : "No",
          id
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
  const datos = tab.getRange(2, 1, tab.getLastRow() - 1, LLEGADAS_COLS.length).getValues();
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
      origen: String(r[3] || "Otro"),
      remitente: remitente,
      // Si no se puede resolver se muestra el mail: nunca una fila sin identificar.
      cliente: quien.cliente || String(r[5] || "") || remitente,
      pod: quien.pod || "",
      reporte: String(r[6] || ""),
      tarde: String(r[7] || "") === "Sí",
      // 0 = domingo. Se calcula acá y no en el navegador para que no dependa de la zona
      // horaria de la máquina de quien mire el dashboard.
      diaSemana: new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2])).getDay()
    });
  });
  return out;
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
  webapp_exigirAutorizacion(usuario);
  const d = datos || {};
  patronesMarcarAtendido(d.tipo, d.remitente, d.reporte, d.cliente, d.evidenciaHasta, d.nota, usuario);
  return { ok: true, atendidos: patronesAtendidosLeer() };
}
