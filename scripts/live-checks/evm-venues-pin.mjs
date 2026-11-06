#!/usr/bin/env node
// Live check of card evm-venues-pin: the kit pins, per EVM testnet, the contracts pool-evm-deploy deployed, and each pin
// holds that code on chain. For every chain of the kit's venue list (evmPoolVenues(), through the kit's public entry)
// that has a deployment record (pool-evm-deploy.<chain>.json):
//   - the pins are the record's: the pool is PrivacyPoolSimple, the v3 and v4 adapters UniswapV3Adapter and
//     UniswapV4Adapter (a record without one, a venue without that pin), the sell delegate SellDelegate, which card
//     evm-sell-v4 deployed again to sell through the v4 PoolManager, card evm-selldelegate-exact-debit again with the
//     exact-debit check and card evm-testnet-delegate-review3 again at the pool-review-3 build: the newest of their records (<key>.<chain>.json), where there is one, names the SellDelegate in
//     place of pool-evm-deploy's;
//   - the chain's WETH, PoolManager and routers are the ones pool-evm-deploy pinned (CHAINS: WETH; the PoolManager; the
//     v3 router, or none), and no middle is listed;
//   - on the chain's two RPCs of two operators (the money gate's), each answering the chain's id: at the newest block
//     both have (the lower of their two eth_blockNumber answers, so no archive read is needed), each pin's code is the
//     same on both and is the current build's (pool-evm-deploy.build.json `contracts`: the same length and, with the
//     immutables' bytes zeroed, the same keccak256), never a build the file froze: a frozen build is an older
//     contract's, which the device's code no longer calls (main's pins at the exact-debit delegates dispatched the
//     10-field sell while the kit built the 11-field one; card evm-testnet-delegate-review3), and its immutables hold exactly the words pool-evm-deploy's getters must return
//     (gettersOf: the pool's verifier, asset and scope, the adapters' PoolManager, router and WETH, the delegate's WETH);
//     the record's verifier is the build's; the PoolManager's, WETH's and each router's code hash is the one CHAINS
//     pins, and where WETH is a proxy (Robinhood testnet), its implementation slot and that implementation's code hash,
//     both read at each RPC's latest block (the one value here an upgrade can change).
//   node scripts/live-checks/evm-venues-pin.mjs [--record <file>]     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file>, for the test's replay (evm-venues-pin.answers.json).
// Runs: once, the kit's EVM pins against the contracts on chain; it changes only with a card that redeploys a contract
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { BUILD, CHAINS, EIP1967, MAINNETS, chainOf, deploymentFile, gettersOf, keccak, operatorProblems, recorder, rpc, runtimeOf } from "./pool-evm-deploy.mjs";

const KEY = "evm-venues-pin";
const lower = (a) => (typeof a === "string" ? a.toLowerCase() : a);
// each pin and the deployed contract it names
const PINS = [
  ["pool", (v) => v.pool, "PrivacyPoolSimple"],
  ["v3 adapter", (v) => v.adapters?.v3, "UniswapV3Adapter"],
  ["v4 adapter", (v) => v.adapters?.v4, "UniswapV4Adapter"],
  ["sell delegate", (v) => v.sellDelegate, "SellDelegate"],
];

// the sell delegate's redeploys alone, newest first: card evm-testnet-delegate-review3's, card
// evm-selldelegate-exact-debit's, then card evm-sell-v4's
const SELL_KEYS = ["evm-testnet-delegate-review3", "evm-selldelegate-exact-debit", "evm-sell-v4"];
const sellFile = (k, c) => path.join(path.dirname(fileURLToPath(import.meta.url)), `${k}.${c}.json`);
/** pool-evm-deploy's record of `chain`, its SellDelegate the newest redeploy's where one has a record; a mainnet's
 * (card pool-evm-deploy-mainnet: the owner's paste, contracts/pool-evm/deployments/<chain>.json) only from a real run */
export function recordOf(chain, file = deploymentFile(chain)) {
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, "utf8"));
  if (Object.hasOwn(MAINNETS, chain) && (d.chain !== chain || d.dryRun !== false)) throw new Error(`${file} is not ${chain}'s real run`);
  const f = SELL_KEYS.map((k) => sellFile(k, chain)).find(existsSync);
  if (!f) return d;
  const s = JSON.parse(readFileSync(f, "utf8"));
  if (s.chain !== chain || s.dryRun !== false) throw new Error(`${f} is not ${chain}'s real run`);
  return { ...d, contracts: { ...d.contracts, SellDelegate: s.contracts.SellDelegate } };
}

/** The chains of the kit's venue list that pool-evm-deploy has a record for, with that record: the testnets, then the
 * mainnets */
export function deployed(venues = evmPoolVenues(), read = recordOf) {
  return [...Object.keys(CHAINS), ...Object.keys(MAINNETS)].filter((c) => Object.hasOwn(venues, c)).map((c) => [c, read(c)]).filter(([, d]) => d !== null);
}

export async function check({ chain, venue, deployment: d, fetchFn = fetch, rpcs = chainOf(chain).rpcs, sleep }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${text}`);
  };
  const c = chainOf(chain);
  // the pins against the record, and the chain's WETH and routers against pool-evm-deploy's
  say(venue.chainId === Number(BigInt(c.chainId)), `the venue's chain id ${venue.chainId} is ${chain}'s ${BigInt(c.chainId)}`);
  const want = [];
  for (const [role, get, name] of PINS) {
    const pin = get(venue);
    const rec = d.contracts?.[name]?.address;
    say(lower(pin) === lower(rec), `the ${role} pin ${pin ?? "(none)"} is the record's ${name} ${rec ?? "(none)"}`);
    if (pin !== undefined && lower(pin) === lower(rec)) want.push([role, pin, name]);
  }
  say(lower(venue.weth) === lower(c.weth.address), `WETH ${venue.weth} is pool-evm-deploy's ${c.weth.address}`);
  say(lower(venue.poolManager) === lower(c.poolManager.address), `the PoolManager ${venue.poolManager ?? "(none)"} is pool-evm-deploy's ${c.poolManager.address}`);
  const routers = c.router ? [lower(c.router.address)] : [];
  say(JSON.stringify(venue.routers.map(lower)) === JSON.stringify(routers), `the routers ${JSON.stringify(venue.routers)} are pool-evm-deploy's ${JSON.stringify(routers)}`);
  // a testnet lists no middle; a mainnet's middles (Base's USDC, Robinhood's USDG) are the kit's route list, not a pin
  if (Object.hasOwn(CHAINS, chain)) say(venue.middles.length === 0, `no middle is listed: ${JSON.stringify(venue.middles)}`);
  // a dry run's record (an anvil fork, the mainnet rehearsal) is read on loopback only, as pool-evm-deploy reads it
  for (const p of operatorProblems(rpcs, { chain, dryRun: d.dryRun === true })) say(false, p);
  // the RPCs: the chain's id, then the newest block both have
  const two = rpcs.slice(0, 2);
  const heads = [];
  for (const u of two) {
    try {
      const id = await rpc(fetchFn, u, "eth_chainId", [], sleep);
      say(lower(id) === c.chainId, `chain id ${id} is ${chain}'s ${c.chainId} on ${u}`);
      heads.push(BigInt(await rpc(fetchFn, u, "eth_blockNumber", [], sleep)));
    } catch (e) {
      say(false, `read ${u}: ${String(e.message).split("\n")[0]}`);
    }
  }
  if (heads.length < 2) return { ok: false, lines };
  const block = "0x" + (heads[0] < heads[1] ? heads[0] : heads[1]).toString(16);
  const codeAt = async (addr) => {
    const out = [];
    for (const u of two) out.push(await rpc(fetchFn, u, "eth_getCode", [addr, block], sleep));
    return out;
  };
  const getters = gettersOf(d);
  try {
    for (const [role, pin, name] of [...want, ["verifier", d.contracts?.WithdrawalVerifier?.address ?? "0x", "WithdrawalVerifier"]]) {
      const [a, b] = await codeAt(pin);
      // the current build, never pinnedBuild's frozen one at an older contract's address: the kit's pin is what the
      // device's code calls today
      const build = BUILD.contracts[name];
      const r = runtimeOf(a, build.immutables);
      say(a === b && a !== "0x", `the ${role} ${pin}: the same code on both RPCs at block ${BigInt(block)} (${(a.length - 2) / 2} bytes)`);
      say(r.length === build.length && r.masked === build.masked, `the ${role} ${pin} is the build's ${name}: length ${r.length}, keccak256 with the immutables zeroed ${r.masked}`);
      const held = r.words.map((w) => (w.length === 1 ? w[0] : `${w.length} words`)).sort();
      const must = getters[name].map(([, w]) => w).sort();
      say(JSON.stringify(held) === JSON.stringify(must), `the ${role} ${pin}: ${name}'s immutables hold ${held.join(", ") || "none"}, each one word, the ones its getters must return`);
    }
    const deps = [["the PoolManager", c.poolManager], ["WETH", c.weth], ...(c.router ? [["the router", c.router]] : [])];
    for (const [what, { address: addr, codehash: hash }] of deps) {
      const [a, b] = await codeAt(addr);
      say(a === b && a !== "0x" && keccak(a) === hash, `${what} ${addr}: code hash ${keccak(a)} on both RPCs at block ${BigInt(block)} is the pinned ${hash}`);
    }
    // WETH's implementation is the one value here an upgrade changes: read at each RPC's latest block, as
    // pool-evm-deploy does, never at the agreed block, which one RPC's stale head could set in the past
    if (c.weth.implementation) {
      const slot = [];
      const code = [];
      for (const u of two) {
        slot.push(await rpc(fetchFn, u, "eth_getStorageAt", [c.weth.address, EIP1967.implementation, "latest"], sleep));
        code.push(await rpc(fetchFn, u, "eth_getCode", [c.weth.implementation.address, "latest"], sleep));
      }
      const want = "0x" + "0".repeat(24) + lower(c.weth.implementation.address).slice(2);
      say(slot.every((x) => lower(x) === want), `WETH's implementation slot holds the pinned ${c.weth.implementation.address} on both RPCs at latest: ${slot.join(", ")}`);
      say(code.every((x) => x !== "0x" && keccak(x) === c.weth.implementation.codehash), `WETH's implementation ${c.weth.implementation.address}: code hash ${code.map((x) => keccak(x)).join(", ")} on both RPCs at latest is the pinned ${c.weth.implementation.codehash}`);
    }
  } catch (e) {
    say(false, `read: ${String(e.message).split("\n")[0]}`);
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const chains = deployed();
    if (chains.length === 0) throw new Error("no pinned chain has a deployment record");
    const rec = recorder();
    let ok = true;
    for (const [chain, d] of chains) {
      const r = await check({ chain, venue: evmPoolVenues()[chain], deployment: d, fetchFn: opt("--record") ? rec.fetchFn : fetch });
      for (const l of r.lines) console.log(`live-check ${KEY} ${chain}: ${l}`);
      ok &&= r.ok;
    }
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ chains: chains.map(([c]) => c), good: rec.answers }) + "\n");
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
