#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The testnet rehearsal of the mainnet money run (card vault-mainnet-money), on a test machine of the team's, the seed
# made there and never moved, every step from a fresh clone as the mainnet pastes run. Two jobs, because U exists only once
# the run has planned and its test USDC comes from outside the job (nobody's key in the job holds any):
#   env PNPM=pnpm sh contracts/vault/scripts/mainnet-money/rehearse-testnet.sh plan
#     run (plans, writes the seed once, prints U, waits) stopped after PLAN_SECONDS: the rehearsal's stop; then open-u
#     from P's key file (0.01 NEAR to U, U's registration) and, once, the named account's registration (--register);
#     then check prints U's state. Fund U with at least 1 test USDC in one transfer, then:
#   env PNPM=pnpm sh contracts/vault/scripts/mainnet-money/rehearse-testnet.sh finish <fund-hash> <fund-signer>
#     resume (restores from the seed: the deposit, the withdrawal to the named account, its arrival), sweep-u (any USDC
#     left at U, or "nothing to sweep"), then record --network testnet with the funding tx: every tx read back FINAL on
#     both RPCs, into the run's folder, copied into this checkout's scripts/live-checks/ for the job's copy-back.
# The clone: a new folder holding one commit of this checkout's HEAD tree, made with fixed names and dates, so the plan
# job and the finish job (each its own clone) name the same commit. It is not on main (the reviewed commit is merged
# only after this rehearsal): --not-on-main skips only the gate's origin and main check, and the driver and the gate
# refuse it on mainnet. Every other check of the mainnet pastes holds: the clone's own config, every file the commit's,
# node_modules from the lockfile resolving inside it, the commit held again before each signature and in each step file.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1
STATE=${REHEARSE_STATE:-"$HOME/ct-runs/vault-mainnet-money-testnet-clone"}
P=bf-vt-20261102t071444.testnet
KEY=${REHEARSE_KEY:-"$HOME/.near-credentials/testnet/$P.json"}
TO=bf-vt-20261102t071444.testnet
G=g-2b700409.bf-vt-20261102t071444.testnet
PLAN_SECONDS=${PLAN_SECONDS:-180}
case "${1:-}" in
  plan) ;;
  finish) [ $# = 3 ] || { echo "rehearse: finish <fund-hash> <fund-signer>: the transfer that sent U its test USDC"; exit 1; } ;;
  *) echo "rehearse: plan | finish <fund-hash> <fund-signer>"; exit 1 ;;
esac
TREE=$(git -C "$ROOT" rev-parse 'HEAD^{tree}')
CLONE=$(mktemp -d "${TMPDIR:-/tmp}/vmm-rehearse.XXXXXX")
git -c init.defaultBranch=main init -q "$CLONE"
git -C "$CLONE" fetch -q "$ROOT" HEAD
C=$(env GIT_AUTHOR_NAME=rehearsal GIT_AUTHOR_EMAIL=rehearsal@invalid GIT_COMMITTER_NAME=rehearsal GIT_COMMITTER_EMAIL=rehearsal@invalid \
  GIT_AUTHOR_DATE=2026-11-08T00:00:00Z GIT_COMMITTER_DATE=2026-11-08T00:00:00Z git -C "$CLONE" commit-tree "$TREE" -m "vault-mainnet-money rehearsal")
git -C "$CLONE" -c advice.detachedHead=false checkout -q --detach "$C"
echo "rehearse: a fresh clone at $C (tree $TREE) in $CLONE"
cd "$CLONE"
node contracts/vault/scripts/source-gate.mjs --commit "$C" --before-install --not-on-main --network testnet
${PNPM:-pnpm} install --frozen-lockfile
D="node contracts/vault/scripts/mainnet-money.ts"
NET="--network testnet --bind-relayer $G --commit $C --not-on-main"
case "$1" in
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
    $D resume $NET --state "$STATE" --to "$TO"
    $D sweep-u $NET --state "$STATE"
    $D record $NET --state "$STATE" --fund-tx "$2" "$3"
    cp "$STATE/vault-mainnet-money.testnet.run.json" "$STATE/vault-mainnet-money.testnet.md" "$ROOT/scripts/live-checks/"
    ;;
esac
