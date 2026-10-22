#!/usr/bin/env bash
# Packs one module into dist/<id>-<version>.tgz with the platform's own command and prints its SHA-256.
# Usage: npm run pack -- <module-id>      (the platform checkout is ../CRM Module, or $MODUNEXO_PLATFORM)
set -euo pipefail
id="${1:?usage: npm run pack -- <module-id>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="${MODUNEXO_PLATFORM:-$here/../CRM Module}"
[ -f "$here/$id/package.json" ] || { echo "no module folder '$id' here" >&2; exit 1; }
version="$(node -p "require('$here/$id/package.json').version")"
mkdir -p "$here/dist"
cd "$platform"
unset DATABASE_URL
npm run -s modunexo -- modules pack "$here/$id" --out "$here/dist/$id-$version.tgz"
