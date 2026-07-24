# Script Operaciones (v2.0)

Este repositorio contiene los scripts de Google Apps Script utilizados para la automatización de la Mesa de Ayuda (Soporte Operativo) de WETCOM. Se encarga de procesar correos, leer alertas de sistemas (vSphere, Veeam, vROps, Horizon) y automatizar el ciclo de vida de los tickets en Jira Service Management.

## Estructura del repositorio

Este repo agrupa varios proyectos de Google Apps Script independientes, cada uno en su propia carpeta con su propio `.clasp.json` (scriptId propio):

- **`Ops Operativo/`** — **Producción.** Es el código que corre en vivo (`ENVIRONMENT=PRODUCCION`). Contiene la arquitectura v2.0 (OOP, Template Method) documentada en [`Ops Operativo/README.md`](Ops%20Operativo/README.md).
- **`Ops Playground/`** — Entorno de staging/pruebas para validar cambios antes de pasarlos a Operativo. No se trackea en git (se sincroniza vía `clasp pull`/`clasp push` directo contra su propio script de Apps Script).
- **`Indice Operativo/` / `Indice Playground/`** — Proyecto de Apps Script del Índice Maestro (hoja de configuración de clientes), independiente de Ops.
- Las carpetas sueltas en la raíz (`core/`, `rvtools/`, `vsphere/`, etc., fuera de `Ops X/`) son restos de la estructura **monolítica anterior** al split en subcarpetas. Ya no están en producción; se conservan como referencia histórica del repo, no como código activo.

Para la arquitectura y componentes principales (MailProcessor, JiraService, MailUtils, DataProcessingService, TimeGuard, etc.) ver **[`Ops Operativo/README.md`](Ops%20Operativo/README.md)**, que es la documentación autoritativa y se mantiene sincronizada con `Ops Playground/README.md`.

## Despliegue

1. Trabajar y validar los cambios en `Ops Playground/` (`clasp pull` antes de editar, `clasp push` para probar en su propio script de Apps Script).
2. Una vez validado, sincronizar el código a `Ops Operativo/` preservando su `.clasp.json` propio (scriptId de producción) y hacer `clasp push` desde esa carpeta específica.

⚠️ **Nunca ejecutar `clasp push` desde la raíz del repositorio**: el `.clasp.json` de la raíz apunta al scriptId de `Ops Playground`, y el contenido de la raíz es la estructura vieja — un push accidental ahí sobrescribiría el Playground real con código obsoleto.

## Seguridad y Secretos

Los tokens, contraseñas y webhooks **no** deben subirse en texto plano a GitHub. Todo token debe configurarse a través del menú de `Configuración del Proyecto -> Propiedades de la Secuencia de Comandos` en la interfaz gráfica de Google Apps Script.

Para el historial de cambios, consulte `CHANGELOG.md`.
