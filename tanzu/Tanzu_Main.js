const TANZU_RECIPIENT_EMAIL = "ian.lucero@wetcom.com"; // Destinatario exclusivo de Tanzu

// Mapeo de Secciones del TXT a Tareas Programadas de Jira y sus títulos de Incidente
const TANZU_JIRA_TASKS = [
  {
    sectionName: "Analizando problemas de estado de los nodos o cerca del límite de pods",
    tpName: "Status de los nodos y uso de recursos",
    jiraSummary: "ANALIZANDO PROBLEMAS DE ESTADO DE LOS NODOS O CERCA DEL LÍMITE DE PODS"
  },
  {
    sectionName: "Chequeo de Pods, Deployments, StatefulSets y DaemonSets de sistema",
    tpName: "Pod de sistema con inconvenientes",
    jiraSummary: "CHEQUEO DE PODS, DEPLOYMENTS, STATEFULSETS Y DAEMONSETS DE SISTEMA"
  },
  {
    sectionName: "Chequeo de Dataprotection",
    tpName: "Backups de Velero Fallidos",
    jiraSummary: "CHEQUEO DE DATAPROTECTION"
  },
  {
    sectionName: "Chequeo de Dataprotection",
    tpName: "Restores Incompletos o fallidos",
    jiraSummary: "CHEQUEO DE DATAPROTECTION"
  },
  {
    sectionName: "Analizando Packages",
    tpName: "Chequeo de estado de certmanager y contour (kapps)",
    jiraSummary: "ANALIZANDO PACKAGES"
  },
  {
    sectionName: "Chequeo PVs y PVCs no Bound",
    tpName: "PVC en estado pending",
    jiraSummary: "CHEQUEO PVS Y PVCS NO BOUND"
  }
];

// Secciones informativas ("Se Adjunta") que se envían por mail consolidado a la práctica de Cloud
const TANZU_MAIL_TASKS = [
  {
    sectionName: "Chequeo cantidad de contenedores sin Requests y Limits",
    tpName: "Auditoría de aplicaciones sin Limits y Requests",
    mailHeader: "CHEQUEO CANTIDAD DE CONTENEDORES SIN REQUESTS Y LIMITS"
  },
  {
    sectionName: "Chequeoddeployments que tienen menos de 2 réplicas",
    tpName: "CHEQUEODDEPLOYMENTS QUE TIENEN MENOS DE 2 RÉPLICAS",
    mailHeader: "CHEQUEODDEPLOYMENTS QUE TIENEN MENOS DE 2 RÉPLICAS"
  },
  {
    sectionName: "Chequeo cantidad de contenedores sin livenessProbe o readinessProbe",
    tpName: "Chequeo de Liveness y Readiness",
    mailHeader: "CHEQUEO CANTIDAD DE CONTENEDORES SIN LIVENESSPROBE O READINESSPROBE"
  },
  {
    sectionName: "Chequeo cantidad de pods en el namespace 'default'",
    tpName: "Aplicaciones en Default Namespace",
    mailHeader: "CHEQUEO CANTIDAD DE PODS EN EL NAMESPACE 'DEFAULT'"
  },
  {
    sectionName: "Chequeo pods en nodos del control plane",
    tpName: "Aplicaciones en Control Plane",
    mailHeader: "CHEQUEO PODS EN NODOS DEL CONTROL PLANE"
  },
  {
    sectionName: "Chequeo de pods NoReady",
    tpName: "Chequeo de pods NoReady",
    mailHeader: "CHEQUEO DE PODS NOREADY"
  }
];

/**
 * Clase Procesadora de Mails para Tanzu (output.txt)
 */
class TanzuMailProcessor extends MailProcessor {
  constructor() {
    super({
      operationName: "Tanzu",
      emailSubject: "Reporte Tanzu",
      attachmentMatch: ".txt",
      scheduledTaskName: null
    });
  }

  processSingleMessage(message, summaryReport) {
    Logger.log(`--- Procesando Correo de Tanzu: "${message.getSubject()}" ---`);
    const attachment = this.findAttachment(message);
    if (!attachment) {
      Logger.log(`[DEBUG MAIL] NO_OP: No se encontró ningún archivo .txt en el correo.`);
      return { status: 'NO_OP' };
    }

    const txtContent = attachment.getDataAsString("UTF-8");
    const parseResult = parseTanzuOutputTxt(txtContent);

    // Obtener la configuración del cliente (basado en remitente)
    const senderEmail = message.getFrom();
    let clientConfig = getClientConfig(senderEmail, "Tanzu");
    if (!clientConfig) {
      clientConfig = getClientConfigByName("WPC - Operaciones Testing", "Tanzu");
    }

    if (!clientConfig) {
      summaryReport.errores.push({ error: 'Error de Configuración', detalle: `No se encontró config de Tanzu para: ${senderEmail}` });
      return { status: 'ERROR' };
    }

    const processResult = ejecutarProcesamientoTanzu(parseResult.parsedData, parseResult.perfilActivo, clientConfig, summaryReport);
    if (processResult.success) {
      return { status: 'SUCCESS' };
    } else {
      return { status: 'FAILURE' };
    }
  }
}

/**
 * Función global para procesar emails de Tanzu en el ciclo diario
 */
function processTanzuEmails() {
  return new TanzuMailProcessor().processEmails();
}

/**
 * Función principal manual llamada desde la planilla de pruebas (checkbox de Tanzu).
 */
function procesarTanzuManual(clientName, tanzuFolderId) {
  Logger.log(`--- INICIANDO PROCESAMIENTO TANZU MANUAL: ${clientName} ---`);
  
  if (!tanzuFolderId || tanzuFolderId.trim() === "") {
    return { success: false, message: "ID de carpeta vacío." };
  }

  const clientConfig = getClientConfigByName(clientName, "Tanzu");
  if (!clientConfig) {
    return { success: false, message: `No se encontró la configuración en el índice para ${clientName}.` };
  }

  // Buscar el output.txt más reciente en Drive
  let file;
  try {
    const folder = DriveApp.getFolderById(tanzuFolderId);
    file = encontrarTxtMasReciente(folder);
  } catch (e) {
    return { success: false, message: `Error al acceder a Drive: ${e.message}` };
  }

  if (!file) {
    return { success: false, message: "No se encontró ningún archivo output.txt en la carpeta." };
  }

  Logger.log(`📄 Leyendo output.txt de Drive: ${file.getName()}`);
  const txtContent = file.getBlob().getDataAsString("UTF-8");
  const parseResult = parseTanzuOutputTxt(txtContent);

  const summaryReport = { exitos: [], advertencias: [], errores: [], TPsCerradas: 0 };
  const result = ejecutarProcesamientoTanzu(parseResult.parsedData, parseResult.perfilActivo, clientConfig, summaryReport);
  return { success: result.success, message: `Procesamiento manual completado. TPs cerradas: ${result.tareasCerradas}`, report: summaryReport };
}

/**
 * Motor central de lógica que analiza el JSON parseado del TXT
 */
function ejecutarProcesamientoTanzu(parsedData, perfilActivo, clientConfig, summaryReport) {
  const htmlMailSections = [];
  let TPsCerradas = 0;
  let processingSuccess = true;

  Logger.log(`ℹ️ Perfil Activo Detectado: ${perfilActivo}`);

  // --- 1. PROCESAR HOJAS JIRA (TICKETS DE INCIDENTES) ---
  TANZU_JIRA_TASKS.forEach(task => {
    const anomalies = [];
    
    for (const cluster in parsedData) {
      const section = parsedData[cluster][task.sectionName];
      if (!section) continue;

      // Si tiene errores listados, los acumulamos
      section.errors.forEach(err => {
        anomalies.push([cluster, err]);
      });

      // Si tiene métricas (como Status) chequeamos que no sea OK / Omitido
      if (section.metrics["Status"]) {
        const val = section.metrics["Status"];
        if (val !== "OK" && val !== "Omitido") {
          anomalies.push([cluster, `Métrica anormal: ${val}`]);
        }
      }
    }

    if (anomalies.length > 0) {
      Logger.log(`🚨 Anomalías detectadas en ${task.sectionName}: ${anomalies.length}`);
      const headers = ["Cluster", "Detalle de Anomalía"];
      const xlsxBlob = convertDataToXlsxBlob([headers].concat(anomalies), `${task.tpName}-Anomalias.xlsx`);
      const description = `Se encontraron ${anomalies.length} anomalías de Tanzu correspondientes al chequeo diario de: ${task.tpName}.\nSe adjunta reporte Excel para análisis.`;

      // Intentamos crear el ticket de Jira
      const result = createTicketAndNotify(task.jiraSummary, description, xlsxBlob, clientConfig, task.tpName);
      if (result.status === 'SUCCESS') {
        summaryReport.exitos.push({ mensaje: `Ticket creado/actualizado para ${task.tpName}` });
      } else {
        Logger.log(`⚠️ Falló la creación/subida del reporte para ${task.tpName}: ${result.status}`);
        summaryReport.errores.push({ error: `Fallo al procesar ticket para ${task.tpName}` });
        processingSuccess = false; // Marcamos como fallo del lote para reintentar sin marcar leido el mail
      }
    }

    // Cerramos la TP correspondiente en Jira
    try {
      buscarYCerrarTareaProgramada(task.tpName, clientConfig, false);
      TPsCerradas++;
    } catch (err) {
      Logger.log(`No se pudo cerrar la TP ${task.tpName}: ${err.message}`);
    }
  });

  // --- 2. PROCESAR SECCIONES DE CORREO ("SE ADJUNTA") ---
  TANZU_MAIL_TASKS.forEach(task => {
    let headers = [];
    const tableRows = [];

    // Formateo específico de cabeceras y mapeo de datos
    if (task.sectionName.includes("Limits")) {
      headers = ["Cluster", "Contenedores sin Requests CPU", "Contenedores sin Limits CPU", "Contenedores sin Requests Memoria", "Contenedores sin Limits Memoria"];
      for (const cluster in parsedData) {
        const sec = parsedData[cluster][task.sectionName];
        if (sec && Object.keys(sec.metrics).length > 0) {
          tableRows.push([
            cluster,
            sec.metrics["Contenedores sin Requests CPU"] || "0",
            sec.metrics["Contenedores sin Limits CPU"] || "0",
            sec.metrics["Contenedores sin Requests Memoria"] || "0",
            sec.metrics["Contenedores sin Limits Memoria"] || "0"
          ]);
        }
      }
    } else if (task.sectionName.includes("livenessProbe")) {
      headers = ["Cluster", "Contenedores sin livenessProbe", "Contenedores sin readinessProbe"];
      for (const cluster in parsedData) {
        const sec = parsedData[cluster][task.sectionName];
        if (sec && Object.keys(sec.metrics).length > 0) {
          tableRows.push([
            cluster,
            sec.metrics["Contenedores sin livenessProbe"] || "0",
            sec.metrics["Contenedores sin readinessProbe"] || "0"
          ]);
        }
      }
    } else if (task.sectionName.includes("réplicas")) {
      headers = ["Cluster", "Deployments con menos de 2 réplicas"];
      for (const cluster in parsedData) {
        const sec = parsedData[cluster][task.sectionName];
        if (sec && Object.keys(sec.metrics).length > 0) {
          tableRows.push([
            cluster,
            sec.metrics["Deployments con menos de 2 réplicas"] || "0"
          ]);
        }
      }
    } else if (task.sectionName.includes("default")) {
      headers = ["Cluster", "Estado", "Pods encontrados en 'default'"];
      for (const cluster in parsedData) {
        const sec = parsedData[cluster][task.sectionName];
        if (sec) {
          const podsCount = sec.metrics["Pods encontrados en 'default'"] || "";
          const status = podsCount ? "" : (sec.metrics["Status"] || "OK");
          tableRows.push([cluster, status, podsCount]);
        }
      }
    } else if (task.sectionName.includes("control plane")) {
      headers = ["Cluster", "Identificador", "Tipo / Atributo", "Detalle"];
      for (const cluster in parsedData) {
        const sec = parsedData[cluster][task.sectionName];
        if (sec) {
          sec.errors.forEach(err => {
            // Parsear: "Sin pods - Nodo: dev-control-plane-bc9wd" -> ["dev-control-plane-bc9wd", "Control Plane", "OK (Sin Pods)"]
            const nodoMatch = err.match(/Nodo:\s*(\S+)/);
            const nodoName = nodoMatch ? nodoMatch[1] : "Desconocido";
            tableRows.push([cluster, nodoName, "Control Plane", "OK (Sin Pods)"]);
          });
        }
      }
    } else if (task.sectionName.includes("NoReady")) {
      headers = ["Cluster", "Identificador", "Tipo / Atributo", "Detalle"];
      for (const cluster in parsedData) {
        const sec = parsedData[cluster][task.sectionName];
        if (sec) {
          sec.errors.forEach(err => {
            // Parsear: "Namespace: cas-sisrginamb-dibm - Pods NoReady: 2" -> ["cas-sisrginamb-dibm", "NoReady", "Cant: 2"]
            const nsMatch = err.match(/Namespace:\s*(\S+)\s*-\s*Pods\s*NoReady:\s*(\d+)/i);
            if (nsMatch) {
              tableRows.push([cluster, nsMatch[1], "NoReady", `Cant: ${nsMatch[2]}`]);
            } else {
              tableRows.push([cluster, err, "NoReady", ""]);
            }
          });
        }
      }
    }

    if (tableRows.length > 0 && perfilActivo === "weekly") {
      let sectionHtml = `<h3>${task.mailHeader}</h3>`;
      sectionHtml += `<table style='border-collapse: collapse; margin-bottom: 20px; font-family: Calibri, sans-serif; font-size: 11pt; width: auto;'>`;
      
      // Headers
      sectionHtml += `<thead><tr style='background-color: #008000; color: #ffffff;'>`;
      headers.forEach(h => {
        sectionHtml += `<th style='border: 1px solid #dddddd; padding: 6px 10px; font-weight: bold; text-align: left; text-transform: uppercase;'>${h}</th>`;
      });
      sectionHtml += `</tr></thead><tbody>`;

      // Filas
      tableRows.forEach((row, rIdx) => {
        const bg = (rIdx % 2 === 0) ? "#ffffff" : "#f2f2f2";
        sectionHtml += `<tr style='background-color: ${bg};'>`;
        row.forEach(cell => {
          sectionHtml += `<td style='border: 1px solid #dddddd; padding: 6px 10px; text-align: left;'>${cell}</td>`;
        });
        sectionHtml += `</tr>`;
      });
      
      sectionHtml += `</tbody></table>`;
      htmlMailSections.push(sectionHtml);
    }

    // Cerramos la TP correspondiente en Jira
    try {
      buscarYCerrarTareaProgramada(task.tpName, clientConfig, false);
      TPsCerradas++;
    } catch (err) {
      Logger.log(`No se pudo cerrar la TP ${task.tpName}: ${err.message}`);
    }
  });

  // --- 3. ENVIAR CORREO CONSOLIDADO SEMANAL (SOLO EN PERFIL WEEKLY A IAN) ---
  if (perfilActivo === "weekly") {
    if (htmlMailSections.length > 0) {
      const hoyStr = Utilities.formatDate(new Date(), "GMT-3", "dd/MM/yyyy");
      const asunto = `⚠️ Reporte Semanal de Tanzu - Wetcom / ${clientConfig.clientName} - ${hoyStr}`;
      
      let htmlBody = `<html>
        <head>
          <meta charset="utf-8">
          <style>
              body { font-family: Calibri, sans-serif; color: #333333; }
              h3 { color: #1f4e3a; font-family: Calibri, sans-serif; font-size: 14pt; margin-top: 20px; margin-bottom: 5px; }
              table { border-collapse: collapse; margin-bottom: 20px; font-family: Calibri, sans-serif; font-size: 11pt; width: auto; }
              th { background-color: #008000; color: #ffffff; font-weight: bold; text-align: left; padding: 6px 10px; border: 1px solid #dddddd; text-transform: uppercase; }
              td { padding: 6px 10px; border: 1px solid #dddddd; text-align: left; }
              tr:nth-child(even) { background-color: #f2f2f2; }
          </style>
        </head>
        <body>
          <p>Estimados, buenos dias. Espero que se encuentren bien.<br>
          Envio a continuacion el reporte de operaciones de Tanzu correspondientes al dia de la fecha.</p>
          <p>Anomalias detectadas:</p>`;
      
      htmlBody += htmlMailSections.join("");
      htmlBody += `</body></html>`;

      sendEmail({
        to: TANZU_RECIPIENT_EMAIL,
        subject: asunto,
        htmlBody: htmlBody,
        name: "Wetcom Proactive Center"
      });
      Logger.log(`✉️ Mail consolidado de Tanzu semanal enviado a: ${TANZU_RECIPIENT_EMAIL}`);
      summaryReport.exitos.push({ mensaje: `Mail consolidado semanal enviado a ${TANZU_RECIPIENT_EMAIL}.` });
    } else {
      Logger.log("✅ Sin anomalías informativas en la corrida semanal de Tanzu.");
    }
  } else {
    Logger.log("ℹ️ Corrida diaria (daily). Se omite el envío del mail semanal consolidado.");
  }

  return { success: processingSuccess, tareasCerradas: TPsCerradas };
}

/**
 * Parser de texto plano para output.txt
 */
function parseTanzuOutputTxt(txtContent) {
  const lines = txtContent.split(/\r?\n/);
  const parsedData = {};
  let currentCluster = "General";
  let currentSection = "Inicio";
  let perfilActivo = "daily";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;

    // Detectar Perfil Activo
    if (line.includes("Perfil activo:")) {
      if (line.toLowerCase().includes("weekly")) {
        perfilActivo = "weekly";
      }
      continue;
    }

    // Detectar Cambio de Cluster
    if (line.includes("========== Cluster:")) {
      const match = line.match(/Cluster:\s*(.+?)\s*={3,}/i);
      if (match) currentCluster = match[1].trim();
      continue;
    }

    // Detectar Cambio de Sección
    if (line.startsWith("----------") && line.endsWith("----------")) {
      currentSection = line.replace(/-{3,}/g, "").trim();
      continue;
    }

    if (!parsedData[currentCluster]) parsedData[currentCluster] = {};
    if (!parsedData[currentCluster][currentSection]) {
      parsedData[currentCluster][currentSection] = { errors: [], metrics: {} };
    }

    const current = parsedData[currentCluster][currentSection];

    if (line.includes("[ERROR]")) {
      const cleanLine = line.replace(/\[ERROR\]\s*/i, "").replace(/[✖✖]\s*/, "").trim();
      
      // Omitir líneas cosméticas de resumen
      if (!cleanLine.toLowerCase().includes("se encontraron") && 
          !cleanLine.toLowerCase().includes("pods ready detectados") && 
          !cleanLine.toLowerCase().includes("problem_pods") && 
          !cleanLine.toLowerCase().includes("omitiendo") && 
          !cleanLine.toLowerCase().includes("omitido")) {
        
        // Si tiene formato clave: valor, lo parseamos como métrica
        if (cleanLine.includes(":")) {
          const parts = cleanLine.split(":");
          const key = parts[0].trim();
          const val = parts[1].trim();
          current.metrics[key] = val;
        } else {
          current.errors.push(cleanLine);
        }
      }
    } else if (line.includes("[SUCCESS]") || line.includes("[INFO]")) {
      const cleanLine = line.replace(/\[SUCCESS\]\s*/i, "").replace(/\[INFO\]\s*/i, "").replace(/[✔✔]\s*/, "").trim();
      
      if (cleanLine.toLowerCase().includes("ok") || cleanLine.toLowerCase().includes("omitido") || cleanLine.toLowerCase().includes("bound")) {
        current.metrics["Status"] = cleanLine.toLowerCase().includes("omitido") ? "Omitido" : "OK";
      } else if (cleanLine.includes("Nodo:")) {
        // Guardamos también los nodos sin pods del Control Plane como errores informativos para listar
        current.errors.push(cleanLine);
      }
    } else {
      // Tablas o líneas adicionales (ej: lista de pods NoReady)
      if (!line.includes("NAMESPACE") && !line.includes("PROBLEM_PODS") && !line.includes("Perfi") && !line.includes("Exclusiones")) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const count = parseInt(parts[1], 10);
          if (!isNaN(count)) {
            current.errors.push(`Namespace: ${parts[0]} - Pods NoReady: ${count}`);
          }
        }
      }
    }
  }

  return { parsedData: parsedData, perfilActivo: perfilActivo };
}

/**
 * Buscar el archivo output.txt más reciente en una carpeta de Drive
 */
function encontrarTxtMasReciente(folder) {
  const files = folder.getFiles();
  let latestFile = null;
  let latestTime = 0;

  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().toLowerCase().includes("output") && file.getName().toLowerCase().endsWith(".txt")) {
      const createdTime = file.getLastUpdated().getTime();
      if (createdTime > latestTime) {
        latestTime = createdTime;
        latestFile = file;
      }
    }
  }
  return latestFile;
}
