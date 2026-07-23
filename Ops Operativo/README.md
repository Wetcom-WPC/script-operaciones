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
