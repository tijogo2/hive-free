#!/usr/bin/env bash
# build.sh - regera install.sh e install.ps1 (payload embutido) a partir de src/free-hive.
# Alternativa ao build.ps1 para quem mantem o repo em Linux/macOS.
#
# Uso: ./build.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
SRC="$ROOT/src/free-hive"
DIST="$ROOT/dist"
B64="$DIST/payload.b64"

[ -f "$SRC/index.ts" ] || { echo "Fonte nao encontrada: $SRC/index.ts" >&2; exit 1; }

mkdir -p "$DIST"
ZIP="$DIST/free-hive-$VERSION.zip"
rm -f "$ZIP" "$ZIP.sha256" "$B64"

# zip com free-hive/ como raiz (zip usa '/' nos caminhos)
make_zip() {
  if command -v zip >/dev/null 2>&1; then
    ( cd "$ROOT/src" && zip -q -X -r "$ZIP" free-hive )
    return
  fi
  if python3 -c 'import zipfile' >/dev/null 2>&1; then
    python3 - "$ROOT/src" "$ZIP" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            rel = os.path.relpath(full, src).replace(os.sep, '/')
            z.write(full, rel)
PY
    return
  fi
  if command -v powershell.exe >/dev/null 2>&1; then
    echo "Sem 'zip'/'python3' - delegando para build.ps1 (Windows)."
    ( cd "$ROOT" && powershell.exe -NoProfile -ExecutionPolicy Bypass -File build.ps1 )
    exit $?
  fi
  echo "Preciso de 'zip' ou 'python3' para empacotar (ou rode ./build.ps1 no Windows)." >&2
  exit 1
}

make_zip

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$DIST" && sha256sum "free-hive-$VERSION.zip" > "free-hive-$VERSION.zip.sha256" )
else
  ( cd "$DIST" && shasum -a 256 "free-hive-$VERSION.zip" > "free-hive-$VERSION.zip.sha256" )
fi

base64 < "$ZIP" > "$B64"

build_one() {
  local tmpl="$1" out="$2" eol="$3"
  sed -e "/__FREEHIVE_B64_PAYLOAD__/r $B64" -e '/__FREEHIVE_B64_PAYLOAD__/d' "$tmpl" \
    | sed "s/__VERSION__/$VERSION/g" > "$out"
  if [ "$eol" = "crlf" ]; then
    sed -i 's/$/\r/' "$out"
  fi
}

build_one "$ROOT/templates/install.ps1.tmpl" "$ROOT/install.ps1" crlf
build_one "$ROOT/templates/install.sh.tmpl"  "$ROOT/install.sh"  lf
chmod +x "$ROOT/install.sh"
rm -f "$B64"

echo "FreeHive build $VERSION"
echo "zip   : dist/free-hive-$VERSION.zip ($(( $(wc -c < "$ZIP") / 1024 )) KB)"
echo "sha256: $(cut -d' ' -f1 "$ZIP.sha256")"
echo "ps1   : install.ps1 ($(( $(wc -c < "$ROOT/install.ps1") / 1024 )) KB)"
echo "sh    : install.sh ($(( $(wc -c < "$ROOT/install.sh") / 1024 )) KB)"
echo
echo "OK. Commit install.ps1 / install.sh e publique (publish.ps1 ou git push + tag)."
