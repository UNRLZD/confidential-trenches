#!/bin/bash
# The helper's local proof (card helper-host-health): the image, the compose stack behind the real Caddyfile on
# plain http, the live check against it, and no IP in any log after a 502 and a malformed request. It needs Docker,
# so it runs through the heavy queue:
#   scripts/heavy.sh helper-proof -- bash apps/helper/deploy/local-proof.sh [<out dir>]
# (on the Mac queue with HEAVY_REMOTE=0 while the box has no Docker). The expected commit is this checkout's newest
# first-parent commit that changed apps/helper; OTHER is another commit, for the bad-commit answer. The recorded
# answers land in <out dir> (default a new temp dir): good.json and bad-commit.json.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
OUT=${1:-$(mktemp -d)}
C=$(git -C "$ROOT" rev-list -1 --first-parent HEAD -- apps/helper)
OTHER=$(git -C "$ROOT" rev-parse HEAD~1)
[ "$OTHER" = "$C" ] && OTHER=$(git -C "$ROOT" rev-parse "$C~1")
CHECK="$ROOT/scripts/live-checks/helper-host-health.mjs"
P=ct-helper-proof
mkdir -p "$OUT"
cleanup() {
  docker rm -f ct-helper-proof-other >/dev/null 2>&1
  (cd "$ROOT/apps/helper/deploy" && HELPER_COMMIT=$C docker compose -p $P down -v --rmi local >/dev/null 2>&1)
  docker rmi "ct-helper:$C" "ct-helper:$OTHER" "ct-helper:refused" >/dev/null 2>&1
}
trap cleanup EXIT
cd "$ROOT/apps/helper"
echo "== docker $(docker version --format '{{.Server.Version}} {{.Server.Arch}}'), commit $C, other $OTHER, out $OUT"
echo "== the build refuses a commit that is not 40 hex"
docker build -q --build-arg HELPER_COMMIT=main -t ct-helper:refused . >/dev/null 2>"$OUT/refused.log"
echo "build rc=$? (want non-zero)"; grep -o "HELPER_COMMIT must be a full 40-hex commit" "$OUT/refused.log" | head -1
echo "== stack: helper + caddy, plain http on 127.0.0.1:18080 (HELPER_SITE), the real Caddyfile otherwise"
cd deploy
export HELPER_COMMIT=$C HELPER_SITE=http://:80 HELPER_PORTS_HTTP=127.0.0.1:18080 HELPER_PORTS_HTTPS=127.0.0.1:18443
docker compose -p $P up -d --build 2>&1 | tail -2
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:18080/v1/health 2>/dev/null && break; sleep 1; done
echo "== live check through Caddy"
node "$CHECK" --base http://127.0.0.1:18080 --commit "$C" --record "$OUT/good.json" | tail -1; echo "rc=${PIPESTATUS[0]} (want 0)"
node "$CHECK" --base http://127.0.0.1:18080 --commit "$OTHER" >/dev/null; echo "against $OTHER: rc=$? (want 1)"
echo "== preflight through Caddy"
curl -sS -o /dev/null -D - -X OPTIONS -H 'Origin: https://sign.confidential.unrealized.trade' \
  -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' \
  http://127.0.0.1:18080/v1/bind | tr -d '\r' | grep -iE '^(HTTP|access-control|vary)'
echo "== GET /v1/health through Caddy, 200 reads"
for _ in $(seq 1 200); do curl -s -o /dev/null -w '%{time_total}\n' -H 'Origin: https://confidential.unrealized.trade' http://127.0.0.1:18080/v1/health; done |
  sort -n | awk '{a[NR]=$1} END {printf "p50 %.1f ms, p95 %.1f ms, n=%d\n", a[int(NR*0.5)]*1000, a[int(NR*0.95)]*1000, NR}'
echo "== upstream down (502) and a malformed request: no IP may reach a log"
docker compose -p $P stop helper >/dev/null 2>&1
curl -s -o /dev/null -w 'status %{http_code}\n' -H 'X-Forwarded-For: 203.0.113.7' http://127.0.0.1:18080/v1/health
printf 'GET / HTTP/1.1\r\nHost: x\r\nbad header\r\n\r\n' | nc -w 2 127.0.0.1 18080 | head -1
sleep 1
docker compose -p $P start helper >/dev/null 2>&1
sleep 2
docker compose -p $P logs --no-color --no-log-prefix helper caddy >"$OUT/logs.txt" 2>&1
echo "$(wc -l <"$OUT/logs.txt" | tr -d ' ') log lines; IP-like strings in them (want none):"
grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|remote_ip|client_ip|X-Forwarded' "$OUT/logs.txt" || echo "none"
echo "== container settings"
docker inspect -f '{{.Name}} ro={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} user={{.Config.User}}' $(docker compose -p $P ps -q)
echo "== the image built at $OTHER, read directly: the bad-commit answer"
cd ..
docker build -q --build-arg HELPER_COMMIT="$OTHER" -t "ct-helper:$OTHER" . >/dev/null
docker run -d --rm --name ct-helper-proof-other -p 127.0.0.1:18081:8080 "ct-helper:$OTHER" >/dev/null
for _ in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:18081/v1/health 2>/dev/null && break; sleep 0.5; done
node "$CHECK" --base http://127.0.0.1:18081 --commit "$C" --record "$OUT/bad-commit.json" | tail -1; echo "rc=${PIPESTATUS[0]} (want 1)"
echo "== done"
