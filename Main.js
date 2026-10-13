/**
 * Punto de entrada principal (Entrypoint)
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Ejecutar Automatización')
    .addItem('Ejecutar y Enviar a Slack', 'disparadorPrincipal_conAPI')
    .addItem('Ejecutar e Imprimir Local', 'disparadorPrincipal_Local')
    .addItem('Ejecutar Guardia de Alarmas', 'disparadorGuardia_Manual')
    .addSeparator()
    .addItem('Actualizar Dropdowns de Clientes', 'actualizarDropdownsClientes')
    .addToUi();

  ui.createMenu('Ejecutar reporte de licencias')
    .addItem('Auditar vSphere (Cliente Seleccionado)', 'ejecutarClienteSeleccionadoLicencias')
    .addItem('Auditar Veeam (Cliente Seleccionado)', 'ejecutarClienteSeleccionadoVeeamLic')
    .addSeparator()
    .addItem('Enviar vSphere a todos los activos', 'enviarTodosActivosVsphere')
    .addItem('Enviar Veeam a todos los activos', 'enviarTodosActivosVeeam')
    .addSeparator()
    .addItem('Ver estado de licencias', 'verEstadoLicencias')
    .addToUi();
}

/**
 * Función interna compartida que procesa todo pero no envía a ningún lado
 */
function _obtenerMensajeFinal() {
  // 1. Busca las alarmas directamente en Jira (Retorna JSON)
  const issues = JiraService.buscarAlarmas();

  if (issues.length === 0) {
    return { exito: false, mensaje: "No se encontraron alarmas a través de la API de Jira." };
  }
  
  // 2. Obtiene diccionarios de mapeo desde las hojas de Google Sheets
  const mappings = DataRepository.obtenerMapeos();
  
  // 3. Procesa las alarmas cruzando la información con los mappings
  const { mensajesProcesados, errores, alarmasSilenciadas } = AlarmProcessor.procesarAlarmas(issues, mappings);
  
  // 4. Formatea el mensaje de Slack agrupando por PODs, Clientes, etc.
  const mensajeFinal = MessageFormatter.generarMensaje(mensajesProcesados, errores);
  
  if (!mensajeFinal || mensajeFinal.trim() === "") {
    return { exito: false, mensaje: "Las alarmas obtenidas fueron filtradas/excluidas (ej: Falsos Positivos). No hay nada nuevo para enviar.", alarmasSilenciadas };
  }
  
  return { exito: true, mensaje: mensajeFinal, alarmasSilenciadas, mensajesProcesados, mappings };
}

/**
 * Cierra en Jira las alarmas silenciadas (si está habilitado) y las informa en el canal
 * de logs de excepciones.
 *
 * Nada de lo que pase acá puede tumbar el envío del resumen: una alarma que no se pudo
 * cerrar sigue estando correctamente silenciada, que es lo que pidió la regla de Excepción.
 */
function _procesarAlarmasSilenciadas(alarmasSilenciadas) {
  if (!alarmasSilenciadas || alarmasSilenciadas.length === 0) return;

  alarmasSilenciadas.forEach(item => {
    let cierre = null;

    if (Config.CERRAR_ALARMAS_SILENCIADAS) {
      try {
        cierre = JiraService.cerrarTicket(item.ticketKey, item.idExcepcion);
      } catch (e) {
        cierre = { cerrado: false, detalle: e.message };
      }
      Logger.log(`[${item.ticketKey}] Cierre automático: ${cierre.cerrado ? 'OK (' + cierre.detalle + ')' : 'NO — ' + cierre.detalle}`);
    }

    try {
      SlackService.enviarLogExcepcion(item.log, item.ticketKey, cierre);
    } catch (e) {
      Logger.log("Error enviando log de excepción: " + e.message);
    }
  });
}

function disparadorPrincipal_conAPI() {
  try {
    const resultado = _obtenerMensajeFinal();

    // Se procesan las excepciones independientemente del éxito del mensaje principal
    _procesarAlarmasSilenciadas(resultado.alarmasSilenciadas);

    if (!resultado.exito) {
      Logger.log(resultado.mensaje);
      return;
    }

    // 5. Envía el resultado a Slack
    SlackService.enviarNotificacion(resultado.mensaje);
    Logger.log("Ejecución finalizada con éxito. Mensaje generado:\n" + resultado.mensaje);

  } catch (e) {
    const errorMsg = "Error crítico en el script: " + e.message;
    Logger.log(errorMsg);
    throw new Error(errorMsg);
  }
}

function disparadorPrincipal_Local() {
  try {
    const resultado = _obtenerMensajeFinal();
    const ui = SpreadsheetApp.getUi();
    
    // Ejecución en seco: se listan las silenciadas pero NO se cierran los tickets ni se
    // postea en Slack, porque este entrypoint existe justamente para simular sin efectos.
    if (resultado.alarmasSilenciadas && resultado.alarmasSilenciadas.length > 0) {
      Logger.log("--- ALARMAS SILENCIADAS ---");
      resultado.alarmasSilenciadas.forEach(item => Logger.log(`[${item.ticketKey}] ${item.log}`));
    }

    if (!resultado.exito) {
      ui.alert("Aviso", resultado.mensaje, ui.ButtonSet.OK);
      return;
    }
    
    // Muestra el mensaje en un popup en lugar de Slack
    ui.alert("Simulación de Ejecución (Local)", resultado.mensaje, ui.ButtonSet.OK);
    Logger.log("Ejecución local finalizada. Mensaje:\n" + resultado.mensaje);

  } catch (e) {
    SpreadsheetApp.getUi().alert("Error crítico en el script", e.message, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

/**
 * Entrypoint exclusivo para el Trigger de Guardia Nocturna/Fines de semana.
 * Realiza la validación de feriados antes de continuar.
 */
function disparadorGuardia() {
  try {
    // 1. Validar que la ejecución corresponda a un día no laborable (Finde o Feriado)
    if (!Tools.esFinDeSemanaOFeriado()) {
      Logger.log("Ejecución de guardia omitida: Hoy es un día laborable normal.");
      return;
    }

    _procesarYEnviarGuardia();
  } catch (e) {
    const errorMsg = "Error crítico en disparador de Guardia: " + e.message;
    Logger.log(errorMsg);
    throw new Error(errorMsg);
  }
}

/**
 * Entrypoint exclusivo para el Botón del Menú de Sheets.
 * Ejecuta la guardia ignorando la validación de feriados (Ejecución forzada/urgente).
 */
function disparadorGuardia_Manual() {
  try {
    Logger.log("Ejecución de guardia manual iniciada desde el menú (Ignorando validación de feriados).");
    _procesarYEnviarGuardia();
    SpreadsheetApp.getUi().alert("Éxito", "La guardia manual finalizó y los reportes fueron enviados.", SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    const errorMsg = "Error en Guardia Manual: " + e.message;
    Logger.log(errorMsg);
    SpreadsheetApp.getUi().alert("Error", errorMsg, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

/**
 * Lógica core compartida para la guardia.
 */
function _procesarYEnviarGuardia() {
  const resultado = _obtenerMensajeFinal();

  _procesarAlarmasSilenciadas(resultado.alarmasSilenciadas);

  if (!resultado.exito) {
    Logger.log("Guardia: " + resultado.mensaje);
    return;
  }
  
  // Enviar a Slack canal de Guardia
  SlackService.enviarNotificacionGuardia(resultado.mensaje);
  Logger.log("Notificación de Guardia enviada a Slack.");

  // Enviar correos por POD
  const { mensajesProcesados, mappings } = resultado;
  
  for (const pod in mensajesProcesados) {
    const alarmasPorCliente = mensajesProcesados[pod];
    const podFormateado = pod === "WPC" ? pod : (pod.toUpperCase().includes('POD') ? pod : `POD ${pod}`);
    
    const htmlCorreo = MessageFormatter.generarCorreoGuardiaHTML(podFormateado, alarmasPorCliente);
    const destino = mappings.mapaCorreosPods[podFormateado] || mappings.mapaCorreosPods[pod] || Config.EMAIL_FALLBACK;
    const tz = Session.getScriptTimeZone() || "America/Argentina/Buenos_Aires";
    const fechaAsunto = Utilities.formatDate(new Date(), tz, "dd/MM/yyyy");
    const asunto = `🌙 Guardia de Alertas Críticas en Clientes - ${podFormateado} - ${fechaAsunto}`;
    
    // Agregar copia a wpc solo si estamos en producción
    const copia_cc = Config.esProduccion() ? Config.EMAIL_FALLBACK : null;
    EmailService.enviarReporteGuardia(destino, asunto, htmlCorreo, copia_cc);
  }
  
  Logger.log("Ejecución de Guardia finalizada con éxito.");
}

/**
 * Función global (Entrypoint) para invocar la limpieza programada de borradores desde los Triggers de Apps Script.
 */
function runnerLimpiarBorradoresViejos() {
  Tools.limpiarBorradoresViejos();
}

/**
 * Función global (Entrypoint) para limpiar las excepciones vencidas de la planilla.
 * Ideal para ser programada como trigger diario a la madrugada.
 */
function runnerLimpiarExcepcionesVencidas() {
  Tools.limpiarExcepcionesVencidas();
}

/**
 * Actualiza masivamente la validación de datos (dropdowns) en la columna 'Cliente' 
 * de todas las hojas de Excepciones dinámicamente.
 */
function actualizarDropdownsClientes() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const clientesSheet = ss.getSheetByName(Config.SHEET_CLIENTES);
    if (!clientesSheet) return;
    
    const lastRow = clientesSheet.getLastRow();
    if (lastRow < 2) return;
    
    // Obtener toda la data de clientes (Columna A, B y C)
    const data = clientesSheet.getRange(2, 1, lastRow - 1, 3).getValues();
    
    const sheets = ss.getSheets();
    let hojasActualizadas = 0;
    
    sheets.forEach(sheet => {
      const sheetName = sheet.getName();
      if (sheetName.startsWith("Excepciones ") && sheetName !== "Excepciones") {
        const podName = sheetName.replace("Excepciones", "").trim();
        
        // Filtrar clientes específicos para este POD
        const listaClientes = ["TODOS"];
        data.forEach(fila => {
          const clienteNombre = fila[1]; // Columna B: Cliente
          const clientePod = fila[2];    // Columna C: POD
          
          if (clientePod === podName || podName === "TODOS") {
            if (clienteNombre && clienteNombre !== "") {
              listaClientes.push(clienteNombre);
            }
          }
        });
        
        // Aplicar a toda la columna B (Cliente) desde la fila 2 hacia abajo
        const maxRows = sheet.getMaxRows();
        if (maxRows > 1) {
          const cellClienteRange = sheet.getRange(2, 2, maxRows - 1, 1);
          const rule = SpreadsheetApp.newDataValidation()
                                     .requireValueInList(listaClientes, true)
                                     .setAllowInvalid(false)
                                     .build();
          cellClienteRange.setDataValidation(rule);
        }
        hojasActualizadas++;
      }
    });
    
    Logger.log(`Dropdowns de Clientes actualizados exitosamente en ${hojasActualizadas} hojas de Excepciones.`);
  } catch(e) {
    Logger.log("Error al actualizar dropdowns masivos: " + e.message);
  }
}

/**
 * Trigger simple que se ejecuta al editar la planilla.
 * Si detecta que se modificó la hoja "Clientes", actualiza automáticamente 
 * los dropdowns en todas las pestañas de excepciones.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  
  if (sheet.getName() === Config.SHEET_CLIENTES) {
    actualizarDropdownsClientes();
  }
}
