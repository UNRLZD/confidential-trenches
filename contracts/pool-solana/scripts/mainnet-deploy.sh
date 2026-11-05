#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The owner's mainnet paste of the Solana pool program (card pool-sol-deploy-mainnet), one line from the repository:
#   sh contracts/pool-solana/scripts/mainnet-deploy.sh <your Solana address: where the run's leftover SOL goes back>
#   sh contracts/pool-solana/scripts/mainnet-deploy.sh <your Solana address> --program <id>
#     the resume of a run that stopped after its deploy (the program is final already): it reads the program on both
#     RPCs as the pinned code with authority none, then makes the pool if missing and the lookup table, as below
# 1. The solana CLI: Agave v4.4.0's release for this Mac, fetched from its GitHub release into a new folder that is
#    removed on exit, refused unless the file's sha256 is the pin below (GitHub's own digest of that asset, uploaded by
#    anza-team on 28 Oct, read 5 Nov 14:49Z) and its `solana --version` is 4.4.0 (src:9ef63128), the release CI's
#    pool-solana job builds with. It goes first on this run's PATH only, so deploy.mjs's CLI calls use it and no other.
# 2. deploy.mjs --mainnet with CI run 42012187381's pool-solana build. Before any key, journal or transaction it refuses:
#    code whose sha256 is not the pin (scripts/pin.mjs: contracts/pool-review-2.md, c86fc7fc..., 79,088 B), a URL other
#    than api.mainnet-beta.solana.com, either of the two mainnet RPCs not answering mainnet's genesis, a return address
#    that is not a wallet in use on both RPCs (a key on the ed25519 curve, a system account holding lamports), and pump Global (the lookup table's venue) read differently on the two RPCs. Then it prints the
#    program id, the funder and the need with its parts, computed from the code's size and mainnet's rent, and waits.
#    Send exactly that many lamports to the printed funder from the address you passed (the line says "send from" it):
#    nothing is sent while the funder holds less. Every signature it signs is journaled before its send (contracts/pool-solana/deployments/mainnet.journal.json);
#    it deploys --final (upgrade authority none), makes the pool, makes the pool buy's lookup table from the kit's list,
#    reads it back, freezes it and reads it back, all on both RPCs at finalized, sweeps the rest back to your address
#    and writes contracts/pool-solana/deployments/mainnet.json.
# 3. The live check on mainnet: records its answers (the card's good answer, scripts/live-checks/
#    pool-sol-deploy-mainnet.good.json) and, on PASS, writes the run record scripts/live-checks/pool-sol-deploy-mainnet.md.
# Nothing is typed in: no seed phrase or key is asked for. The run's two keys are made in memory and kept in a 0700
# folder only until the cleanup reads the funder empty on both RPCs. Ctrl-C or a closed terminal stops the run at its
# next step and its cleanup sweeps every lamport back; this shell waits for it before removing the CLI.
set -eu
if [ $# -ne 1 ] && { [ $# -ne 3 ] || [ "$2" != "--program" ]; }; then
  echo "usage: sh contracts/pool-solana/scripts/mainnet-deploy.sh <your Solana address, where the run's leftover SOL goes back> [--program <id>]"
  exit 1
fi
RETURN=$1
shift
# the resume's two words, or none
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
CI_RUN=42012187381
RELEASE=https://github.com/anza-xyz/agave/releases/download/v4.4.0
case "$(uname -s) $(uname -m)" in
  "Darwin arm64") ASSET=solana-release-aarch64-apple-darwin.tar.bz2; PIN=7f54760a17ccc51b9aee2e019ef1f841a06edfaa8104ba30f94a877ceec0e8e0 ;;
  "Darwin x86_64") ASSET=solana-release-x86_64-apple-darwin.tar.bz2; PIN=d072e2cfcebda282041e7878ea1c2029eb5cff9c777ea1b1953e5c98148bc85f ;;
  *) echo "this paste runs on a Mac (Darwin arm64 or x86_64), not $(uname -s) $(uname -m): nothing was fetched or sent"; exit 1 ;;
esac
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
# a caught signal: this shell waits for deploy.mjs's own cleanup (it handles INT, TERM and HUP) before the EXIT trap
trap ':' INT TERM HUP
curl -sSfL --proto '=https' --tlsv1.2 -o "$D/agave.tar.bz2" "$RELEASE/$ASSET"
GOT=$(shasum -a 256 "$D/agave.tar.bz2" | cut -d' ' -f1)
if [ "$GOT" != "$PIN" ]; then
  echo "the solana CLI download $ASSET has sha256 $GOT, not the pinned $PIN: nothing was sent"
  exit 1
fi
tar -xjf "$D/agave.tar.bz2" -C "$D"
BIN="$D/solana-release/bin"
VERSION=$("$BIN/solana" --version)
case "$VERSION" in
  "solana-cli 4.4.0 (src:9ef63128;"*) echo "the solana CLI: $VERSION, sha256 $GOT (pinned)" ;;
  *) echo "the solana CLI says \"$VERSION\", not 4.4.0 (src:9ef63128): nothing was sent"; exit 1 ;;
esac
mkdir -p contracts/pool-solana/deployments
PATH="$BIN:$PATH" node contracts/pool-solana/scripts/deploy.mjs --mainnet --url https://api.mainnet-beta.solana.com \
  --ci-run "$CI_RUN" --return "$RETURN" --out contracts/pool-solana/deployments/mainnet.json "$@"
node scripts/live-checks/pool-sol-deploy-mainnet.mjs --record scripts/live-checks/pool-sol-deploy-mainnet.good.json --write-record
