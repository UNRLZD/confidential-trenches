#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 3 of the mainnet money run (card vault-mainnet-money): the record. No money, no key. Writes
# scripts/live-checks/vault-mainnet-money.run.json and .md (Money path: yes, one Tx line per transaction) from the run
# state's public values, after reading every transaction back FINAL on FastNEAR and dRPC, every receipt a success.
# The transactions the device saw (the deposit relayer's, the withdrawal's) come from the state; paste 2's from
# <state>.open-u.txs; the ones it did not see are named here: the 5 USDC send to U and the helper's settle, each as
#   sh 3-record.sh --tx <hash> <signer> [--tx <hash> <signer>]...
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
STATE="$HOME/.confidential-trenches/runs/vault-mainnet-money.json"
[ -f "$STATE" ] || { echo "paste 3: no run state: pastes 1 and 2 first"; exit 1; }
set --  "$@"
if [ -f "$STATE.open-u.txs" ]; then
  while read -r H S; do set -- "$@" --tx "$H" "$S"; done < "$STATE.open-u.txs"
fi
exec node contracts/vault/scripts/mainnet-money.ts record --state "$STATE" "$@"
