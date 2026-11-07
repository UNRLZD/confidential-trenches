#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 2 of the mainnet money run (card vault-mainnet-money), while paste 1 waits: opens U, the run's deposit
# account, so it can take 5 USDC and sign its deposit. Real money (0.01125 NEAR): the owner's paste, from confidential.unrlzd.near, signed from KR10's
# key file in near-cli-rs's own process (as mainnet-v1/4-fee-recipient.sh), so no seed phrase is typed anywhere.
# 1. U from <state>.u (paste 1 writes it; this paste never reads the state file, which holds the seed), then
#    mainnet-money.ts check --u U: the gate (the record is mainnet-v1.pin.json, the kit's mainnet vault and USDC,
#    mainnet's release pair, both release relayers named), the vault read on FastNEAR and dRPC (no key, the record's
#    code, asset and scope) and U's state on both. Any refusal stops here with nothing sent.
# 2. U does not exist: sends it 0.01 NEAR (an implicit account exists once it holds NEAR; its key then signs U's
#    delegate, which the deposit relayer pays the gas of). U exists: nothing.
# 3. U is not registered on USDC: storage_deposit({"account_id":U,"registration_only":true}) with 0.00125 NEAR, the
#    token's storage_balance_bounds().min (mainnet-v1/reads.mjs reads min = max on both RPCs first). Registered: nothing.
# 4. Reads U back with check until it exists and is registered on both RPCs, else exit 1.
# Each send's "Transaction ID" line is kept in <state>.open-u.txs for the record (3-record.sh). near-cli-rs writes its
# whole final command (the key file's path, no key) to std::env::temp_dir()/near-cli-rs-final-command.log
# (src/common.rs l.4070-4086 at v0.30.1), so it runs with --quiet and TMPDIR set to a new private folder, removed on
# every exit. Rerun it at any time: it sends only what U still lacks.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
KEY="$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json"
STATE="$HOME/.confidential-trenches/runs/vault-mainnet-money.json"
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
MIN=1250000000000000000000
[ -f "$STATE.u" ] || { echo "paste 2: no $STATE.u: start paste 1 first, and run this once it prints U"; exit 1; }
U=$(cat "$STATE.u")
printf '%s\n' "$U" | grep -Eq '^[0-9a-f]{64}$' || { echo "paste 2: $STATE.u holds no U: nothing was sent"; exit 1; }
ids() {
  node contracts/vault/scripts/mainnet-money.ts check --u "$U"
}
field() {
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p" | tr -d '"'
}
OUT=$(ids) || { echo "paste 2: the run's gate or the vault read refused (above): nothing was sent"; exit 1; }
echo "paste 2: U is $U"
PRIV=$(mktemp -d)
chmod 700 "$PRIV"
trap 'rm -rf "$PRIV"' EXIT
trap 'rm -rf "$PRIV"; exit 130' INT
trap 'rm -rf "$PRIV"; exit 143' TERM
trap 'rm -rf "$PRIV"; exit 129' HUP
TXS="$STATE.open-u.txs"
cli() {
  TMPDIR="$PRIV" npx --yes near-cli-rs@0.30.1 --quiet "$@" > "$PRIV/out" 2>&1
  RC=$?
  cat "$PRIV/out"
  sed -n 's/.*Transaction ID: \([1-9A-HJ-NP-Za-km-z]\{43,44\}\).*/\1 confidential.unrlzd.near/p' "$PRIV/out" >> "$TXS"
  return $RC
}
if [ "$(field "$OUT" u_exists)" != true ]; then
  cli tokens confidential.unrlzd.near send-near "$U" '0.01 NEAR' \
    network-config mainnet sign-with-access-key-file "$KEY" send \
    || { echo "paste 2: the 0.01 NEAR send to U failed, or its answer was lost: rerun this paste (it reads U first)"; exit 1; }
fi
if [ "$(field "$OUT" u_registered)" != true ]; then
  set +e
  node "$HERE/../mainnet-v1/reads.mjs" fee-before "$USDC" "$U" "$MIN"
  RC=$?
  set -e
  if [ "$RC" = 0 ]; then
    cli contract call-function as-transaction "$USDC" storage_deposit \
      json-args "{\"account_id\":\"$U\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit "$MIN yoctoNEAR" \
      sign-as confidential.unrlzd.near network-config mainnet sign-with-access-key-file "$KEY" send \
      || { echo "paste 2: U's USDC registration failed, or its answer was lost: rerun this paste (it reads U first)"; exit 1; }
  elif [ "$RC" != 4 ]; then
    echo "paste 2: the USDC reads did not pass (exit $RC): U's registration was not sent"; exit 1
  fi
fi
for i in 1 2 3 4 5 6 7 8 9 10; do
  OUT=$(ids) || OUT=
  if [ "$(field "$OUT" u_exists)" = true ] && [ "$(field "$OUT" u_registered)" = true ]; then
    echo "paste 2: U $U exists and is registered on USDC on both RPCs. Next: send 5 USDC (NEAR, contract $USDC) to $U from any wallet or exchange; paste 1 goes on once it lands."
    exit 0
  fi
  sleep 3
done
echo "paste 2: U is not read as existing and registered on both RPCs: read the Transaction IDs above back before anything else"
exit 1
