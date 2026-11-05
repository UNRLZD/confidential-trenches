#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Paste 1 of the mainnet test vault (card vault-mainnet-test; vault.md VT-R01): unrlzd.near creates
# confidential.unrlzd.near (owner-decisions vaultname) with 0.1 NEAR and one full-access key, the public key M200 (2)
# and runbook KR10 name. The key's file stays where KR10 keeps it; this line holds only its public half. near-cli-rs
# 0.30.1 (npm, published 2026-09-02) asks for unrlzd.near's seed phrase at its prompt (never in the shell history),
# then shows the transaction: pick "send".
exec npx --yes near-cli-rs@0.30.1 account create-account fund-myself confidential.unrlzd.near '0.1 NEAR' \
  use-manually-provided-public-key ed25519:WHHJ4Rmp2dzkkWtE5UuNkeEnw6JCnXLPrnXV6fiQhhh \
  sign-as unrlzd.near network-config mainnet sign-with-seed-phrase
