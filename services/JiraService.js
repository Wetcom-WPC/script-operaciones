/**
 * Servicio para conectar e interactuar con la API de Jira
 */
const JiraService = {

  /**
   * Encabezados comunes a todas las llamadas a la API de Jira.
   */
  _encabezados: function() {
    return {
      "Accept": "application/json",
      "Authorization": `Basic ${Config.obtenerTokenJira()}`,
      "Content-Type": "application/json"
    };
  },

  /**
   * Obtiene las alarmas desde Jira y devuelve un array de objetos JSON.
   */
  buscarAlarmas: function() {
    const url = `https://${Config.JIRA_BASE_URL}/rest/api/3/search/jql`;

    const headers = this._encabezados();

    const payload = {
      "jql": `filter = ${Config.JIRA_FILTER_ID}`,
      "fields": ["key", "summary", "description", "created", Config.JIRA_POD_FIELD_ID],
      "maxResults": 100
    };

    const options = {
      "method": "post",
      "headers": headers,
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    };

    // Es un POST en la superficie, pero un GET en espíritu: `search/jql` no muta nada en
    // Jira, así que es seguro reintentarlo ante una falla transitoria.
    const response = Http.fetchConReintento(() => UrlFetchApp.fetch(url, options));
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    const jsonResponse = JSON.parse(responseText);

    if (responseCode !== 200) {
      throw new Error(`Jira devolvió un error ${responseCode}. Respuesta: ${responseText}`);
    }

    if (!jsonResponse.issues) {
      return [];
    }

    // Retorna la data mapeada a un objeto estructurado para mejor legibilidad en el código
    return jsonResponse.issues.map(issue => {
      let description = '';
      if (issue.fields.description && issue.fields.description.content) {
        const extractText = (node) => {
          if (node.type === 'text') return node.text || '';
          if (node.content && Array.isArray(node.content)) {
            let joiner = (node.type === 'paragraph' || node.type === 'listItem') ? '\n' : ' ';
            return node.content.map(extractText).join(joiner);
          }
          return '';
        };
        description = extractText(issue.fields.description);
      }
      
      const podField = issue.fields[Config.JIRA_POD_FIELD_ID];

      return {
        key: issue.key,
        summary: issue.fields.summary || "N/A",
        description: description,
        created: issue.fields.created ? new Date(issue.fields.created) : null,
        pod: (podField && podField.value)
              ? podField.value.replace(/^POD-?\s*/i, '').trim()
              : 'POD Desconocido'
      };
    });
  },

  /**
   * Lista las transiciones que el workflow ofrece para un ticket, en su estado actual.
   *
   * Se consulta por ticket y no se cachea a propósito: cada proyecto (SBM, SBDER, ...) puede
   * tener su propio workflow, y el volumen de alarmas silenciadas por corrida es bajo.
   * Un ticket ya cerrado sencillamente no ofrece la transición de cierre.
   */
  obtenerTransiciones: function(ticketKey) {
    const url = `https://${Config.JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/transitions`;

    const response = Http.fetchConReintento(() => UrlFetchApp.fetch(url, {
      "method": "get",
      "headers": this._encabezados(),
      "muteHttpExceptions": true
    }));

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode !== 200) {
      throw new Error(`Jira devolvió ${responseCode} al listar las transiciones de ${ticketKey}. Respuesta: ${responseText}`);
    }

    return JSON.parse(responseText).transitions || [];
  },

  /**
   * Elige, entre las transiciones disponibles, la que cierra la alarma.
   *
   * Función pura (no toca la red) para poder testearla contra payloads reales de Jira.
   * Devuelve null si ninguna sirve, que es el caso normal cuando el ticket ya está cerrado.
   */
  _elegirTransicionDeCierre: function(transiciones) {
    const objetivo = Config.JIRA_TRANSICION_CIERRE || {};
    const lista = transiciones || [];
    const norm = (t) => (t || '').toString().trim().toLowerCase();

    const coincideNombre = (t) => !!objetivo.nombre && norm(t.name) === norm(objetivo.nombre);
    const coincideEstado = (t) => !!objetivo.estadoDestino && t.to && norm(t.to.name) === norm(objetivo.estadoDestino);

    // El match ideal es el doble: la transición se llama como esperamos Y deja el ticket
    // en el estado esperado. Los dos siguientes cubren que renombren una cosa o la otra.
    return lista.filter(t => coincideNombre(t) && coincideEstado(t))[0]
        || lista.filter(coincideNombre)[0]
        || lista.filter(coincideEstado)[0]
        || null;
  },

  /**
   * Cierra un ticket y le deja un comentario con el motivo.
   *
   * Nunca lanza por un rechazo de Jira: devuelve `{ cerrado, detalle }` para que quien
   * llame decida qué informar. Cerrar es un extra sobre el silenciado, no puede tumbar
   * el envío del resumen a Slack.
   */
  cerrarTicket: function(ticketKey, idExcepcion) {
    if (!ticketKey) return { cerrado: false, detalle: 'el ticket no tiene key' };

    let transiciones;
    try {
      transiciones = this.obtenerTransiciones(ticketKey);
    } catch (e) {
      return { cerrado: false, detalle: e.message };
    }

    const transicion = this._elegirTransicionDeCierre(transiciones);
    if (!transicion) {
      const disponibles = transiciones.map(t => `${t.name} → ${(t.to && t.to.name) || '?'}`).join(', ') || 'ninguna';
      return { cerrado: false, detalle: `no hay transición de cierre disponible (¿ya está cerrado?). Ofrecidas: ${disponibles}` };
    }

    // Sin reintento a propósito: este POST SÍ muta el ticket. Si la respuesta se pierde por
    // una falla de red después de que Jira ya aplicó la transición, reintentar arriesgaría
    // un error de "no hay esa transición disponible" enmascarando un cierre que sí ocurrió
    // (o, peor, una transición doble si el workflow lo permitiera). Ver utils/Http.js.
    const url = `https://${Config.JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/transitions`;
    const response = UrlFetchApp.fetch(url, {
      "method": "post",
      "headers": this._encabezados(),
      "payload": JSON.stringify({ transition: { id: transicion.id } }),
      "muteHttpExceptions": true
    });

    const responseCode = response.getResponseCode();
    if (responseCode < 200 || responseCode >= 300) {
      return { cerrado: false, detalle: `Jira devolvió ${responseCode}: ${response.getContentText()}` };
    }

    // El comentario es best-effort: el ticket ya quedó cerrado, que es lo que importa.
    const comentario = this._armarComentarioDeCierre(idExcepcion);
    if (comentario) {
      try {
        this.comentarTicketInterno(ticketKey, comentario);
      } catch (e) {
        Logger.log(`No se pudo comentar ${ticketKey} tras cerrarlo: ${e.message}`);
      }
    }

    return { cerrado: true, detalle: transicion.name };
  },

  /**
   * Arma el texto de la nota interna a partir de la plantilla de Config.
   * Recibe el ID de la regla ya limpio, no el log de Slack: por eso no hay que sanear
   * markdown acá. Si el ID viniera vacío, se deja constancia igual.
   */
  _armarComentarioDeCierre: function(idExcepcion) {
    const plantilla = Config.JIRA_COMENTARIO_CIERRE;
    if (!plantilla) return '';
    const id = (idExcepcion || '').toString().trim() || 'sin ID';
    return plantilla.replace('{idExcepcion}', id);
  },

  /**
   * Agrega una NOTA INTERNA en un ticket.
   *
   * Crítico: estos tickets viven en Jira Service Management y el cliente ve el portal.
   * Un comentario público le expondría el detalle interno de por qué silenciamos su alarma.
   * Por eso acá NO existe la opción de comentar en público: si no se puede garantizar que
   * la nota quede interna, no se comenta nada y se lanza el error.
   *
   * Vía principal: la API de Service Desk, que tiene un campo `public` explícito y lo
   * devuelve en la respuesta, así que el resultado se verifica en lugar de asumirse.
   * Vía de respaldo: la API v3 marcando la propiedad `sd.public.comment` como interna,
   * por si el proyecto no fuese un service desk.
   */
  comentarTicketInterno: function(ticketKey, texto) {
    const viaServiceDesk = this._comentarViaServiceDesk(ticketKey, texto);
    if (viaServiceDesk.ok) return;

    // Si Jira llegó a crear el comentario (aunque haya salido público) no se reintenta:
    // un segundo intento dejaría dos comentarios y no borraría el que ya está publicado.
    if (viaServiceDesk.reintentar === false) {
      throw new Error(`Nota interna comprometida en ${ticketKey}: ${viaServiceDesk.detalle}`);
    }

    Logger.log(`Nota interna vía Service Desk falló en ${ticketKey} (${viaServiceDesk.detalle}). Reintentando por la API v3.`);

    const viaApiV3 = this._comentarInternoViaApiV3(ticketKey, texto);
    if (viaApiV3.ok) return;

    throw new Error(
      `No se pudo dejar la nota interna en ${ticketKey}. ` +
      `Service Desk: ${viaServiceDesk.detalle} | API v3: ${viaApiV3.detalle}. ` +
      `No se comentó nada para no exponer el detalle al cliente.`
    );
  },

  /**
   * Comenta usando la API de Service Desk, que expone `public` como campo de primer orden.
   * No alcanza con un 2xx: se confirma contra la respuesta que el comentario quedó privado.
   */
  _comentarViaServiceDesk: function(ticketKey, texto) {
    const url = `https://${Config.JIRA_BASE_URL}/rest/servicedeskapi/request/${encodeURIComponent(ticketKey)}/comment`;

    const response = UrlFetchApp.fetch(url, {
      "method": "post",
      "headers": this._encabezados(),
      "payload": JSON.stringify({ body: texto, public: false }),
      "muteHttpExceptions": true
    });

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode < 200 || responseCode >= 300) {
      return { ok: false, detalle: `HTTP ${responseCode}: ${responseText}` };
    }

    let creado;
    try {
      creado = JSON.parse(responseText);
    } catch (e) {
      return { ok: false, reintentar: false, detalle: `respuesta ilegible, no se puede confirmar que sea interna: ${responseText}` };
    }

    if (creado.public !== false) {
      return { ok: false, reintentar: false, detalle: `Jira lo creó como PÚBLICO (comentario ${creado.id}); hay que borrarlo a mano` };
    }

    return { ok: true };
  },

  /**
   * Respaldo por la API v3. El cuerpo va en formato ADF (no un string suelto) y la
   * privacidad se marca con la propiedad `sd.public.comment`, que es como Service Management
   * distingue una nota interna de una respuesta al cliente.
   */
  _comentarInternoViaApiV3: function(ticketKey, texto) {
    const url = `https://${Config.JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/comment`;

    const payload = {
      body: this._aDocumentoADF(texto),
      properties: [
        { key: 'sd.public.comment', value: { internal: true } }
      ]
    };

    const response = UrlFetchApp.fetch(url, {
      "method": "post",
      "headers": this._encabezados(),
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    });

    const responseCode = response.getResponseCode();
    if (responseCode < 200 || responseCode >= 300) {
      return { ok: false, detalle: `HTTP ${responseCode}: ${response.getContentText()}` };
    }

    return { ok: true };
  },

  /**
   * Envuelve texto plano multilínea en un documento ADF, un párrafo por línea.
   */
  _aDocumentoADF: function(texto) {
    return {
      type: 'doc',
      version: 1,
      content: (texto || '').split('\n').map(linea => ({
        type: 'paragraph',
        content: linea ? [{ type: 'text', text: linea }] : []
      }))
    };
  }
};
