/**
 * Desensobrado del prefijo que el equipo nuevo antepone al summary.
 *
 *   "9x5 - Operations - Host has lost connection to vCenter Server"
 *      → { cobertura: '9x5', fuente: 'Operations', summary: 'Host has lost connection...' }
 *
 * El prefijo es un SOBRE, no un formato: dice bajo qué cobertura se contrató la alarma
 * y quién la emite, pero no cómo está armado el cuerpo. Por eso vive acá y no dentro de
 * un parser: los dos dialectos lo comparten y ninguno lo usa para decidir el ruteo.
 *
 * Quitarlo es obligatorio para poder cruzar el nombre contra la hoja "Tipos de Alarmas",
 * donde los nombres están cargados sin prefijo.
 */
const AlarmEnvelope = {

  /**
   * @param {string} summary Summary crudo del ticket de Jira.
   * @return {{cobertura: string|null, fuente: string|null, summary: string}}
   */
  desensobrar: function(summary) {
    const texto = summary ? summary.toString().trim() : '';
    const prefijos = Config.PREFIJOS_SOBRE_ALARMA || [];

    for (let i = 0; i < prefijos.length; i++) {
      const match = texto.match(prefijos[i]);
      if (!match) continue;

      return {
        cobertura: match[1] ? match[1].toLowerCase() : null,
        fuente: match[2] || null,
        summary: texto.replace(prefijos[i], '').trim()
      };
    }

    // Sin prefijo: alarma del formato histórico. Se devuelve intacta.
    return { cobertura: null, fuente: null, summary: texto };
  }
};
