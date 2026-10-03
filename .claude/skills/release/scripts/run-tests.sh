#!/usr/bin/env bash
# Copies this repository's plugin (and the scale check) into the Outline tree
# prepared by setup.sh, migrates the test DB from containers.sh, installs the
# PGroonga index and runs vitest.
# Usage: run-tests.sh <outline version> [vitest filter, default: plugins/search-pgroonga/]
set -euo pipefail
version="$1"
filter="${2:-plugins/search-pgroonga/}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
base=~/pgroonga-test
major=$(tr -d '[:space:]v' < "$base/outline-$version/.nvmrc" | cut -d. -f1)
export PATH="$base/bin:$base/node-$major/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export NODE_ENV=test
export DATABASE_URL=postgres://user:pass@127.0.0.1:25432/outline-test
export REDIS_URL=redis://127.0.0.1:26379

cd "$base/outline-$version"
rm -rf plugins/search-pgroonga plugins/search-pgroonga-scale
cp -R "$repo/plugin/search-pgroonga" plugins/
mkdir -p plugins/search-pgroonga-scale/server
cp "$here/scale.test.ts" plugins/search-pgroonga-scale/server/

yarn sequelize db:migrate > "$base/migrate.log" 2>&1 || { tail -30 "$base/migrate.log"; exit 1; }
docker exec -i outline-search-pgroonga-test-pg psql -q -U user -d outline-test -v ON_ERROR_STOP=1 \
  < plugins/search-pgroonga/sql/install.sql

log="$base/vitest.log"
TZ=UTC yarn vitest run --project server "$filter" > "$log" 2>&1 && status=0 || status=$?
grep -E "✓|✗|×|FAIL|Test Files|Tests |Error|expected|received|\{\"query\".*ms$" "$log" | tail -80
exit $status
