#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 4 of the mainnet vault (card vault-mainnet-deploy): registers the withdrawal fee recipient fees.unrlzd.near
# (owner, 7 Nov 09:27Z) on mainnet USDC, so every fee quote and every withdrawal send stops holding (apps/helper fee.ts
# readFeeAccount, send.ts check 7b). The owner's NEAR pays it, from confidential.unrlzd.near (signed from KR10's key
# file, this process only), so no seed phrase is typed.
# 1. Reads USDC's storage_balance_bounds on FastNEAR and dRPC: min = max = 1250000000000000000000 yocto (0.00125 N) on
#    both, else nothing is sent; and storage_balance_of(fees.unrlzd.near): null on both (already registered: nothing to
#    do, exit 0).
# 2. Sends storage_deposit({"account_id":"fees.unrlzd.near","registration_only":true}) with exactly that deposit.
# 3. Reads storage_balance_of(fees.unrlzd.near) back on both RPCs at final: non-null, else exit 1.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
KEY="$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json"
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
FEES=fees.unrlzd.near
MIN=1250000000000000000000
READ='
const [usdc, fees, min, mode] = process.argv.slice(1);
const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const view = async (u, m, a) => {
  const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", account_id: usdc, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64"), finality: "final" } }), signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (!j.result) throw new Error(`${m} on ${u}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
};
const bal = [];
for (const u of RPCS) {
  if (mode === "before") {
    const b = await view(u, "storage_balance_bounds", {});
    if (b.min !== min || b.max !== min) { console.error(`paste 4: USDC storage_balance_bounds on ${u} is ${JSON.stringify(b)}, not min = max = ${min}: nothing was sent`); process.exit(1); }
  }
  bal.push(await view(u, "storage_balance_of", { account_id: fees }));
  console.log(`paste 4: ${fees} on USDC on ${u}: ${JSON.stringify(bal.at(-1))}`);
}
if (mode === "before") process.exit(bal.every((b) => b === null) ? 0 : bal.every((b) => b !== null) ? 4 : 1);
process.exit(bal.every((b) => b !== null) ? 0 : 1);
'
set +e
node --input-type=module -e "$READ" "$USDC" "$FEES" "$MIN" before
RC=$?
set -e
[ "$RC" = 4 ] && { echo "paste 4: $FEES is already registered on USDC on both RPCs: nothing to send"; exit 0; }
[ "$RC" = 0 ] || { echo "paste 4: the reads did not pass (exit $RC): nothing was sent"; exit 1; }
npx --yes near-cli-rs@0.30.1 contract call-function as-transaction "$USDC" storage_deposit \
  json-args "{\"account_id\":\"$FEES\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit "$MIN yoctoNEAR" \
  sign-as confidential.unrlzd.near network-config mainnet sign-with-access-key-file "$KEY" send
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node --input-type=module -e "$READ" "$USDC" "$FEES" "$MIN" after; then echo "paste 4: $FEES is registered on USDC on both RPCs"; exit 0; fi
  sleep 3
done
echo "paste 4: $FEES is not read as registered on both RPCs: read the send's Transaction ID above back before anything else"
exit 1
