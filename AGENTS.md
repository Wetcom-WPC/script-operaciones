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
| `Ops Playground/` | `ops-playground` | Staging |
| `Indice Operativo/` | `indice-operativo` | 🔴 **PRODUCCIÓN** |
| `Indice Playground/` | `indice-playground` | Staging |

**Las cuatro carpetas son, cada una, su propio checkout git**, fijo en su rama
(nunca hace falta `git checkout` para cambiar de proyecto: cada carpeta ya
está en la rama que le corresponde). El árbol de cada rama es **plano** —
refleja 1:1 lo que ves en el editor de Apps Script, sin carpeta contenedora.
Si algún día ves una de estas carpetas como subcarpeta *dentro* del árbol de
otra rama, algo se rompió en la estructura: avisar antes de seguir.

El respaldo de `Indice Operativo/` e `Indice Playground/` es el mismo flujo de
git de siempre — `commit` + `push` a `indice-operativo` / `indice-playground`
respectivamente — no un paso manual aparte que haya que acordarse de correr.
No hay ninguna diferencia de proceso contra `Ops Operativo/` / `Ops
Playground/` en este sentido.

### Sobre el nombre de la rama de Playground

Hasta el 05/08/2026 esta rama se llamó `refactor-operaciones`. Fue decisión de
equipo renombrarla a `ops-playground` (más claro, sin implicar que es un
refactor temporal). `refactor-operaciones` **ya no existe como rama remota**:
se eliminó a propósito. Si aparece referenciada en un commit viejo, un enlace
o una conversación anterior, es la misma rama — usar `ops-playground` de acá
en adelante. El estado completo de `refactor-operaciones` al momento del
rename (incluida una feature que todavía no se había traído del todo,
"Detector de Gravedad en Snapshots") quedó preservado en la rama
`backup-refactor-operaciones` y ya fue reintegrado a `ops-playground`.

**Corrección del 18/08/2026:** lo anterior daba a entender que
`refactor-operaciones` ya no existía y que todo su contenido estaba a salvo —
ninguna de las dos cosas era cierta. La rama remota siguió viva en GitHub, y
alguien siguió commiteando ahí después del rename sin saber que ya no era la
rama activa: quedaron 4 commits (fixes de Veeam para el formato ZIP/CSV de
Veeam ONE v13 y ZIPs vacíos, más la automatización completa de Nutanix
OPS-NTX-001 a 004) que nunca llegaron a `ops-playground`. Se auditó, se
trajeron 3 por `cherry-pick` (el cuarto ya estaba cubierto por un fix
equivalente) y recién entonces se borró `origin/refactor-operaciones`. Ya no
existe, ahora sí. Moraleja: antes de dar una rama vieja por "reintegrada y
borrada" en este documento, verificar con `git log <vieja>..<nueva>` — no
asumir a partir de la intención original del rename.

### Ramas que NO se deben tocar

- `backup-real-prod`, `backup-refactor-operaciones`: snapshots de un estado
  anterior, para rollback. No son para trabajar ahí.
- `refactor`, `backup-prod-20260723`: existieron como ramas locales (nunca
  llegaron a GitHub — bloqueadas por push protection por tener secretos
  reales sin censurar en su historial: tokens de Atlassian, webhooks de
  Slack) y se borraron el 18/08/2026 al confirmar que ya no hacía falta
  conservar ese código. Si reaparecen en algún checkout local viejo, mismo
  criterio: **nunca merge, rebase ni cherry-pick** desde ellas hacia `main` o
  `ops-playground` sin limpiar el historial primero — arrastrarían los
  secretos.

## 3. Las cinco reglas que no se negocian

### Regla 1 — Nunca `clasp push` a producción sin aprobación humana explícita

"Producción" es `Ops Operativo/` e `Indice Operativo/`. Un agente puede
preparar, verificar y dejar el cambio listo, pero el push final a esos dos
proyectos requiere que una persona lo confirme explícitamente en esa
conversación. Esto aplica *siempre*, incluso en medio de un incidente activo:
mejor una demora de un minuto pidiendo confirmación que un segundo incidente
encima del primero.

**Esta regla ya no depende solo de que el agente la respete.** Desde el
18/08/2026 las ramas `main` e `indice-operativo` tienen *branch protection*
en GitHub: solo `nbarlasina-wetcom` y `thiagochinabro-WETCOM` pueden pushear
ahí (directo o vía merge), con `enforce_admins` activado. Cualquier otra
cuenta — humana o un agente de IA corriendo con otras credenciales de git —
recibe un rechazo del servidor, sin importar qué le hayan indicado o qué
haya decidido hacer. Esto cierra el lado de GitHub. **El lado de Apps
Script sigue abierto**: `clasp push` habla directo con la cuenta de Google
del que lo corre y no pasa por GitHub en absoluto, así que branch
protection no lo alcanza. Falta restringir en el proyecto de Apps Script de
producción (**Compartir** → dejar Editor solo a las cuentas de confianza,
el resto en Viewer/Commenter) — es un ajuste manual en Google, ningún
agente puede hacerlo por su cuenta.

Además, desde la misma fecha cada rama corre un chequeo de GitHub Actions
(`.github/workflows/ci.yml`) con las mismas verificaciones de `deploy.sh`
(sintaxis y declaraciones duplicadas, §4) en cada push — visible como
check en GitHub independientemente de si alguien corrió `deploy.sh`
localmente. No está marcado como *required* (bloquearía los pushes directos
de Regla 5, que no pasan por PR); es una red de verificación adicional, no
un gate.

### Regla 2 — Siempre `clasp pull` antes de editar

El equipo edita seguido directo desde el editor de Apps Script en el
navegador. Si no se hace `clasp pull` antes de tocar código, se corre el
riesgo de pisar un cambio hecho ahí. Esto vale para **las cuatro carpetas**,
no solo para Operativo.

### Regla 3 — Todo push a Apps Script tiene que crear una versión

`clasp push` escribe **solo sobre el borrador** (el *head*) y no deja ninguna
marca en el Project History del editor. El 29/07/2026 se descubrió que una
jornada entera de cambios en producción figuraba únicamente como
"Current version": sin saber qué se había desplegado, ni cuándo, ni a qué punto
volver. Las versiones son inmutables y son el único rollback real que existe.

Por eso **no usar `clasp push` a secas**. Usar el script del proyecto:

```bash
./deploy.sh "Nicolas - Gire sin tickets de alerta + multi-mensaje por hilo"
```

Hace, en este orden: exige descripción → muestra el `scriptId` y pide
confirmación escrita si es producción (Regla 1) → sincroniza con GitHub
primero (Regla 5) → `node --check` de todos los `.js` → chequeo de
declaraciones duplicadas (§4) → `clasp push` → `clasp create-version`. Si algo
falla antes del push, no sube nada — ni a GitHub ni a Apps Script.

La descripción arranca con el nombre de quien despliega: es la convención que ya
venía usando el equipo (`clasp list-versions`). Nunca dejarla vacía — quedan como
"No description" y no sirven para rastrear nada (ya hay varias así en producción).

Ojo: `clasp` v3 sacó `clasp version`; ahora el comando es `clasp create-version`
(con `version` como alias).

### Regla 4 — Antes de pushear a Ops Operativo, respaldar el código productivo vigente

El código que está corriendo en producción en Apps Script **puede no coincidir
con lo último commiteado en `main`** — el equipo edita seguido directo desde
el navegador (Regla 2), y esas ediciones no siempre se bajan a git antes del
próximo despliegue. Sin un respaldo del estado REAL justo antes de pushear, un
despliegue que rompe algo no tiene forma confiable de deshacerse: "volver
atrás" significaría adivinar qué había antes.

Por eso, **siempre, sin excepción**, antes de cualquier `clasp push` o
`deploy.sh` hacia `Ops Operativo/` o `Indice Operativo/`:

1. `clasp pull` en esa carpeta a una copia limpia (no asumir que el working
   tree local ya refleja lo que hay en el editor — puede estar desactualizado).
2. Commitear ese estado, tal cual vino, en una rama de respaldo con fecha:
   `backup-prod-YYYYMMDD` (mismo patrón que `backup-prod-20260723` /
   `backup-real-prod`). Una rama nueva por respaldo, no reescribir una
   existente: así se acumula un historial de puntos de rollback reales.
3. Pushear esa rama de respaldo a GitHub **antes** de tocar el código nuevo.

Recién después de esto, seguir con el flujo normal de despliegue (sección 10).
Sin este respaldo, no se hace `clasp push` a producción — ni con aprobación
explícita del usuario (Regla 1): son dos chequeos independientes, uno no
reemplaza al otro.

### Regla 5 — GitHub y Apps Script se mantienen sincronizados: siempre se pushea a GitHub primero

Si dos personas despliegan casi al mismo tiempo (por ejemplo, alguien
trabajando directo en `Ops Playground/` mientras otro agente hace lo mismo),
la que llega segunda tiene que enterarse **antes** de escribir en Apps
Script, no después. Un `clasp push` no sabe nada de git: pisa el borrador sin
preguntar, aunque el commit que lo generó ya esté obsoleto.

Por eso `deploy.sh` ahora hace `git push` **antes** de tocar Apps Script, no
después:

1. Si hay cambios sin commitear, `deploy.sh` corta ahí — hay que commitear
   primero (si no, GitHub y GAS terminarían mostrando código distinto).
2. `deploy.sh` pushea a GitHub. Si el remoto tiene commits que el local no
   tiene (alguien ya desplegó desde acá y pusheó después que vos), GitHub
   rechaza el push, `deploy.sh` corta ahí, y **no se toca Apps Script**. El
   mensaje de error indica traer los cambios (`git pull`) y reintentar.
3. Recién si GitHub aceptó el push sigue el resto del flujo (§4, `clasp
   push`, `clasp create-version`).

Con esto, un `clasp push` a un proyecto desactualizado deja de ser posible
por accidente: falla primero en GitHub, que es más barato de resolver que
descubrirlo mirando Apps Script. Aplica a las dos carpetas con `deploy.sh`
(`Ops Operativo/` y `Ops Playground/`); `Indice Operativo/` e `Indice
Playground/` todavía no tienen `deploy.sh` (ver sección 11).

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

1. Trabajar en `Ops Playground/` (rama `ops-playground`). `clasp pull`
   antes de editar.
2. Validar: correr `manual_runAllTests()` desde el editor de Apps Script
   (suite en `tests/TestRunner.js`). Todo fix de bug debería sumar un test de
   regresión ahí, no solo la corrección.
3. Commitear los cambios en `Ops Playground/` y desplegar con
   `./deploy.sh "Nombre - qué se despliega"`. El script pushea primero a
   GitHub y recién después a Apps Script (Regla 5) — si queda algo sin
   commitear, corta ahí. Mensajes de commit multilínea: usar heredoc de bash
   (`git commit -m "$(cat <<'EOF' ... EOF)"`), nunca sintaxis de PowerShell
   (`@'...'@`) en un entorno bash — genera un commit con basura literal.
4. Con la aprobación del usuario, promover a producción:
   - Respaldar el código productivo vigente (Regla 4) — **antes** de tocar
     nada de lo que sigue.
   - `clasp pull` en `Ops Operativo/` (por si hubo cambios desde el
     navegador desde el respaldo del paso anterior).
   - Copiar solo los archivos que cambiaron (no todo el árbol a ciegas).
   - Verificar sintaxis (`node --check archivo.js` sirve como chequeo rápido
     aunque el runtime real sea Apps Script V8) y ausencia de declaraciones
     duplicadas (sección 4).
   - Commitear ese cambio en `Ops Operativo/` (mismo criterio de heredoc para
     el mensaje).
   - Desplegar con `./deploy.sh "Nombre - qué se despliega"` (ver Regla 3 y
     Regla 5), **solo con confirmación explícita del usuario** — el script
     pushea a GitHub primero y recién después a Apps Script.
   - `clasp pull` de vuelta a una carpeta de verificación aparte y comparar
     contra lo que se pusheó, para confirmar que llegó como se esperaba.

El historial de Apps Script y el de GitHub tienen que contar la misma historia:
por cada versión creada con `deploy.sh` debería haber un commit equivalente —
y ahora eso queda garantizado por el propio script (Regla 5), no solo por
convención.

## 11. Herramientas manuales

`custom/HerramientasManuales.js` centraliza funciones de ejecución rápida
desde el editor de Apps Script (prefijo `manual_`): correr tests, probar un
flujo puntual, forzar un trigger fuera de horario, auditar/cerrar tareas
programadas. Si se necesita una función de diagnóstico o testing ad-hoc,
agregarla ahí en vez de crear un archivo nuevo suelto.

`Indice Operativo/` e `Indice Playground/` todavía no tienen su propio
`deploy.sh`: los push ahí son `clasp push` directo, sin creación de versión
(Regla 3) ni sincronización GitHub-primero (Regla 5). Si se les da más uso,
portarles el mismo script que usan los proyectos Ops en vez de reinventarlo.
