#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 1 of the mainnet money run (card vault-mainnet-money): the deposit and the relayed withdrawal, both carried by
# the deployed helper (its mainnet switch, apps/helper/deploy/vault-lines.sh, must be live first). Real money: the
# owner's paste. It types no secret: the run's seed is made here, in a new state file (mode 600, outside the repo).
# mainnet-money.ts run, in one process (its note store lives in memory from plan to change note):
#   1. the gate and the vault read on FastNEAR and dRPC; the relayer's fee held to the device's own fee_max before
#      anything moves; any refusal stops here with nothing signed;
#   2. plans the note and prints U, also written alone to <state>.u; waits up to an hour for U to exist and hold
#      5 USDC: run paste 2 (2-open-u.sh) in a second terminal, then send 5 USDC to U from any wallet or exchange;
#   3. U's deposit (the wallet's bindDeposit to POST /v1/bind), its leaf read on both RPCs, then the withdrawal (the
#      signing page's withdrawHandoff to POST /v1/withdraw), followed to its spends row and change leaf.
# It refuses a state that holds a run already: a stopped run is never planned again (a fresh note store draws a new
# lane); its deposit, if it landed, is the run's 12 words'.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
DIR="$HOME/.confidential-trenches/runs"
STATE="$DIR/vault-mainnet-money.json"
mkdir -p "$DIR"
chmod 700 "$DIR"
exec node contracts/vault/scripts/mainnet-money.ts run --state "$STATE"
