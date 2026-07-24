# Script Operaciones — Ops Operativo (Producción)

Código fuente del proyecto de Google Apps Script que automatiza la Mesa de Ayuda (Soporte Operativo) de WETCOM: procesa correos, lee alertas de sistemas (vSphere, Veeam, vROps, Horizon, RVTools) y gestiona el ciclo de vida de tickets en Jira Service Management.

Esta rama (`main`) refleja **1:1 el contenido real del proyecto de Apps Script en producción** — el árbol de archivos de este repo es el mismo que ves en el editor de GAS, sin carpetas contenedoras adicionales.

## Arquitectura

Refactorizado con principios OOP y el patrón **Template Method** para maximizar reutilización y resiliencia frente a los límites de ejecución de Apps Script:

- **`core/MailProcessor.js`** — Clase base que orquesta el flujo completo (búsqueda de correos vía etiquetas `[OPS-PENDIENTE]`/`[OPS-PROCESADO]`, parsing, chequeo de excepciones, creación/actualización de tickets, resumen a Slack). Las operaciones individuales (`vsphere/*.js`, `veeam/*.js`, `rvtools/*.js`, `horizon/*.js`) heredan de esta clase y solo proveen configuración y transformación de datos específicas.
- **`core/JiraService.js`** — Comunicación con la API de Atlassian (creación/actualización/cierre de tickets, adjuntos con reintento e idempotencia, comentarios vía API v3 + formato ADF marcados como internos, caché de Request Types).
- **`core/ClientConfigService.js`** — Lee el Índice Maestro (hoja de Google Sheets) para resolver configuración por cliente y las reglas de excepción de cada operación, con caché en memoria (`MasterSheetSingleton`) para evitar aperturas repetidas de la hoja.
- **`core/DataProcessingService.js`** — Parsing robusto de CSV, normalización de encabezados con alias (`normalizarEncabezado`), evaluación de reglas de excepción (`isRowExcepted`) y generación de reportes Excel.
- **`core/MailUtils.js`** — Optimiza el consumo de cuota de Gmail con "Global Thread Fetching": una única búsqueda por ciclo de ejecución, filtrada en memoria.
- **`core/NotificationService.js` / `core/SlackService.js`** — Envío unificado de correo (con *safeguard* que redirige todo a un buzón de pruebas si `ENVIRONMENT` no es `PRODUCCION`) y de resúmenes/alertas a Slack.
- **`core/Utils.js`** — Clase `TimeGuard` (corta la ejecución de forma segura antes del límite de 6 minutos de Apps Script) y helpers transversales (ver abajo).
- **`core/ExecutionLogger.js` / `core/ScheduledLogger.js`** — Registro de ejecuciones y de tareas programadas.
- **`core/Main.js`** — Despachador por lotes: ejecuta la lista de operaciones (`LISTA_DE_TAREAS`) de forma encadenada vía triggers de tiempo, respetando la ventana operativa y el límite de tiempo por lote.

## Utilidades internas y helpers

Funciones propias del proyecto (no dependen de librerías externas):

- **`executeDriveWithBackoff(fn, maxRetries)`** — en `core/Utils.js`. Envuelve llamadas a la API de Drive con *backoff* exponencial ante `User rate limit exceeded`.
- **`estaEnHorarioOperativo()` / `dentroDeVentanaOperativa(nombreTrigger)`** — en `core/Utils.js`. Determinan si el momento actual está dentro de la ventana operativa (ver abajo). Los triggers 24/7 (`organizarReportesEnDrive`, `processProxyAlarms`) cortan la ejecución fuera de esa ventana para no consumir cuota de Gmail.
- **`construirAdfDesdeTexto(texto)`** — en `core/JiraService.js`. Convierte texto plano a formato ADF (Atlassian Document Format) para la API v3 de Jira.

## Ventana operativa

El día operativo de la Mesa es de **05:00 a 15:00 (hora Argentina)**. El orquestador principal (`ejecutarCicloDeOperaciones` en `core/Main.js`) tiene su propia ventana (`HORA_INICIO`/`HORA_FIN`), y los triggers 24/7 usan las constantes de `core/Utils.js`.

## Herramientas manuales

`custom/HerramientasManuales.js` reúne funciones de ejecución rápida desde el editor de Apps Script (prefijo `manual_`): correr la suite de tests, probar el flujo de RVTools contra un cliente de testing, verificar la ventana operativa, forzar una corrida de un trigger sin esperar el horario, etc.

## Testing

`tests/TestRunner.js` contiene una suite de pruebas unitarias nativas (sin dependencias externas) para los helpers puros del proyecto. Correr `runAllTests()` (o `manual_runAllTests()`) desde el editor de Apps Script.

## Repositorio hermano: Ops Playground

Los cambios se prueban primero en el proyecto de Apps Script **Ops Playground** antes de promoverlos a producción. Su código versionado vive en la rama [`refactor-operaciones`](../../tree/refactor-operaciones) de este mismo repositorio, con el mismo formato plano.

## Despliegue

1. Trabajar y validar en el proyecto Playground (rama `refactor-operaciones`).
2. Promover a producción: mergear/portar los cambios a `main` y hacer `clasp push` desde la carpeta local conectada al script de Apps Script de producción.

## Seguridad y Secretos

Los tokens, contraseñas y webhooks **no** deben subirse en texto plano a GitHub. Todo token se configura a través de `Configuración del Proyecto → Propiedades de la Secuencia de Comandos` en la interfaz de Google Apps Script.

Para el historial de cambios, ver [`CHANGELOG.md`](CHANGELOG.md).
