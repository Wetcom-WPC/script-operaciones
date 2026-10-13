/**
 * WebApp HTTP Listener para Generación Interactiva de Borradores de Correo
 */

/**
 * Un GET debe ser seguro de repetir (un prefetch del navegador, una recarga de pestaña no
 * deberían generar un borrador de más). Acá NO se crea nada: la página que se devuelve le
 * pide la generación al servidor con `google.script.run`, y la creación real vive en
 * `generarBorradorDesdeWeb` / `_generarBorrador`.
 *
 * POR QUÉ NO SE NAVEGA A NINGÚN LADO
 * Antes esto era un `<form>` que se autoenviaba, y las dos variantes fallan:
 *
 *  - Sin `target`, el form navega el iframe en el que Apps Script sirve esta página hacia
 *    /exec, y esa URL se niega a ser embebida. El POST llegaba igual al servidor —el
 *    borrador se creaba— pero el usuario veía "script.google.com refused to connect".
 *  - Con `target="_top"`, el iframe viene con `sandbox="... allow-top-navigation-by-user-
 *    activation"`: una navegación disparada desde `onload`, sin un clic real de por medio,
 *    queda bloqueada en silencio y la página se cuelga en "Generando borrador…".
 *
 * `google.script.run` no navega nada: llama al servidor desde la misma página y devuelve el
 * HTML de la confirmación, que se inyecta en el lugar. Esquiva los dos problemas sin
 * obligar al operador a hacer un segundo clic.
 */
function doGet(e) {
  const borradorId = e && e.parameter ? e.parameter.id : null;

  if (!borradorId) {
    return HtmlService.createHtmlOutput(_avisoHTML('⚠️ Enlace Inválido', 'Falta el identificador de la alarma.'));
  }

  // El id llega por la URL, así que se inyecta como literal JSON y con los '<' escapados:
  // no puede cerrar el <script> ni colar markup desde el parámetro.
  const idLiteral = JSON.stringify(borradorId.toString()).replace(/</g, '\\u003c');

  return HtmlService.createHtmlOutput(`
    <div id="estado" style="font-family: 'Segoe UI', Tahoma, sans-serif; text-align: center; margin-top: 60px; padding: 20px; color: #666;">
      Generando borrador…
    </div>
    <script>
      google.script.run
        .withSuccessHandler(function (html) {
          document.getElementById('estado').innerHTML = html;
        })
        .withFailureHandler(function (err) {
          // textContent y no innerHTML: el mensaje de error no se renderiza como markup.
          document.getElementById('estado').textContent =
            'No se pudo generar el borrador: ' + (err && err.message ? err.message : err);
        })
        .generarBorradorDesdeWeb(${idLiteral});
    </script>
  `);
}

/**
 * Punto de entrada de `google.script.run` desde la página que devuelve doGet.
 * Devuelve HTML como string porque google.script.run no puede devolver un HtmlOutput.
 */
function generarBorradorDesdeWeb(borradorId) {
  return _generarBorrador(borradorId);
}

/**
 * El POST directo se mantiene: sigue siendo una forma válida de pedir la generación, y es
 * la que usaban los enlaces servidos por deployments anteriores a este cambio.
 */
function doPost(e) {
  return HtmlService.createHtmlOutput(_generarBorrador(e && e.parameter ? e.parameter.id : null));
}

/** Los avisos cortos comparten formato; el texto sale siempre de este archivo, no del usuario. */
function _avisoHTML(titulo, texto) {
  return `<div style="font-family: sans-serif; text-align: center; margin-top: 50px;"><h2 style="color: #d9534f;">${titulo}</h2><p>${texto}</p></div>`;
}

/**
 * Genera el borrador en Gmail y devuelve, como string, el HTML a mostrar.
 *
 * Devuelve string y no HtmlOutput porque lo consumen dos caminos distintos:
 * `generarBorradorDesdeWeb` (que viaja por google.script.run) y `doPost`.
 */
function _generarBorrador(borradorId) {
  try {
    if (!borradorId) {
      return _avisoHTML('⚠️ Enlace Inválido', 'Falta el identificador de la alarma.');
    }

    let dataGuardada = null;

    // 1. Intentar buscar en Google Drive
    try {
      const file = DriveApp.getFileById(borradorId);
      dataGuardada = file.getBlob().getDataAsString();
    } catch(err) {
      // 2. Fallback a la caché si no es un ID de archivo válido o fue borrado
      dataGuardada = CacheService.getScriptCache().get(`draft_${borradorId}`);
    }

    if (!dataGuardada) {
      return _avisoHTML('⚠️ Código expirado o procesado', 'Este borrador ya caducó (pasaron más de 6 horas) o no existe.');
    }

    let payloadBorrador;
    try {
      payloadBorrador = JSON.parse(dataGuardada);
    } catch (err) {
      payloadBorrador = null;
    }

    // El id puede apuntar a CUALQUIER archivo que el usuario tenga permiso de leer en su
    // Drive (executeAs: USER_ACCESSING lo acota a su propio Drive, pero no a esta app). Si
    // el contenido no tiene la forma esperada, no se usa: mejor un error claro que intentar
    // armar un correo con datos ajenos.
    if (!_esPayloadBorradorValido(payloadBorrador)) {
      return _avisoHTML('⚠️ Contenido inválido', 'El identificador no corresponde a un borrador generado por esta aplicación.');
    }

    // Obtener destinatarios desde DataRepository
    const repositorios = DataRepository.obtenerMapeos();
    const mapaCorreos = repositorios.mapaCorreos || {};
    const dest = mapaCorreos[payloadBorrador.cliente] || "";

    const tz = Session.getScriptTimeZone() || "America/Argentina/Buenos_Aires";
    const fechaAsunto = Utilities.formatDate(new Date(), tz, "dd/MM/yyyy");

    // El asunto contendrá la alarma principal y el nombre del cliente
    const asuntoCorreo = `${_alarmaPrincipalDe(payloadBorrador)} - WETCOM - ${payloadBorrador.cliente} - ${fechaAsunto}`;

    // Armar el cuerpo corporativo
    // Nota: Dejamos el espacio final libre para que el operador pueda insertar su firma corporativa de Gmail.
    // payloadBorrador.html no se escapa: es markup generado por MessageFormatter, no texto libre.
    const cuerpoFinal = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; font-size: 14px; max-width: 800px; text-align: left;">
        <p style="margin-bottom: 20px;">Estimados, ¿cómo están? Me comunico para informarles que recibimos las siguientes alarmas:</p>

        ${payloadBorrador.html}

        <p style="margin-top: 20px; margin-bottom: 30px;">Ante esto les consulto: ¿Están al tanto de las anomalías? ¿Desean que generemos un ticket para analizar la anomalía en profundidad?</p>
      </div>`;

    // Construir lista de CC dinámicamente
    let correosCC = Config.EMAIL_FALLBACK;
    if (payloadBorrador.pod) {
      const p = payloadBorrador.pod.toString().toLowerCase().replace(/\s+/g, '');
      if (p !== "wpc" && !p.includes("desconocido")) {
        const podEmail = p.startsWith("pod") ? `${p}@wetcom.com` : `pod${p}@wetcom.com`;
        correosCC += `, ${podEmail}`;
      }
    }

    GmailApp.createDraft(dest, asuntoCorreo, "Por favor, active HTML para ver el formato.", {
      htmlBody: cuerpoFinal,
      name: "Soporte Wetcom",
      cc: correosCC
    });

    return `
      <div style="font-family: 'Segoe UI', Tahoma, sans-serif; text-align: center; padding: 20px;">
        <h1 style="color: #008a3b; font-size: 28px;">✅ Borrador Listo</h1>
        <p style="font-size: 16px; color: #444;">El borrador para <b>${MessageFormatter._escapeHTML(payloadBorrador.cliente)}</b> ya está en tu Gmail.</p>
        <p style="font-size: 14px; background-color: #f1f3f4; padding: 15px; border-radius: 8px; display: inline-block;">
          👉 Ve a la carpeta <b>Borradores</b> de tu Gmail. Los destinatarios preconfigurados fueron cargados.
        </p>
        <br><br><p style="color: #888; font-size: 12px;">Ya puedes cerrar esta pestaña y volver a Slack.</p>
      </div>
    `;

  } catch (err) {
    return `<div style="font-family: sans-serif; text-align: center; margin-top: 50px;"><h2 style="color: #d9534f;">❌ Ocurrió un error crítico:</h2><p>${MessageFormatter._escapeHTML(err.message)}</p></div>`;
  }
}

/**
 * Nombre de la alarma que encabeza el asunto del correo.
 *
 * Este dato no lo produce el WebApp: viaja en un JSON que escribió MessageFormatter y que
 * quedó persistido en Drive. Lector y escritor son dos ejecuciones distintas, y no
 * necesariamente del mismo código: el enlace de Slack lo atiende el deployment publicado
 * en Config.URL_WEB_APP, que puede ser anterior al que generó el borrador. Por eso acá el
 * campo se trata como dato de entrada y no como algo garantizado:
 *
 *  - se acepta 'alarmaPricipal', el nombre con el typo que el campo tuvo hasta v10.10.0
 *    (AUDITORIA.md, punto 17), para no romper los borradores generados antes de esa
 *    corrección; y
 *  - ante un valor ausente o inservible se cae al mismo texto genérico que usa
 *    MessageFormatter, en vez de dejar que un undefined llegue al asunto — que es
 *    justamente lo que se veía: "undefined - WETCOM - Cliente - dd/MM/yyyy".
 */
function _alarmaPrincipalDe(payload) {
  const candidatos = [payload.alarmaPrincipal, payload.alarmaPricipal];

  for (let i = 0; i < candidatos.length; i++) {
    const valor = candidatos[i];
    if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
  }

  return "Incidentes Varios";
}

/**
 * Forma mínima que debe tener el JSON de un borrador para confiar en él: los campos que
 * MessageFormatter.generarMensaje efectivamente escribe al crearlo (ver payloadBorrador ahí).
 */
function _esPayloadBorradorValido(payload) {
  return !!payload
    && typeof payload === 'object'
    && typeof payload.cliente === 'string' && payload.cliente !== ''
    && typeof payload.html === 'string';
}
