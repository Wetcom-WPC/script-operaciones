/**
 * Patrón Strategy para formatear lógicas específicas de cada Tipo de Alarma.
 * Si necesitas agregar lógica de parseo para un tipo de alarma nuevo, agrégalo aquí
 * y será llamado automáticamente, sin tocar el AlarmProcessor central.
 */
const AlarmFormatters = {
  
  // Handlers específicos por nombre de alarma
  manejadores: {
    'Desconexión de Host': function(summaryResto, target, description) {
      const match = summaryResto.match(/in\s+(.+?)\s+is not responding/i);
      let nuevoSummary = (match && match[1]) ? match[1].trim() : null;
      if (!nuevoSummary) Logger.log("Desconexión de Host: No se encontró el patrón esperado en summaryResto: " + summaryResto);
      return { incluir: true, nuevoTarget: target, nuevoSummary, etiquetaTarget: 'Host' };
    },

    'Datastore inaccesible': function(summaryResto, target, description) {
      if (/^VeeamBackup_.*/i.test(target)) return { incluir: false };
      return { incluir: true, nuevoTarget: target, nuevoSummary: null, etiquetaTarget: 'Datastore' };
    },

    'Pérdida de conexión a storage': function(summaryResto, target, description) {
      return { incluir: true, nuevoTarget: target, nuevoSummary: AlarmFormatters._formatearStorageConnection(summaryResto), etiquetaTarget: 'Host' };
    },

    'Perdida de redundancia de storage': function(summaryResto, target, description) {
      return { incluir: true, nuevoTarget: target, nuevoSummary: AlarmFormatters._formatearStorageRedundancy(summaryResto), etiquetaTarget: 'Host' };
    },

    'Perdida de conexión de red': function(summaryResto, target, description) {
      return AlarmFormatters._procesarFalloDeRed(summaryResto, target, description);
    },

    'Perdida de redundancia de red': function(summaryResto, target, description) {
      return AlarmFormatters._procesarFalloDeRed(summaryResto, target, description);
    },

    'Alarma de sensor de Hardware': function(summaryResto, target, description) {
      const sinPrefijo = summaryResto.replace(/Hardware Sensor Status:\s*/i, '');
      let hwMatches = sinPrefijo.match(/([^,]*\b(?:red|yellow)\b[^,]*)/gi);
      let nuevoSummary;
      if (hwMatches && hwMatches.length > 0) {
        nuevoSummary = hwMatches.map(m => m.trim()).join('\n');
      } else {
        nuevoSummary = sinPrefijo.trim() !== "" ? sinPrefijo.trim() : summaryResto;
      }
      return { incluir: true, nuevoTarget: target, nuevoSummary, etiquetaTarget: 'Host' };
    },

    'Alarma de Nutanix': function(summaryResto, target, description) {
      if (/has\s+\d+\s+unresolved alerts/i.test(summaryResto)) return { incluir: false };
      const nutanixMatch = summaryResto.match(/:\s*([^:]+):\s*(.*)/);
      if (nutanixMatch) {
        return { incluir: true, nuevoTarget: nutanixMatch[1].trim(), nuevoSummary: nutanixMatch[2].trim(), etiquetaTarget: 'Cluster' };
      }
      return { incluir: true, nuevoTarget: 'Target Desconocido', nuevoSummary: summaryResto, etiquetaTarget: 'Cluster' };
    },

    'vSAN Health Test': function(summaryResto, target, description) {
      return { incluir: true, nuevoTarget: target, nuevoSummary: summaryResto, etiquetaTarget: 'Cluster' };
    },

    'Insufficient resources to satisfy vSphere HA failover level': function(summaryResto, target, description) {
      return { incluir: true, nuevoTarget: target, nuevoSummary: summaryResto, etiquetaTarget: 'Cluster' };
    },

    'Alarma de HA': function(summaryResto, target, description) {
      let etiquetaTarget = 'Cluster'; // Por defecto HA suele ser de cluster
      if (description.toLowerCase().includes('host')) etiquetaTarget = 'Host';
      return { incluir: true, nuevoTarget: target, nuevoSummary: summaryResto, etiquetaTarget: etiquetaTarget };
    }
  },

  // Helpers compartidos
  _procesarFalloDeRed: function(summaryResto, target, description) {
    let nuevoSummary = summaryResto;
    const index = description.indexOf("Physical NIC");
    if (index !== -1) {
      const substringDesde = description.substring(index);
      const newlineIndex = substringDesde.indexOf("\n");
      let resultado = newlineIndex !== -1 ? substringDesde.substring(0, newlineIndex).trim() : substringDesde.trim();
      nuevoSummary = resultado.replace(/[.]+$/, '');
    }
    return { incluir: true, nuevoTarget: target, nuevoSummary, etiquetaTarget: 'Host' };
  },

  _formatearStorageRedundancy: function(summaryResto) {
    const regex = /^(storage device .*?\.)\s*(Path .*? is down\.)\s*(Affected datastores: .*?)\.?$/i;
    const match = summaryResto.match(regex);
    if (match) {
      return `${match[1].trim()}\n${match[2].trim()}\n${match[3].trim()}`;
    }
    return summaryResto;
  },

  _formatearStorageConnection: function(summaryResto) {
    if (/^\s*Lost connection to server/i.test(summaryResto)) {
      const matchA = summaryResto.match(/^\s*Lost connection to server\s+(.+?)\s+mount point\s+(.+?)\s+mounted as\s+(.+?)\.?$/i);
      if (matchA) return `Lost connection to server ${matchA[1].trim()}\nMount point: ${matchA[2].trim()}\nMounted as: ${matchA[3].trim()}`;
    } else if (/^\s*Lost connectivity to storage device/i.test(summaryResto)) {
      const matchB = summaryResto.match(/^\s*Lost connectivity to storage device\s+(.+?\.)\s+Path\s+(.+?)\s+is down\.\s+Affected datastores:\s+(.+?)\.?$/i);
      if (matchB) return `Lost connectivity to storage device ${matchB[1].trim()}\nPath ${matchB[2].trim()} is down\nAffected datastores: ${matchB[3].trim()}`;
    } else if (/^\s*server/i.test(summaryResto)) {
      const matchC = summaryResto.match(/^\s*server\s+(.+?)\s+mount point\s+(.+?)\s+mounted as\s+(.+?)\.?$/i);
      if (matchC) return `Lost connection to server ${matchC[1].trim()}\nMount point: ${matchC[2].trim()}\nMounted as: ${matchC[3].trim()}`;
    }
    return summaryResto;
  }
};
