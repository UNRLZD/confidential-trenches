#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 1 of the mainnet vault (card vault-mainnet-deploy): unrlzd.near sends 2 NEAR to confidential.unrlzd.near, the
# parent that signs the deploy (owner-decisions vaultname; M200, its one key KR10). Real money: the owner's paste.
# Why 2 NEAR: the parent held 0.771245 NEAR (FastNEAR and dRPC, 7 Nov 09:59Z). deploy.mjs refuses to send unless it
# holds the code storage 2.3123 N ((230130 B + 100 B) x 1e19 yocto + 0.01 N, deploy.mjs transfer) + MAX_REGISTRATION
# 0.01 N + MAINNET_GAS_MARGIN 0.05 N = 2.3723 N; after it, paste 3's storage_prepay (0.00756 N) and paste 4's fee
# recipient registration (0.00125 N) also come from it. 0.771245 + 2 = 2.771245 N covers 2.3723 N with 0.399 N left;
# after every paste about 0.43 N stays with the parent (the unused 0.01 N registration bound and the gas margin).
# A wallet app's "send 2 NEAR to confidential.unrlzd.near" from unrlzd.near is the same transfer.
# near-cli-rs 0.30.1 asks for unrlzd.near's seed phrase at its prompt (never in the shell history) and shows the
# transaction: pick "send". It writes its whole final command, the phrase in it, to std::env::temp_dir()/
# near-cli-rs-final-command.log (src/common.rs l.4070-4086 at v0.30.1), so it runs with --quiet and TMPDIR set to a new
# private folder, removed on every exit, Ctrl-C and a closed terminal included (as mainnet-test/1-create-parent.sh).
set -eu
PRIV=$(mktemp -d)
chmod 700 "$PRIV"
trap 'rm -rf "$PRIV"' EXIT
CMDK="Press Cmd-K now to clear this window: its prompt showed the seed phrase."
trap 'rm -rf "$PRIV"; echo "paste 1: stopped. $CMDK"; exit 130' INT
trap 'rm -rf "$PRIV"; echo "paste 1: stopped. $CMDK"; exit 143' TERM
trap 'rm -rf "$PRIV"; exit 129' HUP
set +e
TMPDIR="$PRIV" npx --yes near-cli-rs@0.30.1 --quiet tokens unrlzd.near send-near confidential.unrlzd.near '2 NEAR' \
  network-config mainnet sign-with-seed-phrase
RC=$?
set -e
rm -rf "$PRIV"
echo "paste 1: near-cli-rs exited $RC. $CMDK"
exit "$RC"
