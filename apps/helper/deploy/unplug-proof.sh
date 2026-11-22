#!/bin/bash
# The unplug switch's local proof (card helper-unplug-off): the compose stack built from this checkout, behind the real
# Caddyfile on plain http (as local-proof.sh runs it, with planted vendor keys made for this run, never a real key), then
# deploy/unplug.sh off, scripts/drill/servers-down.mjs reading every port of it as answering nothing, unplug.sh on, and
# the same read failing on the helper it brought back. It needs Docker; nothing of the live host is touched:
#   bash apps/helper/deploy/unplug-proof.sh [<out dir>]
# The recorded reads land in <out dir> (default a new temp dir), off.json (the good answer) and on.json (the bad one),
# and are printed, so a run on another machine (heavy.sh's box) hands them back in its output.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
OUT=${1:-$(mktemp -d)}
C=$(git -C "$ROOT" rev-list -1 --first-parent HEAD -- $(node "$ROOT/apps/helper/deploy/image-inputs.mjs"))
export JUPITER_API_KEY="ct-proof-jupiter-$(openssl rand -hex 12)" RELAY_API_KEY="ct-proof-relay-$(openssl rand -hex 12)"
export LIFI_API_KEY="ct-proof-lifi-$(openssl rand -hex 12)" ONECLICK_JWT="ct-proof-oneclick-$(openssl rand -hex 12)"
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
echo "== unplug.sh status"
bash ./unplug.sh status; echo "rc=$? (want 0)"
echo "== unplug.sh off"
bash ./unplug.sh off 2>&1 | tail -3; echo "rc=${PIPESTATUS[0]} (want 0)"
echo "== servers-down on the stopped stack: the good answer"
node "$DOWN" --helper 127.0.0.1 --http-port 18090 --https-port 18453 --record "$OUT/off.json"; echo "rc=$? (want 0)"
echo "== off.json"; cat "$OUT/off.json"
echo "== unplug.sh on"
UNPLUG_READY_S=${UNPLUG_READY_S:-300} bash ./unplug.sh on 2>&1 | tail -3; echo "rc=${PIPESTATUS[0]} (want 0)"
curl -s -o /dev/null -w 'health after: %{http_code}\n' http://127.0.0.1:18090/v1/health
echo "== servers-down on the stack brought back: the bad answer"
node "$DOWN" --helper 127.0.0.1 --http-port 18090 --https-port 18453 --record "$OUT/on.json"; echo "rc=$? (want 1)"
echo "== on.json"; cat "$OUT/on.json"
echo "== done"
