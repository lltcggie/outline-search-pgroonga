#!/usr/bin/env bash
# Prepares ~/pgroonga-test/outline-<version>: Outline's source at that tag with
# its dependencies, and the Node.js major version from its .nvmrc.
# Usage: setup.sh <outline version>
set -euo pipefail
version="$1"
base=~/pgroonga-test
mkdir -p "$base/bin"
cd "$base"

major=$(curl -fsSL "https://raw.githubusercontent.com/outline/outline/v$version/.nvmrc" \
  | tr -d '[:space:]v' | cut -d. -f1)
node_dir="$base/node-$major"
if [ ! -x "$node_dir/bin/node" ]; then
  line=$(curl -fsSL "https://nodejs.org/dist/latest-v$major.x/SHASUMS256.txt" \
    | grep -E 'linux-x64\.tar\.xz$')
  name=${line##* }
  curl -fsSLO "https://nodejs.org/dist/latest-v$major.x/$name"
  echo "$line" | sha256sum -c -
  mkdir -p "$node_dir"
  tar -xJf "$name" -C "$node_dir" --strip-components=1
  rm "$name"
fi
export PATH="$base/bin:$node_dir/bin:$PATH"
node --version

outline="$base/outline-$version"
if [ ! -d "$outline" ]; then
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$version" \
    https://github.com/outline/outline.git "$outline"
fi
git -C "$outline" log --oneline -1

# Node 25+ no longer bundles corepack.
if [ ! -x tools/node_modules/.bin/corepack ]; then
  npm install --silent --prefix "$base/tools" corepack
fi
tools/node_modules/.bin/corepack enable --install-directory "$base/bin"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$outline"
yarn --version
log="$base/yarn-install-$version.log"
yarn install --immutable > "$log" 2>&1 || { tail -30 "$log"; exit 1; }
echo "yarn install done"
