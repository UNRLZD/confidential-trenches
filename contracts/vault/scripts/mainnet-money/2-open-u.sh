#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 2 of the mainnet money run (card vault-mainnet-money), while paste 1 waits: opens U, the run's deposit
# account, so it can take USDC and sign its deposit. Real money (0.01125 NEAR): the owner's paste, from
# confidential.unrlzd.near. mainnet-money.ts open-u reads U from the run's folder (its run step, checked against the
# folder's seed), runs the gate and the vault read, then signs here, in its own process, from KR10's key file (read
# by deploy.mjs loadKey, which refuses a file in the repo or another account's key): no package is downloaded, no
# other program sees the key, no seed phrase is typed and nothing of the key is written anywhere.
#   1. U does not exist: 0.01 NEAR to it (an implicit account exists once it holds NEAR; its key then signs U's
#      delegate, which the deposit relayer pays the gas of). U exists: nothing.
#   2. U is not registered on USDC: storage_deposit({"account_id":U,"registration_only":true}) with the token's
#      storage_balance_bounds (min = max, read on both RPCs). Registered: nothing.
# Each tx is read back FINAL on both RPCs, every receipt a success, and kept in the run's open-u.json for the record.
# Rerun it at any time: it sends only what U still lacks.
# It runs only from a fresh clone of the public repo at the reviewed, merged commit its line names (lines.sh prints the
# line): source-gate.mjs holds the clone to that commit before pnpm installs, and the driver again before each signature.
#   sh contracts/vault/scripts/mainnet-money/2-open-u.sh <commit>
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
[ $# = 1 ] || { echo "paste 2: the commit paste 1 names: sh $0 <commit>"; exit 1; }
node contracts/vault/scripts/source-gate.mjs --commit "$1" --before-install
pnpm install --frozen-lockfile
exec node contracts/vault/scripts/mainnet-money.ts open-u --commit "$1" --state "$HOME/.confidential-trenches/runs/vault-mainnet-money" \
  --payer confidential.unrlzd.near --key-file "$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json"
