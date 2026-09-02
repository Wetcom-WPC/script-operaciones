#!/usr/bin/env bash
#
# Despliegue a Apps Script CON trazabilidad.
#
# POR QUÉ EXISTE ESTE SCRIPT
# `clasp push` escribe únicamente sobre el BORRADOR del proyecto (el "head"). No deja
# ninguna marca en el Project History del editor. El 29/07/2026 se descubrió que una
# jornada entera de cambios en producción figuraba solo como "Current version", sin forma
# de saber qué se había desplegado ni cuándo, ni a qué punto volver. Las versiones son
# inmutables: son el único registro real y el único rollback posible.
#
# Por eso acá `push` y `create-version` van juntos y la descripción es OBLIGATORIA.
#
# USO
#   ./deploy.sh "Nicolas - descripcion corta de que se desplega"
#
# El prefijo con el nombre es la convención que ya venía usando el equipo
# (ver `clasp list-versions`).

set -euo pipefail

# --- 1. Descripción obligatoria -------------------------------------------------------
if [ $# -lt 1 ] || [ -z "${1// /}" ]; then
  echo "ERROR: falta la descripción de la versión."
  echo ""
  echo "  Uso: ./deploy.sh \"Nicolas - que se esta desplegando\""
  echo ""
  echo "No es burocracia: sin descripción, la versión queda como \"No description\" en el"
  echo "Project History y no sirve para rastrear nada (ya hay varias así en producción)."
  exit 1
fi
DESCRIPCION="$1"

cd "$(dirname "$0")"

# --- 2. Mostrar contra QUÉ proyecto se va a pushear -----------------------------------
# El scriptId es la única diferencia entre Playground y producción, y confundirlos ya
# provocó un incidente (27/07/2026: se re-subió código legacy a producción). Se muestra
# siempre, y si es producción se pide confirmación escrita.
SCRIPT_ID=$(grep -oE '"scriptId"[^,]*' .clasp.json | cut -d'"' -f4)
ID_PRODUCCION="1wVCbInNTiICrLfn57O07d1ZYxHCzHcN7MxwM0B-m1GfeZmN5j4_MGErN"

echo "Proyecto : $(basename "$PWD")"
echo "scriptId : ${SCRIPT_ID}"
echo "Versión  : ${DESCRIPCION}"
echo ""

if [ "$SCRIPT_ID" = "$ID_PRODUCCION" ]; then
  echo "*** ESTO ES PRODUCCIÓN (Ops Operativo) ***"
  printf 'Escribí exactamente PRODUCCION para continuar: '
  read -r CONFIRMACION
  if [ "$CONFIRMACION" != "PRODUCCION" ]; then
    echo "Cancelado. No se pusheó nada."
    exit 1
  fi
  echo ""
fi

# --- 3. GitHub primero, GAS después ---------------------------------------------------
# Si dos personas despliegan casi al mismo tiempo, la que llega segunda tiene que
# enterarse ANTES de escribir en Apps Script, no después. Por eso el push a GitHub va
# primero: si lo rechaza porque el remoto tiene commits que no tenés en local, es señal
# de que alguien ya desplegó desde acá — seguir pisaría ese trabajo. GitHub y GAS quedan
# sincronizados porque, si uno falla, el otro tampoco se toca.
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: hay cambios sin commitear. Commiteá antes de desplegar — si no, clasp push"
  echo "subiría a Apps Script código que git todavía no tiene, y quedan desincronizados."
  exit 1
fi

echo "Sincronizando con GitHub..."
if ! git push origin HEAD; then
  echo ""
  echo "ERROR: GitHub rechazó el push (el remoto tiene commits que no tenés en local,"
  echo "probablemente alguien más ya desplegó desde acá). NO se tocó Apps Script."
  echo "Traé los cambios (git pull) y volvé a correr ./deploy.sh."
  exit 1
fi
echo "GitHub OK."
echo ""

# --- 4. Chequeo de sintaxis antes de subir --------------------------------------------
# Apps Script no valida hasta que algo se ejecuta: un error de sintaxis pusheado a
# producción puede quedar latente hasta el ciclo de la mañana siguiente. `node --check`
# sólo parsea (no ejecuta), que es exactamente lo que hace falta.
if command -v node >/dev/null 2>&1; then
  ERRORES=0
  while IFS= read -r -d '' ARCHIVO; do
    if ! node --check "$ARCHIVO" >/dev/null 2>&1; then
      echo "ERROR DE SINTAXIS: ${ARCHIVO}"
      ERRORES=$((ERRORES + 1))
    fi
  done < <(git ls-files -z '*.js')

  if [ "$ERRORES" -gt 0 ]; then
    echo ""
    echo "Se encontraron ${ERRORES} archivo(s) con errores de sintaxis. NO se pusheó nada."
    exit 1
  fi
  echo "Sintaxis OK."
else
  echo "AVISO: node no está disponible, se omite el chequeo de sintaxis."
fi

# --- 5. Declaraciones duplicadas ------------------------------------------------------
# En Apps Script todos los archivos comparten un scope global: un const/let/class repetido
# entre dos archivos rompe el proyecto ENTERO al cargar, no sólo el archivo culpable
# (ver AGENTS.md §4). Es barato chequearlo y caro descubrirlo en producción.
#
# Se enumera con `git ls-files` y no con `grep -r .` / `find .` a propósito: esas dos formas
# recorren TODO lo que cuelgue del directorio, incluidas copias del propio repo que no se
# despliegan (por ejemplo `.claude/worktrees/`, un worktree de git ignorado). Cada archivo
# copiado hacía que toda declaración apareciera "duplicada" contra sí misma: el 02/09/2026
# este chequeo reportaba 320 duplicados inexistentes y dejaba `deploy.sh` inutilizable.
# `git ls-files` lista exactamente los archivos versionados, que son los que `clasp push`
# sube; y como arriba ya se exige el árbol limpio, coincide con lo que hay en disco.
DUPLICADOS=$(git ls-files -z '*.js' | xargs -0 grep -hoE "^(const|let|class) +[A-Za-z0-9_]+" | sort | uniq -d || true)
if [ -n "$DUPLICADOS" ]; then
  echo ""
  echo "ERROR: declaraciones duplicadas en el scope global. NO se pusheó nada:"
  echo "$DUPLICADOS" | sed 's/^/  /'
  exit 1
fi
echo "Sin declaraciones duplicadas."
echo ""

# --- 6. Push + versión ----------------------------------------------------------------
echo "Pusheando..."
clasp push --force

echo ""
echo "Creando versión inmutable..."
clasp create-version "$DESCRIPCION"

echo ""
echo "Últimas versiones:"
clasp list-versions | tail -3

echo ""
echo "Listo. GitHub y Apps Script quedaron sincronizados (GitHub se actualizó antes de tocar GAS)."
