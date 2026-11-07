#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 3 of the mainnet money run (card vault-mainnet-money): the record. No money, no key. Writes
# scripts/live-checks/vault-mainnet-money.run.json and .md (Money path: yes, one Tx line per transaction) from the run
# folder's public steps, after reading every transaction back FINAL on FastNEAR and dRPC, every receipt a success:
# paste 2's (open-u.json), the relayers' as the device heard them (heard.json), and the ones the device cannot see,
# named here: the USDC send to U (its hash and signer, from the sending wallet or exchange), and the settle when the
# spends row reads settled:
#   sh contracts/vault/scripts/mainnet-money/3-record.sh --fund-tx <hash> <signer> [--settle-tx <hash> <signer>]
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
exec node contracts/vault/scripts/mainnet-money.ts record --state "$HOME/.confidential-trenches/runs/vault-mainnet-money" "$@"
