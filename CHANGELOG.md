# CHANGELOG - Ops Playground / Ops Operativo (v2.0)

## [2.2.0] - 2026-09-02

### Deployed
- `Ops Playground` versiones 51 a 53. `Ops Operativo` versiones 30 y 31, con respaldo previo del código productivo vigente en la rama `backup-prod-20260902` (Regla 4). La promoción a producción se hizo archivo por archivo, no copiando el árbol de Playground: `vsphere/VMsConSnapshots.js` tenía en producción trabajo que el repo no tenía y se mergeó en vez de pisarse.

### Fixed
- **Un reporte podía cerrar la Tarea Programada del entorno equivocado (AVS vs. no-AVS)**. El operador `~` de JQL es difuso: buscar `"VMs con snapshots"` también devuelve `"AVS - VMs con snapshots"`. `findExistingJiraTicket()` filtraba en una sola dirección y después caía a `data.issues[0]` **sin filtrar**, así que cuando el ticket del lado buscado no estaba abierto devolvía el del lado contrario. Dejó de ser hipotético cuando "VMs con snapshots" pasó a existir de los dos lados (OBM-18502 y OBM-18503). Se parte por lado AVS antes de elegir y no se cruza esa frontera ni en la coincidencia exacta ni en el fallback; si no hay ninguno del lado buscado se devuelve `null`, porque no cerrar nada es mejor que cerrar el ticket equivocado. `buscarTareaProgramadaDelDia()` tenía el mismo agujero por vía de su `includes()` y recibió la misma guarda.
- **Los tickets de Soporte se creaban siempre con Tecnología "Veeam Backup & Replication"** (ticket real: SCB-403). `createJiraTicketForSoporte()` mandaba el valor hardcodeado en el payload, y las cuatro ramas de "soporte" de `core/ClientConfigService.js` descartaban la Tecnología del Índice Maestro. Servía cuando el único que usaba esa ruta era Jobs Veeam; dejó de servir cuando "VMs con snapshots" empezó a crear tickets de Soporte, que salían con tecnología Veeam siendo reportes de vSphere. Ahora sale de la configuración del cliente; los processors de Veeam fijan la suya explícitamente, que es donde corresponde.
- **`core/Main.js` llamaba a `registrarResumenDiario()`, que no existe**. Envuelta en `try { } catch(e) {}`, tiraba `ReferenceError` todos los días al cerrar la ventana operativa y nadie se enteraba. La migración al ExecutionLogger la había dado de baja y dejó anotado el paso pendiente en su propio encabezado; la llamada quedó. El resumen ya lo registra `_registrarEnLog()`.
- **`processEspacioRepositoriosEmails()` instanciaba una clase inexistente** (`EspacioRepositoriosProcessor`, sin el "En"). Duplicado muerto de `processRepositorySpaceEmails()`, que funciona y es la que usa el registro. No la referenciaba nadie.
- **Doble codificación UTF-8 en `custom/HerramientasManuales.js`** (245 tramos). No era cosmético: `ESTADO_TAREA_CERRABLE` valía literalmente `"Pendiente de EjecuciÃ³n"`, así que `manual_cerrarTareasProgramadas()` daba TODAS las tareas por "en un estado distinto" y no cerraba ninguna. Los encabezados que ese archivo escribe en las planillas de excepciones (`"ID de ExcepciÃ³n"`, `"VÃ¡lida hasta"`) salían corruptos, y una columna que no matchea hace que la regla de excepción se descarte en silencio. Se verificó que el cambio toca únicamente caracteres no-ASCII: cada línea modificada queda idéntica al quitarle los acentos.
- **`clasp push` estaba roto en silencio desde el 26/08**. Un worktree de git bajo `.claude/` es una copia entera del repo, y `clasp` la recorre igual: veía dos `appsscript.json` y moría con `A file with this name already exists in the current project: appsscript`. Con la vía de despliegue rota, la única forma de tocar Playground era el editor del navegador — de ahí salieron ~2900 líneas que nunca estuvieron en git y dos fixes ya commiteados que quedaron pisados. Se agrega `.claspignore`.
- **`deploy.sh` reportaba 320 duplicados inexistentes**, por el mismo motivo: enumeraba con `grep -r .` y `find .`, que entran en esas copias y hacen que toda declaración aparezca duplicada contra sí misma. Pasa a `git ls-files`. El `ci.yml` de `main` tenía el mismo problema y quedó a la par.

### Added
- **Chequeo de compilación del proyecto ENTERO** en `deploy.sh` y `ci.yml`: concatena todos los `.js` y se los da al parser. Es el único que reproduce el scope global único de Apps Script — un `const` repetido entre dos archivos no rompe a ninguno por separado y sin embargo tumba el proyecto al cargar, que es exactamente lo que dejó Playground caído horas el 02/09. No es heurístico: es el compilador.
- **Chequeo de funciones duplicadas** en `deploy.sh` y `ci.yml`. El anterior solo miraba `const/let/class`, que son las que rompen la compilación; dos `function foo()` en archivos distintos no rompen nada, la última pisa a la otra en silencio. Es el chequeo que habría detectado las tres copias de `esFeriadoHoy()` y las tres de `findTargetReportTicket()`.
- **`tests/E2ETecnologiaSoporteTest.js`**: suite E2E de 3 pasos que verifica contra Jira real la Tecnología del ticket de Soporte ya creado. Los unitarios verifican el payload que se arma; este verifica lo que Jira efectivamente guardó. Dispara la rama de Soporte de forma determinista usando los umbrales hardcodeados de `VMsConSnapshots`, sin depender de cómo esté cargada la planilla del cliente de pruebas. Avisa en pantalla si el cliente de pruebas tiene "Veeam Backup & Replication" como Tecnología, porque en ese caso el test no puede distinguir la regresión y daría PASS igual.
- **15 aserciones nuevas en `tests/TestRunner.js`**: 13 de frontera AVS con los tickets reales del caso (incluidos los dos escenarios en que la versión anterior cruzaba), y 2 de la Tecnología interceptando `fetchWithRetries`.
- **AGENTS.md**: §4 suma la trampa de las funciones duplicadas y el chequeo de compilación completa; §5 suma la sección sobre llamadas a código que ya no existe; §10 suma el criterio de promoción a producción; §12 (nueva) documenta la doble codificación UTF-8, cómo detectarla a nivel de bytes y cómo verificar que la reparación no tocó nada más.

### Changed
- Una sola copia de cada función: `esFeriadoHoy()` queda en `core/Utils.js` (había tres, y solo una logueaba el motivo cuando fallaba el calendario) y `findTargetReportTicket()` en `core/JiraService.js` (había tres, una disfrazada con el sufijo `Local` para esquivar la colisión de nombres). La detección de la frontera AVS se centraliza en `core/JiraService.js`. `TECNOLOGIA_FIELD_ID` pasa a ser una constante de módulo en vez de estar declarada dentro de tres funciones.
- `custom/Debug.js`: `arreglarVariableDeDrive()` ya no pisa una Script Property que tenga otro valor — avisa y corta (bandera roja de §9).

### Known gaps
- Al reparar el encoding quedó a la vista `"En Ánalisis"` como nombre de una transición de Jira en `custom/HerramientasManuales.js`, que parece un typo por `"En Análisis"`. Es configuración externa: hay que verificarlo contra Jira antes de tocarlo. Misma duda con el doble espacio en `"Esperando confirmación  del cliente"`.
- `Ops Operativo` tiene la misma doble codificación en `custom/HerramientasManuales.js` (200 tramos). No se reparó ahí porque las reparaciones de esta tanda van solo a Playground.
- El repo se desincroniza del proyecto vivo con facilidad: en una sola jornada dos despliegues propios fueron pisados por pushes hechos desde copias desactualizadas. `clasp push --force` no avisa que está pisando algo más nuevo; la única defensa es comparar antes de cada push.

## [2.1.0] - 2026-07-27
### Deployed
- Desplegado a producción (`Ops Operativo`) el 27/07/2026 ~19:50. Backup previo: rama `main` en GitHub (`36e48df`) + snapshot crudo local en `_archivo local/backup-prod-pre-v2.1.0-20260727`. Se preservaron el `.clasp.json` de producción y el bloque `webapp` del manifest (el manifest de Playground no lo tiene).

### Added
- **Pipeline unificado**: `ejecutarCicloDeOperaciones` absorbió a `organizarReportesEnDrive`. Los reportes se procesan y se archivan en Drive dentro del mismo ciclo, en vez de depender de un trigger aparte con ventana `newer_than` (origen del incidente del 27/07).
- **Registro único de processors** (`core/Main.js`, `obtenerRegistroDeProcesadores`): fuente única de verdad de la que salen tanto el orden de ejecución como los asuntos "reclamados". Antes eran dos listas paralelas mantenidas a mano.
- **`core/DriveReportService.js`**: concentra el archivado en Drive que vivía en `reports/SubirReportesADrive.js` (que queda como wrapper delgado).
- **`reports/ReportesSinProcessor.js`**: catch-all que corre último y archiva lo que ningún processor reclamó, para que ningún reporte se pierda en silencio al apagar el trigger viejo.
- **`veeam/VeeamOneReportes.js`**: processors de Veeam ONE (solo archivan y cierran su tarea programada).
- **Pasos declarados en `MailProcessor`** (`'tickets'` / `'drive'`): el correo solo se marca `[OPS-PROCESADO]` si TODOS los pasos declarados salieron bien.

### Fixed
- **El ciclo procesaba correos de días anteriores**: la búsqueda de Gmail no tenía filtro de fecha, así que la primera corrida del catch-all barrió el backlog desde el 24/07 hasta que el TimeGuard cortó la ejecución. Ahora los correos nuevos (`is:unread`) se limitan al día de ejecución; los reintentos ya etiquetados `[OPS-PENDIENTE]` siguen sin límite de fecha, para no abandonar un reporte que falló ayer.
- **HTTP 500 intermitente de Jira al adjuntar**: el boundary del multipart se armaba con `base64(Math.random())`, cuyo alfabeto incluye `/` y `=` — ambos son *tspecials* (RFC 2045) y son inválidos en un token sin comillas del `Content-Type`. Según qué caracteres salieran, el mismo adjunto subía bien (200) o devolvía 500. Ahora se usa un UUID en hexadecimal.
- **Tareas programadas cerradas sobre reportes incompletos**: `buscarYCerrarTareaProgramada` ahora se niega a cerrar la tarea si el correo ya tiene pasos fallidos. Cerrarla igual rompía el reintento: la corrida siguiente la encontraba cerrada → `NOT_FOUND` (terminal) → el correo terminaba en `[OPS-ERROR]` para siempre, aunque el 500 fuera pasajero. La guarda es central porque ~20 processors la llaman sin mirar el resultado del paso anterior.

### Known gaps
- El catch-all archiva también correos que no son reportes (invitaciones de calendario, minutas, adjuntos sueltos de hilos internos). Pendiente acotar el criterio.
- De los 31 processors, la validación del 27/07 solo ejercitó 3 con correos reales (snapshots, VMs protegidas, catch-all); el resto corrió contra cero correos.

## Housekeeping - 2026-07-24
- **Reestructuración de repositorio (sin cambios de código)**: `main` pasó a reflejar 1:1 el contenido del proyecto de Apps Script `Ops Operativo` (sin carpeta contenedora), para que el árbol de GitHub sea fiel al editor de GAS. La rama `refactor-operaciones` cumple el mismo rol como espejo de `Ops Playground`. Se retiró el árbol de código legacy pre-refactor que quedaba duplicado en la raíz (ver commit `chore: retirar estructura legacy pre-refactor de la raiz`). `backup-real-prod` se limpió con el mismo criterio.

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
