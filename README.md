# Script Operaciones (v2.0)

Este repositorio contiene los scripts de Google Apps Script utilizados para la automatización de la Mesa de Ayuda (Soporte Operativo) de WETCOM. Se encarga de procesar correos, leer alertas de sistemas (vSphere, Veeam, vROps, Horizon) y automatizar el ciclo de vida de los tickets en Jira Service Management.

## Arquitectura

El proyecto ha sido refactorizado (v2.0) utilizando principios de programación orientada a objetos (OOP) y Patrones de Diseño (Singleton, Template Method) para maximizar la reutilización de código y la resiliencia frente a los límites de Google Apps Script.

### Componentes Principales

- **MailProcessor**: Clase base que orquesta todo el flujo (búsqueda, parsing, creación/actualización de tickets). Las operaciones individuales heredan de esta clase y solo proveen configuraciones y funciones de transformación específicas.
- **JiraService**: Manejador robusto para la comunicación con la API de Atlassian. Incluye reintentos exponenciales, caching de tipos de solicitud y paginación.
- **MailUtils**: Maneja las interacciones con Gmail optimizando el consumo de cuota mediante la técnica de "Global Thread Fetching" que concentra la búsqueda de correos pendientes al inicio del ciclo de vida del Trigger.
- **DataProcessingService**: Transforma, limpia y convierte (ej. de HTML/CSV a JSON y Excel) de manera segura para que pueda inyectarse sin errores a los tickets.
- **TimeGuard**: Protector de ejecución que interrumpe tareas de forma segura si el script está a punto de exceder el límite de 30 minutos de Workspace, guardando el progreso para la siguiente ejecución.

## Despliegue

La rama `main` contiene el código productivo. Para subir código:
1. Clonar el repositorio localmente con `clasp`.
2. Actualizar la variable `ENVIRONMENT` en las `Script Properties` a `"PRODUCCION"`.
3. Ejecutar `clasp push`.

## Seguridad y Secretos

Los tokens, contraseñas y webhooks **no** deben subirse en texto plano a GitHub. Todo token debe configurarse a través del menú de `Configuración del Proyecto -> Propiedades de la Secuencia de Comandos` en la interfaz gráfica de Google Apps Script.

Para más información, consulte `CHANGELOG.md`.
