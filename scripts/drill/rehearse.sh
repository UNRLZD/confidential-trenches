#!/bin/bash
# The unplug drill's rehearsal (card vault-drill-rehearsal-mainnet-copy): the drill end to end on a local copy of
# mainnet, every server of ours off, so the live drill runs steps that have already passed once. No test network.
#   bash scripts/drill/rehearse.sh <out dir>               the rehearsal; exit 0 only when scripts/drill/rehearse.mjs
#                                                          judges its record PASS
#   bash scripts/drill/rehearse.sh <out dir> --leave-on    the same run with unplug.sh off left out: its servers-down
#                                                          read must FAIL, the exit never runs, and the rehearsal exits 1
# The steps, in this order:
#   1. the helper's compose stack built from this checkout, behind the real Caddyfile on plain http with no vendor key
#      (as apps/helper/deploy/unplug-proof.sh brings it up), read ready on /v1/health;
#   2. the deposits: contracts/vault/tests/exit_every_kind.rs on near-sandbox, holding the mainnet vault's code and
#      every state record (tests/fixtures/mainnet-vault-copy.json) beside the real USDC wasm, seeds every kind of note
#      the 12 words make by the vault's own deposit paths;
#   3. the cut, which that test runs at DRILL_CUT after the deposits and before the exit command (this script --cut):
#      apps/helper/deploy/unplug.sh off,
#   4. then scripts/drill/servers-down.mjs read against that stack's ports: a FAIL stops the test, no exit runs;
#   5. the exit tool's command from the published all-zero words alone (packages/exit/test/exit-cli.ts on the
#      sandbox's RPC), every node process under scripts/drill/net-guard.mjs, which refuses and writes down any request
#      to a host of ours; then the test reads the payout account's and the vault's USDC on chain.
# It needs Docker, Rust 1.96.0 with cargo-near and Node 24 with the workspace installed: a CI runner
# (.github/workflows/drill-rehearse.yml). The files it leaves in <out dir> are the run's record (record.json, judged by
# rehearse.mjs, replayed by scripts/ci/drill-rehearse.test.mjs) and what it was built from.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
DEPLOY="$ROOT/apps/helper/deploy"
HTTP_PORT=18190
HTTPS_PORT=18553

if [ "${1:-}" = --cut ]; then
  # run by exit_every_kind at DRILL_CUT, in the stack's env (HELPER_COMMIT, COMPOSE_PROJECT_NAME) it inherits; its own
  # reads go out unguarded, so the guard's list holds the test's node processes only
  OUT=$2
  unset NODE_OPTIONS DRILL_HOSTS
  date -u +%Y-%m-%dT%H:%M:%SZ >"$OUT/cut.at"
  if [ "${3:-}" = --leave-on ]; then
    echo "rehearse: unplug.sh off left out (--leave-on)" | tee "$OUT/unplug.txt"
  else
    (cd "$DEPLOY" && bash ./unplug.sh off) >"$OUT/unplug.txt" 2>&1
    echo $? >"$OUT/unplug.rc"
    cat "$OUT/unplug.txt"
  fi
  node "$ROOT/scripts/drill/servers-down.mjs" --helper 127.0.0.1 --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT" \
    --record "$OUT/servers-down.json" >"$OUT/servers-down.txt" 2>&1
  rc=$?
  echo $rc >"$OUT/servers-down.rc"
  cat "$OUT/servers-down.txt"
  [ -f "$OUT/unplug.rc" ] && [ "$(cat "$OUT/unplug.rc")" != 0 ] && exit 1
  exit $rc
fi

[ $# -ge 1 ] && [ $# -le 2 ] && { [ $# -eq 1 ] || [ "$2" = --leave-on ]; } || { echo "usage: rehearse.sh <out dir> [--leave-on]" >&2; exit 2; }
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
LEAVE=${2:-}
C=$(git -C "$ROOT" rev-list -1 --first-parent HEAD -- $(node "$DEPLOY/image-inputs.mjs"))
# no vendor key at all, each vendor on its keyless plan, as unplug-proof.sh runs the stack
export PROXY_BUDGET_JUPITER=30,4 PROXY_BUDGET_RELAY=2,1 PROXY_BUDGET_LIFI=2,1 PROXY_BUDGET_ONECLICK=50,5
export COMPOSE_PROJECT_NAME=ct-drill-rehearse
export HELPER_COMMIT=$C HELPER_RELEASE=1 HELPER_SITE=http://:80 HELPER_PORTS_HTTP=127.0.0.1:$HTTP_PORT HELPER_PORTS_HTTPS=127.0.0.1:$HTTPS_PORT
READY_S=${REHEARSE_READY_S:-600}
cleanup() { (cd "$DEPLOY" && docker compose down -v --rmi local >/dev/null 2>&1); }
trap cleanup EXIT
docker version >/dev/null 2>&1 || { echo "rehearse: Docker does not answer here; nothing run"; exit 2; }
git -C "$ROOT" rev-parse HEAD >"$OUT/commit"
echo "$LEAVE" >"$OUT/mode"
echo "$HTTP_PORT $HTTPS_PORT" >"$OUT/ports"

echo "== 1. the helper stack up (commit $C), plain http on 127.0.0.1:$HTTP_PORT"
(cd "$DEPLOY" && docker compose up -d --build 2>&1 | tail -2)
code=000
for _ in $(seq 1 "$READY_S"); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/v1/health" 2>/dev/null)
  [ "$code" = 200 ] && break
  sleep 1
done
echo "$code" >"$OUT/health"
(cd "$DEPLOY" && bash ./unplug.sh status) >"$OUT/stack.txt" 2>&1
echo "health: $code"; cat "$OUT/stack.txt"

echo "== 2-5. the deposits on the mainnet vault's copy, the cut, the exit from the words, the balance read"
: >"$OUT/requests.jsonl"
export DRILL_CUT="bash $ROOT/scripts/drill/rehearse.sh --cut $OUT $LEAVE"
NODE_OPTIONS="--import=file://$ROOT/scripts/drill/net-guard.mjs" DRILL_HOSTS="$OUT/requests.jsonl" \
  "$ROOT/contracts/vault/tests/harness/run.sh" --test exit_every_kind 2>&1 | tee "$OUT/exit.log"
echo "${PIPESTATUS[0]}" >"$OUT/exit.rc"

echo "== the record"
node "$ROOT/scripts/drill/rehearse.mjs" record "$OUT"
