#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 1 of the mainnet money run (card vault-mainnet-money): the deposit and the relayed withdrawal, both carried by
# the deployed helper (its mainnet switch, apps/helper/deploy/vault-lines.sh, must be live first). Real money: the
# owner's paste, with the NEAR account the withdrawal pays as its one argument (an existing account the owner holds):
#   sh contracts/vault/scripts/mainnet-money/1-run.sh <your-account.near>
# It types no secret. mainnet-money.ts run, with the run's folder ~/.confidential-trenches/runs/vault-mainnet-money/
# (mode 700, outside the repo):
#   1. the gate and the vault read on FastNEAR and dRPC, the named account read on both (it must exist), the relayer's
#      fee held to the device's own fee_max; any refusal stops here with nothing signed;
#   2. the first time, makes the run's seed (written once, mode 600) and plans its note, and prints U; it then waits,
#      with no time limit, for U to exist and hold at least 1 USDC: run paste 2 (2-open-u.sh) in a second terminal,
#      then send the whole amount to U in one transfer, from any wallet or exchange; what lands first is deposited
#      whole, and USDC that reaches U after it is sent on by paste 4 (4-sweep-u.sh) to the named account;
#   3. U's deposit (the wallet's bindDeposit to POST /v1/bind), its leaf read on both RPCs, then the withdrawal of the
#      whole note less the relayer's fee to the named account (the wallet's withdrawRequest, POST /v1/withdraw),
#      followed until the spends row shows it paid to that account on both RPCs.
# Stopped anywhere (Ctrl-C, a lost connection, a closed lid): paste the same line again. It restores the run's notes
# from its seed and the vault's pages and goes on from where it stopped; keep the folder as it is.
# It runs only from a clean checkout whose HEAD is pushed (source-gate.mjs); a changed or untracked path stops it.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
[ $# = 1 ] || { echo "paste 1: name the NEAR account the withdrawal pays: sh $0 <your-account.near>"; exit 1; }
DIR="$HOME/.confidential-trenches/runs"
mkdir -p "$DIR"
chmod 700 "$DIR"
node contracts/vault/scripts/source-gate.mjs
exec node contracts/vault/scripts/mainnet-money.ts run --state "$DIR/vault-mainnet-money" --to "$1"
