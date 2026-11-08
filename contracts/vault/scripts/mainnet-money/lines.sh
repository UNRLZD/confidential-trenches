#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The owner's paste lines of the mainnet money run (card vault-mainnet-money), for the reviewed commit once it is merged
# to main. The CO prints them, never the owner:
#   sh contracts/vault/scripts/mainnet-money/lines.sh <commit> <the account paste 1 pays>
# Each line, pasted in any folder, reads nothing of the owner's checkout: with no environment but HOME and PATH and no
# global or system git config (so no url.insteadOf, no status or index setting of anyone's applies), it clones the
# public repo into a new folder of its own under ~/.confidential-trenches/src/, checks the commit out detached and runs
# that commit's own paste script, which holds the clone to the commit (source-gate.mjs: the commit is on main, every
# file is the commit's), installs from the lockfile there and hands the commit to the driver, which holds it again right
# before each signature. The run's folder (~/.confidential-trenches/runs/vault-mainnet-money) is outside every clone, so
# a later paste from a new clone at the same commit goes on with it. Paste 3 takes its txs after the line's end.
set -eu
REPO=https://github.com/UNRLZD/confidential-trenches.git
[ $# = 2 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$' && printf '%s' "$2" | grep -Eq '^[a-z0-9._-]{2,64}$' || { echo "lines: <commit, 40 hex, merged to main> <the NEAR account paste 1 pays>"; exit 1; }
line() {
  # $1 the paste script, then its arguments; the clone's folder is made by mktemp, mode 700, never reused
  S=$1
  shift
  printf '%s\n' "env -i HOME=\"\$HOME\" PATH=\"\$PATH\" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 sh -c 'set -eu; mkdir -p \"\$HOME/.confidential-trenches/src\"; D=\$(mktemp -d \"\$HOME/.confidential-trenches/src/vmm.XXXXXX\"); git clone -q $REPO \"\$D\"; cd \"\$D\"; git -c advice.detachedHead=false checkout -q --detach \"\$1\"; exec sh contracts/vault/scripts/mainnet-money/$S \"\$@\"' vmm $*"
}
echo "# 1, the run (waits for U's USDC; paste it again after any stop):"
line 1-run.sh "$1" "$2"
echo "# 2, while 1 waits: opens U"
line 2-open-u.sh "$1"
echo "# 3, once 1 has printed 'next: paste 3': the record; add --fund-tx <hash> <signer> (and --settle-tx <hash> <signer> when settled) at the end"
line 3-record.sh "$1"
echo "# 4, only when USDC is left at U: sends it to the account 1 pays"
line 4-sweep-u.sh "$1"
