function limpiarMemoriaPropiedades() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log("Memoria limpiada con éxito. Vuelve a correr tu script principal.");
}