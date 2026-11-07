#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 4 of the mainnet vault (card vault-mainnet-deploy): registers the withdrawal fee recipient fees.unrlzd.near
# (owner, 7 Nov 09:27Z) on mainnet USDC, so every fee quote and every withdrawal send stops holding (apps/helper fee.ts
# readFeeAccount, send.ts check 7b). The owner's NEAR pays it, from confidential.unrlzd.near (signed from KR10's key
# file, this process only), so no seed phrase is typed.
# The reads are reads.mjs's (fee-before, fee-after), tested with planted answers.
# 1. Reads USDC's storage_balance_bounds on FastNEAR and dRPC: min = max = 1250000000000000000000 yocto (0.00125 N) on
#    both, else nothing is sent; and storage_balance_of(fees.unrlzd.near): null on both (already registered: nothing to
#    do, exit 0).
# 2. Sends storage_deposit({"account_id":"fees.unrlzd.near","registration_only":true}) with exactly that deposit.
# 3. Reads storage_balance_of(fees.unrlzd.near) back on both RPCs at final: non-null, else exit 1.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
KEY="$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json"
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
FEES=fees.unrlzd.near
MIN=1250000000000000000000
set +e
node "$HERE/reads.mjs" fee-before "$USDC" "$FEES" "$MIN"
RC=$?
set -e
[ "$RC" = 4 ] && { echo "paste 4: $FEES is already registered on USDC on both RPCs: nothing to send"; exit 0; }
[ "$RC" = 0 ] || { echo "paste 4: the reads did not pass (exit $RC): nothing was sent"; exit 1; }
if ! npx --yes near-cli-rs@0.30.1 contract call-function as-transaction "$USDC" storage_deposit \
  json-args "{\"account_id\":\"$FEES\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit "$MIN yoctoNEAR" \
  sign-as confidential.unrlzd.near network-config mainnet sign-with-access-key-file "$KEY" send; then
  echo "paste 4: the send failed, or its answer was lost. Rerun this paste: it reads $FEES's registration first and sends nothing once it is registered on both RPCs"
  exit 1
fi
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node "$HERE/reads.mjs" fee-after "$USDC" "$FEES"; then echo "paste 4: $FEES is registered on USDC on both RPCs"; exit 0; fi
  sleep 3
done
echo "paste 4: $FEES is not read as registered on both RPCs: read the send's Transaction ID above back before anything else"
exit 1
