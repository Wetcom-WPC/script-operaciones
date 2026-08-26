# Panel web de Operaciones

WebApp de Apps Script que da al equipo dos cosas que antes necesitaban acceso a
`alarmas@wetcom.com`: **lanzar el ciclo de operaciones a mano** y **ver en qué estado quedó
cada reporte del día**.

## Por qué existe

Los reportes llegan a `alarmas@wetcom.com`, buzón al que solo acceden el Tech Lead y el SDM.
En Apps Script, ejecutar una función a mano la corre **sobre el Gmail de quien la ejecuta**:
si alguien más quería disparar un ciclo fuera de horario, tenía que esperar a que una de esas
dos personas estuviera disponible.

Una WebApp desplegada con `executeAs: USER_DEPLOYING` y publicada **por la cuenta de alarmas**
corre siempre sobre esa casilla, sin importar quién apriete el botón. El acceso al buzón deja
de ser un cuello de botella sin repartir la contraseña ni sumar delegados.

## Qué hace

| Acción | Qué pasa |
|---|---|
| **Ejecutar ciclo ahora** | Crea un activador de una sola vez para `ejecutarCicloDeOperaciones`. La página responde al instante y el ciclo corre después, sobre la casilla del deploy. **Una pasada y se detiene.** |
| **Actualizar** | Lee la bandeja del día (4 búsquedas de Gmail) y guarda la foto en `CacheService` por 6 h. Quien entre después ve esa foto sin volver a pagar el escaneo. |

## Una corrida manual no se reprograma

El ciclo automático, al terminar, se vuelve a agendar cada 5 minutos hasta `HORA_FIN`. Eso
está bien para la jornada, pero convierte un clic en el botón en un bucle que sigue todo el
día — y si se lanza pasadas las `HORA_FIN`, además re-dispara los reportes de cierre y duplica
el resumen diario en Slack.

Por eso `webapp_lanzarCiclo()` marca la corrida con la Script Property `EJECUCION_MANUAL`, y
`core/Main.js` la consume al terminar: hace el ciclo entero y para. Sin bucle de sondeo y sin
reportes de cierre.

Dos matices que importan:

- **Las continuaciones sí se mantienen.** Si el ciclo se corta por el límite de 15 minutos con
  tareas pendientes, se reprograma al minuto para terminarlas. Eso no es una repetición: es el
  mismo ciclo completándose. Cortarlo ahí dejaría reportes sin procesar en silencio.
- **Dentro de la ventana operativa se repone el bucle automático.** Al arrancar,
  `borrarActivadorTemporal()` borra *todos* los activadores del ciclo, incluido el del bucle
  automático. Si la corrida manual no lo repusiera, un clic a media mañana dejaría la
  automatización muerta hasta el activador diario del día siguiente.

Las cuatro columnas siguen el orden del pipeline, no el alfabético: **Sin leer → Pendiente →
Procesado / Error**. Cada tarjeta muestra hora, remitente, adjuntos, las etiquetas `[OPS-*]`
del hilo y, cuando aplica, el **contador de reintentos** — que es el dato que dice cuántas
vueltas le quedan a un correo `[OPS-PENDIENTE]` antes de que el ciclo lo aparte a
`[OPS-ERROR]`.

## Por qué el botón no ejecuta el ciclo directamente

Una llamada de `google.script.run` muere a los 6 minutos. El ciclo está diseñado para
encadenarse en varias ejecuciones: guarda `INDICE_SIGUIENTE_TAREA` y se reprograma solo. Si el
navegador cortara la ejecución a mitad de camino, la cadena quedaría trunca —índice a medias y
sin activador que lo retome— y el ciclo del día se detendría en seco.

Por eso el botón crea un activador, que es exactamente lo que hace el propio ciclo cuando se
reprograma (`crearNuevoActivador` en `core/Main.js`). El ciclo arranca con los 30 minutos
completos de Apps Script a disposición.

## Archivos

| Archivo | Rol |
|---|---|
| `webapp/WebApp.js` | `doGet`, permisos y las funciones que expone a `google.script.run`. |
| `webapp/BandejaService.js` | Escaneo de Gmail y caché fragmentada. |
| `webapp/Index.html` | Estructura de la página. |
| `webapp/Estilos.html` | Paleta e interfaz. |
| `webapp/Script.html` | Cliente: render y llamadas al servidor. |
| `webapp/SinAcceso.html` | Pantalla para quien no está en la lista de autorizados. |

## Configuración

En **Configuración del proyecto → Propiedades del script**:

| Propiedad | Obligatoria | Para qué |
|---|---|---|
| `WEBAPP_USUARIOS_AUTORIZADOS` | No | Emails separados por coma. Vacía o ausente = entra todo el dominio (lo que ya permite el deploy). Se cambia en caliente, sin volver a desplegar. |
| `WEBAPP_MAX_HILOS_COLUMNA` | No | Cuántos hilos lista cada columna como máximo. Default 150, techo 500 (el de `GmailApp.search`). Ver abajo. |
| `WEBAPP_ULTIMO_LANZAMIENTO` | No | La escribe el propio panel: quién lanzó el último ciclo y cuándo. No tocarla a mano. |

## El tope por columna

Cada columna lista como mucho `WEBAPP_MAX_HILOS_COLUMNA` hilos (150 por defecto). No es un
límite de Gmail —su `search` admite hasta 500— sino un techo de costo: cada hilo listado cuesta
abrir sus mensajes, adjuntos y etiquetas, y el escaneo entero tiene que caber en los 6 minutos
que dura una llamada de `google.script.run`.

En una casilla con el volumen de alarmas@, **"Sin leer" y "Procesado" chocan contra el tope casi
todos los días**. Cuando eso pasa el total es un piso, no un conteo: la columna lo muestra como
`150+` y la cinta de arriba dice cuáles quedaron cortadas.

Las dos columnas que importan para debuggear, **Error y Pendiente, no se acercan nunca** — si
alguna llegara al tope, eso ya sería el hallazgo.

Subir el tope hace el botón "Actualizar" proporcionalmente más lento. Si se necesitan conteos
exactos de las columnas de volumen, conviene antes recortar lo que se enriquece por hilo.

## Despliegue

> `Ops Operativo/` es producción: el push lo hace una persona, con el flujo de `AGENTS.md`
> (Reglas 1 a 5). Este documento describe qué hacer **una vez que el código ya está en el
> proyecto**.

1. En el editor de Apps Script del proyecto, **Implementar → Nueva implementación**.
2. Tipo: **Aplicación web**.
3. **Ejecutar como: Yo (`alarmas@wetcom.com`)** ← el paso que hace que todo esto funcione.
   Tiene que estar logueada esa cuenta al desplegar.
4. **Quién tiene acceso: Cualquier usuario de WETCOM**.
5. Autorizar los permisos que pida (Gmail, Drive, Calendar, activadores).
6. Copiar la URL `/exec` y repartirla al equipo.

Al cambiar código hay que **Implementar → Gestionar implementaciones → editar (lápiz) → Versión:
Nueva versión**. Crear una implementación nueva cambiaría la URL.

## Verificación desde el editor

`manual_probarWebApp()` (en `webapp/WebApp.js`) deja en el log la cuenta efectiva, la URL del
deploy activo y el conteo por columna, sin pasar por el navegador.

`webapp_cacheLimpiar()` borra la foto cacheada — útil si se cambia el formato de los datos.
