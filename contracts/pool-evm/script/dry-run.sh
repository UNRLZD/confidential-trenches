#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The dry run of deploy.mjs on anvil forks of Base Sepolia and Robinhood testnet, on loopback. A stand-in for the
# test wallet (a fresh random address, given 1 ETH and impersonated on each fork, so no key here; anvil's dev accounts
# carry EIP-7702 code on these testnets, and deploy.mjs refuses a --return with code) funds exactly the need the
# script prints and is the --return address:
#   1. each chain: the whole run (build, need, deploys, sweep), then the live check on two loopback URLs, recorded;
#   2. Base Sepolia again, sent SIGTERM as soon as it is funded: a deploy already sent lands, no other is sent, the
#      sweep runs; its record lists what landed, and the live check fails it (contracts missing).
# After each, the run key's balance is printed. Outputs go to contracts/pool-evm/out/dry-run/ (ignored by git), or $DRY_RUN_OUT.
#   bash contracts/pool-evm/script/dry-run.sh   (with anvil, forge and cast on PATH, and the workspace installed)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT="${DRY_RUN_OUT:-$ROOT/contracts/pool-evm/out/dry-run}"
rm -rf "$OUT" && mkdir -p "$OUT"
STANDIN=0x$(openssl rand -hex 20)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
# bash 3 has no maps: each chain's fork source and port in plain variables
fork_of() { case $1 in base-sepolia) echo https://sepolia.base.org ;; robinhood-testnet) echo https://rpc.testnet.chain.robinhood.com ;; esac; }
PORT_BASE=$((20000 + RANDOM % 20000))
port_of() { case $1 in base-sepolia) echo "$PORT_BASE" ;; robinhood-testnet) echo $((PORT_BASE + 1)) ;; esac; }
for chain in base-sepolia robinhood-testnet; do
  port=$(port_of "$chain")
  anvil --fork-url "$(fork_of "$chain")" --port "$port" --host 127.0.0.1 --silent >"$OUT/anvil-$chain.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 60); do cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1 && break; sleep 1; done
  cast rpc anvil_setBalance "$STANDIN" 0xde0b6b3a7640000 --rpc-url "http://127.0.0.1:$port" >/dev/null
  cast rpc anvil_impersonateAccount "$STANDIN" --rpc-url "http://127.0.0.1:$port" >/dev/null
  echo "dry-run: $chain fork at http://127.0.0.1:$port, chain id $(cast chain-id --rpc-url "http://127.0.0.1:$port"), block $(cast block-number --rpc-url "http://127.0.0.1:$port")"
done

# run <name> <chain> [stop]: starts the script, funds exactly the printed need from the stand-in, waits
run() {
  local name=$1 chain=$2 stop=${3:-}
  local url="http://127.0.0.1:$(port_of "$chain")" log="$OUT/$name.log"
  node "$ROOT/contracts/pool-evm/script/deploy.mjs" --chain "$chain" --return "$STANDIN" --rpc "$url" --out "$OUT/$name.json" --no-build >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 600); do grep -q "^deploy: waiting for" "$log" && break; kill -0 $pid 2>/dev/null || break; sleep 0.5; done
  local line; line=$(grep "^deploy: waiting for" "$log")
  local need; need=$(awk '{print $4}' <<<"$line")
  local key; key=$(awk '{print $9}' <<<"$line")
  local before; before=$(cast balance "$STANDIN" --rpc-url "$url")
  cast send --unlocked --from "$STANDIN" "$key" --value "$need" --rpc-url "$url" >/dev/null
  echo "dry-run [$name]: funded $key with exactly $need wei"
  if [ "$stop" = stop ]; then
    for _ in $(seq 600); do grep -q "^deploy: funded" "$log" && break; sleep 0.1; done
    kill -TERM $pid
    echo "dry-run [$name]: sent SIGTERM once funded"
  fi
  local rc=0; wait $pid || rc=$?
  cat "$log"
  echo "dry-run [$name]: exit $rc; run key $key holds $(cast balance "$key" --rpc-url "$url") wei; the stand-in spent $(node -p "BigInt('$before') - BigInt('$(cast balance "$STANDIN" --rpc-url "$url")')") wei net (the fees)"
}
(cd "$ROOT" && forge build --root contracts/pool-evm >/dev/null && echo "dry-run: $(forge --version | head -1), build ok")
run base-sepolia base-sepolia
run robinhood-testnet robinhood-testnet
run stopped base-sepolia stop
node -e 'const d=require(process.argv[1]); console.log("dry-run [stopped]: record lists " + d.txs.map((t) => t.step).join(", "))' "$OUT/stopped.json"
p=$(port_of base-sepolia)
node "$ROOT/scripts/live-checks/pool-evm-deploy.mjs" --deployment "$OUT/stopped.json" --rpc "http://127.0.0.1:$p,http://localhost:$p" | grep -E "FAIL|: (PASS|FAIL)$" | head -3 || true
for chain in base-sepolia robinhood-testnet; do
  port=$(port_of "$chain")
  node "$ROOT/scripts/live-checks/pool-evm-deploy.mjs" --deployment "$OUT/$chain.json" --rpc "http://127.0.0.1:$port,http://localhost:$port" --record "$OUT/$chain-answers.json"
done
