# ⚠️ Rama de BACKUP — no es código vigente

Esta rama guarda el **código de producción anterior al refactor v2.0** (el monolito plano:
`FuncionesCompartidas.js`, `Logging.js`, `Main.js`, …). Existe solo como respaldo histórico.

**El código vigente está en `main` (producción) y `refactor-operaciones` (Playground).**

## Por qué esta rama no tiene `.clasp.json`

Se quitó a propósito el 27/07/2026.

Hasta esa fecha, esta rama incluía un `.clasp.json` que apuntaba al proyecto de
**PRODUCCIÓN**:

```
scriptId: 1wVCbInNTiICrLfn57O07d1ZYxHCzHcN7MxwM0B-m1GfeZmN5j4_MGErN
```

Eso la convertía en una trampa: bastaba con hacer checkout de esta rama en cualquier carpeta
y correr `clasp push` para subir el monolito legacy **encima del código actual de producción**.

Eso fue exactamente lo que pasó el **27/07/2026**: producción amaneció con 118 archivos (el
v2.0 más el legacy re-subido en la raíz). Como en Apps Script todos los archivos comparten el
scope global, quedaron **243 colisiones de `const`/`class`** → `Identifier has already been
declared` → el proyecto **no compilaba y no se ejecutaba nada**: ni las operaciones, ni los
tickets de Jira, ni la subida de reportes a Drive.

Sin `.clasp.json`, un `clasp push` desde acá ahora falla de entrada y no toca nada.

## Si alguna vez hay que restaurar este código

No hagas `clasp push` desde esta rama. El procedimiento correcto es:

1. Confirmá contra qué proyecto vas a pushear:
   ```bash
   grep scriptId .clasp.json
   ```
   Hacelo **siempre**, en cualquier carpeta, antes de cualquier `clasp push`.
2. Copiá los archivos que necesites a la carpeta del proyecto destino, que ya tiene su propio
   `.clasp.json` correcto (`Ops Operativo/` = producción, `Ops Playground/` = staging).
3. Verificá que no queden archivos huérfanos del código anterior: si conviven dos estructuras
   (raíz plana + subcarpetas), vas a tener declaraciones duplicadas y el proyecto entero deja
   de compilar. Compará la lista de archivos local contra la del proyecto en GAS antes de subir.

## Regla general

**Nunca `clasp push` a `Ops Operativo` / `Indice Operativo` sin autorización explícita**: son
producción y cualquier error impacta a la Mesa de Ayuda en vivo (tickets de Jira, correos a
clientes y PODs, Slack).
