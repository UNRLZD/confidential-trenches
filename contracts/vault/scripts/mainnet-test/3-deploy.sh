#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 3 of the mainnet test vault (card vault-mainnet-test; vault.md 2.8, VT-R01): the keyless deploy.
# 1. Downloads the vault-mainnet-wasm artifact of the newest passing vault-build run on this branch (two clean builds on
#    ubuntu-24.04 whose sha256 equals the pin of contracts/vault/deployments/mainnet-test.json).
# 2. Runs deploy.mjs on mainnet as confidential.unrlzd.near, signed from KR10's key file in this process only (never
#    printed or written). Before anything is sent it refuses: a wasm that is not the pin, a missing required export, a
#    test token, a chain id other than mainnet on FastNEAR or dRPC, a parent key that is not its full-access key, a
#    parent balance short of the code storage (2.30964 N) + registration + 0.05 N, a vault account that exists, and a
#    batch other than exactly [CreateAccount, Transfer, DeployContract, FunctionCall(config)].
# 3. Sends that one batch (no AddKey, so the vault never holds a key and none is left to delete), reads keys [] and the
#    code hash back on both RPCs at final, registers the vault on mainnet USDC (0.00125 N) and rewrites
#    mainnet-test.json with the deploy's transactions.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
BRANCH=card/vault-mainnet-test
RUN=$(gh run list -R UNRLZD/confidential-trenches -w vault-build.yml -b "$BRANCH" -s success -L 1 --json databaseId -q '.[0].databaseId')
[ -n "$RUN" ] || { echo "no passing vault-build run on $BRANCH yet: nothing was sent"; exit 1; }
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
gh run download "$RUN" -R UNRLZD/confidential-trenches -n vault-mainnet-wasm -D "$D"
echo "vault-build run $RUN: $(cat "$D/blindfill_vault.wasm.sha256")"
node contracts/vault/scripts/deploy.mjs --network mainnet --parent confidential.unrlzd.near \
  --vault vault-test.confidential.unrlzd.near \
  --key-file "$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json" \
  --wasm "$D/blindfill_vault.wasm" \
  --deployment contracts/vault/deployments/mainnet-test.json --out contracts/vault/deployments/mainnet-test.json
