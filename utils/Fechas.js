/**
 * Utilidades puras de fechas.
 *
 * `interpretarVencimiento` vivía duplicada, casi al carácter, en DataRepository (decide si
 * una regla de Excepción sigue vigente) y en Tools (decide si la fila se borra de la
 * planilla). Dos copias del mismo criterio pueden divergir: un fix aplicado en una sola
 * dejaría a la otra tomando una decisión distinta sobre la misma regla.
 */
const Fechas = {
  /**
   * Interpreta las columnas "Fecha hasta" / "Hora hasta" de una fila de Excepciones.
   * Devuelve el instante en que la regla deja de tener efecto, o null si no vence nunca.
   * Sin hora explícita, la regla vence al final del día (23:59:59.999).
   */
  interpretarVencimiento: function(fechaVal, horaVal) {
    if (!fechaVal || fechaVal === "") return null;

    const fechaBase = this._parsearFecha(fechaVal);

    // Fail-closed: si la fecha no se pudo interpretar, la regla se trata como YA VENCIDA
    // en vez de "no vence nunca" o -peor, el bug que esto reemplaza- "vence hoy". Una
    // celda con una fecha ilegible no debe seguir silenciando alarmas indefinidamente
    // (incidente Tempora_Macro / Banco Macro, 18/08/2026: la celda había quedado como
    // texto y el fallback a `new Date()` hacía que la excepción "venciera" cada noche
    // a la misma hora, sin importar el día).
    if (!fechaBase) return new Date(0);

    if (horaVal && horaVal !== "") {
      if (horaVal instanceof Date) {
        fechaBase.setHours(horaVal.getHours(), horaVal.getMinutes(), 0, 0);
      } else if (typeof horaVal === 'string') {
        const partes = horaVal.split(':');
        if (partes.length >= 2) {
          fechaBase.setHours(parseInt(partes[0], 10), parseInt(partes[1], 10), 0, 0);
        }
      }
    } else {
      fechaBase.setHours(23, 59, 59, 999);
    }

    return fechaBase;
  },

  /**
   * Interpreta `fechaVal` como fecha. Acepta un objeto Date (lo normal cuando la celda de
   * Sheets está tipada como fecha) o texto "DD/MM/YYYY" / "DD-MM-YYYY" (lo que queda en la
   * celda si Sheets no la reconoció como fecha y la guardó como texto plano). Cualquier otro
   * formato de texto se intenta con el parser nativo de Date. Devuelve null si nada de esto
   * resulta en una fecha válida.
   */
  _parsearFecha: function(fechaVal) {
    if (fechaVal instanceof Date) return new Date(fechaVal.getTime());

    if (typeof fechaVal === 'string') {
      const match = fechaVal.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (match) {
        const dia = parseInt(match[1], 10);
        const mes = parseInt(match[2], 10);
        const anio = parseInt(match[3], 10);
        const candidato = new Date(anio, mes - 1, dia);
        // new Date(2026, 1, 30) no revienta, rueda a marzo: se valida que la fecha
        // resultante sea realmente la pedida (rechaza un 31/02, por ejemplo).
        const esValida = candidato.getFullYear() === anio && candidato.getMonth() === mes - 1 && candidato.getDate() === dia;
        return esValida ? candidato : null;
      }
    }

    const generico = new Date(fechaVal);
    return isNaN(generico.getTime()) ? null : generico;
  }
};
