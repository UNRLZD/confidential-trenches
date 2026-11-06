#!/usr/bin/env bash
# Card ci-cargo-fetch-retry: removes <dir>, then runs <command> and exits with its code. Under scripts/ci/retry.sh it
# gives each try of a build an empty --build-dir (deploy.mjs refuses a dir with a file in it, and a try that failed
# after one record's wasm was written left one):
#   bash scripts/ci/retry.sh bash scripts/ci/fresh-dir.sh <dir> <command> [args...]
set -eu
dir=$1
shift
rm -rf -- "$dir"
exec "$@"
