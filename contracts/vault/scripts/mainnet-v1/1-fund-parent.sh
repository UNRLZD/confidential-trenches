#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 1 of the mainnet vault (card vault-mainnet-deploy): unrlzd.near sends 2 NEAR to confidential.unrlzd.near, the
# parent that signs the deploy (owner-decisions vaultname; M200, its one key KR10). Real money: the owner's paste.
# Why 2 NEAR: the parent held 0.771245 NEAR (FastNEAR and dRPC, 7 Nov 09:59Z). deploy.mjs refuses to send unless it
# holds the code storage 2.3123 N ((230130 B + 100 B) x 1e19 yocto + 0.01 N, deploy.mjs transfer) + MAX_REGISTRATION
# 0.01 N + MAINNET_GAS_MARGIN 0.05 N = 2.3723 N; after it, paste 3's storage_prepay (0.00756 N) and paste 4's fee
# recipient registration (0.00125 N) also come from it. 0.771245 + 2 = 2.771245 N covers 2.3723 N with 0.399 N left;
# after every paste about 0.43 N stays with the parent (the unused 0.01 N registration bound and the gas margin).
# Sending 2 NEAR to confidential.unrlzd.near from any wallet app or exchange is the same transfer; paste 2 reads the
# parent's balance itself and refuses short of 2.3723 N.
# Before near-cli-rs prompts for anything, reads.mjs reads unrlzd.near on FastNEAR and dRPC at final and stops, with
# nothing typed or sent, unless it can spend 2 N + a 0.01 N fee margin on both (its amount minus storage_usage x 1e19),
# printing how much is short (review H1: it held 0.459 N on 7 Nov 12:4xZ; the owner tops it up first).
# near-cli-rs 0.30.1 asks for unrlzd.near's seed phrase at its prompt (never in the shell history) and shows the
# transaction: pick "send". It writes its whole final command, the phrase in it, to std::env::temp_dir()/
# near-cli-rs-final-command.log (src/common.rs l.4070-4086 at v0.30.1), so it runs with --quiet and TMPDIR set to a new
# private folder, removed on every exit, Ctrl-C and a closed terminal included (as mainnet-test/1-create-parent.sh).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SENDER=unrlzd.near
NEED=2010000000000000000000000
node "$HERE/reads.mjs" sender "$SENDER" "$NEED" || { echo "paste 1: $SENDER cannot pay 2 NEAR + the 0.01 NEAR fee margin on both RPCs (above): nothing was typed or sent. Top it up, or send 2 NEAR to confidential.unrlzd.near from any wallet or exchange."; exit 1; }
PRIV=$(mktemp -d)
chmod 700 "$PRIV"
trap 'rm -rf "$PRIV"' EXIT
CMDK="Press Cmd-K now to clear this window: its prompt showed the seed phrase."
trap 'rm -rf "$PRIV"; echo "paste 1: stopped. $CMDK"; exit 130' INT
trap 'rm -rf "$PRIV"; echo "paste 1: stopped. $CMDK"; exit 143' TERM
trap 'rm -rf "$PRIV"; exit 129' HUP
set +e
TMPDIR="$PRIV" npx --yes near-cli-rs@0.30.1 --quiet tokens "$SENDER" send-near confidential.unrlzd.near '2 NEAR' \
  network-config mainnet sign-with-seed-phrase
RC=$?
set -e
rm -rf "$PRIV"
echo "paste 1: near-cli-rs exited $RC. $CMDK"
exit "$RC"
