#!/usr/bin/env bash
# Compiles the plugin against a given Outline version and writes the result to
# dist/search-pgroonga. Needed again after every Outline upgrade, because the
# compiled files reference Outline's own modules.
#
#   ./build.sh          # the version in OUTLINE_VERSION
#   ./build.sh 1.11.0   # any other version
#
# Requires git and Node.js (with corepack, or yarn 4 on PATH).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-$(tr -d '[:space:]' < "$HERE/OUTLINE_VERSION")}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$VERSION" \
  https://github.com/outline/outline.git "$WORK/outline"
cd "$WORK/outline"

command -v yarn >/dev/null 2>&1 || corepack enable
yarn install --immutable

cp -R "$HERE/plugin/search-pgroonga" plugins/

# The plugin reuses internals of Outline's built-in search provider. If a new
# Outline version renamed or reshaped them, this is where it shows up.
echo "Type-checking against Outline v$VERSION…"
yarn tsc --noEmit -p .

echo "Compiling…"
yarn swc ./plugins/search-pgroonga/server -d ./build/plugins \
  --strip-leading-paths --extensions .ts,.tsx \
  --ignore "**/*.test.ts" --quiet

OUT="$HERE/dist/search-pgroonga"
rm -rf "$OUT"
mkdir -p "$HERE/dist"
cp -R build/plugins/search-pgroonga "$OUT"
cp plugins/search-pgroonga/plugin.json "$OUT/"
cp -R plugins/search-pgroonga/sql "$OUT/"
cp "$HERE/LICENSE" "$HERE/NOTICE" "$OUT/"
echo "$VERSION" > "$OUT/OUTLINE_VERSION"
echo "Done: $OUT (for Outline v$VERSION)"
