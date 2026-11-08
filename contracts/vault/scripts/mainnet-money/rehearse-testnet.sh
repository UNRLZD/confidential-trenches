#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The testnet rehearsal of the mainnet money run (card vault-mainnet-money), on the box through heavy.sh, the seed made
# there and never moved. Two jobs, because U exists only once the run has planned and its test USDC comes from outside
# the job (nobody's key in the job holds any):
#   HEAVY_REMOTE=1 scripts/heavy.sh vmm-rehearse-plan -- sh contracts/vault/scripts/mainnet-money/rehearse-testnet.sh plan
#     run (plans, writes the seed once, prints U, waits) stopped after PLAN_SECONDS: the rehearsal's stop; then open-u
#     from P's key file (0.01 NEAR to U, U's registration) and, once, the named account's registration (--register);
#     then check prints U's state. Fund U with at least 1 test USDC in one transfer, then:
#   HEAVY_REMOTE=1 scripts/heavy.sh vmm-rehearse-finish -- sh contracts/vault/scripts/mainnet-money/rehearse-testnet.sh finish <fund-hash> <fund-signer>
#     resume (restores from the seed: the deposit, the withdrawal to the named account, its arrival), sweep-u (any USDC
#     left at U, or "nothing to sweep"), then record --network testnet with the funding tx: every tx read back FINAL on
#     both RPCs, into scripts/live-checks/vault-mainnet-money.testnet.run.json and .md.
# Every step is the driver's (mainnet-money.ts); keys are read only by its own process from the key file's path.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
STATE=${REHEARSE_STATE:-"$HOME/ct-runs/vault-mainnet-money-testnet"}
P=bf-vt-20261102t071444.testnet
KEY=${REHEARSE_KEY:-"$HOME/.near-credentials/testnet/$P.json"}
TO=bf-vt-20261102t071444.testnet
G=g-2b700409.bf-vt-20261102t071444.testnet
PLAN_SECONDS=${PLAN_SECONDS:-180}
D="node contracts/vault/scripts/mainnet-money.ts"
NET="--network testnet --bind-relayer $G"
case "${1:-}" in
  plan)
    mkdir -p "$(dirname "$STATE")"
    chmod 700 "$(dirname "$STATE")"
    set +e
    timeout "$PLAN_SECONDS" $D run $NET --state "$STATE" --to "$TO"
    RC=$?
    set -e
    # 124: stopped while it waits for U's USDC, the rehearsal's stop; any other exit is the run's own refusal
    [ "$RC" = 124 ] || { echo "rehearse: run ended with exit $RC before its wait: see above"; exit 1; }
    if grep -q "storage_deposit of $TO on" "$STATE/open-u.json" 2>/dev/null; then
      $D open-u $NET --state "$STATE" --payer "$P" --key-file "$KEY"
    else
      $D open-u $NET --state "$STATE" --payer "$P" --key-file "$KEY" --register "$TO"
    fi
    $D check $NET --state "$STATE" --to "$TO"
    ;;
  finish)
    [ $# = 3 ] || { echo "rehearse: finish <fund-hash> <fund-signer>: the transfer that sent U its test USDC"; exit 1; }
    $D resume $NET --state "$STATE" --to "$TO"
    $D sweep-u $NET --state "$STATE"
    $D record $NET --state "$STATE" --fund-tx "$2" "$3"
    ;;
  *)
    echo "rehearse: plan | finish <fund-hash> <fund-signer>"
    exit 1
    ;;
esac
