#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The rehearsal of the owner's mainnet paste (script/mainnet-deploy.sh, card pool-evm-deploy-mainnet) on anvil forks of
# Base and Robinhood mainnet, on loopback: deploy.mjs --mainnet exactly as the paste runs it (its forge build, the
# pinned init code, the key folder, the journal), with --rpc at the fork and --out in this run's folder. A stand-in for
# the owner's wallet (a fresh random address, given 1 ETH and impersonated on each fork, so no key here) is --return
# and funds exactly the need the script prints. For each chain:
#   1. the whole run, then the live check on the fork's two loopback names, recorded; the need, each deploy's gas and
#      what the stand-in spent are printed (the owner's funding on that chain, at the fork block's fees);
#   2. the run key's folder and the journal are gone (the key itself never reaches a log: test/deploy-run.test.mjs);
#   3. a second run is refused before any key: its record exists.
#   bash contracts/pool-evm/script/mainnet-rehearsal.sh   (anvil, forge, cast on PATH; the workspace installed)
# Outputs go to contracts/pool-evm/out/mainnet-rehearsal/ (ignored by git), or $REHEARSAL_OUT.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT="${REHEARSAL_OUT:-$ROOT/contracts/pool-evm/out/mainnet-rehearsal}"
rm -rf "$OUT" && mkdir -p "$OUT"
STANDIN=0x$(openssl rand -hex 20)
KEYS="${XDG_STATE_HOME:-$HOME/.local/state}/pool-evm-deploy"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
fork_of() { case $1 in base) echo "${FORK_BASE:-https://mainnet.base.org}" ;; robinhood) echo "${FORK_ROBINHOOD:-https://rpc.mainnet.chain.robinhood.com}" ;; esac; }
PORT_BASE=$((20000 + RANDOM % 20000))
port_of() { case $1 in base) echo "$PORT_BASE" ;; robinhood) echo $((PORT_BASE + 1)) ;; esac; }
folders() { if [ -d "$KEYS" ]; then ls "$KEYS" | sort; fi; }
for chain in base robinhood; do
  port=$(port_of "$chain")
  url="http://127.0.0.1:$port"
  anvil --fork-url "$(fork_of "$chain")" --port "$port" --host 127.0.0.1 --silent >"$OUT/anvil-$chain.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 60); do cast chain-id --rpc-url "$url" >/dev/null 2>&1 && break; sleep 1; done
  cast rpc anvil_setBalance "$STANDIN" 0xde0b6b3a7640000 --rpc-url "$url" >/dev/null
  cast rpc anvil_impersonateAccount "$STANDIN" --rpc-url "$url" >/dev/null
  block=$(cast block-number --rpc-url "$url")
  echo "rehearsal: $chain fork of $(fork_of "$chain") at $url, chain id $(cast chain-id --rpc-url "$url"), block $block"
  before_keys=$(folders)
  log="$OUT/$chain.log"
  node "$ROOT/contracts/pool-evm/script/deploy.mjs" --mainnet --chain "$chain" --return "$STANDIN" --rpc "$url" --out "$OUT/$chain.json" >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1200); do grep -q "^deploy: waiting for" "$log" && break; kill -0 $pid 2>/dev/null || break; sleep 0.5; done
  line=$(grep "^deploy: waiting for" "$log")
  need=$(awk '{print $4}' <<<"$line")
  key=$(awk '{print $9}' <<<"$line")
  grep -q "^deploy: send exactly $need wei to $key from $STANDIN, the address you passed$" "$log"
  sb=$(cast balance "$STANDIN" --rpc-url "$url")
  cast send --unlocked --from "$STANDIN" "$key" --value "$need" --rpc-url "$url" >/dev/null
  echo "rehearsal [$chain]: funded $key with exactly $need wei from the stand-in"
  rc=0; wait $pid || rc=$?
  cat "$log"
  spent=$(node -p "BigInt('$sb') - BigInt('$(cast balance "$STANDIN" --rpc-url "$url")')")
  echo "rehearsal [$chain]: exit $rc; need $need wei ($(node -p "Number($need) / 1e18") ETH); the run key holds $(cast balance "$key" --rpc-url "$url") wei; the stand-in spent $spent wei net ($(node -p "Number($spent) / 1e18") ETH), at block $block's fees"
  [ "$rc" = 0 ]
  # the key folder and the journal are gone
  [ "$(folders)" = "$before_keys" ] || { echo "rehearsal [$chain]: FAIL: a key folder is left in $KEYS"; exit 1; }
  [ ! -e "$OUT/$chain.journal.json" ] || { echo "rehearsal [$chain]: FAIL: the journal is left"; exit 1; }
  echo "rehearsal [$chain]: the run key's folder and the journal are removed"
  node "$ROOT/scripts/live-checks/pool-evm-deploy.mjs" --deployment "$OUT/$chain.json" --rpc "$url,http://localhost:$port" --record "$OUT/$chain-answers.json"
  # a second run: refused before any key, its record exists
  rc2=0; node "$ROOT/contracts/pool-evm/script/deploy.mjs" --mainnet --chain "$chain" --return "$STANDIN" --rpc "$url" --out "$OUT/$chain.json" --no-build >"$OUT/$chain-again.log" 2>&1 || rc2=$?
  cat "$OUT/$chain-again.log"
  grep -q "exists: the pool is deployed on $chain: run its live check alone" "$OUT/$chain-again.log" && [ "$rc2" != 0 ] && [ "$(folders)" = "$before_keys" ]
  echo "rehearsal [$chain]: a second run is refused before any key (exit $rc2)"
done
# the card's live check on both forks at once, recorded: each record, and the kit's venue with the record's contracts
# as its pins (the kit pins mainnet's own once the owner's paste has run): the replay file of its test
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const [root, out, pb, pr, forge] = process.argv.slice(1);
const { checkMainnets } = await import(`${root}/scripts/live-checks/pool-evm-deploy-mainnet.mjs`);
const { recorder } = await import(`${root}/scripts/live-checks/pool-evm-deploy.mjs`);
const { evmPoolVenues } = await import(`${root}/packages/kit/src/index.ts`);
const port = { base: pb, robinhood: pr };
const records = Object.fromEntries(["base", "robinhood"].map((c) => [c, JSON.parse(readFileSync(`${out}/${c}.json`, "utf8"))]));
const pins = Object.fromEntries(Object.entries(records).map(([c, d]) => [c, { pool: d.contracts.PrivacyPoolSimple.address, adapters: { v3: d.contracts.UniswapV3Adapter.address, v4: d.contracts.UniswapV4Adapter.address }, sellDelegate: d.contracts.SellDelegate.address }]));
const rpcs = Object.fromEntries(Object.keys(port).map((c) => [c, [`http://127.0.0.1:${port[c]}`, `http://localhost:${port[c]}`]]));
const rec = recorder();
const r = await checkMainnets({ read: (c) => records[c], venues: Object.fromEntries(Object.keys(pins).map((c) => [c, { ...evmPoolVenues()[c], ...pins[c] }])), rpcsOf: (c) => rpcs[c], fetchFn: rec.fetchFn });
for (const l of r.lines) console.log(`rehearsal live-check pool-evm-deploy-mainnet ${l}`);
console.log(`rehearsal live-check pool-evm-deploy-mainnet: ${r.ok ? "PASS" : "FAIL"}`);
const notes = [`A REHEARSAL recording: scripts/live-checks/pool-evm-deploy-mainnet.mjs on anvil forks of Base and Robinhood mainnet (contracts/pool-evm/script/mainnet-rehearsal.sh, ${forge}, ${new Date().toISOString()}), each fork read on two loopback names, the kit venue given the rehearsal record pins. After the owner paste, re-record on mainnet: node scripts/live-checks/pool-evm-deploy-mainnet.mjs --record <file>.`];
writeFileSync(`${out}/pool-evm-deploy-mainnet.answers.json`, JSON.stringify({ notes, records, pins, rpcs, good: rec.answers }) + "\n");
if (!r.ok) process.exit(1);
' "$ROOT" "$OUT" "$(port_of base)" "$(port_of robinhood)" "$(forge --version | head -1)"
echo "rehearsal: PASS on both forks; $(forge --version | head -1)"
