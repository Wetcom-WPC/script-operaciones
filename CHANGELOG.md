# CHANGELOG - Ops Playground / Ops Operativo (v2.0)

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
