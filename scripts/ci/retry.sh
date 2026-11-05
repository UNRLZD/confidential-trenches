#!/usr/bin/env bash
# Card ci-downloads-retry: runs one network install again when it fails, 3 tries 20 s apart, and exits with the last
# try's code. For the tools whose own retry is missing or does not wait out an outage: rustup retries a component at
# once with no wait (src/dist/manifestation.rs l.800 at 1.29.3, FixedInterval 0), git and cargo install not at all,
# while a release host's 504 outlasted foundryup's five tries over 31 s (job 127152961657, 5 Nov 09:13Z).
#   bash scripts/ci/retry.sh <command> [args...]
# scripts/ci/download-retry.mjs refuses a workflow's rustup install, cargo install or git submodule update without it.
set -u
for try in 1 2 3; do
  "$@" && exit 0
  rc=$?
  [ "$try" = 3 ] && exit "$rc"
  echo "retry.sh: try $try of 3 ended $rc: $*; again in 20 s" >&2
  sleep 20
done
