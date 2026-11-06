#!/bin/bash
# Publica uma versao nova do pdLink (os PCs dos amigos atualizam sozinhos).
# Uso: bash publish.sh 1.0.1 "o que mudou"
set -e
cd "$(dirname "$0")"
VER="$1"
NOTES="${2:-Melhorias e correcoes.}"
[ -z "$VER" ] && { echo "uso: bash publish.sh <versao> \"o que mudou\""; exit 1; }
printf "%s\n" "$VER" > VERSION

cmd //c installer\\build.bat >/dev/null
bash build-package.sh

# codigo-fonte no repositorio
REPO=../repo
cp ../Vencord/src/userplugins/goLiveP2P/* "$REPO/plugin/goLiveP2P/" && rm -f "$REPO/plugin/goLiveP2P/viewer-hw.js"
cp ../helper/main.cpp ../helper/guids.cpp ../helper/build.bat "$REPO/helper/"
cp build-package.sh publish.sh VERSION "$REPO/package/"
cp shim/* "$REPO/package/shim/"
cp installer/installer.cpp installer/build.bat "$REPO/package/installer/"
cp ../Vencord/scripts/build/common.mjs ../Vencord/scripts/build/build.mjs "$REPO/vencord-build/"
(cd "$REPO" && git add -A && (git diff --cached --quiet || git commit -q -m "Versao $VER") && git push -q)

gh release create "v$VER" release/* --repo pdhenklein/pdlink --title "pdLink $VER" --notes "$NOTES"
echo "publicado v$VER"
