#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 1 of the mainnet test vault (card vault-mainnet-test; vault.md VT-R01): unrlzd.near creates
# confidential.unrlzd.near (owner-decisions vaultname) with 0.1 NEAR and one full-access key, the public key M200 (2)
# and runbook KR10 name.
# 1. Before anything is sent: KR10's key file must hold that key. Its public half is derived from the private key in
#    this process (deploy.mjs loadKey, which also refuses a file inside the repo or for another account) and compared;
#    nothing of the key is printed. A mismatch stops here, so no account is made whose key we do not hold.
# 2. near-cli-rs 0.30.1 (npm, published 2026-09-02) asks for unrlzd.near's seed phrase at its prompt (never in the
#    shell history), then shows the transaction: pick "send". near-cli-rs writes its whole final command, the seed
#    phrase in it, to std::env::temp_dir()/near-cli-rs-final-command.log on every run (src/common.rs l.4070-4086 at
#    v0.30.1, save_cli_command, called from src/main.rs l.168 and l.191) and prints it unless --quiet (l.161, l.185).
#    So it runs with --quiet and with TMPDIR set to a new private folder (std::env::temp_dir() reads TMPDIR on Unix),
#    removed on every exit, Ctrl-C and a closed terminal included.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEPLOY="$HERE/../deploy.mjs"
KEY="$HOME/.confidential-trenches/keys/confidential.unrlzd.near.json"
KR10_PUBLIC_KEY=ed25519:WHHJ4Rmp2dzkkWtE5UuNkeEnw6JCnXLPrnXV6fiQhhh

# the paths go in by the environment: as argv[1], deploy.mjs's path would make importing it run its main
P1_DEPLOY="$DEPLOY" P1_KEY="$KEY" P1_WANT="$KR10_PUBLIC_KEY" node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { P1_DEPLOY: deploy, P1_KEY: file, P1_WANT: want } = process.env;
  const { loadKey } = await import(pathToFileURL(deploy).href);
  const { b58encode } = await import(new URL("near-tx.mjs", pathToFileURL(deploy)).href);
  let pub;
  try {
    pub = `ed25519:${b58encode(loadKey(file, "confidential.unrlzd.near").pub)}`;
  } catch (e) {
    console.error(`paste 1: KR10 key file ${file}: ${e.message}: nothing was sent`);
    process.exit(1);
  }
  if (pub !== want) {
    console.error(`paste 1: KR10 key file ${file} holds ${pub}, not ${want}: nothing was sent`);
    process.exit(1);
  }
  console.log(`paste 1: KR10 key file holds ${want}`);
'

PRIV=$(mktemp -d)
chmod 700 "$PRIV"
trap 'rm -rf "$PRIV"' EXIT
trap 'rm -rf "$PRIV"; exit 130' INT
trap 'rm -rf "$PRIV"; exit 143' TERM
trap 'rm -rf "$PRIV"; exit 129' HUP
set +e
TMPDIR="$PRIV" npx --yes near-cli-rs@0.30.1 --quiet account create-account fund-myself confidential.unrlzd.near '0.1 NEAR' \
  use-manually-provided-public-key "$KR10_PUBLIC_KEY" \
  sign-as unrlzd.near network-config mainnet sign-with-seed-phrase
RC=$?
set -e
rm -rf "$PRIV"
echo "paste 1: near-cli-rs exited $RC. Press Cmd-K now to clear this window: its prompt showed the seed phrase."
exit "$RC"
