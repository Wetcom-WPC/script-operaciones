/**
 * @fileoverview Alarma mensual para restablecer la contraseña de Miqueas (Comafi).
 * Ejecución: Día 12 de cada mes, entre las 8:00 y las 9:00 AM.
 */

// Día del mes en que vence la password. El aviso sale ese día, o el primer día hábil
// siguiente si cae feriado o fin de semana.
const COMAFI_DIA_ALARMA = 12;

/**
 * ¿La fecha dada es día hábil (ni fin de semana ni feriado)?
 * @param {Date} fecha
 * @returns {boolean}
 */
function _comafiEsDiaHabil(fecha) {
  const dia = fecha.getDay();
  if (dia === 0 || dia === 6) return false;
  if (typeof esFeriadoHoy === "function" && esFeriadoHoy(fecha)) return false;
  return true;
}

/**
 * ¿Hoy es el día de avisar?
 *
 * Es el día 12, o el primer día hábil después del 12 si ese día no lo fue.
 *
 * POR QUÉ NO ALCANZA CON `if (esFeriadoHoy()) return;`
 * Esta alarma suena UNA sola vez por mes. Si el 12 cae feriado y simplemente se descarta el
 * aviso, la password queda vencida hasta el 12 del mes siguiente y nadie se entera: el
 * silencio sale más caro que el mensaje a destiempo. Es el patrón del §8 de AGENTS.md —
 * un guard que produce una omisión silenciosa es peor que no tener guard.
 *
 * No usa Script Properties ni triggers auxiliares a propósito: se deduce mirando los días
 * ya pasados del mes, así que no hay estado que se pueda desincronizar ni triggers que se
 * acumulen. Si entre el 12 y hoy hubo algún día hábil, el aviso ya salió ese día y hoy no
 * corresponde.
 *
 * @param {Date} hoy
 * @returns {boolean}
 */
function _comafiCorrespondeAvisarHoy(hoy) {
  if (hoy.getDate() < COMAFI_DIA_ALARMA) return false;
  if (!_comafiEsDiaHabil(hoy)) return false;

  for (let dia = COMAFI_DIA_ALARMA; dia < hoy.getDate(); dia++) {
    const anterior = new Date(hoy.getFullYear(), hoy.getMonth(), dia);
    if (_comafiEsDiaHabil(anterior)) return false;
  }
  return true;
}

function enviarAlertaPasswordMiqueas() {
  const hoy = new Date();
  if (!_comafiCorrespondeAvisarHoy(hoy)) {
    Logger.log(`[AlarmaPassComafi] Hoy no corresponde avisar (${Utilities.formatDate(hoy, HORARIO_OPERATIVO_TZ, "dd/MM/yyyy")}): ` +
               `no es el día ${COMAFI_DIA_ALARMA} hábil o el aviso ya salió este mes.`);
    return;
  }

  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_COMAFI");
  if (!webhookUrl || webhookUrl.trim() === "") {
    Logger.log("[AlarmaPassComafi] Error: SLACK_WEBHOOK_COMAFI no está configurado en las Script Properties.");
    return;
  }

  const mensaje = `🚨 *ATENCIÓN <!channel>:* Se venció la password de Miqueas de Comafi y hay que restablecerla.\n\n` +
                  `🔗 *Link para restablecer:* https://passwordreset.microsoftonline.com/passwordreset#!/\n` +
                  `🔑 *Aclaración:* Pedir token a POD 2.`;

  const payload = { "text": mensaje };
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload)
  };

  try {
    fetchWithRetries(webhookUrl, options);
    Logger.log("Mensaje enviado a Slack con éxito.");
  } catch (e) {
    Logger.log("Error al enviar mensaje a Slack: " + e.message);
  }
}
