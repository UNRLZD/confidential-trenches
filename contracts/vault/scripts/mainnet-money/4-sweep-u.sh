#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 4 of the mainnet money run (card vault-mainnet-money), only when USDC is left at U: sends all the USDC U holds
# to the account paste 1 named, in one ft_transfer signed by U itself (its key derived in mainnet-money.ts's own process
# from the run's seed; nothing typed, nothing written but the tx hash). Use it when the deposit relayer refused or
# struck U, or USDC reached U after the deposit (a second transfer): paste 1 deposits one transfer, so send one
# transfer of the whole amount. U's 0.01 NEAR pays the gas. Not while paste 1 is waiting to deposit: a sweep then takes
# the USDC that deposit would use. The tx is read back FINAL on both RPCs and kept in the run's sweep.json for the record.
# It runs only from a fresh clone of the public repo at the reviewed, merged commit its line names (lines.sh prints the
# line): source-gate.mjs holds the clone to that commit before pnpm installs, and the driver again before each signature.
#   sh contracts/vault/scripts/mainnet-money/4-sweep-u.sh <commit>
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
[ $# = 1 ] || { echo "paste 4: the commit paste 1 names: sh $0 <commit>"; exit 1; }
node contracts/vault/scripts/source-gate.mjs --commit "$1" --before-install
pnpm install --frozen-lockfile
exec node contracts/vault/scripts/mainnet-money.ts sweep-u --commit "$1" --state "$HOME/.confidential-trenches/runs/vault-mainnet-money"
