#!/usr/bin/env bash
# Removes the containers started by containers.sh (and only those).
set -euo pipefail
docker ps -aq --filter label=outline-search-pgroonga.test=true | xargs -r docker rm -f -v
