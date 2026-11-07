#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 3 of the mainnet vault (card vault-mainnet-deploy; vault.md V3.8, VT-R02): the read-back's one write.
# 1. scripts/live-checks/vault-mainnet-deploy.mjs reads the vault on FastNEAR and dRPC against mainnet-v1.json (keys [],
#    the pinned code hash and sha256, the import and export lists, config() with mainnet USDC, the vault registered on
#    USDC). Only when every read passes does it print the write, a storage_prepay of a fresh precommitment with exactly
#    756 B x 1e19 = 0.00756 N attached (exit 3). Anything else stops here, with nothing signed.
# 2. near-cli-rs 0.30.1 signs that one call as confidential.unrlzd.near from KR10's key file (sign-with-access-key-file,
#    this process only) and sends it.
# 3. The check reads the write back on both RPCs by its Transaction ID and the same precommitment, and records every
#    answer to scripts/live-checks/vault-mainnet-deploy.answers.json (signatures replaced), the card's good answer.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
KEY="$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json"
VAULT=vault.confidential.unrlzd.near
[ -f contracts/vault/deployments/mainnet-v1.json ] || { echo "no contracts/vault/deployments/mainnet-v1.json: run paste 2 first; nothing was signed"; exit 1; }
set +e
OUT=$(node scripts/live-checks/vault-mainnet-deploy.mjs)
RC=$?
set -e
echo "$OUT"
[ "$RC" = 3 ] || { echo "the reads did not pass (exit $RC): nothing was signed"; exit 1; }
P=$(echo "$OUT" | sed -n 's/^near call vault\.confidential\.unrlzd\.near storage_prepay .{"precommitment":"\([0-9]*\)"}. .*--networkId mainnet$/\1/p' | head -1)
[ -n "$P" ] || { echo "no precommitment in the check's write line: nothing was signed"; exit 1; }
SENT=$(npx --yes near-cli-rs@0.30.1 contract call-function as-transaction "$VAULT" storage_prepay \
  json-args "{\"precommitment\":\"$P\"}" prepaid-gas '30 Tgas' attached-deposit '7560000000000000000000 yoctoNEAR' \
  sign-as confidential.unrlzd.near network-config mainnet sign-with-access-key-file "$KEY" send 2>&1) || { echo "$SENT"; echo "the send failed"; exit 1; }
echo "$SENT"
TX=$(echo "$SENT" | grep -o 'Transaction ID: [1-9A-HJ-NP-Za-km-z]\{43,44\}' | head -1 | sed 's/.* //')
[ -n "$TX" ] || { echo "no Transaction ID in the answer above: read it back with --precommitment $P --tx <its id>"; exit 1; }
node scripts/live-checks/vault-mainnet-deploy.mjs --precommitment "$P" --tx "$TX" --record scripts/live-checks/vault-mainnet-deploy.answers.json
