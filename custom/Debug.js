function verTiposDeIssueValidos() {
  // PONE AQUÍ LA KEY DEL PROYECTO QUE DA ERROR (ej: "COM", "SOP")
  const PROJECT_KEY = "WPC"; 
  
  const endpoint = `https://wetcom.atlassian.net/rest/api/2/issue/createmeta?projectKeys=${PROJECT_KEY}&expand=projects.issuetypes`;
  const options = {
    "method": "get",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "muteHttpExceptions": true
  };

  const response = UrlFetchApp.fetch(endpoint, options);
  Logger.log("--- TIPOS VÁLIDOS PARA " + PROJECT_KEY + " ---");
  
  if (response.getResponseCode() === 200) {
    const data = JSON.parse(response.getContentText());
    if (data.projects && data.projects.length > 0) {
      const types = data.projects[0].issuetypes;
      types.forEach(t => {
        Logger.log(`Nombre: "${t.name}"  (ID: ${t.id})`);
      });
    } else {
      Logger.log("No se encontró información del proyecto.");
    }
  } else {
    Logger.log("Error: " + response.getContentText());
  }
}