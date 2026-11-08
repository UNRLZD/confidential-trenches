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
# It runs only from a clean checkout whose HEAD is pushed (source-gate.mjs); a changed or untracked path stops it.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
node contracts/vault/scripts/source-gate.mjs
exec node contracts/vault/scripts/mainnet-money.ts open-u --state "$HOME/.confidential-trenches/runs/vault-mainnet-money" \
  --payer confidential.unrlzd.near --key-file "$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json"
