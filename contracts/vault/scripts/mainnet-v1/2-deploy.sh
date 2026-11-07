#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 2 of the mainnet vault (card vault-mainnet-deploy; vault.md 2.8, VT-R02): the keyless deploy of
# vault.confidential.unrlzd.near (M304 D-13), signed by confidential.unrlzd.near from KR10's key file.
# 1. Downloads the vault-mainnet-wasm artifact of vault-build run RUN, refused unless GitHub says that run is of
#    UNRLZD/confidential-trenches itself (not a fork), of .github/workflows/vault-build.yml, at REVIEWED (the vault's
#    final source commit, testnet-v4.json's source_commit), completed and successful.
# 2. Hashes the wasm here and stops, nothing sent, unless its sha256 is PIN (mainnet-v1.pin.json's wasm_sha256 and
#    deploy.mjs MAINNET_PINS', held equal by mainnet-v1-pastes.test.mjs). deploy.mjs hashes it again.
# 3. Runs deploy.mjs on mainnet. Before anything is sent it refuses: a wasm that is not the pin of MAINNET_PINS and the
#    record, whose NEP-330 metadata does not name REVIEWED, missing a required export or naming a test token; a chain id
#    other than mainnet on FastNEAR or dRPC; a parent key that is not its full-access key; a parent balance short of
#    2.3723 N (code storage 2.3123 N + registration bound 0.01 N + gas 0.05 N); a vault account that exists; a batch
#    other than exactly [CreateAccount, Transfer, DeployContract, FunctionCall(config)].
# 4. Sends that one batch (no AddKey: the vault never holds a key), reads keys [] and the code hash back on both RPCs at
#    final, registers the vault on mainnet USDC with storage_balance_bounds().min (0.00125 N, min = max read on both
#    RPCs 7 Nov 09:59Z) and reads storage_balance_of back, then writes contracts/vault/deployments/mainnet-v1.json from
#    mainnet-v1.pin.json and the landed transactions. Until both are done the only record is mainnet-v1.partial.json.
# 5. If anything fails once the batch is sent (a timeout, the registration), this paste is never run again as it is:
#    deploy.mjs prints the same command with --resume-tx <the batch hash>, which checks the landed batch on both RPCs
#    and finishes the read-back, the registration and mainnet-v1.json. Paste it with `sh 2-deploy.sh --resume-tx <hash>`.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
REPO=UNRLZD/confidential-trenches
RUN=42355216946
REVIEWED=e0623bf3244dee5115a8b18cbdb54ca355fd3c25
PIN=a4a2af6960d93e5187271cf401ffe0e1a6f1ae5da0af1d82b1250eee313e87fc
RESUME=
if [ $# -eq 2 ] && [ "$1" = --resume-tx ]; then RESUME="$2"; elif [ $# -ne 0 ]; then echo "usage: 2-deploy.sh [--resume-tx <batch hash>]"; exit 2; fi
GOT=$(gh api "repos/$REPO/actions/runs/$RUN" --jq '[.head_repository.full_name, .head_sha, .path, .status, .conclusion] | join(" ")')
[ "$GOT" = "$REPO $REVIEWED .github/workflows/vault-build.yml completed success" ] || { echo "vault-build run $RUN is \"$GOT\", not $REPO at $REVIEWED, completed and successful: nothing was sent"; exit 1; }
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
gh run download "$RUN" -R "$REPO" -n vault-mainnet-wasm -D "$D"
SHA=$(shasum -a 256 "$D/blindfill_vault.wasm" | cut -d' ' -f1)
[ "$SHA" = "$PIN" ] || { echo "the wasm of vault-build run $RUN hashes to $SHA, not the pin $PIN: nothing was sent"; exit 1; }
echo "the wasm of vault-build run $RUN hashes to the pin $PIN"
node contracts/vault/scripts/deploy.mjs --network mainnet --parent confidential.unrlzd.near \
  --vault vault.confidential.unrlzd.near \
  --key-file "$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json" \
  --wasm "$D/blindfill_vault.wasm" \
  --deployment contracts/vault/deployments/mainnet-v1.pin.json --out contracts/vault/deployments/mainnet-v1.json \
  ${RESUME:+--resume-tx "$RESUME"}
