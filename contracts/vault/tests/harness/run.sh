#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# The vault's near-sandbox suite (vault.md 5, V3.1): builds the vault (the mainnet build, as it ships), the mock token
# and the harness's probe contract with cargo-near, then runs every `required-features = ["sandbox"]` test against
# them in near-sandbox 2.13.4.
# A heavy job: run it from the repo root through the heavy gate, never as a plain command:
#   scripts/heavy.sh vault-sandbox -- contracts/vault/tests/harness/run.sh [cargo test args, e.g. --test smoke]
# With no args it runs every test target with the sandbox feature on. Output: the wasm sizes and sha256, then the
# tests with --nocapture (the harness prints each wasm's size and sha256 as it loads it; each test its gas table).
# A NEAR_SANDBOX_BIN_PATH is refused by the harness unless HARNESS_SANDBOX_BIN names the same path.
set -euo pipefail
V=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
TC=+1.96.0
date -u +"start %Y-%m-%dT%H:%M:%SZ"
rustc $TC --version; cargo $TC near --version; uname -srm

# The target dir cargo itself resolves (CARGO_TARGET_DIR, .cargo/config, or <crate>/target): cargo-near writes there,
# and the wasm is removed before each build, so a test never loads a stale file.
target_dir() {
  (cd "$1" && cargo $TC metadata --format-version 1 --no-deps --locked) | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p'
}
build() { # <crate dir> <wasm name>
  local t; t=$(target_dir "$1")
  [ -n "$t" ] || { echo "run.sh: cargo metadata names no target dir for $1" >&2; exit 1; }
  local w="$t/near/$2.wasm"
  rm -f "$w"
  mkdir -p "$t"
  local log="$t/near-build-$2.log" # under the target dir, which git ignores
  (cd "$1" && cargo $TC near build non-reproducible-wasm --no-embed-abi --locked >"$log" 2>&1) || {
    tail -60 "$log" >&2; exit 1; }
  [ -s "$w" ] || { echo "run.sh: no $w after the build" >&2; exit 1; }
  echo "$w $(wc -c <"$w" | tr -d ' ') B sha256 $(shasum -a 256 "$w" | cut -d' ' -f1)" >&2
  echo "$w"
}
echo "CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-unset} NEAR_SANDBOX_BIN_PATH=${NEAR_SANDBOX_BIN_PATH:-unset} HARNESS_SANDBOX_BIN=${HARNESS_SANDBOX_BIN:-unset}"
VAULT_WASM=$(build "$V" blindfill_vault)
MOCK_TOKEN_WASM=$(build "$V/tests/mock-token" blindfill_mock_token)
PROBE_WASM=$(build "$V/tests/harness/probe" blindfill_harness_probe)
export VAULT_WASM MOCK_TOKEN_WASM PROBE_WASM

cd "$V"
if [ "$#" -eq 0 ]; then set -- --tests; fi
cargo $TC test --locked --features sandbox "$@" -- --nocapture
date -u +"end %Y-%m-%dT%H:%M:%SZ"
