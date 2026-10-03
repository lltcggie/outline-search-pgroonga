#!/usr/bin/env bash
# Starts throwaway test containers (PostgreSQL + PGroonga on 127.0.0.1:25432,
# Redis on 127.0.0.1:26379), labelled so teardown.sh removes only these.
# Any container or port it did not create is someone else's (assume
# production): it stops instead of touching it.
# Usage: containers.sh <pgroonga image, e.g. groonga/pgroonga:4.0.9-debian-18>
set -euo pipefail
image="$1"
label=outline-search-pgroonga.test
pg=outline-search-pgroonga-test-pg
redis=outline-search-pgroonga-test-redis

for name in "$pg" "$redis"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    owner=$(docker container inspect -f "{{index .Config.Labels \"$label\"}}" "$name")
    if [ "$owner" != true ]; then
      echo "Container $name exists and was not created by this script; leaving it alone." >&2
      exit 1
    fi
    docker rm -f -v "$name" >/dev/null
  fi
done
# The ports sit below Windows' dynamic range (49152+), where Hyper-V reserves
# ranges. With WSL's mirrored networking, Windows listeners share the ports
# but are invisible to ss, so ask netstat.exe too. (grep reads to the end:
# with -q it would exit early and pipefail would report the writer's SIGPIPE.)
netstat=/mnt/c/Windows/System32/netstat.exe
for port in 25432 26379; do
  if ss -Htln "sport = :$port" | grep . >/dev/null ||
    { [ -x "$netstat" ] && "$netstat" -ano -p tcp </dev/null | grep -E ":$port[[:space:]].*LISTENING" >/dev/null; }; then
    echo "Port $port is already in use; leaving its owner alone." >&2
    exit 1
  fi
done

docker run -d --name "$pg" --label "$label=true" \
  -e POSTGRES_USER=user -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=outline-test \
  -p 127.0.0.1:25432:5432 "$image" >/dev/null
docker run -d --name "$redis" --label "$label=true" \
  -p 127.0.0.1:26379:6379 redis:8 >/dev/null

# The entrypoint restarts the server after initdb, so wait for the final
# server, reached over TCP (the init server only listens on the socket).
for i in $(seq 1 60); do
  if docker exec "$pg" psql -h 127.0.0.1 -U user -d outline-test \
    -Atc "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$pg" psql -U user -d outline-test -Atc \
  "SELECT version(); CREATE EXTENSION IF NOT EXISTS pgroonga; SELECT extversion FROM pg_extension WHERE extname = 'pgroonga';"
