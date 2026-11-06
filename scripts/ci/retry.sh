#!/usr/bin/env bash
# Card ci-downloads-retry: runs one network install again when it fails, 3 tries 20 s apart, and exits with the last
# try's code. For the tools whose own retry is missing or does not wait out an outage: rustup retries a component at
# once with no wait (src/dist/manifestation.rs l.800 at 1.29.3, FixedInterval 0), git and cargo install not at all,
# while a release host's 504 outlasted foundryup's five tries over 31 s (job 127152961657, 5 Nov 09:13Z).
#   bash scripts/ci/retry.sh <command> [args...]
# Card ci-cargo-fetch-retry: RETRY_FINAL="<code> [<code>...]" names exit codes that are answers, not failures to try
# again: a command that ends with one stops the run at once with that code. For deploy.mjs's code for hashes that
# disagree (EXIT_HASH_DISAGREE, 3), which a retry must never turn green:
#   RETRY_FINAL=3 bash scripts/ci/retry.sh node contracts/vault/scripts/deploy.mjs --build-only ...
# scripts/ci/download-retry.mjs refuses a workflow's rustup install, cargo install or git submodule update without it.
set -u
final=" ${RETRY_FINAL:-} "
for try in 1 2 3; do
  "$@" && exit 0
  rc=$?
  case "$final" in
    *" $rc "*) echo "retry.sh: try $try ended $rc, a final code: not tried again: $*" >&2; exit "$rc" ;;
  esac
  [ "$try" = 3 ] && exit "$rc"
  echo "retry.sh: try $try of 3 ended $rc: $*; again in 20 s" >&2
  sleep 20
done
