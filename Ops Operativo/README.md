# Script Operaciones

Este repositorio contiene el código fuente del proyecto en Google Apps Script para la automatización de operaciones.

## Arquitectura

El proyecto funciona como un **Despachador Inteligente por Lotes**. 
- `Main.js`: Orquestador principal que ejecuta una cadena de validaciones cada día (dentro del horario operativo).
- `ConfiguracionGlobal.js`: Variables y constantes (Jira, Google Sheets, Slack).
- `FuncionesCompartidas.js`: Módulo principal que interactúa con las APIs (Jira, Slack) y verifica reglas de excepción contra una matriz maestra en Google Sheets.
- `Logging.js`: Manejo de registros operacionales.

El resto de los scripts se encargan de conectarse a Gmail o Google Drive para parsear alertas y reportes originados por herramientas como:
- vCenter y vRealize Operations (vSphere, DRS, Alertas generales).
- Veeam Backup & Replication (Errores de Jobs, Espacio en repositorios, Máquinas duplicadas).
- RVTools (Archivos zombies, redes desconectadas, licencias).

Cualquier alerta procesada puede generar un ticket en Jira o un mensaje en Slack dependiendo de las reglas de negocio y excepciones configuradas.

## Utilidades internas y helpers

Estas funciones son **propias del proyecto** (no dependen de librerías externas) y se usan de forma transversal:

- **`executeDriveWithBackoff(fn, maxRetries)`** — definida en `core/Utils.js`. Envuelve llamadas a la API de Drive (ej. `Drive.Files.copy`) con *backoff* exponencial para tolerar el error `User rate limit exceeded`. Reintenta hasta `maxRetries` (default 3) solo ante errores de límite de tasa; cualquier otro error se propaga. **No es una librería externa**: vive en el propio proyecto, por lo que no hay riesgo de desvinculación.
- **`estaEnHorarioOperativo()` / `dentroDeVentanaOperativa(nombreTrigger)`** — definidas en `core/Utils.js`. Determinan si el momento actual está dentro de la **ventana operativa (05:00–15:00, hora Argentina)**. Los triggers que corren 24/7 (`organizarReportesEnDrive`, `processProxyAlarms`) llaman a `dentroDeVentanaOperativa(...)` al inicio y cortan la ejecución fuera de ese horario para no consumir cuota de Gmail. Los límites se configuran con las constantes `HORARIO_OPERATIVO_INICIO` / `HORARIO_OPERATIVO_FIN`.
  - `organizarReportesEnDrive` amplía su ventana de búsqueda de correo a 16 h en la **primera corrida del día** (marca `ORGANIZAR_DRIVE_ULTIMA_FECHA` en Script Properties) para recuperar reportes que hayan llegado durante el hueco nocturno.
- **`construirAdfDesdeTexto(texto)`** — definida en `core/JiraService.js`. Convierte texto plano a formato ADF (Atlassian Document Format) para la API v3 de Jira. Todo comentario a Jira pasa por `addCommentToJiraTicket`, que usa v3 + ADF y lo marca como **interno** (`sd.public.comment = internal`), consistente con el lector `haSidoActualizadoHoy`.

## Ventana operativa

El día operativo de la Mesa es de **05:00 a 15:00 (hora Argentina)**. El orquestador principal (`ejecutarCicloDeOperaciones` en `core/Main.js`) tiene su propia ventana (`HORA_INICIO` / `HORA_FIN`), y los triggers 24/7 usan las constantes de `core/Utils.js`.
