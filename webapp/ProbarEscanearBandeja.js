function probarEscanearBandeja() {
  const datos = webapp_escanearBandeja();
  Logger.log('Columnas encontradas:');
  datos.columnas.forEach(c => {
    Logger.log(' - ' + c.titulo + ': ' + c.total);
  });
  Logger.log('Total items guardados: ' + Object.keys(datos.items).length);
}
