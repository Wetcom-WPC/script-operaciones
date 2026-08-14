/**
 * =================================================================
 * LÓGICA DE ENVÍO CON BÚSQUEDA HÍBRIDA (KEY + NOMBRE) + NUTANIX
 * Rediseño visual adaptado para Triggers en Segundo Plano (Sin getUi)
 * ================================================================
/**
 * IMPORTANTE:
 * true  = no envía el mail, solo deja logs para pruebas.
 * false = envía el mail real.
 */

const MODO_TEST_MAIL = false;

const JIRA_FILTER_VSPHERE = "24647";
const JIRA_FILTER_VEEAM   = "27659";
const JIRA_FILTER_NUTANIX = "28945";
const EMAIL_CC_GLOBAL     = "wpc@wetcom.com";

// Paleta de colores por tecnología
const TECH_COLORS = {
  "vSphere":  { primary: "#0071C5", light: "#e8f4fb" },
  "Veeam":    { primary: "#00B336", light: "#e8f9ec" },
  "Nutanix":  { primary: "#024DA1", light: "#e8edf8" },
  "Horizon":  { primary: "#6A0DAD", light: "#f3eafd" },
  "Tanzu":    { primary: "#0F6EFF", light: "#e8f0ff" },
};

function enviarMailUnitario(tecnologia, opsKey, nombreOps, soporteKey, nombreSoporte, nombreEmpresa, podDestino, serviciosHabilitados) {

  // 1. OBTENCIÓN DE DATOS
  let ticketsCrudos = {};
  let consumoCrudo = [];

  if (tecnologia === "vSphere") {
    ticketsCrudos = AutomatizarOperaciones.generarReporteDiarioDeTickets(JIRA_FILTER_VSPHERE);
    consumoCrudo = AutomatizarOperaciones.generarReporteConsumoVsphere(opsKey);
  } else if (tecnologia === "Veeam") {
    ticketsCrudos = AutomatizarOperaciones.generarReporteDiarioDeTickets(JIRA_FILTER_VEEAM);
  } else if (tecnologia === "Nutanix") {
    ticketsCrudos = AutomatizarOperaciones.generarReporteDiarioDeTickets(JIRA_FILTER_NUTANIX);
  }

  // 2. BÚSQUEDA INTELIGENTE DE TICKETS
  let misTickets = [];
  let keysDisponibles = [];

  function agregarTickets(arrayDestino, objetoTecnologias, esSoporte) {
    for (const t in objetoTecnologias) {
      objetoTecnologias[t].forEach(ticket => {
        ticket.esSoporte = esSoporte;
        arrayDestino.push(ticket);
      });
    }
  }

  for (const equipo in ticketsCrudos) {
    const keysDelEquipo = Object.keys(ticketsCrudos[equipo]);
    keysDisponibles = keysDisponibles.concat(keysDelEquipo);

    Logger.log("Equipo: " + equipo);
    Logger.log("Keys disponibles: " + keysDelEquipo.join(", "));

    const kOps = opsKey ? opsKey.trim() : "";
    const nOps = nombreOps ? nombreOps.toString().trim() : "";

    if (kOps && ticketsCrudos[equipo][kOps]) {
      agregarTickets(misTickets, ticketsCrudos[equipo][kOps], false);
    } else if (nOps && ticketsCrudos[equipo][nOps]) {
      agregarTickets(misTickets, ticketsCrudos[equipo][nOps], false);
    }

    const kSup = soporteKey ? soporteKey.trim() : "";
    const nSup = nombreSoporte ? nombreSoporte.toString().trim() : "";

    if (kSup && ticketsCrudos[equipo][kSup]) {
      agregarTickets(misTickets, ticketsCrudos[equipo][kSup], true);
    } else if (nSup && ticketsCrudos[equipo][nSup]) {
      agregarTickets(misTickets, ticketsCrudos[equipo][nSup], true);
    }
  }

  // --- COMPORTAMIENTO AUTOMÁTICO EN SEGUNDO PLANO SI NO HAY TICKETS ---
  if (misTickets.length === 0) {
    const listaKeysTexto = keysDisponibles.length > 0 ? keysDisponibles.slice(0, 20).join(", ") : "VACÍO";
    
    // Dejamos registro en los logs operativos en vez de interrumpir con una alerta en pantalla
    Logger.log(`ℹ️ [Aviso] 0 Tickets Encontrados para ${nombreEmpresa}.`);
    Logger.log(`Búsquedas intentadas -> Ops: "${opsKey}"/"${nombreOps}" | Sup: "${soporteKey}"/"${nombreSoporte}"`);
    Logger.log(`Disponibles hoy en Jira: [ ${listaKeysTexto} ... ]`);
    Logger.log(`🤖 Automatización: Procediendo con el envío de mail "Verde" (Sin anomalías).`);
    
    // Se elimina SpreadsheetApp.getUi() para que el trigger automático pueda continuar con el mail limpio
  }

  // 3. ALERTAS DE CONSUMO VSPHERE
  let misAlertasConsumo = [];

  if (tecnologia === "vSphere" && consumoCrudo && Array.isArray(consumoCrudo)) {

    function normalizarTexto(valor) {
      return String(valor || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    }

    const clavesCliente = [
      opsKey,
      nombreOps,
      soporteKey,
      nombreSoporte,
      nombreEmpresa
    ]
      .filter(Boolean)
      .map(normalizarTexto);

    Logger.log("Claves usadas para buscar consumo: " + clavesCliente.join(" | "));

    misAlertasConsumo = consumoCrudo
      .filter(item => {
        const clienteConsumo = normalizarTexto(item.clientName);

        const match = clavesCliente.some(clave =>
          clienteConsumo === clave ||
          clienteConsumo.includes(clave) ||
          clave.includes(clienteConsumo)
        );

        if (match) {
          Logger.log("MATCH consumo vSphere para cliente: " + item.clientName);
        }

        return match;
      })
      .flatMap(item => item.alerts || []);
  }

  Logger.log("Alertas consumo vSphere encontradas: " + misAlertasConsumo.length);

  // 4. ARMADO DE DATOS
  const hoy = new Date();
  const esViernes = hoy.getDay() === 5;
  const fechaFormateada = Utilities.formatDate(hoy, "GMT-3", "dd/MM/yyyy");

  let itemsErrores = [];
  let itemsAdvertencias = [];

  // Tickets Jira
  misTickets.forEach(t => {
    const item = {
      summary: t.summary,
      key: t.key,
      link: t.link
    };

    if (t.esSoporte) {
      itemsErrores.push(item);
    } else {
      itemsAdvertencias.push(item);
    }
  });

  // Alertas de consumo sin ticket Jira
  if (misAlertasConsumo.length > 0) {
    const alertasAgrupadas = {};

    misAlertasConsumo.forEach(a => {
      const frase = a.alarm || a["alarm"] || "Alerta de consumo";
      const objeto = a.object || a["object"] || "(objeto sin nombre)";

      if (!alertasAgrupadas[frase]) {
        alertasAgrupadas[frase] = [];
      }

      alertasAgrupadas[frase].push(objeto);
    });

    for (const frase in alertasAgrupadas) {
      const unicos = [...new Set(alertasAgrupadas[frase])];

      itemsAdvertencias.push({
        summary: frase,
        subitems: unicos,
        key: null,
        link: null
      });
    }
  }

  const tieneErrores = itemsErrores.length > 0;
  const tieneAdvertencias = itemsAdvertencias.length > 0;

  // 5. ESTADO GENERAL
  let colorEstado;
  let iconoEstado;

  if (tieneErrores) {
    colorEstado = "#d9534f";
    iconoEstado = "❌";
  } else if (tieneAdvertencias) {
    colorEstado = "#f0ad4e";
    iconoEstado = "⚠️";
  } else {
    colorEstado = "#5cb85c";
    iconoEstado = "✅";
  }

  let nombreTecnicaMail = tecnologia;
  let introTexto = `reporte de operaciones de ${tecnologia}`;
  let esCombinadoHorizon = false;

  if (tecnologia === "vSphere" && String(serviciosHabilitados).toLowerCase().includes("horizon")) {
    nombreTecnicaMail = "vSphere/Horizon";
    introTexto = "reporte de operaciones de vSphere y Horizon";
    esCombinadoHorizon = true;
  }

  const tipoReporte = (esViernes && tecnologia !== "Nutanix") ? "Diarias y Semanales" : "Diarias";
  const asunto = `${iconoEstado} Operaciones ${tipoReporte} - Wetcom / ${nombreEmpresa} - ${nombreTecnicaMail} - ${fechaFormateada}`;
  const emailReal = `${podDestino.toLowerCase().trim()}@wetcom.com`;

  // 6. CONSTRUCCIÓN HTML

  function renderTicketRow(item, colorAccent) {
    if (item.subitems) {
      const vmsHtml = item.subitems.map(vm =>
        `<li style="margin: 2px 0; color: #000;">${vm}</li>`
      ).join("");

      return `
        <tr>
          <td style="padding: 10px 14px; border-bottom: 1px solid #eee; vertical-align: top;">
            <span style="font-weight: 600; color: #000;">${item.summary}</span>
            <ul style="margin: 6px 0 0 0; padding-left: 18px; font-size: 12px; color: #000;">
              ${vmsHtml}
            </ul>
          </td>
          <td style="padding: 10px 14px; border-bottom: 1px solid #eee; text-align: center; vertical-align: top; color: #000; font-style: italic;">
            —
          </td>
        </tr>`;
    }

    return `
      <tr>
        <td style="padding: 10px 14px; border-bottom: 1px solid #eee; vertical-align: middle;">
          <span style="color: #000;">${item.summary}</span>
        </td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #eee; text-align: center; vertical-align: middle; white-space: nowrap;">
          <a href="${item.link}" style="color: ${colorAccent}; font-weight: 700; text-decoration: none; font-size: 13px;">
            ${item.key}
          </a>
        </td>
      </tr>`;
  }

  function renderSection(titulo, colorHeader, colorAccent, bgLight, items) {
    if (!items || items.length === 0) return "";

    const rows = items.map(i => renderTicketRow(i, colorAccent)).join("");

    return `
      <div style="margin-bottom: 20px;">
        <table style="border-collapse: collapse; width: 100%; background: #fff; font-size: 13px; border: 1px solid #ddd; border-radius: 4px; overflow: hidden; color: #000;">
          <thead>
            <tr style="background-color: ${colorHeader};">
              <th colspan="2" style="padding: 10px 14px; text-align: left; color: #fff; font-size: 13px; font-weight: 700; letter-spacing: 0.4px;">
                ${titulo}
              </th>
            </tr>
            <tr style="background-color: ${bgLight};">
              <th style="padding: 8px 14px; text-align: left; font-size: 12px; color: #000; font-weight: 600; border-bottom: 1px solid #ddd;">
                Descripción
              </th>
              <th style="padding: 8px 14px; text-align: center; font-size: 12px; color: #000; font-weight: 600; border-bottom: 1px solid #ddd; width: 110px;">
                Ticket
              </th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>`;
  }

  const seccionErrores = renderSection(
    "❌ INCIDENCIAS",
    "#d9534f",
    "#d9534f",
    "#fdf7f7",
    itemsErrores
  );

  const seccionAdvertencias = renderSection(
    "⚠️ ADVERTENCIAS",
    "#f0ad4e",
    "#c87941",
    "#fcf8f2",
    itemsAdvertencias
  );

  const seccionOk = (!tieneErrores && !tieneAdvertencias) ? `
      <p style="margin: 0; font-size: 14px; color: #000; font-weight: 600;">
        ✅ No se detectaron anomalías en las operaciones del día.
      </p>` : "";

  let notaAdicional = "";

  if (tecnologia === "Veeam") {
    notaAdicional = `
      <p style="font-size: 13px; color: #000; margin: 0;">
        <b>Adicionalmente:</b> se adjuntan reportes de Veeam.
      </p>`;
  } else if (tecnologia === "vSphere") {
    notaAdicional = `
      <p style="font-size: 13px; color: #000; margin: 0;">
        <b>Adicionalmente:</b> se adjuntan reportes de ${nombreTecnicaMail}.
      </p>`;
  }

  const htmlBody = `
<div style="font-family: 'Segoe UI', Calibri, Arial, sans-serif; color: #000; max-width: 700px;">
  <p style="font-size: 14px; color: #000; margin: 0 0 20px 0;">
    Estimados, buenos días. Espero que se encuentren bien.<br>
    A continuación el ${introTexto} correspondiente al día de la fecha.
  </p>
  ${esCombinadoHorizon ? `
    <p style="font-size: 13px; font-weight: 600; color: #000; margin-bottom: 14px;">
      Ambiente vSphere/Horizon:
    </p>` : ""}
  <div style="border: 1px solid #ddd; border-left: 6px solid ${colorEstado}; padding: 20px 24px; background: #f9f9f9; border-radius: 4px; margin-bottom: 24px;">
    ${seccionErrores}
    ${seccionAdvertencias}
    ${seccionOk}
    ${notaAdicional}
  </div>
  <div style="margin-top: 28px; padding-top: 16px; border-top: 1px solid #eee;">
    <p style="font-size: 13px; color: #000; margin: 0 0 4px 0;">
      Ante cualquier duda o consulta, estamos a su disposición.
    </p>
    <p style="font-size: 13px; color: #000; margin: 0 0 12px 0;">
      Saludos cordiales.
    </p>
  </div>
</div>`;

  // 7. LOGS DE CONTROL
  Logger.log("========== RESUMEN DEL MAIL ==========");
  Logger.log("Modo test: " + MODO_TEST_MAIL);
  Logger.log("Destino: " + emailReal);
  Logger.log("CC: " + EMAIL_CC_GLOBAL);
  Logger.log("Asunto: " + asunto);
  Logger.log("Tecnología: " + tecnologia);
  Logger.log("Cliente: " + nombreEmpresa);
  Logger.log("POD: " + podDestino);

  // 8. ENVÍO O TEST
  if (MODO_TEST_MAIL) {
    Logger.log("========== TEST MAIL ==========");
    Logger.log("El mail NO fue enviado porque MODO_TEST_MAIL está en true.");
  } else {
    GmailApp.sendEmail(emailReal, asunto, "", {
      htmlBody: htmlBody,
      cc: EMAIL_CC_GLOBAL,
      name: "Wetcom Proactive Center"
    });
    Logger.log("Mail enviado correctamente.");
  }
  
  // LOGGING en Registro Operacional
  AutomatizarOperaciones.registrarEnvioMail(
    tecnologia, nombreEmpresa, podDestino, misTickets, itemsErrores, itemsAdvertencias, asunto, MODO_TEST_MAIL
  );
 
  // CIERRE DE TAREA PROGRAMADA EN JIRA
  if (tecnologia === "vSphere" || tecnologia === "Veeam") {
    try {
      const configParaCierre = AutomatizarOperaciones.getClientConfigByName(nombreEmpresa, "Enviar Mail de Tareas Programadas");
      if (configParaCierre) {
        const resultadoCierre = AutomatizarOperaciones.buscarYCerrarTareaProgramada("Enviar Mail de Tareas Programadas", configParaCierre, false);
        Logger.log(`[MAIL] Cierre tarea Jira para ${nombreEmpresa}: ${resultadoCierre ? resultadoCierre.status : "sin resultado"}`);
      }
    } catch (e) {
      Logger.log(`[MAIL] Error al cerrar tarea Jira: ${e.message}`);
    }
  }
  AutomatizarOperaciones.flushLogs();
  return true;
}