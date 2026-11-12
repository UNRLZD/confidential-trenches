#!/bin/sh
# One chain's fork run of the signing page's EVM pool code (pool-fork-evm.mjs), anvil forking the chain's mainnet at
# contracts/pool-evm/test/fork-rpc.mjs POOLS_FORK_BLOCKS through that file's replay of fixtures/fork-rpc-pools.json:
#   node contracts/pool-evm/test/fork-rpc.mjs [--record] --book pools -- sh packages/signpage/scripts/pool-fork-evm.sh <base|robinhood> <slots> <lag> <out.json> [<script> [args...]]
# (from the repository root, through scripts/heavy.sh: anvil is a heavy job). <slots> is anvil's --slots-in-an-epoch
# (finalized is the head less 2 x slots blocks), <lag> the head-to-finalized lag read on mainnet, in seconds. <script> runs after pool-fork-evm.mjs against the same
# fork, given the anvil URL and its args (a later card's steps on the note this run left: ANVIL=<url> in its env).
# Ports from the environment, so two runs on one machine do not collide: FORK_RPC_PORT is fork-rpc.mjs's (default 47545,
# the parent fork-rpc.mjs passes its own), ANVIL_PORT anvil's (default 48601 for base, 48602 for robinhood).
set -eu
CHAIN=$1 SLOTS=$2 LAG=$3 OUT=$4
shift 4
case "$CHAIN" in base) PORT=${ANVIL_PORT:-48601} ;; robinhood) PORT=${ANVIL_PORT:-48602} ;; *) echo "usage: pool-fork-evm.sh <base|robinhood> <slots> <lag> <out.json> [<script> [args...]]" >&2; exit 2 ;; esac
BLOCK=$(node -e 'import("./contracts/pool-evm/test/fork-rpc.mjs").then((m) => console.log(m.POOLS_FORK_BLOCKS[process.argv[1]]))' "$CHAIN")
[ -n "$BLOCK" ] || { echo "pool-fork-evm.sh: no fork block for $CHAIN" >&2; exit 2; }
anvil --port "$PORT" --fork-url "http://127.0.0.1:${FORK_RPC_PORT:-47545}/$CHAIN" --fork-block-number "$BLOCK" --slots-in-an-epoch "$SLOTS" --no-storage-caching --silent &
A=$!
trap 'kill $A 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -s -o /dev/null -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "http://127.0.0.1:$PORT" && break
  sleep 0.5
done
export ANVIL="http://127.0.0.1:$PORT"
node packages/signpage/scripts/pool-fork-evm.mjs "$CHAIN" "$ANVIL" "$OUT" --slots "$SLOTS" --lag "$LAG"
if [ $# -gt 0 ]; then node "$@"; fi
