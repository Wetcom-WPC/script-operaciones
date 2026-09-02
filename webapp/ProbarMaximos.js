function probarMaximos() {
  Logger.log('Probando maximos de GmailApp...');
  
  const query = 'is:unread';
  try {
    const hilos = GmailApp.search(query, 0, 500);
    Logger.log('search(0, 500) ok: ' + hilos.length);
  } catch (e) {
    Logger.log('search(0, 500) fallo: ' + e.message);
  }
  
  const etiqueta = GmailApp.getUserLabelByName('[OPS-PROCESADO]');
  if (etiqueta) {
    try {
      const hilos = etiqueta.getThreads(0, 500);
      Logger.log('getThreads(0, 500) ok: ' + hilos.length);
    } catch (e) {
      Logger.log('getThreads(0, 500) fallo: ' + e.message);
      try {
        const hilos2 = etiqueta.getThreads(0, 100);
        Logger.log('getThreads(0, 100) ok: ' + hilos2.length);
      } catch (e2) {
        Logger.log('getThreads(0, 100) fallo: ' + e2.message);
      }
    }
  }
}
