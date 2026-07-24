# CHANGELOG - Ops Playground / Ops Operativo (v2.0)

## [2.0.1] - 2026-07-24
### Deployed
- **Primer despliegue real de v2.0 a producción**: el código refactorizado (arquitectura OOP/Template Method documentada en [2.0.0]) fue validado en `Ops Playground` y desplegado a `Ops Operativo` (producción real). Hasta esta versión, producción seguía ejecutando el código monolítico anterior (`FuncionesCompartidas.js`, `Logging.js`).
- Se tomó un backup censurado (sin secretos) del código de producción previo en la rama `backup-real-prod` antes del despliegue.

### Fixed
- **Excepciones de Zombies VMDKs nunca se aplicaban**: la planilla de excepciones usa la columna `name`, pero la pestaña `vHealth` de RVTools expone esa columna como `Object`. `procesarZombiesVmdk` ahora normaliza el encabezado detectado al nombre canónico `name`/`message` antes de evaluar las reglas.
- **Adjuntos a Jira sin reintento de aplicación**: `gestionarReporteRVTools` reintenta hasta 3 veces (pausa de 30s) ante error 500 de Jira al adjuntar, verificando idempotencia con `buscarAdjuntoEnTicket` antes de cada intento.
- **`createTicketCOMAFI` sin verificación de adjunto pre-existente**: ahora confirma contra la API de Jira antes de reportar fallo, evitando adjuntos duplicados en reintentos.
- **Mensajes de Slack sin cliente identificado**: los errores de `gestionarReporteRVTools` ahora incluyen el nombre del cliente y el ticket afectado.
- **Rango de lectura incorrecto en `SubirReportesADrive.js`**: el rango de la hoja de clientes era `A2:C` pero se leía la columna D (`projectKey`), que siempre daba `undefined` y desactivaba el cierre automático de tareas programadas. Corregido a `A2:D`.
- **Llamada inválida a `generarReporteConsumoVsphere()`**: se invocaba sin el `opsKey` requerido en `EnvioMailTecnologias.js`, por lo que nunca procesaba nada. Se retiró la llamada rota.
- **`diagnosticarEncabezadosDeReporte()` inutilizable**: dependía de `SpreadsheetApp.getUi()`, que solo funciona invocado desde un menú de hoja (nunca estuvo enganchado a ninguno). Ahora acepta el nombre de operación como parámetro y funciona ejecutada directamente desde el editor.

### Changed
- **Consumo de cuota de Gmail fuera de horario**: los triggers 24/7 (`organizarReportesEnDrive`, `processProxyAlarms`) ahora verifican `dentroDeVentanaOperativa()` (05:00–15:00 hora Argentina) al inicio y cortan la ejecución fuera de esa ventana.
- **API mixta de comentarios de Jira unificada**: `addCommentToJiraTicket` pasó de la Service Desk API (body string) a la API v3 con formato ADF, marcado como comentario interno. Esto alinea el escritor con `haSidoActualizadoHoy` (que ya leía vía v3), evitando que el marcador anti-duplicado `[AUTO-UPDATE]` se pierda por el desajuste de formato.
- **Log spam en Proxies de Veeam**: los correos descartados por formato no reconocido ahora se acumulan y se resumen en un único log en vez de uno por correo.

### Removed
- Función de testing `hola()` en `RVTools_Main.js`, reemplazada por herramientas manuales explícitas en `custom/HerramientasManuales.js` (`manual_RVToolsTesting`, `manual_runAllTests`, `manual_probarHorarioOperativo`, etc).
- `configurarEntornoDeTesting()` en `Debug.js`: sobrescribía Script Properties reales con valores placeholder (`REDACTED_...`) resultantes de un pase de redacción de secretos anterior; ya no era funcional y representaba un riesgo de corromper la configuración productiva si se ejecutaba por error.

### Testing
- Suite de tests ampliada (`tests/TestRunner.js`): casos adicionales para `normalizarEncabezado`/`isRowExcepted` con valores "sucios" (mayúsculas, espacios extra, guiones), cobertura del fix de excepciones de Zombies, del formato ADF de comentarios y de la ventana operativa.

## [2.0.0] - 2026-07-23
### Added
- **Auditoría Final (v2.0)**: Ejecución de todas las mejoras de auditoría.
- **Caché Persistente Jira**: Implementación de `CacheService` nativo para Request Types de Jira (6 horas de expiración), reduciendo tiempos de latencia y llamadas API.
- **Optimización Gmail**: Las consultas a Gmail (búsqueda de `[OPS-PENDIENTE]`) fueron extraídas de los módulos individuales hacia `MailUtils.js`, reduciendo a **1 única llamada de búsqueda por ciclo de ejecución**. El filtrado ahora se maneja en memoria RAM.
- **TimeGuard Integrado**: En tickets que requieren espera asíncrona de estado (ej. Jira transitions), se pasa la instancia global de TimeGuard para prevenir la muerte del trigger de Apps Script de forma abrupta si llega al límite de 30 minutos.
- **Centralización Auth**: Todos los módulos consumen las cabeceras de Jira desde una única función global `getJiraHeaders()`.
- **TestRunner**: Nueva suite de tests básicos unitarios para validación de helpers y funciones puras (`_parseAndValidateExceptions`, `escapeJiraWikiText`, etc).
- **Template Method `handleAlerts`**: Abstracción del flujo de creación/actualización de tickets en `MailProcessor.js`. Reducción masiva de código duplicado.

### Fixed
- **Sanitización Jira**: Corrección del pipeline de parseo de CSV/Excel (`escapeJiraWikiText`) transformando los pipes `|` a guiones `-` para evitar romper las tablas wiki en Jira.
- **Envío Múltiple**: Reparado bucle de paginación de correos que excedía los 1000 caracteres de Query.

### Security
- **Hardcode de Tokens**: Tokens y URLs de webhooks extraídas del código productivo mediante el nuevo mapa seguro de secretos (`secrets_mapping.md`).
- **Safeguard testing**: Reglas defensivas para evitar envíos de Slack o modificaciones Jira si la variable `ENVIRONMENT` no está en "PRODUCCION".
- **Dynamic Eval**: Control seguro de ejecución dinámica de triggers desde la lista de tareas en `Main.js`.
