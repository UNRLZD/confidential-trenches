#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The owner's mainnet paste of the EVM pool (card pool-evm-deploy-mainnet), one line per chain from the repository,
# after `pnpm install --frozen-lockfile`, with forge on PATH:
#   sh contracts/pool-evm/script/mainnet-deploy.sh base <your Base address: where the run's leftover ETH goes back>
#   sh contracts/pool-evm/script/mainnet-deploy.sh robinhood <your Robinhood chain address>
#   sh contracts/pool-evm/script/mainnet-deploy.sh <base|robinhood> --sweep-kept
#     a stopped run whose key was kept (its last line says so): sends the key's ETH back to the address that run was
#     given, and no other, then removes the key
# Each chain is its own paste: it funds, deploys and fails on its own, so a stop on one never touches the other.
# 1. deploy.mjs --mainnet. Before any key or transaction it refuses: an RPC that does not answer the chain's id (the
#    chain's own public RPC and PublicNode's, pool-evm-deploy.mjs MAINNETS), a return address with code or with no ETH
#    on either RPC, a build whose runtime is not pool-evm-deploy.build.json's or whose init code is not deploy.mjs
#    MAINNET_INIT's, and a chain whose record (contracts/pool-evm/deployments/<chain>.json) exists. Then it prints the
#    run key's address and the need with its parts, and waits. Send exactly that much ETH to the printed address from
#    the address you passed (the line says "send exactly ... from" it). It deploys the withdrawal verifier, the pool,
#    the v4 adapter, the v3 adapter and the sell delegate, each checked as the build's code on both RPCs, sweeps the
#    rest back to your address and writes contracts/pool-evm/deployments/<chain>.json.
# 2. The live check on that record, on both of the chain's RPCs: no owner, no proxy, the pinned code, the run key empty.
# Nothing is typed in: no seed phrase or key is asked for. The run key is made in memory and kept in a 0700 folder
# (~/.local/state/pool-evm-deploy) only until both RPCs read it empty; every transaction it signs is journaled
# beside the record before it is sent. Ctrl-C or a closed terminal stops the run at its next step and the sweep sends
# every wei it can back; this shell waits for it.
set -eu
usage() {
  echo "usage: sh contracts/pool-evm/script/mainnet-deploy.sh <base|robinhood> <your address, where the run's leftover ETH goes back>"
  echo "   or: sh contracts/pool-evm/script/mainnet-deploy.sh <base|robinhood> --sweep-kept"
}
FORM=
case "$#:${1:-}:${2:-}" in
  2:base:--sweep-kept|2:robinhood:--sweep-kept) FORM=sweep ;;
  2:base:-*|2:robinhood:-*) ;;
  2:base:?*|2:robinhood:?*) FORM=deploy ;;
esac
if [ -z "$FORM" ]; then
  usage
  exit 1
fi
CHAIN=$1
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
# a caught signal: this shell waits for deploy.mjs's own cleanup (it handles INT, TERM and HUP)
trap ':' INT TERM HUP
if [ "$FORM" = sweep ]; then
  node contracts/pool-evm/script/deploy.mjs --mainnet --chain "$CHAIN" --sweep-kept "contracts/pool-evm/deployments/$CHAIN.journal.json"
  exit 0
fi
command -v forge >/dev/null 2>&1 || { echo "forge is not on PATH (https://getfoundry.sh): nothing was sent"; exit 1; }
mkdir -p contracts/pool-evm/deployments
node contracts/pool-evm/script/deploy.mjs --mainnet --chain "$CHAIN" --return "$2"
node scripts/live-checks/pool-evm-deploy.mjs --deployment "contracts/pool-evm/deployments/$CHAIN.json"
