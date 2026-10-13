/**
 * Reintento simple para llamadas HTTP.
 *
 * A propósito, ninguna de las dos funciones de acá se usa contra un POST que muta estado
 * (transicionar o comentar un ticket de Jira, publicar en Slack): un POST que tira una
 * excepción de red pudo haber llegado igual al servidor, y reintentarlo a ciegas arriesga
 * duplicar la acción. Es el mismo motivo por el que `JiraService.comentarTicketInterno` ya
 * evita reintentar tras un resultado incierto. Sólo se usan contra GET (sin efectos).
 */
const Http = {
  /**
   * Reintenta `llamada()` ante una excepción, hasta `intentos` veces en total (por defecto
   * 2: el intento original + 1 reintento). Si todos los intentos fallan, relanza el último
   * error tal cual.
   *
   * Pensada para llamadas que ya deciden por sí mismas qué cuenta como falla (por ejemplo,
   * lanzando ante un HTTP distinto de 200), así el llamador no tiene que distinguir entre
   * "falló la red" y "falló el servidor".
   */
  conReintento: function(llamada, intentos) {
    const total = intentos || 2;
    let ultimoError;

    for (let intento = 1; intento <= total; intento++) {
      try {
        return llamada();
      } catch (e) {
        ultimoError = e;
        Logger.log(`Fallo (intento ${intento}/${total}): ${e.message}`);
      }
    }

    throw ultimoError;
  },

  /**
   * Variante para llamadas hechas con `muteHttpExceptions: true`, donde una falla HTTP no
   * lanza sino que llega como una respuesta con un código de error.
   *
   * Reintenta ante una excepción de red O una respuesta con código transitorio (429 o
   * cualquier 5xx). Un 4xx es determinístico —reintentarlo no va a cambiar nada— así que se
   * devuelve tal cual ya en el primer intento, sin gastar la llamada extra.
   */
  fetchConReintento: function(llamada, intentos) {
    const total = intentos || 2;
    let ultimaRespuesta, ultimoError;

    for (let intento = 1; intento <= total; intento++) {
      try {
        ultimaRespuesta = llamada();
        const codigo = ultimaRespuesta.getResponseCode();
        if (codigo !== 429 && codigo < 500) return ultimaRespuesta;
        Logger.log(`HTTP ${codigo} transitorio (intento ${intento}/${total}).`);
      } catch (e) {
        ultimoError = e;
        Logger.log(`Fallo de red (intento ${intento}/${total}): ${e.message}`);
      }
    }

    if (ultimaRespuesta !== undefined) return ultimaRespuesta;
    throw ultimoError;
  }
};
