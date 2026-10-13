/**
 * Catálogo declarativo de las "Categorías" del formato estandarizado nuevo.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PARA AGREGAR UNA CATEGORÍA NUEVA (ej: Datastore, Virtual Machine):
 * agregá una entrada en CATEGORIAS. No hace falta tocar ninguna otra cosa.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Campos de cada entrada:
 *   nombre          Identificador legible (sólo para logs y warnings).
 *   etiquetaObjeto  Etiqueta de la description que contiene el ${RESOURCE_NAME}.
 *                   Es además el discriminador que elige la categoría.
 *   etiquetaTarget  Cómo se rotula el objeto en Slack y en el correo de guardia.
 *                   OJO: debe ser coherente con la columna "Campo" de las hojas
 *                   de Excepciones, porque las reglas de silenciado matchean contra esto.
 *   campoCluster    Etiqueta de la que sale el cluster contenedor (opcional).
 *   detalles        Etiquetas que se vuelcan como líneas de detalle, EN ORDEN.
 *                   'Descripcion' se emite sin rótulo por ser el texto principal.
 *
 * El ORDEN del array importa: gana la primera categoría cuya `etiquetaObjeto`
 * aparezca en la description. Por eso las específicas van primero y 'Objeto'
 * (genérica) va última.
 */
const VropsCategorias = {

  CATEGORIAS: [
    {
      nombre: 'vSAN Cluster',
      etiquetaObjeto: 'vSAN Cluster',
      etiquetaTarget: 'Cluster',
      campoCluster: null, // el objeto ya es el cluster
      detalles: ['Descripcion', 'Latencia sitio preferido a secundario', 'Latencia sitio preferido a witness']
    },
    {
      nombre: 'Host',
      etiquetaObjeto: 'Host',
      etiquetaTarget: 'Host',
      campoCluster: 'Cluster',
      // 'Recomendacion' y 'Datacenter' se parsean pero NO se publican: la recomendación es
      // un texto genérico y largo que ensucia el mensaje del NOC, y el datacenter no se usa
      // en la jerarquía. Para mostrarlos, alcanza con sumarlos a esta lista.
      detalles: ['Descripcion']
    },
    {
      nombre: 'Capacity Disk',
      etiquetaObjeto: 'Objeto',
      etiquetaTarget: 'Disco',
      campoCluster: 'Cluster',
      detalles: ['Descripcion', 'Health Status']
    }
  ],

  /** Etiqueta cuya presencia confirma que la description usa el formato nuevo. */
  ETIQUETA_TESTIGO: 'Descripcion',

  /** Etiquetas de ubicación comunes a todas las categorías. */
  ETIQUETA_VCENTER: 'vCenter',

  /**
   * Etiquetas que el template emite pero que NO se publican en Slack.
   *
   * TIENEN que estar declaradas igual: el tokenizador corta el texto usando el
   * vocabulario, así que una etiqueta desconocida no funciona como separador y su
   * contenido termina absorbido dentro del valor del campo anterior.
   * Para publicar alguna, sumala a los `detalles` de la categoría que corresponda.
   */
  ETIQUETAS_NO_PUBLICADAS: ['Recomendacion', 'Datacenter'],

  /**
   * Vocabulario completo de etiquetas conocidas, ordenado de más larga a más corta.
   * El orden es obligatorio: si 'Cluster' se evaluara antes que 'vSAN Cluster',
   * partiría mal la etiqueta más larga.
   */
  vocabulario: function() {
    const set = {};
    set[this.ETIQUETA_TESTIGO] = true;
    set[this.ETIQUETA_VCENTER] = true;
    this.ETIQUETAS_NO_PUBLICADAS.forEach(e => { set[e] = true; });

    this.CATEGORIAS.forEach(cat => {
      set[cat.etiquetaObjeto] = true;
      if (cat.campoCluster) set[cat.campoCluster] = true;
      cat.detalles.forEach(d => { set[d] = true; });
    });

    return Object.keys(set).sort((a, b) => b.length - a.length);
  },

  /**
   * Elige la categoría a partir de las etiquetas realmente presentes en la description.
   * @param {Object} campos Diccionario etiqueta → valor ya extraído.
   * @return {Object|null}
   */
  detectar: function(campos) {
    if (!campos) return null;
    for (let i = 0; i < this.CATEGORIAS.length; i++) {
      const cat = this.CATEGORIAS[i];
      if (campos[cat.etiquetaObjeto]) return cat;
    }
    return null;
  }
};
