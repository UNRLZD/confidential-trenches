#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# The vault's near-sandbox suite (vault.md 5, V3.1): builds the vault (the mainnet build, as it ships, and VT-S17's
# out-of-gas test build of it, VAULT_OOG_WASM), the mock token
# and the harness's probe contract with cargo-near, fetches the pinned real USDC and intents.near wasm
# (fetch-wasm.mjs), then runs every `required-features = ["sandbox"]` test against them in near-sandbox 2.13.4.
# Run it from the repo root:
#   contracts/vault/tests/harness/run.sh [cargo test args, e.g. --test smoke]
# It needs Linux or macOS, Rust 1.96.0 (rustup toolchain 1.96.0), cargo-near, Node 24 and network access the first
# time, when near-workspaces downloads near-sandbox 2.13.4 and fetch-wasm.mjs reads the two mainnet contracts.
# With no args it runs every test target with the sandbox feature on. Output: the wasm sizes and sha256, then the
# tests with --nocapture (the harness prints each wasm's size and sha256 as it loads it; each test its gas table).
# A NEAR_SANDBOX_BIN_PATH is refused by the harness unless HARNESS_SANDBOX_BIN names the same path.
# CI builds the four once for all its shards (.github/workflows/ci.yml, job vault-sandbox-build):
#   contracts/vault/tests/harness/run.sh --build-only <dir>   builds them and copies each to <dir>/<name>.wasm, fetches
#                                                             the two pinned ones into <dir>, and runs no test
#   VAULT_WASM_DIR=<dir> contracts/vault/tests/harness/run.sh [args]   builds nothing: loads the four from <dir> (each
#                                                             must be there) and runs the tests, cargo-near not needed
set -euo pipefail
V=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
TC=+1.96.0
OUT=
if [ "${1:-}" = --build-only ]; then
  [ "$#" -eq 2 ] || { echo "usage: run.sh --build-only <dir>" >&2; exit 2; }
  [ -z "${VAULT_WASM_DIR:-}" ] || { echo "run.sh: --build-only builds, and VAULT_WASM_DIR says not to" >&2; exit 2; }
  mkdir -p "$2"; OUT=$(cd "$2" && pwd)
  export BLINDFILL_WASM_CACHE="$OUT"
  set --
fi
date -u +"start %Y-%m-%dT%H:%M:%SZ"
rustc $TC --version; [ -n "${VAULT_WASM_DIR:-}" ] || cargo $TC near --version; uname -srm

# The target dir cargo itself resolves (CARGO_TARGET_DIR, .cargo/config, or <crate>/target): cargo-near writes there,
# and the wasm is removed before each build, so a test never loads a stale file.
target_dir() {
  (cd "$1" && cargo $TC metadata --format-version 1 --no-deps --locked) | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p'
}
build() { # <crate dir> <wasm name> [more cargo-near args]
  local dir=$1 name=$2; shift 2
  local t; t=$(target_dir "$dir")
  [ -n "$t" ] || { echo "run.sh: cargo metadata names no target dir for $dir" >&2; exit 1; }
  local w="$t/near/$name.wasm"
  rm -f "$w"
  mkdir -p "$t"
  local log="$t/near-build-$name.log" # under the target dir, which git ignores
  (cd "$dir" && cargo $TC near build non-reproducible-wasm --no-embed-abi --locked "$@" >"$log" 2>&1) || {
    tail -60 "$log" >&2; exit 1; }
  [ -s "$w" ] || { echo "run.sh: no $w after the build" >&2; exit 1; }
  echo "$w $(wc -c <"$w" | tr -d ' ') B sha256 $(shasum -a 256 "$w" | cut -d' ' -f1)" >&2
  echo "$w"
}
echo "CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-unset} NEAR_SANDBOX_BIN_PATH=${NEAR_SANDBOX_BIN_PATH:-unset} HARNESS_SANDBOX_BIN=${HARNESS_SANDBOX_BIN:-unset}"
# VT-S17's test build first (tests/s17.rs; its on_payout runs out of gas), copied aside, so the release build below is
# the last one at blindfill_vault.wasm and VAULT_WASM names it
# a wasm built by --build-only, by its name in VAULT_WASM_DIR
prebuilt() {
  local w="$VAULT_WASM_DIR/$1.wasm"
  [ -s "$w" ] || { echo "run.sh: no $w (VAULT_WASM_DIR holds what run.sh --build-only built)" >&2; exit 1; }
  echo "$w $(wc -c <"$w" | tr -d ' ') B sha256 $(shasum -a 256 "$w" | cut -d' ' -f1)" >&2
  echo "$w"
}
if [ -n "${VAULT_WASM_DIR:-}" ]; then
  VAULT_WASM_DIR=$(cd "$VAULT_WASM_DIR" && pwd)
  export BLINDFILL_WASM_CACHE="${BLINDFILL_WASM_CACHE:-$VAULT_WASM_DIR}" # the pinned two, as --build-only fetched them
  VAULT_OOG_WASM=$(prebuilt blindfill_vault_out_of_gas)
  VAULT_WASM=$(prebuilt blindfill_vault)
  MOCK_TOKEN_WASM=$(prebuilt blindfill_mock_token)
  PROBE_WASM=$(prebuilt blindfill_harness_probe)
else
  OOG_BUILT=$(build "$V" blindfill_vault --features test-on-payout-out-of-gas)
  VAULT_OOG_WASM="$(dirname "$OOG_BUILT")/blindfill_vault_out_of_gas.wasm"
  cp "$OOG_BUILT" "$VAULT_OOG_WASM"
  VAULT_WASM=$(build "$V" blindfill_vault)
  MOCK_TOKEN_WASM=$(build "$V/tests/mock-token" blindfill_mock_token)
  PROBE_WASM=$(build "$V/tests/harness/probe" blindfill_harness_probe)
fi
if [ -n "$OUT" ]; then
  for w in "$VAULT_OOG_WASM" "$VAULT_WASM" "$MOCK_TOKEN_WASM" "$PROBE_WASM"; do cp "$w" "$OUT/"; done
fi
export VAULT_WASM VAULT_OOG_WASM MOCK_TOKEN_WASM PROBE_WASM
# the real USDC and intents.near at DF: mainnet's code, pinned in tests/fixtures/real-wasm.json, read by view_code on
# two mainnet RPCs (or the cache, when its sha256 is the pin); the harness refuses any other bytes again
PINNED=$(node "$V/tests/harness/fetch-wasm.mjs")
while IFS='=' read -r k v; do
  case "$k" in
    USDC_WASM | INTENTS_WASM) export "$k=$v"; echo "$k=$v" >&2 ;;
    *) echo "run.sh: fetch-wasm.mjs printed $k=$v" >&2; exit 1 ;;
  esac
done <<<"$PINNED"
[ -n "${USDC_WASM:-}" ] && [ -n "${INTENTS_WASM:-}" ] || { echo "run.sh: fetch-wasm.mjs named no USDC_WASM or INTENTS_WASM" >&2; exit 1; }

if [ -n "$OUT" ]; then ls -l "$OUT"; date -u +"end %Y-%m-%dT%H:%M:%SZ"; exit 0; fi

cd "$V"
if [ "$#" -eq 0 ]; then set -- --tests; fi
cargo $TC test --locked --features sandbox "$@" -- --nocapture
date -u +"end %Y-%m-%dT%H:%M:%SZ"
