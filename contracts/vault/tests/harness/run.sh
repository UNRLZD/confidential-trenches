#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# The vault's near-sandbox suite (vault.md 5, V3.1): builds the vault (the mainnet build, as it ships) and the mock
# token with cargo-near, then runs every `required-features = ["sandbox"]` test against them in near-sandbox 2.13.4.
# A heavy job: run it from the repo root through the heavy gate, never as a plain command:
#   scripts/heavy.sh vault-sandbox -- contracts/vault/tests/harness/run.sh [cargo test args, e.g. --test smoke]
# With no args it runs every test target with the sandbox feature on. Output: the wasm sizes and sha256, then the
# tests with --nocapture (each prints its gas table).
set -euo pipefail
V=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
TC=+1.96.0
date -u +"start %Y-%m-%dT%H:%M:%SZ"
rustc $TC --version; cargo $TC near --version; uname -srm

build() { # <crate dir> <wasm name>
  mkdir -p "$1/target"
  local log="$1/target/near-build.log" # under target/, which git ignores
  (cd "$1" && cargo $TC near build non-reproducible-wasm --no-embed-abi --locked >"$log" 2>&1) || {
    tail -60 "$log" >&2; exit 1; }
  local w="$1/target/near/$2.wasm"
  [ -s "$w" ] || { echo "run.sh: no $w after the build" >&2; exit 1; }
  echo "$w $(wc -c <"$w" | tr -d ' ') B sha256 $(shasum -a 256 "$w" | cut -d' ' -f1)" >&2
  echo "$w"
}
VAULT_WASM=$(build "$V" blindfill_vault)
MOCK_TOKEN_WASM=$(build "$V/tests/mock-token" blindfill_mock_token)
export VAULT_WASM MOCK_TOKEN_WASM

cd "$V"
if [ "$#" -eq 0 ]; then set -- --tests; fi
cargo $TC test --locked --features sandbox "$@" -- --nocapture
date -u +"end %Y-%m-%dT%H:%M:%SZ"
