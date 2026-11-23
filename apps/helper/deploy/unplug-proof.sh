#!/bin/bash
# The unplug switch's local proof (card helper-unplug-off): the compose stack built from this checkout, behind the real
# Caddyfile on plain http (as local-proof.sh runs it, but with no vendor key: each on its keyless plan), then
# deploy/unplug.sh off, scripts/drill/servers-down.mjs reading every port of it as answering nothing, unplug.sh on, and
# the same read failing on the helper it brought back. It needs Docker; nothing of the live host is touched:
#   bash apps/helper/deploy/unplug-proof.sh [<out dir>]
# The recorded reads land in <out dir> (default a new temp dir), off.json (the good answer) and on.json (the bad one),
# and are printed, so a run on another machine (a CI runner) hands them back in its output.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
OUT=${1:-$(mktemp -d)}
C=$(git -C "$ROOT" rev-list -1 --first-parent HEAD -- $(node "$ROOT/apps/helper/deploy/image-inputs.mjs"))
# no vendor key at all: each vendor on its keyless plan (proxy.ts checkVendorPlans), as a helper with no key starts; so
# it reaches ready (a local start with these four, 22 Nov 20:2xZ: ready at 165 s) and on's wait is the real one
export PROXY_BUDGET_JUPITER=30,4 PROXY_BUDGET_RELAY=2,1 PROXY_BUDGET_LIFI=2,1 PROXY_BUDGET_ONECLICK=50,5
export COMPOSE_PROJECT_NAME=ct-helper-unplug-proof
export HELPER_COMMIT=$C HELPER_RELEASE=1 HELPER_SITE=http://:80 HELPER_PORTS_HTTP=127.0.0.1:18090 HELPER_PORTS_HTTPS=127.0.0.1:18453
DOWN="$ROOT/scripts/drill/servers-down.mjs"
mkdir -p "$OUT"
cleanup() { (cd "$ROOT/apps/helper/deploy" && docker compose down -v --rmi local >/dev/null 2>&1); }
trap cleanup EXIT
cd "$ROOT/apps/helper/deploy" || exit 2
# a Docker that does not answer proves nothing: stop before any step reads it
docker version >/dev/null 2>&1 || { echo "unplug-proof: Docker does not answer here; nothing run"; exit 2; }
echo "== docker $(docker version --format '{{.Server.Version}} {{.Server.Arch}}'), commit $C, out $OUT"
echo "== stack up: helper + caddy, plain http on 127.0.0.1:18090"
docker compose up -d --build 2>&1 | tail -2
for _ in $(seq 1 120); do curl -fsS -o /dev/null http://127.0.0.1:18090/v1/health 2>/dev/null && break; sleep 1; done
curl -s -o /dev/null -w 'health before: %{http_code}\n' http://127.0.0.1:18090/v1/health
# each step's exit code against the one it should have; the proof exits 1 when any differs
MISSED=()
want() { echo "rc=$2 (want $3)"; [ "$2" = "$3" ] || MISSED+=("$1 rc=$2 want $3"); }
echo "== unplug.sh status"
bash ./unplug.sh status; want status $? 0
echo "== unplug.sh off"
bash ./unplug.sh off 2>&1 | tail -3; want off "${PIPESTATUS[0]}" 0
echo "== servers-down on the stopped stack: the good answer"
node "$DOWN" --helper 127.0.0.1 --http-port 18090 --https-port 18453 --record "$OUT/off.json"; want down-after-off $? 0
echo "== off.json"; cat "$OUT/off.json"
echo "== unplug.sh on"
UNPLUG_READY_S=${UNPLUG_READY_S:-300} bash ./unplug.sh on 2>&1 | tail -3; want on "${PIPESTATUS[0]}" 0
curl -s -o /dev/null -w 'health after: %{http_code}\n' http://127.0.0.1:18090/v1/health
echo "== servers-down on the stack brought back: the bad answer"
node "$DOWN" --helper 127.0.0.1 --http-port 18090 --https-port 18453 --record "$OUT/on.json"; want down-after-on $? 1
echo "== on.json"; cat "$OUT/on.json"
if [ ${#MISSED[@]} -gt 0 ]; then
  echo "== FAIL: ${MISSED[*]}"
  exit 1
fi
echo "== PASS: every step answered as it should"
