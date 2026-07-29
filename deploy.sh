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

# --- 3. Chequeo de sintaxis antes de subir --------------------------------------------
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
  done < <(find . -name "*.js" -not -path "./.git/*" -print0)

  if [ "$ERRORES" -gt 0 ]; then
    echo ""
    echo "Se encontraron ${ERRORES} archivo(s) con errores de sintaxis. NO se pusheó nada."
    exit 1
  fi
  echo "Sintaxis OK."
else
  echo "AVISO: node no está disponible, se omite el chequeo de sintaxis."
fi

# --- 4. Declaraciones duplicadas ------------------------------------------------------
# En Apps Script todos los archivos comparten un scope global: un const/let/class repetido
# entre dos archivos rompe el proyecto ENTERO al cargar, no sólo el archivo culpable
# (ver AGENTS.md §4). Es barato chequearlo y caro descubrirlo en producción.
DUPLICADOS=$(grep -rhoE "^(const|let|class) +[A-Za-z0-9_]+" --include=*.js . | sort | uniq -d || true)
if [ -n "$DUPLICADOS" ]; then
  echo ""
  echo "ERROR: declaraciones duplicadas en el scope global. NO se pusheó nada:"
  echo "$DUPLICADOS" | sed 's/^/  /'
  exit 1
fi
echo "Sin declaraciones duplicadas."
echo ""

# --- 5. Push + versión ----------------------------------------------------------------
echo "Pusheando..."
clasp push --force

echo ""
echo "Creando versión inmutable..."
clasp create-version "$DESCRIPCION"

echo ""
echo "Últimas versiones:"
clasp list-versions | tail -3

echo ""
echo "Listo. Acordate de commitear y pushear a GitHub para que el código y el"
echo "historial de Apps Script cuenten la misma historia."
