function probarFiltroFecha() {
  const hoyStr = Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'yyyy/MM/dd');
  const desde = new Date(hoyStr + ' 00:00:00');
  
  Logger.log('Fecha desde calculada: ' + desde);
  
  const etiqueta = GmailApp.getUserLabelByName('[OPS-PROCESADO]');
  if (!etiqueta) {
    Logger.log('No se encontro la etiqueta [OPS-PROCESADO]');
    return;
  }
  
  const hilos = etiqueta.getThreads(0, 10);
  Logger.log('Se encontraron ' + hilos.length + ' hilos con la etiqueta.');
  
  let hilosDeHoy = 0;
  for (let i = 0; i < hilos.length; i++) {
    const hilo = hilos[i];
    if (hilo.getMessageCount() === 0) continue;
    
    const mensajes = hilo.getMessages();
    const ultimo = mensajes[mensajes.length - 1];
    const fecha = ultimo.getDate();
    
    Logger.log('Hilo ' + i + ': Fecha del ultimo mensaje = ' + fecha);
    
    if (fecha < desde) {
      Logger.log('  -> DESCARTADO (es anterior a hoy)');
    } else {
      Logger.log('  -> ACEPTADO (es de hoy)');
      hilosDeHoy++;
    }
  }
  
  Logger.log('Total de hilos aceptados (de hoy): ' + hilosDeHoy);
}
