#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The local dry run of deploy.mjs on a fresh solana-test-validator: five runs, each funded with exactly the need the
# script prints, from a local stand-in for the devnet wallet (a key made here, airdropped, never leaving this run):
#   1. the whole run with planted transient failures (--flaky: every third RPC call throws "fetch failed"): build,
#      deploy --final, init, deposit, sweep; then the live check on two loopback URLs, recorded;
#   2. a planted stop just past the deploy (--fail-after deploy): the cleanup sweeps, the program stays final;
#   3. the resume of that program (--program, --flaky): init and deposit only; the live check on its record;
#   4. a second resume of it: its pool exists, so init is skipped;
#   5. the CLI stopped while it writes the buffer (SIGTERM): the cleanup closes the buffer and sweeps.
# After each, the funder must hold 0. Outputs go to contracts/pool-solana/out/dry-run/ (ignored by git).
#   bash contracts/pool-solana/scripts/dry-run.sh   (with solana-test-validator, the solana CLI and cargo-build-sbf on PATH)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT="$ROOT/contracts/pool-solana/out/dry-run"
rm -rf "$OUT" && mkdir -p "$OUT"
W=$(mktemp -d)
chmod 700 "$W"
PORT=$((20000 + RANDOM % 20000))
URL="http://127.0.0.1:$PORT"
VPID=
cleanup() { [ -n "$VPID" ] && kill "$VPID" 2>/dev/null; wait 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
solana-test-validator --reset --quiet --ledger "$W/ledger" --rpc-port "$PORT" --faucet-port $((PORT + 2)) \
  --gossip-port $((PORT + 3)) --dynamic-port-range $((PORT + 10))-$((PORT + 60)) >"$W/validator.log" 2>&1 &
VPID=$!
for _ in $(seq 60); do solana -u "$URL" cluster-version >/dev/null 2>&1 && break; sleep 1; done
echo "dry-run: validator $(solana -u "$URL" cluster-version) at $URL"
solana-keygen new --no-bip39-passphrase --silent --force -o "$W/d.json" >/dev/null
D=$(solana-keygen pubkey "$W/d.json")
solana -u "$URL" airdrop 10 "$D" >/dev/null
echo "dry-run: stand-in wallet $D holds $(solana -u "$URL" balance "$D" --lamports)"

sol() { node -e 'const n=BigInt(process.argv[1]);console.log(`${n/1000000000n}.${String(n%1000000000n).padStart(9,"0")}`)' "$1"; }
# run <name> <deploy.mjs args...>: starts the script, funds exactly the printed need, waits; prints the funder after
run() {
  local name=$1; shift
  local log="$OUT/$name.log"
  node "$ROOT/contracts/pool-solana/scripts/deploy.mjs" --url "$URL" --return "$D" --out "$OUT/$name.json" "$@" >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 600); do grep -q "^deploy: waiting for" "$log" && break; kill -0 $pid 2>/dev/null || break; sleep 0.5; done
  local line; line=$(grep "^deploy: waiting for" "$log")
  local funder; funder=$(awk '{print $4}' <<<"$line")
  local need; need=$(awk '{print $7}' <<<"$line")
  solana -u "$URL" transfer --from "$W/d.json" --fee-payer "$W/d.json" --allow-unfunded-recipient "$funder" "$(sol "$need")" >/dev/null
  echo "dry-run [$name]: funded $funder with exactly $need lamports"
  if [ "$name" = stopped ]; then
    # stop the CLI once its buffer exists, while it writes
    for _ in $(seq 600); do solana -u "$URL" program show --buffers --buffer-authority "$funder" 2>/dev/null | grep -q "$funder" && break; sleep 0.1; done
    pkill -TERM -P $pid -f "program deploy" || true
    echo "dry-run [$name]: sent SIGTERM to the CLI while it writes"
  fi
  local rc=0; wait $pid || rc=$?
  cat "$log"
  echo "dry-run [$name]: exit $rc; funder $funder holds $(solana -u "$URL" balance "$funder" --lamports)"
}
run whole --flaky
run planted --no-build --fail-after deploy
PROGRAM=$(awk '/^deploy: program id /{print $4}' "$OUT/planted.log")
run resumed --no-build --flaky --program "$PROGRAM"
run resumed-again --no-build --program "$PROGRAM"
run stopped --no-build
echo "dry-run: stand-in wallet $D holds $(solana -u "$URL" balance "$D" --lamports) after every run"
echo "dry-run: runs whose cleanup read the funder empty with nothing left, so removed its keys: $(grep -l 'keys removed (gone)' "$OUT"/*.log | wc -l | tr -d ' ') of 5; kept: $(grep -h 'KEYS KEPT' "$OUT"/*.log | wc -l | tr -d ' ')"
echo "dry-run: buffers left with any authority: $(solana -u "$URL" program show --buffers --all 2>&1 | tail -n +1 | grep -c '^ *[1-9A-HJ-NP-Za-km-z]\{32,44\} ' || true)"
node "$ROOT/scripts/live-checks/pool-sol-deploy.mjs" --deployment "$OUT/whole.json" --rpc "$URL,http://localhost:$PORT" --record "$OUT/whole-answers.json"
node "$ROOT/scripts/live-checks/pool-sol-deploy.mjs" --deployment "$OUT/resumed.json" --rpc "$URL,http://localhost:$PORT" | tail -1
node "$ROOT/scripts/live-checks/pool-sol-deploy.mjs" --deployment "$OUT/resumed-again.json" --rpc "$URL,http://localhost:$PORT" | tail -1
