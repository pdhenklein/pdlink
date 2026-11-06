#!/bin/bash
# Monta a versao para distribuir em F:/Discord2/package/release
# Uso: bash build-package.sh   (a versao vem do arquivo VERSION)
set -e
cd "$(dirname "$0")"
PKG="$(pwd)"
VER="$(tr -d ' \r\n' < VERSION)"
OUT="$PKG/out"
REL="$PKG/release"

rm -rf "$OUT" "$REL"
mkdir -p "$REL"

# 1. Vencord enxuto: so o GoLive P2P e o nucleo, sem atualizador do Vencord
(cd ../Vencord && GOLIVE_ONLY=goLiveP2P GOLIVE_OUT="$OUT" npx --yes pnpm@12.15.0 build --standalone --disable-updater >/dev/null)

# 2. pagina de assistir com decodificacao por hardware
(cd ../Vencord && npx --yes esbuild src/userplugins/goLiveP2P/viewer-hw-entry.ts --bundle --format=iife --minify --outfile=src/userplugins/goLiveP2P/viewer-hw.js --log-level=warning)

cp "$OUT/patcher.js" "$OUT/preload.js" "$OUT/renderer.js" "$OUT/renderer.css" "$REL/"
cp ../Vencord/src/userplugins/goLiveP2P/viewer.html ../Vencord/src/userplugins/goLiveP2P/viewer-hw.js "$REL/"
cp ../helper/bin/golive-helper-p8.exe "$REL/golive-helper.exe"
printf "%s" "$VER" > "$REL/version.txt"

# 3. carregador que fica no lugar do app.asar do Discord
npx --yes @electron/asar@3.2.17 pack shim "$REL/golive-shim.asar"

# 4. instalador
cp installer/bin/Instalar-GoLiveP2P.exe "$REL/" 2>/dev/null || echo "AVISO: instalador ainda nao compilado"

echo "versao $VER pronta em $REL"
ls -la "$REL"
