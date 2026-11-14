#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The rehearsal of the owner's SellDelegate v2 paste (card pool-amounts-are-standard-sizes-evm:
# script/mainnet-deploy.sh <chain> <address> --only SellDelegate) on anvil forks of Base and Robinhood mainnet at their
# heads, on loopback, then real sales through the delegate it made. For each chain:
#   1. deploy.mjs --mainnet --chain <chain> --only SellDelegate exactly as the paste runs it (its forge build, the pinned
#      init code, the key folder, the journal), --rpc at the fork, --out in this run's folder; a stand-in for the owner's
#      wallet (a fresh random address given 1 ETH and impersonated, so no key here) is --return and funds exactly the need
#      it prints: the need, the deploy's gas and what the stand-in spent are printed (the owner's ETH on that chain, at
#      the fork block's fees); the key folder and the journal are gone after it;
#   2. a second run is refused before any key: its record exists;
#   3. two sales through the new delegate (script/SellDelegate2Fork.s.sol), each a fresh W bought the chain's v3 pair's
#      token, then W's EIP-7702 authorization and Sell in one type-4 transaction to the pinned mainnet pool: one over the
#      least rung (the pool takes the largest 1-2-5 rung, W keeps the rest), one under it (nothing deposited, W keeps it
#      all, the sale lands); every transaction's hash and status, and each Deposited value, printed from the receipts;
#   4. the card's live check (scripts/live-checks/pool-amounts-are-standard-sizes-evm.mjs) on the record, recorded.
#   bash contracts/pool-evm/script/sell-delegate-2-rehearsal.sh   (anvil, forge, cast on PATH; the workspace installed)
# Outputs go to contracts/pool-evm/out/sell-delegate-2-rehearsal/ (ignored by git), or $REHEARSAL_OUT.
set -euo pipefail
fail() { echo "rehearsal [$1]: FAIL: $2"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
echo "rehearsal: head $(git -C "$ROOT" rev-parse HEAD)$(git -C "$ROOT" diff --quiet HEAD -- || echo ' (with uncommitted changes)')"
OUT="${REHEARSAL_OUT:-$ROOT/contracts/pool-evm/out/sell-delegate-2-rehearsal}"
rm -rf "$OUT" && mkdir -p "$OUT"
STANDIN=0x$(openssl rand -hex 20)
KEYS="${XDG_STATE_HOME:-$HOME/.local/state}/pool-evm-deploy"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
fork_of() { case $1 in base) echo "${FORK_BASE:-https://mainnet.base.org}" ;; robinhood) echo "${FORK_ROBINHOOD:-https://rpc.mainnet.chain.robinhood.com}" ;; esac; }
# each chain's v3 pair (test/SellFork.t.sol): router, quoter, WETH, token, fee tier
route_of() { case $1 in
  base) echo "0x2626664c2603336E57B271c5C0b26F421741e481 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a 0x4200000000000000000000000000000000000006 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 500" ;;
  robinhood) echo "0xCaf681a66D020601342297493863E78C959E5cb2 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 100" ;;
esac; }
PORT_BASE=$((20000 + RANDOM % 20000))
port_of() { case $1 in base) echo "$PORT_BASE" ;; robinhood) echo $((PORT_BASE + 1)) ;; esac; }
folders() { if [ -d "$KEYS" ]; then ls "$KEYS" | sort; fi; }
CHAINS=${CHAINS:-base robinhood}
for chain in $CHAINS; do
  port=$(port_of "$chain")
  url="http://127.0.0.1:$port"
  # Base as the OP chain it is, so forge reads the fork's hardfork by Base's own names (a plain "Prague" is refused there)
  family=(); [ "$chain" = base ] && family=(--network optimism)
  anvil --fork-url "$(fork_of "$chain")" --port "$port" --host 127.0.0.1 --slots-in-an-epoch 0 "${family[@]}" --silent >"$OUT/anvil-$chain.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 60); do cast chain-id --rpc-url "$url" >/dev/null 2>&1 && break; sleep 1; done
  cast rpc anvil_setBalance "$STANDIN" 0xde0b6b3a7640000 --rpc-url "$url" >/dev/null
  cast rpc anvil_impersonateAccount "$STANDIN" --rpc-url "$url" >/dev/null
  block=$(cast block-number --rpc-url "$url")
  echo "rehearsal: $chain fork of $(fork_of "$chain") at $url, chain id $(cast chain-id --rpc-url "$url"), block $block"
  before_keys=$(folders)
  rec="$OUT/$chain.sell-delegate-2.json"
  log="$OUT/$chain.log"
  node "$ROOT/contracts/pool-evm/script/deploy.mjs" --mainnet --chain "$chain" --only SellDelegate --return "$STANDIN" --rpc "$url" --out "$rec" >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1200); do grep -q "^deploy: waiting for" "$log" && break; kill -0 $pid 2>/dev/null || break; sleep 0.5; done
  line=$(grep "^deploy: waiting for" "$log") || { cat "$log"; fail "$chain" "no funding line"; }
  need=$(awk '{print $4}' <<<"$line")
  key=$(awk '{print $9}' <<<"$line")
  sb=$(cast balance "$STANDIN" --rpc-url "$url")
  cast send --unlocked --from "$STANDIN" "$key" --value "$need" --rpc-url "$url" >/dev/null
  echo "rehearsal [$chain]: funded $key with exactly $need wei from the stand-in"
  rc=0; wait $pid || rc=$?
  cat "$log"
  spent=$(node -p "BigInt('$sb') - BigInt('$(cast balance "$STANDIN" --rpc-url "$url")')")
  echo "rehearsal [$chain]: exit $rc; need $need wei ($(node -p "Number($need) / 1e18") ETH); the run key holds $(cast balance "$key" --rpc-url "$url") wei; the stand-in spent $spent wei net ($(node -p "Number($spent) / 1e18") ETH), at block $block's fees"
  [ "$rc" = 0 ] || fail "$chain" "the deploy exited $rc"
  [ "$(folders)" = "$before_keys" ] || fail "$chain" "a key folder is left in $KEYS"
  [ ! -e "${rec%.json}.journal.json" ] || fail "$chain" "the journal is left"
  echo "rehearsal [$chain]: the run key's folder and the journal are removed"
  rc2=0; node "$ROOT/contracts/pool-evm/script/deploy.mjs" --mainnet --chain "$chain" --only SellDelegate --return "$STANDIN" --rpc "$url" --out "$rec" --no-build >"$OUT/$chain-again.log" 2>&1 || rc2=$?
  cat "$OUT/$chain-again.log"
  { grep -q "exists: SellDelegate is deployed on $chain" "$OUT/$chain-again.log" && [ "$rc2" != 0 ] && [ "$(folders)" = "$before_keys" ]; } || fail "$chain" "a second run was not refused before any key (exit $rc2)"
  echo "rehearsal [$chain]: a second run is refused before any key (exit $rc2)"
  # the card's live check on the fork's two loopback names, recorded (the replay file's dry-run half)
  node "$ROOT/scripts/live-checks/pool-amounts-are-standard-sizes-evm.mjs" --deployment "$rec" --rpc "$url,http://localhost:$port" --record "$OUT/$chain-answers.json" | tee "$OUT/$chain-check.log"
  tail -1 "$OUT/$chain-check.log" | grep -q ": PASS$" || fail "$chain" "the live check fails on the fork"
  delegate=$(node -p "require('$rec').contracts.SellDelegate.address")
  pool=$(node -p "require('$ROOT/contracts/pool-evm/deployments/$chain.json').contracts.PrivacyPoolSimple.address")
  collector=$(node -p "require('$ROOT/contracts/pool-evm/deployments/$chain.json').contracts.FeeCollector.address")
  read -r router quoter weth token tier <<<"$(route_of "$chain")"
  echo "rehearsal [$chain]: SellDelegate v2 at $delegate ($(( ($(cast code "$delegate" --rpc-url "$url" | wc -c) - 3) / 2 )) bytes); sales into the pinned pool $pool, fee to the pinned FeeCollector $collector"
  for sale in "731 2000000000000000" "732 800000000000000"; do
    read -r idx buy <<<"$sale"
    # W fresh on the fork: no ETH, no code (a published test address may hold either on mainnet)
    w=$(cast wallet address --mnemonic "test test test test test test test test test test test junk" --mnemonic-index "$idx")
    cast rpc anvil_setBalance "$w" 0x0 --rpc-url "$url" >/dev/null
    cast rpc anvil_setCode "$w" 0x --rpc-url "$url" >/dev/null
    slog="$OUT/$chain-sale-$idx.log"
    rc=0
    (cd "$ROOT/contracts/pool-evm" && DELEGATE=$delegate POOL=$pool FEE_TO=$collector ROUTER=$router QUOTER=$quoter WETH=$weth TOKEN=$token FEE_TIER=$tier W_INDEX=$idx BUY_WEI=$buy \
      forge script script/SellDelegate2Fork.s.sol --rpc-url "$url" --broadcast --evm-version prague --slow >"$slog" 2>&1) || rc=$?
    cat "$slog"
    [ "$rc" = 0 ] || fail "$chain" "sale W$idx: forge script exited $rc"
    run="$ROOT/contracts/pool-evm/broadcast/SellDelegate2Fork.s.sol/$(cast chain-id --rpc-url "$url")/run-latest.json"
    for h in $(node -p "require('$run').transactions.map((t) => t.hash).join(' ')"); do
      st=$(cast receipt "$h" status --rpc-url "$url")
      ty=$(cast tx "$h" type --rpc-url "$url")
      echo "rehearsal [$chain]: sale W$idx tx $h type $ty status $st"
      case "$st" in 1|"1 (success)"|true|0x1) ;; *) fail "$chain" "tx $h status $st" ;; esac
    done
    last=$(node -p "const t = require('$run').transactions; t[t.length - 1].hash")
    [ "$(cast tx "$last" type --rpc-url "$url")" = "0x4" ] || fail "$chain" "the sale $last is not one type-4 transaction"
    dep=$(cast receipt "$last" --json --rpc-url "$url" | node -e '
      const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const topic = process.argv[1];
      const d = r.logs.filter((l) => l.address.toLowerCase() === process.argv[2].toLowerCase() && l.topics[0] === topic);
      console.log(d.length === 0 ? "none" : d.map((l) => BigInt("0x" + l.data.slice(2 + 128, 2 + 192)).toString()).join(","));
    ' "$(cast keccak 'Deposited(address,uint256,uint256,uint256,uint256)')" "$pool")
    echo "rehearsal [$chain]: sale W$idx Deposited value: $dep"
    cp "$run" "$OUT/$chain-sale-$idx.run.json"
  done
done
echo "rehearsal: PASS"
