/**
 * Se encarga de la presentación de los datos (agrupación y conversión a texto para Slack)
 * Utiliza Markdown avanzado para mantener estética Premium sin Emojis.
 */
const MessageFormatter = {
  
  generarMensaje: function(mensajesProcesados, errores) {
    let mensaje = this._formatearErrores(errores);

    for (const pod in mensajesProcesados) {
      mensaje += `*POD ${pod}*\n`;
      mensaje += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      
      if (pod === "WPC") {
        mensaje += `@wpc Buenas POD! Les comento que recibimos las siguientes alarmas:\n\n`;
      } else {
        mensaje += `@pod${pod} Buenas POD! Les comento que recibimos las siguientes alarmas:\n\n`;
      }

      let enlacesBorradores = [];

      for (const cliente in mensajesProcesados[pod]) {
        mensaje += `*${cliente}*${this._enlacesTickets(mensajesProcesados[pod][cliente])}\n\n`;
        const alarmasCliente = mensajesProcesados[pod][cliente];
        mensaje += this._generarDetalleAlarmas(alarmasCliente);
        
        // --- INYECCIÓN DEL ENLACE DE BORRADOR ---
        const urlWebApp = this._urlWebApp();
        if (urlWebApp) {
          try {
            const htmlBorrador = this._generarDetalleAlarmasHTML(alarmasCliente);
            const alarmaPrincipal = Object.keys(alarmasCliente)[0] || "Incidentes Varios";
            const payloadBorrador = {
              cliente: cliente,
              pod: pod,
              alarmaPrincipal: alarmaPrincipal,
              // Alias con el typo que el campo tuvo hasta v10.10.0. Se sigue escribiendo
              // porque el que lee este JSON es el deployment publicado del WebApp, que
              // puede ser anterior a esa corrección: si ese lector sólo conoce
              // 'alarmaPricipal', sin el alias arma el asunto con "undefined". Se puede
              // borrar cuando Config.URL_WEB_APP apunte con certeza a un deployment
              // posterior a v10.10.0.
              alarmaPricipal: alarmaPrincipal,
              html: htmlBorrador
            };
            
            const cadenaPayload = JSON.stringify(payloadBorrador);
            const hashBorrador = this._generarMD5(cadenaPayload);
            let borradorId = null;
            
            // Verificamos si ya existe en caché para deduplicar rápidamente
            const cache = CacheService.getScriptCache();
            const idEnCache = cache.get(`hash_${hashBorrador}`);
            
            if (idEnCache) {
              borradorId = idEnCache;
            } else if (Config.ID_CARPETA_BORRADORES && Config.ID_CARPETA_BORRADORES.trim() !== "") {
              const carpetaDrive = DriveApp.getFolderById(Config.ID_CARPETA_BORRADORES);
              
              // Failsafe 2: Buscar en Drive si ya existe un archivo con ese Hash (búsqueda exacta)
              const archivosExistentes = carpetaDrive.searchFiles(`title = '${hashBorrador}.json' and trashed = false`);
              if (archivosExistentes.hasNext()) {
                borradorId = archivosExistentes.next().getId();
              } else {
                const nombreArchivo = `${hashBorrador}.json`;
                const file = carpetaDrive.createFile(nombreArchivo, cadenaPayload, MimeType.PLAIN_TEXT);
                borradorId = file.getId();
              }
              cache.put(`hash_${hashBorrador}`, borradorId, 21600); // 6 horas
            } else {
              // Fallback a Caché temporal si la carpeta no fue configurada aún
              borradorId = Utilities.getUuid();
              cache.put(`draft_${borradorId}`, cadenaPayload, 21600); 
              cache.put(`hash_${hashBorrador}`, borradorId, 21600); 
            }
            
            enlacesBorradores.push(`📩 <${urlWebApp}?id=${borradorId}|Generar correo para ${cliente}>`);
          } catch(e) {
            Logger.log("Error al generar borrador (Cache/Drive): " + e.message);
          }
        }
      }

      // El cierre es el mismo para todos los PODs, WPC incluido. La variante propia que
      // tenía WPC ("¿Desean que generemos un ticket...? Aguardamos sus comentarios.")
      // era el texto que se le escribe AL CLIENTE, no el que se le pregunta al POD.
      // Ese texto sigue vivo donde corresponde: en el borrador de correo (WebApp.js).
      mensaje += `Ante esto, les consulto, ¿están al tanto de la/s anomalía/s? ¿desean que le informemos al cliente?\n\n`;

      if (enlacesBorradores.length > 0) {
        mensaje += enlacesBorradores.join('\n') + '\n\n\n\n';
      } else {
        mensaje += `\n\n`;
      }
    }

    return mensaje.trim();
  },

  generarCorreoGuardiaHTML: function(podFormateado, alarmasPorCliente) {
    let htmlContent = ``;
    for (const cliente in alarmasPorCliente) {
      const clienteEscapado = this._escapeHTML(cliente);
      htmlContent += `<h3 style="color: #333; margin-top: 30px; margin-bottom: 10px; border-bottom: 2px solid #00875a; padding-bottom: 5px; max-width: 800px;">Cliente: ${clienteEscapado}</h3>`;
      htmlContent += this._generarDetalleAlarmasHTML(alarmasPorCliente[cliente]);
    }

    let cuerpoFinal = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; max-width: 800px; text-align: left;">
        <p style="font-size: 15px; margin-bottom: 20px;">Buenas noches equipo, se adjunta el resumen de alertas críticas registradas para el <b>${podFormateado}</b>.</p>
        ${htmlContent}
        <hr style="border: 0; border-top: 1px solid #eee; margin-top: 20px; margin-bottom: 15px; max-width: 800px;">
        <p style="font-size: 12px; color: #666; margin-top: 0;">Saludos cordiales,<br><b>Wetcom Proactive Center</b></p>
      </div>`;
    
    return cuerpoFinal;
  },

  /**
   * URL del WebApp de borradores, o null si no está configurada o no se pudo leer.
   *
   * `Config.URL_WEB_APP` sale de una Script Property y `getPropiedad` lanza si la clave
   * falta. Antes esa lectura vivía en la condición del `if`, fuera del try: una property
   * sin cargar no dejaba al mensaje sin enlaces, dejaba al POD sin mensaje, porque la
   * excepción se llevaba puesta a `generarMensaje` entera.
   *
   * El enlace al borrador es una comodidad; el resumen de alarmas es el producto. Ante
   * configuración incompleta se publica igual, sin enlaces, y queda el aviso en el log.
   */
  _urlWebApp: function() {
    try {
      const url = Config.URL_WEB_APP;
      return (url && url.toString().startsWith('http')) ? url.toString() : null;
    } catch (e) {
      Logger.log(`No se pudo resolver URL_WEB_APP; el mensaje se publica sin enlaces de borrador: ${e.message}`);
      return null;
    }
  },

  /**
   * Enlaces a los tickets de Jira de las alarmas de un cliente, listos para acolarse al
   * nombre del cliente ("*Falabella* | SOPFALABEL-26796 | SOPFALABEL-26801").
   *
   * Se recorren todas las alarmas del cliente y todos sus grupos de origen, porque un mismo
   * bloque puede venir de más de un ticket: la misma alarma sobre tres hosts llega como tres
   * tickets distintos y se agrupa en una sola línea. Se deduplica conservando el orden de
   * aparición, que es el mismo en el que se listan las alarmas más abajo.
   *
   * Las entradas sin `ticketKey` se saltean en vez de romper: el campo lo agrega
   * AlarmProcessor, y un test que arme la estructura a mano puede no traerlo.
   */
  _enlacesTickets: function(alarmasCliente) {
    const keys = [];

    for (const alarma in alarmasCliente) {
      const entradasTarget = alarmasCliente[alarma];
      for (const targetStr in entradasTarget) {
        entradasTarget[targetStr].forEach(entrada => {
          const key = entrada && entrada.ticketKey;
          if (key && keys.indexOf(key) === -1) keys.push(key);
        });
      }
    }

    return keys.map(key => ` | <https://${Config.JIRA_BASE_URL}/browse/${key}|${key}>`).join('');
  },

  _formatearErrores: function(errores) {
    if (errores.length === 0) return '';
    return '*Errores encontrados:*\n' + errores.map(e => `• ${e}`).join('\n') + '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  },

  /**
   * Agrupa las entradas de una alarma (indexadas por el string de `origen`) en combinaciones
   * de cobertura + vCenter + cluster + etiqueta + summaries idénticos.
   *
   * Compartida por el render de Slack y el de HTML: antes cada uno tenía su propia copia de
   * este bloque (~65 líneas repetidas), y ya llegaron a divergir una vez sin que nadie lo
   * decidiera — el agrupado por cobertura (`_agruparPorCobertura`) sólo se enganchaba en el
   * camino de Slack; en el HTML funcionaba igual de pura casualidad, porque la cobertura ya
   * viaja dentro de `claveGrupo`. Ver AUDITORIA.md, punto 9.
   */
  _agruparPorCombinacion: function(entradasTarget) {
    const groupByCombination = {};

    for (const targetStr in entradasTarget) {
      let origen;
      try {
        origen = JSON.parse(targetStr);
      } catch (e) {
        origen = { vCenter: 'Desconocido', cluster: 'Desconocido', target: targetStr };
      }

      let summariesSet = new Set();
      entradasTarget[targetStr].forEach(entry => {
        if (entry.summaryResto !== null && entry.summaryResto !== 'N/A' && typeof entry.summaryResto === 'string') {
          const sumVal = entry.summaryResto.toString().trim();
          if (sumVal !== "") summariesSet.add(sumVal);
        }
      });

      const sortedSummaries = Array.from(summariesSet).sort();
      const claveGrupo = JSON.stringify({
        cobertura: origen.cobertura || '',
        vCenter: origen.vCenter,
        cluster: origen.cluster,
        etiquetaTarget: origen.etiquetaTarget || 'Host/Target',
        summaries: sortedSummaries
      });

      if (!groupByCombination[claveGrupo]) {
        groupByCombination[claveGrupo] = {
          cobertura: origen.cobertura || '',
          vCenter: origen.vCenter,
          cluster: origen.cluster,
          etiquetaTarget: origen.etiquetaTarget || 'Host/Target',
          summaries: sortedSummaries,
          targets: [],
          entries: []
        };
      }

      groupByCombination[claveGrupo].targets.push(origen.target);
      groupByCombination[claveGrupo].entries.push(...entradasTarget[targetStr]);
    }

    return groupByCombination;
  },

  _generarDetalleAlarmas: function(alarmas) {
    let detalle = "";
    for (const alarma in alarmas) {
      const entradasTarget = alarmas[alarma];
      const groupByCombination = this._agruparPorCombinacion(entradasTarget);

      // Una misma alarma puede llegar bajo coberturas distintas (9x5 y 24x7). Se emite un
      // bloque por cobertura, con su propio título y su propia fecha, porque son contratos
      // distintos y el POD necesita distinguirlos de un vistazo.
      const bloques = this._agruparPorCobertura(groupByCombination);

      for (let b = 0; b < bloques.length; b++) {
        const bloque = bloques[b];
        const mensajeFecha = this._crearMensajeFecha(bloque.entries);

        if (bloque.cobertura && Config.MOSTRAR_ROTULO_COBERTURA) detalle += `${bloque.cobertura}\n`;
        detalle += `• *${alarma}* _(${mensajeFecha})_\n`;

      for (const key in bloque.grupos) {
        const group = bloque.grupos[key];

        if (group.vCenter && !group.vCenter.toLowerCase().includes('desconocido')) {
          detalle += `    • *vCenter:* ${group.vCenter}\n`;
        }
        
        if (group.cluster && !group.cluster.toLowerCase().includes('desconocido') && group.etiquetaTarget !== 'Cluster') {
          detalle += `        • *Cluster:* ${group.cluster}\n`;
        }
        
        group.targets.forEach(targetName => {
          if (targetName && !targetName.toLowerCase().includes('desconocido') && !targetName.toLowerCase().includes('no encontrado')) {
            // Si hay un cluster que no es el target, indentamos el target un nivel más
            if (group.cluster && !group.cluster.toLowerCase().includes('desconocido') && group.etiquetaTarget !== 'Cluster') {
              detalle += `            • *${group.etiquetaTarget}:* ${targetName}\n`;
            } else {
              detalle += `        • *${group.etiquetaTarget}:* ${targetName}\n`;
            }
          }
        });
        
        if (group.summaries.length > 0) {
          const indentSummaries = (group.cluster && !group.cluster.toLowerCase().includes('desconocido') && group.etiquetaTarget !== 'Cluster') ? '                ' : '            ';
          group.summaries.forEach(summary => {
            if (summary.indexOf('\n') !== -1) {
              const lines = summary.split('\n');
              for (let i = 0; i < lines.length; i++) {
                detalle += `${indentSummaries}• _${lines[i].trim()}_\n`;
              }
            } else {
              detalle += `${indentSummaries}• _${summary}_\n`;
            }
          });
        }
      }
        detalle += `\n`;
      }
    }
    return detalle;
  },

  /**
   * Parte los grupos de una alarma en bloques por cobertura contratada (9x5 / 24x7).
   * Las alarmas del formato histórico no traen cobertura: caen en un único bloque sin
   * rótulo, así que su salida no cambia.
   */
  _agruparPorCobertura: function(groupByCombination) {
    const porCobertura = {};
    const orden = [];

    for (const key in groupByCombination) {
      const group = groupByCombination[key];
      const cobertura = group.cobertura || '';

      if (!porCobertura[cobertura]) {
        porCobertura[cobertura] = { cobertura: cobertura, grupos: {}, entries: [] };
        orden.push(cobertura);
      }

      porCobertura[cobertura].grupos[key] = group;
      porCobertura[cobertura].entries.push(...group.entries);
    }

    return orden.map(c => porCobertura[c]);
  },

  _crearMensajeFecha: function(entries) {
    const fechas = entries
      .map(entry => {
        if (!entry || !entry.created) return null;
        // Clonar antes de truncar: entry.created es la misma referencia que usan otros
        // consumidores (ej. el mismo dato se formatea para Slack y para el HTML de guardia),
        // y setSeconds() muta el objeto original en vez de devolver uno nuevo.
        const fecha = new Date(entry.created.getTime());
        fecha.setSeconds(0, 0);
        return fecha;
      })
      .filter(date => date !== null && !isNaN(date.getTime()));

    if (fechas.length === 0) return 'Fecha no disponible';

    const fechasOrdenadas = fechas.sort((a, b) => a - b);

    if (fechas.length === 1 || fechasOrdenadas.every(date => date.getTime() === fechasOrdenadas[0].getTime())) {
      const fechaFormateada = this._formatearFecha(fechasOrdenadas[0]);
      return `El día ${fechaFormateada.date} a las ${fechaFormateada.time}`;
    } else {
      const primeraFecha = this._formatearFecha(fechasOrdenadas[0]);
      const ultimaFecha = this._formatearFecha(fechasOrdenadas[fechasOrdenadas.length - 1]);
      if (primeraFecha.date === ultimaFecha.date) {
        return `El día ${primeraFecha.date} desde las ${primeraFecha.time} hasta las ${ultimaFecha.time}`;
      } else {
        return `Desde el día ${primeraFecha.date} a las ${primeraFecha.time} hasta el día ${ultimaFecha.date} a las ${ultimaFecha.time}`;
      }
    }
  },

  _formatearFecha: function(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return { date: `${day}/${month}/${year}`, time: `${hours}:${minutes}` };
  },

  _generarDetalleAlarmasHTML: function(alarmas) {
    let detalleHTML = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; border-left: 5px solid #00875a; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-top: 15px; margin-bottom: 25px; padding: 15px 20px; background-color: #fcfcfc;">
      <h2 style="color: #00875a; font-size: 18px; margin-top: 0; margin-bottom: 20px;">Incidentes Registrados</h2>
    `;
    
    for (const alarma in alarmas) {
      const entradasTarget = alarmas[alarma];
      const groupByCombination = this._agruparPorCombinacion(entradasTarget);

      for (const key in groupByCombination) {
        const group = groupByCombination[key];
        const mensajeFecha = this._crearMensajeFecha(group.entries);
        
        const targetsText = group.targets.filter(t => t && !t.toLowerCase().includes('desconocido') && !t.toLowerCase().includes('no encontrado'))
                                         .map(t => this._escapeHTML(t))
                                         .join('<br>') || 'N/A';
        
        let coberturaHtml = '';
        if (group.cobertura && Config.MOSTRAR_ROTULO_COBERTURA) {
          coberturaHtml = `
            <tr style="border-bottom: 1px solid #e0e0e0;">
              <td style="padding: 12px 15px; font-weight: bold; color: #555; background-color: #f9f9f9; text-transform: uppercase;">COBERTURA</td>
              <td style="padding: 12px 15px; color: #666;">${this._escapeHTML(group.cobertura)}</td>
            </tr>
          `;
        }

        let vcenterHtml = '';
        if (group.vCenter && !group.vCenter.toLowerCase().includes('desconocido')) {
          vcenterHtml += `
            <tr style="border-bottom: 1px solid #e0e0e0;">
              <td style="padding: 12px 15px; font-weight: bold; color: #555; background-color: #f9f9f9; text-transform: uppercase;">VCENTER</td>
              <td style="padding: 12px 15px; color: #666; line-height: 1.5;">${this._escapeHTML(group.vCenter)}</td>
            </tr>
          `;
        }

        let clusterHtml = '';
        if (group.cluster && !group.cluster.toLowerCase().includes('desconocido') && group.etiquetaTarget !== 'Cluster') {
          clusterHtml += `
            <tr style="border-bottom: 1px solid #e0e0e0;">
              <td style="padding: 12px 15px; font-weight: bold; color: #555; background-color: #f9f9f9; text-transform: uppercase;">CLUSTER</td>
              <td style="padding: 12px 15px; color: #666; line-height: 1.5;">${this._escapeHTML(group.cluster)}</td>
            </tr>
          `;
        }
        
        // Líneas del detalle ya aplanadas: un summaryResto puede traer varios campos
        // separados por saltos de línea (así los emite VropsStandardParser, uno por campo).
        const lineasDetalle = [];
        group.summaries.forEach(summary => {
          summary.split('\n').forEach(linea => {
            const limpia = linea.trim();
            if (limpia !== '') lineasDetalle.push(limpia);
          });
        });
        if (lineasDetalle.length === 0) lineasDetalle.push('Sin detalles adicionales');

        // Con una sola línea el detalle va como texto plano. La viñeta es un resto del
        // formato de Slack, donde el detalle cuelga indentado del target: acá, dentro de
        // una celda que ya está rotulada DETALLE, no separa nada y queda como el único
        // renglón con viñeta de una tabla en la que todos los demás campos son texto plano.
        // Con varias líneas la lista sí trabaja: cada una es un campo distinto
        // (Descripcion, Health Status, ...) y sin viñeta se leerían como un solo párrafo.
        const summariesHTML = lineasDetalle.length === 1
          ? this._escapeHTML(lineasDetalle[0])
          : '<ul style="margin: 0; padding-left: 20px;">'
              + lineasDetalle.map(linea => `<li>${this._escapeHTML(linea)}</li>`).join('')
              + '</ul>';

        detalleHTML += `
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; border: 1px solid #e0e0e0; background-color: #fff;">
          <tbody>
            <tr style="border-bottom: 1px solid #e0e0e0;">
              <td style="padding: 12px 15px; width: 20%; font-weight: bold; color: #555; background-color: #f0f7f4; text-transform: uppercase;">ALARMA</td>
              <td style="padding: 12px 15px; width: 80%; color: #222;"><b>${this._escapeHTML(alarma)}</b></td>
            </tr>
            ${coberturaHtml}
            <tr style="border-bottom: 1px solid #e0e0e0;">
              <td style="padding: 12px 15px; font-weight: bold; color: #555; background-color: #f9f9f9; text-transform: uppercase;">FECHA</td>
              <td style="padding: 12px 15px; color: #666;">${mensajeFecha.replace('El día ', '').replace('Desde el día ', 'Desde el ')}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e0e0e0;">
              <td style="padding: 12px 15px; font-weight: bold; color: #555; background-color: #f9f9f9; text-transform: uppercase;">${this._escapeHTML(group.etiquetaTarget).toUpperCase()}</td>
              <td style="padding: 12px 15px; color: #444; font-family: 'Courier New', Courier, monospace; font-size: 14px;">${targetsText}</td>
            </tr>
            ${vcenterHtml}
            ${clusterHtml}
            <tr>
              <td style="padding: 12px 15px; font-weight: bold; color: #555; background-color: #f9f9f9; text-transform: uppercase; vertical-align: top;">DETALLE</td>
              <td style="padding: 12px 15px; color: #666; vertical-align: top;">${summariesHTML}</td>
            </tr>
          </tbody>
        </table>
        `;
      }
    }
    
    detalleHTML += `
    </div>`;

    return detalleHTML;
  },

  /**
   * Genera un Hash MD5 en formato Hexadecimal para deduplicación
   */
  _generarMD5: function(str) {
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, str, Utilities.Charset.UTF_8);
    let hexString = '';
    for (let i = 0; i < digest.length; i++) {
      let hex = (digest[i] < 0 ? digest[i] + 256 : digest[i]).toString(16);
      if (hex.length == 1) hex = '0' + hex;
      hexString += hex;
    }
    return hexString;
  },

  /**
   * Escapa caracteres especiales de HTML para prevenir Inyección HTML / XSS
   */
  _escapeHTML: function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
};
