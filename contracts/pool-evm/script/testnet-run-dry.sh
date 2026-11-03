#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The dry run of testnet-run.mjs on an anvil fork of Base Sepolia, on loopback (two URLs, 127.0.0.1 and localhost, so
# the wallet's two-provider rule holds). A stand-in for the test wallet (a fresh random address given 1 ETH and
# impersonated on the fork, so no key here) funds exactly the need the run prints and is its --return. The fork mines a
# block every 2 s, so the pool's time moves past each leaf as on the chain. Then the live check reads the run's record
# on the fork. Outputs go to contracts/pool-evm/out/testnet-run-dry/ (ignored by git), or $DRY_RUN_OUT.
#   bash contracts/pool-evm/script/testnet-run-dry.sh [venues]   (anvil and cast on PATH, the workspace installed)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT="${DRY_RUN_OUT:-$ROOT/contracts/pool-evm/out/testnet-run-dry}"
VENUES=${1:-v4,v3}
rm -rf "$OUT" && mkdir -p "$OUT"
STANDIN=0x$(openssl rand -hex 20)
PORT=$((20000 + RANDOM % 20000))
URL="http://127.0.0.1:$PORT"
# publicnode as the fork's source: its eth_getLogs range cap is 50,000 blocks (sepolia.base.org's is 200)
anvil --fork-url https://base-sepolia-rpc.publicnode.com --port "$PORT" --host 127.0.0.1 --block-time 2 --silent >"$OUT/anvil.log" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true; wait 2>/dev/null || true' EXIT
for _ in $(seq 60); do cast chain-id --rpc-url "$URL" >/dev/null 2>&1 && break; sleep 1; done
cast rpc anvil_setBalance "$STANDIN" 0xde0b6b3a7640000 --rpc-url "$URL" >/dev/null
cast rpc anvil_impersonateAccount "$STANDIN" --rpc-url "$URL" >/dev/null
echo "dry-run: fork at $URL, chain id $(cast chain-id --rpc-url "$URL"), block $(cast block-number --rpc-url "$URL")"

log="$OUT/run.log"
node "$ROOT/contracts/pool-evm/script/testnet-run.mjs" --chain base-sepolia --return "$STANDIN" --venues "$VENUES" --rpc "$URL,http://localhost:$PORT" --out "$OUT/run.json" >"$log" 2>&1 &
pid=$!
for _ in $(seq 600); do grep -q "^run: waiting for" "$log" && break; kill -0 $pid 2>/dev/null || break; sleep 0.5; done
line=$(grep "^run: waiting for" "$log" || true)
if [ -n "$line" ]; then
  need=$(awk '{print $4}' <<<"$line")
  key=$(awk '{print $9}' <<<"$line")
  cast send --unlocked --from "$STANDIN" "$key" --value "$need" --rpc-url "$URL" >/dev/null
  echo "dry-run: funded $key with exactly $need wei"
fi
rc=0; wait $pid || rc=$?
cat "$log"
echo "dry-run: exit $rc; the stand-in got back $(cast balance "$STANDIN" --rpc-url "$URL") of 1 ETH less the need"
node "$ROOT/scripts/live-checks/pool-evm-testnet-run.mjs" --record-file "$OUT/run.json" --rpc "$URL,http://localhost:$PORT" --record "$OUT/answers.json" || true
exit $rc
