# AGENTS.md — Guía de trabajo para agentes de IA y colaboradores

Este documento es el acuerdo de trabajo para cualquier agente de IA (o persona) que
edite código en este repositorio. Para arquitectura y componentes, ver
[`README.md`](README.md). Para el historial de cambios, [`CHANGELOG.md`](CHANGELOG.md).
Este archivo es sobre **cómo trabajar acá sin romper producción** — y por qué,
con ejemplos reales de incidentes de este proyecto.

---

## 1. Qué es esto

Automatización de la Mesa de Ayuda (Soporte Operativo) de WETCOM en Google Apps
Script: procesa correos con reportes de infraestructura (vSphere, Veeam, vROps,
Horizon, RVTools, Tanzu), evalúa reglas de excepción por cliente, y gestiona
tickets en Jira Service Management. Corre 100% dentro del ecosistema de Google
(Gmail, Sheets, Drive) vía `clasp`, sin servidor propio.

## 2. Mapa del repositorio — leer esto ANTES de tocar nada

Este único repositorio de GitHub (`script-operaciones`) contiene **cuatro
proyectos de Apps Script independientes**, cada uno viviendo en su propia
carpeta local con su propio `.clasp.json` (su propio scriptId):

| Carpeta local | Rama de git | Entorno |
|---|---|---|
| `Ops Operativo/` | `main` | 🔴 **PRODUCCIÓN** |
| `Ops Playground/` | `refactor-operaciones` | Staging |
| `Indice Operativo/` | `indice-operativo` | 🔴 **PRODUCCIÓN** |
| `Indice Playground/` | `indice-playground` | Staging |

**`Ops Operativo/` y `Ops Playground/` son cada una su propio checkout git**,
fijo en su rama (nunca hace falta `git checkout` para cambiar de proyecto: cada
carpeta ya está en la rama que le corresponde). El árbol de cada rama es
**plano** — refleja 1:1 lo que ves en el editor de Apps Script, sin carpeta
contenedora. Si algún día ves `Ops Operativo/` como subcarpeta *dentro* del
árbol de `main`, algo se rompió en la estructura: avisar antes de seguir.

`Indice Operativo/` e `Indice Playground/` **no** son checkouts git activos:
son carpetas de trabajo normal para `clasp`, con un backup versionado en las
ramas `indice-operativo` / `indice-playground` (actualizar ese backup a mano
cuando corresponda — no hay automatización todavía).

### Ramas que NO se deben tocar

- `backup-real-prod`: snapshot de un estado anterior de producción, para
  rollback. No es para trabajar ahí.
- `refactor`, `backup-prod-20260723`: ramas históricas **con secretos reales
  sin censurar en su historial de commits** (tokens de Atlassian, webhooks de
  Slack). GitHub bloqueó el push la primera vez que se intentó por push
  protection. **Nunca hacer merge, rebase ni cherry-pick desde estas ramas
  hacia `main` o `refactor-operaciones`** sin antes limpiar el historial —
  arrastrarían los secretos.

## 3. Las dos reglas que no se negocian

### Regla 1 — Nunca `clasp push` a producción sin aprobación humana explícita

"Producción" es `Ops Operativo/` e `Indice Operativo/`. Un agente puede
preparar, verificar y dejar el cambio listo, pero el push final a esos dos
proyectos requiere que una persona lo confirme explícitamente en esa
conversación. Esto aplica *siempre*, incluso en medio de un incidente activo:
mejor una demora de un minuto pidiendo confirmación que un segundo incidente
encima del primero.

### Regla 2 — Siempre `clasp pull` antes de editar

El equipo edita seguido directo desde el editor de Apps Script en el
navegador. Si no se hace `clasp pull` antes de tocar código, se corre el
riesgo de pisar un cambio hecho ahí. Esto vale para **las cuatro carpetas**,
no solo para Operativo.

## 4. La trampa que ya rompió producción una vez — scope global de Apps Script

**Todos los archivos `.js`/`.gs` de un mismo proyecto de Apps Script comparten
un único scope global.** No hay módulos, no hay imports: dos archivos
declarando el mismo `const` o `class` a nivel superior es un error fatal
(`Identifier 'X' has already been declared'`) que impide que el proyecto
**entero** compile. Nada se ejecuta — ni siquiera las funciones que no tienen
relación con la colisión.

Esto ya pasó: el 27/07/2026 producción quedó con el código v2.0 (`core/`,
`vsphere/`, etc.) **más** un árbol de código legacy re-subido en la raíz, con
**243 declaraciones duplicadas**. El proyecto dejó de compilar, y el síntoma
visible fueron docenas de errores sueltos en Slack (columnas no encontradas,
tickets no creados) que no tenían relación aparente entre sí — la causa real
era que nada corría en absoluto.

**Antes de cualquier `clasp push`, verificar que no haya declaraciones
top-level duplicadas entre archivos.** Forma rápida de auditar:

```bash
grep -hoE "^(const|let|class) +[A-Za-z0-9_]+" *.js **/*.js | sort | uniq -d
```

Si aparece algo, hay una colisión real. Ninguna salida = seguro para pushear.

## 5. El otro patrón que rompió cosas dos veces — lógica duplicada

El 27/07/2026 hubo un segundo incidente, distinto: la detección del separador
de CSV estaba escrita en dos lugares (`DataProcessingService.js` y
`MailProcessor.js`). Alguien arregló uno y el otro, sin saberlo, **anulaba el
fix**. El síntoma (`Columna X no encontrada` en todas las operaciones) no
apuntaba para nada a la causa real.

**Regla práctica: si una pieza de lógica (parseo, detección de columnas,
normalización) tiene más de una copia en el código, es un bug latente, no una
casualidad.** Antes de "arreglar" algo, buscar si existe en otro lado:

```bash
grep -rn "nombre_de_la_función_o_patrón" --include="*.js" .
```

Si aparece duplicado, centralizar en una sola función y hacer que el resto la
llame, no reimplementarla. Los puntos ya centralizados hoy (no reabrirlos):

- **Separador de CSV / parseo de reportes**: `detectarSeparadorCsv()` y
  `parseCsvDeReporte()` en `core/DataProcessingService.js`.
- **Normalización de encabezados / alias de columnas**: `normalizarEncabezado()`
  y el mapa `COLUMN_ALIASES` en el mismo archivo.
- **Cabeceras de autenticación de Jira**: `getJiraHeaders()` en
  `core/JiraService.js`.

## 6. El patrón de bug más frecuente de este proyecto — nombres de columna en español vs. inglés

Varias veces la causa de "las excepciones no se aplican" fue el mismo
problema: el reporte trae una columna en español (`Particion`, `Object`) y el
Excel de excepciones del cliente la referencia en inglés (`Partition`,
`name`). Sin alias entre ambas, la regla de excepción nunca encuentra la
columna y **se descarta en silencio** — no rompe nada, simplemente deja de
filtrar, que es mucho más difícil de notar que un error.

Si una regla de excepción "no funciona" para un cliente puntual: comparar el
nombre exacto de columna del Excel de excepciones contra los encabezados
reales del reporte (correr `manual_diagnosticarEncabezados` o revisar el log
de `[ZombieDebug]` si aplica), y agregar el alias que falte en
`COLUMN_ALIASES` en vez de tocar la lógica de cada operación.

## 7. Jira: fallos silenciosos por diseño anterior (ya se está corrigiendo)

Varias funciones de integración con Jira devuelven `{status: 'FAILURE'}` sin
loguear el motivo, y la mayoría de los llamadores descartan ese resultado. Un
cierre de ticket que nunca ocurrió es indistinguible en el log de uno
exitoso. `resolveJiraTicket()` (`core/JiraService.js`) ya fue corregida para
loguear el motivo concreto (ej. "no existe transición hacia el estado
configurado") — si se toca otra función de este estilo, aplicar el mismo
criterio: nunca fallar en silencio.

`JIRA_STATUS_TO_CLOSE` (`core/ConfiguracionGlobal.js`) debe coincidir
EXACTAMENTE con el nombre del estado destino en Jira. Si varía entre
proyectos, hay que resolverlo ahí, no asumir un único nombre global.

## 8. Nunca cerrar tareas programadas en bloque sin evidencia

`custom/HerramientasManuales.js` tiene `manual_cerrarTareasProgramadas()`.
**No modificar su lógica para que cierre "todo lo que esté abierto".** La
primera versión hacía eso y, probada en simulación contra producción, iba a
cerrar 164 tickets — incluyendo pedidos de clientes en curso, tickets
`[INTERNO]` y mantenimientos manuales que nadie había hecho.

La versión correcta exige tres condiciones antes de cerrar algo:
1. La tarea está en `TAREAS_QUE_CIERRA_LA_AUTOMATIZACION` (lista explícita).
2. Está en estado `Pendiente de Ejecución` (no "En Ejecución": puede ser
   trabajo real en curso).
3. Hay evidencia de que el reporte correspondiente se procesó hoy (hilo de
   Gmail con `[OPS-PROCESADO]` del remitente de ese cliente).

Cualquier automatización nueva que module estado en Jira/Sheets a partir de
"lo que está pendiente" debe exigir evidencia positiva de que corresponde
actuar, no asumir que todo lo pendiente hay que resolverlo.

## 9. Secretos

- Los tokens/webhooks se configuran en **Script Properties** de cada
  proyecto de Apps Script (`Configuración del Proyecto → Propiedades de la
  Secuencia de Comandos`), nunca hardcodeados en el código.
- `custom/Debug.js` tuvo una función (`configurarEntornoDeTesting`, ya
  eliminada) que sobrescribía Script Properties reales con valores
  placeholder. Si aparece algo similar (una función que hace
  `setProperties()` con valores literales en el código), tratarlo como una
  bandera roja: o son secretos reales expuestos, o es un placeholder que
  puede corromper la configuración productiva si se ejecuta por error.
- Antes de cualquier commit a git, escanear el diff por patrones de secreto
  (tokens de Atlassian, webhooks de Slack, `Basic <base64 largo>`). GitHub
  push protection es la última red, no la primera.

## 10. Flujo de trabajo y despliegue

1. Trabajar en `Ops Playground/` (rama `refactor-operaciones`). `clasp pull`
   antes de editar.
2. Validar: correr `manual_runAllTests()` desde el editor de Apps Script
   (suite en `tests/TestRunner.js`). Todo fix de bug debería sumar un test de
   regresión ahí, no solo la corrección.
3. Con la aprobación del usuario, promover a producción:
   - `clasp pull` en `Ops Operativo/` primero (por si hubo cambios desde el
     navegador).
   - Copiar solo los archivos que cambiaron (no todo el árbol a ciegas).
   - Verificar sintaxis (`node --check archivo.js` sirve como chequeo rápido
     aunque el runtime real sea Apps Script V8) y ausencia de declaraciones
     duplicadas (sección 4).
   - `clasp push` — **solo con confirmación explícita del usuario**.
   - `clasp pull` de vuelta a una carpeta de verificación aparte y comparar
     contra lo que se pusheó, para confirmar que llegó como se esperaba.
4. Commitear y pushear a `main`/`refactor-operaciones` en GitHub para dejar
   registro. Mensajes de commit multilínea: usar heredoc de bash
   (`git commit -m "$(cat <<'EOF' ... EOF)"`), nunca sintaxis de PowerShell
   (`@'...'@`) en un entorno bash — genera un commit con basura literal.

## 11. Herramientas manuales

`custom/HerramientasManuales.js` centraliza funciones de ejecución rápida
desde el editor de Apps Script (prefijo `manual_`): correr tests, probar un
flujo puntual, forzar un trigger fuera de horario, auditar/cerrar tareas
programadas. Si se necesita una función de diagnóstico o testing ad-hoc,
agregarla ahí en vez de crear un archivo nuevo suelto.
