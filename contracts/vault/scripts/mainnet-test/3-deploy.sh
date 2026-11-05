#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 3 of the mainnet test vault (card vault-mainnet-test; vault.md 2.8, VT-R01): the keyless deploy.
# 1. Downloads the vault-mainnet-wasm artifact of one named vault-build run (two clean builds on ubuntu-24.04 whose
#    sha256 is the pin), refused unless GitHub says that run is of UNRLZD/confidential-trenches itself (not a fork), of
#    .github/workflows/vault-build.yml, at the reviewed commit, completed and successful. The sha256 file in the artifact
#    is printed as the artifact's own claim only: deploy.mjs hashes the wasm itself.
# 2. Runs deploy.mjs on mainnet as confidential.unrlzd.near, signed from KR10's key file in this process only (never
#    printed or written). Before anything is sent it refuses: a wasm that is not the pin (MAINNET_PINS and the record), a missing required export, a
#    test token, a chain id other than mainnet on FastNEAR or dRPC, a parent key that is not its full-access key, a
#    parent balance short of the code storage (2.30964 N) + registration + 0.05 N, a vault account that exists, and a
#    batch other than exactly [CreateAccount, Transfer, DeployContract, FunctionCall(config)].
# 3. Sends that one batch (no AddKey, so the vault never holds a key and none is left to delete), reads keys [] and the
#    code hash back on both RPCs at final, registers the vault on mainnet USDC (0.00125 N) and rewrites
#    mainnet-test.json with the deploy's transactions.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
REPO=UNRLZD/confidential-trenches
RUN=42017944135
REVIEWED=f3318ce3411945ff94a3fe119e2fde8ec9482198
GOT=$(gh api "repos/$REPO/actions/runs/$RUN" --jq '[.head_repository.full_name, .head_sha, .path, .status, .conclusion] | join(" ")')
[ "$GOT" = "$REPO $REVIEWED .github/workflows/vault-build.yml completed success" ] || { echo "vault-build run $RUN is \"$GOT\", not $REPO at $REVIEWED, completed and successful: nothing was sent"; exit 1; }
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
gh run download "$RUN" -R "$REPO" -n vault-mainnet-wasm -D "$D"
echo "the artifact of vault-build run $RUN claims: $(cat "$D/blindfill_vault.wasm.sha256") (deploy.mjs checks the wasm itself)"
node contracts/vault/scripts/deploy.mjs --network mainnet --parent confidential.unrlzd.near \
  --vault vault-test.confidential.unrlzd.near \
  --key-file "$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json" \
  --wasm "$D/blindfill_vault.wasm" \
  --deployment contracts/vault/deployments/mainnet-test.json --out contracts/vault/deployments/mainnet-test.json
