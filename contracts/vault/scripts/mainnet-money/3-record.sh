#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 3 of the mainnet money run (card vault-mainnet-money): the record. No money, no key. Writes
# vault-mainnet-money.run.json and .md (Money path: yes, one Tx line per transaction) into the run's folder, outside the
# clone (the CO commits them as scripts/live-checks/vault-mainnet-money.{run.json,md}), from the run folder's public steps, after reading every transaction back FINAL on FastNEAR and dRPC, every receipt a success:
# paste 2's (open-u.json), the relayers' as the device heard them (heard.json), and the ones the device cannot see,
# named here: the USDC send to U (its hash and signer, from the sending wallet or exchange), and the settle when the
# spends row reads settled:
#   sh contracts/vault/scripts/mainnet-money/3-record.sh <commit> --fund-tx <hash> <signer> [--settle-tx <hash> <signer>]
# and, for a relayer tx the device did not hear (its answer came after the device stopped waiting), from the
# account's tx list on any explorer: [--deposit-tx <hash> <signer>] [--withdraw-tx <hash> <signer>], each held to the run.
# It runs only from a fresh clone of the public repo at the reviewed, merged commit its line names (lines.sh prints the
# line): source-gate.mjs holds the clone to that commit before pnpm installs, and the driver again before each signature.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
[ $# -ge 1 ] || { echo "paste 3: the commit paste 1 names, then the txs: sh $0 <commit> --fund-tx <hash> <signer> ..."; exit 1; }
C=$1
shift
node contracts/vault/scripts/source-gate.mjs --commit "$C" --before-install
pnpm install --frozen-lockfile
exec node contracts/vault/scripts/mainnet-money.ts record --commit "$C" --state "$HOME/.confidential-trenches/runs/vault-mainnet-money" "$@"
