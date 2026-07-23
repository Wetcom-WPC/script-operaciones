function verTiposDeIssueValidos() {
  // PONE AQUÍ LA KEY DEL PROYECTO QUE DA ERROR (ej: "COM", "SOP")
  const PROJECT_KEY = "WPC"; 
  
  const endpoint = `${JIRA_DOMAIN}/rest/api/2/issue/createmeta?projectKeys=${PROJECT_KEY}&expand=projects.issuetypes`;
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

function configurarEntornoDeTesting() {
  const properties = PropertiesService.getScriptProperties();
  properties.setProperties({
    "DRIVE_AVISO_BASE_FOLDER_ID": "1RZOjoQdpcT1IB2qiJSvTvZH-R3set9Bq",
    "DRIVE_RVTOOLS_LIC_FOLDER_ID": "1VllNqvkjruw173C1LYHRoZrMIqhkfdKL",
    "DRIVE_RVTOOLS_ZOMB_FOLDER_ID": "1OBjILy44I8DaYhRmYL3Sl-XHvrp9GAGB",
    "HOLIDAYS_CALENDAR_ID": "alarmas@wetcom.com",
    "JIRA_API_TOKEN": "REDACTED_ATLASSIAN_TOKEN=B9C96C5B",
    "JIRA_API_TOKEN_BASE64": "YWxhcm1hc0B3ZXRjb20uY29tOkFUQVRUM3hGZkdGMHZpWmVoZUVfVUhLaFhmcGlfOWpfSy1fOXJIN0ZUbS1wMUFnS0ZiLUdmeGd0dlNoSGlaWlN2aldrbnMxM1BuYmoxWFk2c1RaYzRPRVhUU0NoOGcxb095MG13MlNkWjlUU1FwQmdrYWo2UDA4RXVNQ3EtcHhKTDZjLVYwTml5WUEtcmJhaXlNdTRLUDlDYUZVUEFJMFVNOXdLY2tOOFo2dGNjVEpDWVYxbThGZz0wOEQxMjUwRg==",
    "JIRA_DEFAULT_ASSIGNEE_ID": "557058:ecc91d93-c16f-46d1-b6ea-0527936e8a4c",
    "JIRA_DOMAIN": "https://wetcom.atlassian.net",
    "JIRA_EMAIL": "thiago.chinabro@wetcom.com",
    "JIRA_FILTER_AUDITOR_TPS": "29682",
    "JIRA_FILTER_NUTANIX": "28945",
    "JIRA_FILTER_VEEAM": "27659",
    "JIRA_FILTER_VSPHERE_DIARIO": "24647",
    "LOG_SHEET_ID": "11dfz2dBl-A1owku7xGhtuyJ2pbayezwObHV5oETuuDw",
    "MASTER_INDEX_SHEET_ID": "1IcGMqJJAiMzPT6x304EQAdX6QmklfBxqq2twltRuliQ",
    "SLACK_WEBHOOK_AUDITOR_POD_1": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AUDITOR_POD_2": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AUDITOR_POD_3": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AUDITOR_POD_4": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AUDITOR_POD_5": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AUDITOR_TPS": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AVISOS_POD_1": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AVISOS_POD_2": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AVISOS_POD_3": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AVISOS_POD_4": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_AVISOS_POD_5": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_COMAFI": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_GENERAL": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_LOGS": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_REPORTE_DIARIO": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_RESUMEN_TICKETS": "REDACTED_SLACK_WEBHOOK",
    "SLACK_WEBHOOK_YASC": "REDACTED_SLACK_WEBHOOK"
  });
  
  Logger.log("✅ Propiedades del script del ambiente de testing configuradas.");
}

/**
 * Envía un mensaje de prueba al webhook de Slack para verificar la integración.
 */
function testearNotificacionSlack() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL");
  if (!webhookUrl) {
    Logger.log("❌ Error: No se encontró la propiedad SLACK_WEBHOOK_GENERAL.");
    return;
  }
  
  const payload = JSON.stringify({
    text: "🚀 *¡Hola!* Esto es una notificación de prueba desde el Apps Script de testing. La integración con Slack está funcionando."
  });
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": payload,
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(webhookUrl, options);
    Logger.log(`Código de respuesta de Slack: ${response.getResponseCode()}`);
    Logger.log(`Respuesta de Slack: ${response.getContentText()}`);
  } catch (e) {
    Logger.log(`❌ Error al enviar mensaje a Slack: ${e.message}`);
  }
}

/**
 * Envía un mensaje de prueba al canal mock-auditoria-pods.
 */
function testearSlackAuditoriaPods() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AUDITOR_POD_1");
  if (!webhookUrl) {
    Logger.log("❌ Error: No se encontró la propiedad SLACK_WEBHOOK_AUDITOR_POD_1.");
    return;
  }
  
  const payload = JSON.stringify({
    text: "🔍 *[Auditoría PODs - Testing]* Mensaje de prueba enviado al canal mock-auditoria-pods."
  });
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": payload,
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(webhookUrl, options);
    Logger.log(`[Auditoría] Código: ${response.getResponseCode()} | Respuesta: ${response.getContentText()}`);
  } catch (e) {
    Logger.log(`❌ Error: ${e.message}`);
  }
}

/**
 * Envía un mensaje de prueba al canal mock-comunicaciones-pods.
 */
function testearSlackAvisosPods() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_AVISOS_POD_1");
  if (!webhookUrl) {
    Logger.log("❌ Error: No se encontró la propiedad SLACK_WEBHOOK_AVISOS_POD_1.");
    return;
  }
  
  const payload = JSON.stringify({
    text: "📢 *[Avisos PODs - Testing]* Mensaje de prueba enviado al canal mock-comunicaciones-pods."
  });
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": payload,
    "muteHttpExceptions": true
  };
  
  try {
    const response = UrlFetchApp.fetch(webhookUrl, options);
    Logger.log(`[Avisos] Código: ${response.getResponseCode()} | Respuesta: ${response.getContentText()}`);
  } catch (e) {
    Logger.log(`❌ Error: ${e.message}`);
  }
}

/**
 * Crea una Tarea Programada de prueba en el proyecto de Jira para poder testear su cierre.
 * @param {string} summary El asunto de la tarea (ej: "Undersized VMs", "Espacio en datastores").
 * @param {string} projectKey La clave del proyecto en Jira (ej: "WPC").
 * @param {boolean} skipSlack Si es true, no envía la notificación individual a Slack.
 */
function crearTareaProgramadaDePrueba(summary, projectKey, skipSlack) {
  const targetSummary = summary || "Undersized VMs";
  const targetProject = projectKey || "WPC";
  
  const endpoint = `${JIRA_DOMAIN}/rest/api/2/issue`;
  
  const payload = {
    "fields": {
      "project": { "key": targetProject },
      "summary": targetSummary,
      "description": `Ticket de prueba automático para verificar el cierre de la tarea programada: ${targetSummary}`,
      "issuetype": { "name": "Tarea Programada" },
      "customfield_12316": { "value": "VMware vSphere" } // Campo de tecnología requerido en Jira
    }
  };

  const options = {
    "method": "post",
    "contentType": "application/json",
    "headers": { "Authorization": `Basic ${JIRA_AUTH_TOKEN_BASE_64}` },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    const code = response.getResponseCode();
    const responseText = response.getContentText();
    Logger.log(`[JIRA DEBUG] Crear TP - Código: ${code}`);
    if (code >= 200 && code < 300) {
      const data = JSON.parse(responseText);
      Logger.log(`✅ Tarea Programada de prueba creada con éxito: ${data.key} (${targetSummary})`);
      
      // Enviar notificación a Slack si no se solicita omitirla
      if (!skipSlack) {
        const slackWebhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL");
        if (slackWebhookUrl) {
          try {
            const slackPayload = JSON.stringify({
              text: `⚙️ *[Testing]* Se generó la Tarea Programada de prueba *${targetSummary}* (Ticket: <${JIRA_DOMAIN}/browse/${data.key}|${data.key}>).`
            });
            UrlFetchApp.fetch(slackWebhookUrl, {
              "method": "post",
              "contentType": "application/json",
              "payload": slackPayload,
              "muteHttpExceptions": true
            });
          } catch (err) {
            Logger.log(`Error al enviar noti de TP a Slack: ${err.message}`);
          }
        }
      }
      
      return data.key;
    } else {
      Logger.log(`❌ Error de Jira al crear la TP. Respuesta: ${responseText}`);
      return null;
    }
  } catch (e) {
    Logger.log(`❌ Excepción al conectar con Jira: ${e.message}`);
    return null;
  }
}

/**
 * Crea masivamente todas las Tareas Programadas de prueba para vSphere y Veeam en el Jira de pruebas.
 */
function crearTodasLasTareasProgramadasDePrueba(projectKey) {
  const targetProject = projectKey || "WPC";
  
  const tareasATestear = [
    // vSphere Ops
    "VMs con snapshots",
    "Undersized VMs",
    "Oversized VMs",
    "Idle VMs",
    "Espacio en datastores",
    "Storage DRS",
    "Cluster DRS",
    "VMs en datastores locales",
    "VMs con Preguntas",
    "VMs inaccesibles",
    "VMs operativas",
    "VMs apagadas por periodo de tiempo significativo",
    "Capacidad de particiones",
    "Affinity Rules",
    "Alertas de vSphere",
    "Orphaned VMs",
    
    // Veeam Ops
    "Backup por tag",
    "Jobs de Veeam",
    "Discos Montados en Proxy",
    "Espacio en Repositorios",
    "VMs en mas de un Job",
    
    // Tanzu Ops
    "Status de los nodos y uso de recursos",
    "Pod de sistema con inconvenientes",
    "Backups de Velero Fallidos",
    "Restores Incompletos o fallidos",
    "Chequeo de estado de certmanager y contour (kapps)",
    "PVC en estado pending",
    "Auditoría de aplicaciones sin Limits y Requests",
    "CHEQUEODDEPLOYMENTS QUE TIENEN MENOS DE 2 RÉPLICAS",
    "Chequeo de Liveness y Readiness",
    "Aplicaciones en Default Namespace",
    "Aplicaciones en Control Plane"
  ];
  
  Logger.log(`🚀 Iniciando creación masiva de ${tareasATestear.length} Tareas Programadas de prueba...`);
  
  let exitos = 0;
  let creadas = [];
  
  for (const tarea of tareasATestear) {
    const key = crearTareaProgramadaDePrueba(tarea, targetProject, true); // Omitimos avisos individuales
    if (key) {
      creadas.push(`• *${tarea}*: <${JIRA_DOMAIN}/browse/${key}|${key}>`);
      exitos++;
    }
    // Pequeño delay de 500ms para no saturar la API de Jira
    Utilities.sleep(500);
  }
  
  // Enviar un único mensaje consolidado a Slack al final
  if (creadas.length > 0) {
    const slackWebhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_GENERAL");
    if (slackWebhookUrl) {
      try {
        const text = `⚙️ *[Testing]* Se crearon masivamente las siguientes Tareas Programadas de prueba:\n\n${creadas.join("\n")}`;
        UrlFetchApp.fetch(slackWebhookUrl, {
          "method": "post",
          "contentType": "application/json",
          "payload": JSON.stringify({ text: text }),
          "muteHttpExceptions": true
        });
      } catch (err) {
        Logger.log(`Error al enviar noti masiva de TPs a Slack: ${err.message}`);
      }
    }
  }
  
  Logger.log(`🎉 Proceso completado. Se crearon ${exitos} de ${tareasATestear.length} Tareas Programadas con éxito.`);
}

/**
 * Envía masivamente 21 correos electrónicos de prueba a la casilla del propio usuario activo,
 * con los asuntos y los archivos adjuntos correspondientes (CSV/JSON) para simular todo el flujo.
 */
function enviarMailsDePruebaMasivos() {
  const miMail = Session.getActiveUser().getEmail();
  Logger.log(`📧 Enviando correos de prueba a: ${miMail}`);
  
  // Generamos el blob de Excel real usando la función del sistema para Espacio en Repositorios
  let repoExcelBlob = null;
  try {
    const dataRepo = [
      ["Repository Name", "Path", "Capacity (GB)", "Free Space (GB)", "Free Space (%)"],
      ["Veeam-Repo-PROD", "E:\\Backup", "10000", "850", "8.5"]
    ];
    repoExcelBlob = convertDataToXlsxBlob(dataRepo, "16-7-26 Espacio en repositorios.xlsx");
  } catch (err) {
    Logger.log(`Advertencia al generar Excel de Repositorios: ${err.message}`);
  }

  const mailsDePrueba = [
    {
      subject: "VMs con snapshots",
      filename: "16-7-26 VMs con snapshots.csv",
      mimeType: "text/csv",
      body: "VM Name,Age,Snapshot_Space,Cantidad\r\nvm-test-snap-01,15,45.2,1\r\nvm-test-snap-02,1,1.5,0"
    },
    {
      subject: "Undersized VMs",
      filename: "16-7-26 Undersized VMs.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,CPU,Memory,Status\r\nvm-test-under-01,1,2048,Undersized\r\nvm-test-under-02,2,4096,OK"
    },
    {
      subject: "Espacio en datastores",
      filename: "16-7-26 Espacio en datastores.csv",
      mimeType: "text/csv",
      body: "Name,Free Space,Cluster,Used Space (%)\r\nvsanDatastore-PROD,197093.12,,92.89\r\nvsanDatastore-DEV,432770.28,,52.73"
    },
    {
      subject: "Oversized VMs",
      filename: "16-7-26 Oversized VMs.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,CPU,Memory,Status\r\nvm-test-over-01,16,65536,Oversized\r\nvm-test-over-02,2,4096,OK"
    },
    {
      subject: "Idle VMs",
      filename: "16-7-26 Idle VMs.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,CPU,Memory,Status\r\nvm-test-idle-01,2,8192,Idle\r\nvm-test-idle-02,4,16384,OK"
    },
    {
      subject: "Cluster DRS",
      filename: "16-7-26 Cluster DRS.csv",
      mimeType: "text/csv",
      body: "Cluster,DRS Configuration,Details\r\nCluster-PROD-01,Disabled,DRS has been manually deactivated\r\nCluster-DEV-01,Enabled,OK"
    },
    {
      subject: "Storage DRS",
      filename: "16-7-26 Storage DRS.csv",
      mimeType: "text/csv",
      body: "Datastore Cluster,sDRS Configuration,DRS Enabled\r\nSDRS-PROD-01,Disabled,True"
    },
    {
      subject: "VMs en datastores locales",
      filename: "16-7-26 VMs en datastores locales.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,Datastore,Type\r\nvm-test-local-01,datastore1-local,local"
    },
    {
      subject: "VMs con Preguntas",
      filename: "16-7-26 VMs con Preguntas.json",
      mimeType: "application/json",
      body: '[{"Virtual Machine": "vm-test-blocked-01", "Question": "Did you copy or move this VM?", "Response Required": "Yes"}]'
    },
    {
      subject: "VMs inaccesibles",
      filename: "16-7-26 VMs inaccesibles.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,Status,Details\r\nvm-test-dead-01,Inaccessible,Configuration file vmx not found"
    },
    {
      subject: "VMs operativas",
      filename: "16-7-26 VMs operativas.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,Partition Usage (%)\r\nvm-test-tools-01,88.5"
    },
    {
      subject: "VMs apagadas por periodo de tiempo significativo",
      filename: "16-7-26 VMs apagadas por periodo de tiempo significativo.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,Days Powered Off,Last Active\r\nvm-test-off-01,45,01/06/2026"
    },
    {
      subject: "Capacidad de particiones",
      filename: "16-7-26 Capacidad de particiones.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,Partition,Porcentaje de uso (%)\r\nvm-test-full-01,C:\\,85.2"
    },
    {
      subject: "Affinity Rules",
      filename: "16-7-26 Affinity Rules.json",
      mimeType: "application/json",
      body: '[{"Rule Name": "Rule-AntiAffinity-DB", "Status": "Violated", "Details": "Both critical VMs running on the same host"}]'
    },
    {
      subject: "Alertas de vSphere",
      filename: "16-7-26 Alertas de vSphere.json",
      mimeType: "application/json",
      body: '[{"Object": "Host-PROD-01", "Alarm": "Host Connection State", "Time": "16/07/2026", "Severity": "Red"}]'
    },
    {
      subject: "Orphaned VMs",
      filename: "16-7-26 Orphaned VMs.csv",
      mimeType: "text/csv",
      body: "File Path,Size (GB),Datastore\r\n[vsan] orphaned_vms/vm_test_orphaned.vmdk,120,vsanDatastore"
    },
    {
      subject: "Backup por tag",
      filename: "16-7-26 Backup por tag.csv",
      mimeType: "text/csv",
      body: "Virtual Machine,Tag,Backup Job,Status\r\nvm-test-tag-01,Backup-Gold,None,No Job Associated"
    },
    {
      subject: "Jobs de Veeam",
      filename: "16-7-26 Jobs de Veeam.csv",
      mimeType: "text/csv",
      body: "JobName,JobType,SessionStart,SessionEnd,Result,ObjectName,ObjectStatus,ErrorMessage\r\nBackup_Veeam_PROD,Backup,16/07/2026 01:00,16/07/2026 02:00,Failed,VM-Database-01,Failed,Network connection timeout"
    },
    {
      subject: "Discos montados en proxy",
      filename: "16-7-26 Discos montados en proxy.json",
      mimeType: "application/json",
      body: '[{"Proxy": "proxy-test-01", "VM": "vm-mounted-test", "Status": "Failed", "Details": "Backup disk stuck"}]'
    },
    {
      subject: "Espacio en repositorios", // Asunto en minúsculas requerido por el script
      filename: "16-7-26 Espacio en repositorios.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      blob: repoExcelBlob,
      body: ""
    },
    {
      subject: "VMs en mas de un Job",
      filename: "details-16-7-26-VMs-en-mas-de-un-job.csv", // El nombre debe contener la palabra 'details'
      mimeType: "text/csv",
      body: "Virtual Machine,Job 1,Job 2,Status\r\nvm-double-backup-01,Daily_Backup_01,Daily_Backup_02,Duplicate"
    },
    {
      subject: "Reporte Tanzu",
      filename: "output.txt",
      mimeType: "text/plain",
      body: "    [INFO] Perfil activo: weekly\r\n    [INFO] Exclusiones cargadas: 0\r\n\r\n========== Cluster: cert ==========\r\n    [INFO] env=dev | criticality=low\r\n---------- Test de conexión API... ----------\r\n  [SUCCESS] API cluster cert OK\r\n---------- Chequeo cantidad de contenedores sin Requests y Limits ----------\r\n  [ERROR] ✖ Contenedores sin Requests CPU: 378\r\n  [ERROR] ✖ Contenedores sin Limits CPU: 383\r\n---------- Chequeo PVs y PVCs no Bound ----------\r\n  [SUCCESS] ✔ Todos los PVs están en estado Bound - OK\r\n---------- Chequeoddeployments que tienen menos de 2 réplicas ----------\r\n  [ERROR] ✖ Deployments con menos de 2 réplicas: 1010\r\n---------- Chequeo de Dataprotection ----------\r\n  [SUCCESS] ✔ Todos los backups están OK\r\n  [SUCCESS] ✔ Todos los restores están OK\r\n---------- Chequeo pods en nodos del control plane ----------\r\n  [SUCCESS] ✔ Sin pods - Nodo: cert-zfl8x-2dklh\r\n---------- Chequeo de pods NoReady ----------\r\n  [ERROR] Pods NoReady detectados\r\n  NAMESPACE                PROBLEM_PODS\r\n  cas-sisrginamb-dibm        2"
    }
  ];
  
  let enviados = 0;
  for (const mail of mailsDePrueba) {
    try {
      let attachmentBlob;
      if (mail.blob) {
        attachmentBlob = mail.blob;
      } else {
        attachmentBlob = Utilities.newBlob(mail.body, mail.mimeType, mail.filename);
      }
      
      GmailApp.sendEmail(miMail, mail.subject, "Adjunto reporte simulado de testing.", {
        attachments: [attachmentBlob]
      });
      enviados++;
      Logger.log(`📧 Mail enviado: "${mail.subject}" con adjunto "${mail.filename}"`);
      Utilities.sleep(800);
    } catch (e) {
      Logger.log(`❌ Error al enviar mail "${mail.subject}": ${e.message}`);
    }
  }
  
  Logger.log(`🎉 Envío masivo completado. Se enviaron ${enviados} correos.`);
}

/**
 * Elimina todos los activadores de tiempo (triggers) programados en el proyecto.
 * Detiene por completo la ejecución recurrente cada 2 minutos.
 */
function detenerTodosLosActivadores() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log(`🛑 Encontrados ${triggers.length} activadores activos. Procediendo a eliminar...`);
  
  for (const trigger of triggers) {
    try {
      ScriptApp.deleteTrigger(trigger);
      Logger.log(`- Activador eliminado: ${trigger.getHandlerFunction()}`);
    } catch (e) {
      Logger.log(`- Error al eliminar activador: ${e.message}`);
    }
  }
  
  // Limpiamos también el índice para reiniciar desde cero el próximo ciclo
  PropertiesService.getScriptProperties().deleteProperty('INDICE_SIGUIENTE_TAREA');
  Logger.log("✅ Ciclo detenido y reseteado con éxito.");
}
