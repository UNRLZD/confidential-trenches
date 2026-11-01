#!/bin/sh
# Heavy jobs: full suites, contract builds, e2e, docker.
#   scripts/heavy.sh <label> -- <command...>
# With HEAVY_SH set (a job queue on your machine, called with the same arguments), the job goes to it.
# Without it, the command runs here as is.
if [ $# -lt 3 ] || [ "$2" != "--" ]; then
  echo "usage: scripts/heavy.sh <label> -- <command...>" >&2
  exit 2
fi
if [ -n "${HEAVY_SH:-}" ]; then exec "$HEAVY_SH" "$@"; fi
shift 2
exec "$@"
