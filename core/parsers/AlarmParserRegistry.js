/**
 * Registry de parsers (patrón Strategy + Chain of Responsibility).
 *
 * Cada dialecto de alarma (formato viejo de vCenter, formato estandarizado nuevo,
 * y los que vengan) se resuelve con su propia estrategia. El registry le pregunta
 * a cada una si reconoce el ticket y delega en la primera que dice que sí.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PARA AGREGAR UN DIALECTO NUEVO:
 *   1. Creá core/parsers/MiParser.js con: nombre, prioridad, puedeParsear(ticket)
 *      y parsear(ticket, mappings, warnings).
 *   2. Sumalo a la lista de _estrategias(). Listo: AlarmProcessor no se toca.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * CONTRATO DE SALIDA (modelo canónico). Todos los parsers devuelven esta forma,
 * de modo que las excepciones, el agrupado y MessageFormatter no sepan ni les
 * importe de qué dialecto vino la alarma:
 *
 *   {
 *     incluir:             boolean,
 *     alarma:              string,                        // nombre ya cruzado con "Tipos de Alarmas"
 *     origen:              { vCenter, cluster, target, etiquetaTarget },
 *     summaryResto:        string|null,                   // detalle multilínea, o null
 *     usaFormattersLegacy: boolean                        // si debe pasar por AlarmFormatters
 *   }
 */
const AlarmParserRegistry = {

  /**
   * La lista se arma dentro de una función a propósito.
   * Apps Script concatena los archivos del proyecto y `filePushOrder` está vacío:
   * si esto fuera un array literal a nivel de módulo, podría evaluarse antes de que
   * existan los parsers y tirar ReferenceError. Resolviéndolo en tiempo de llamada,
   * el orden de carga deja de importar.
   */
  _estrategias: function() {
    return [
      VropsStandardParser,
      LegacyVCenterParser
    ].sort(function(a, b) { return b.prioridad - a.prioridad; });
  },

  /**
   * Elige el parser que corresponde y devuelve el modelo canónico.
   * @param {Object} ticket   Ticket normalizado por JiraService.
   * @param {Object} mappings Diccionarios de la planilla.
   * @param {Array}  warnings Acumulador de avisos (se muta).
   * @return {Object} modelo canónico
   */
  parsear: function(ticket, mappings, warnings) {
    const estrategias = this._estrategias();

    for (let i = 0; i < estrategias.length; i++) {
      const estrategia = estrategias[i];

      let aplica = false;
      try {
        aplica = estrategia.puedeParsear(ticket);
      } catch (e) {
        // Un parser roto no puede tumbar el pipeline entero: se lo saltea y se avisa.
        Logger.log(`Parser "${estrategia.nombre}" falló en puedeParsear: ${e.message}`);
        continue;
      }
      if (!aplica) continue;

      const resultado = estrategia.parsear(ticket, mappings, warnings);
      if (resultado) {
        resultado.parser = estrategia.nombre;
        return resultado;
      }
      // Si devolvió null se arrepintió: seguimos con la siguiente estrategia.
    }

    // Inalcanzable mientras LegacyVCenterParser siga aceptando todo, pero si alguien
    // rompe esa invariante conviene enterarse por una excepción y no por datos raros.
    throw new Error('Ningún parser pudo procesar el ticket (falta el fallback legacy).');
  }
};
