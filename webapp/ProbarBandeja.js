function probarBandeja() {
  const hoyStr = Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'yyyy/MM/dd');
  const query = 'label:OPS-PROCESADO after:' + hoyStr;
  
  Logger.log('Probando query: ' + query);
  
  try {
    const hilos = GmailApp.search(query, 0, 10);
    Logger.log('Hilos encontrados con search: ' + hilos.length);
  } catch(e) {
    Logger.log('Error con search: ' + e.message);
  }
  
  Logger.log('Probando getThreads() directo desde la etiqueta...');
  const etiqueta = GmailApp.getUserLabelByName('[OPS-PROCESADO]');
  if (etiqueta) {
    const hilosEtiqueta = etiqueta.getThreads(0, 10);
    Logger.log('Hilos encontrados con getThreads: ' + hilosEtiqueta.length);
  } else {
    Logger.log('No se encontro la etiqueta [OPS-PROCESADO]');
  }
}
