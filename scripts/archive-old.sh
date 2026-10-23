#!/usr/bin/env bash
# Keeps dist/ to the current version of a module: every other packed version <id>-<version>.tgz moves to
# versions/<id>/<version>/ with its SHA-256. Run by `npm run pack`; safe to run again.
# Usage: scripts/archive-old.sh <module-id> <current-version>      (DIST_DIR and VERSIONS_DIR override the folders)
set -euo pipefail
id="${1:?usage: archive-old.sh <module-id> <current-version>}"
current="${2:?usage: archive-old.sh <module-id> <current-version>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="${DIST_DIR:-$here/dist}"
versions="${VERSIONS_DIR:-$here/versions}"
semver='^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'

shopt -s nullglob
for file in "$dist/$id"-*.tgz; do
  name="$(basename "$file" .tgz)"
  version="${name#"$id"-}"
  [ "$version" = "$current" ] && continue
  [[ "$version" =~ $semver ]] || continue # a longer id such as <id>-pro, or a file that is not a packed version
  target="$versions/$id/$version"
  if [ -e "$target/$name.tgz" ]; then
    if cmp -s "$file" "$target/$name.tgz"; then
      rm "$file"
      continue
    fi
    echo "refused: versions/$id/$version already holds a different $name.tgz; a released version is never replaced" >&2
    exit 1
  fi
  mkdir -p "$target"
  mv "$file" "$target/$name.tgz"
  (cd "$target" && sha256sum "$name.tgz" > SHA256)
  echo "archived $id $version -> versions/$id/$version/"
done
