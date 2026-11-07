#!/usr/bin/env node
// Live check of card pool-evm-deploy: the Blindfill EVM pool on Base Sepolia and Robinhood testnet, with no admin.
// For each chain's deployment record, on two RPCs of two operators, each answering the chain's id, it reads:
//   - every contract the record names (the verifier, the pool, the v4 adapter, the v3 adapter on Base Sepolia only,
//     the sell delegate, and on the mainnets the fee collector): its code is the build's (pool-evm-deploy.build.json, which test/deploy.test.mjs keeps equal to
//     forge's output; at an address the file's `frozen` map pins, that older build: pinnedBuild): the same length and, with the immutables' bytes zeroed, the same keccak256; every place one
//     immutable sits holds the same word;
//   - those immutables through their getters: the pool's ASSET is the native asset, WITHDRAWAL_VERIFIER is the
//     record's verifier and SCOPE is keccak256(pool, chain id, asset) mod p (contracts/pool-evm/src/State.sol); the
//     adapters' PoolManager, router and WETH and the delegate's WETH are the chain's, pinned below; the words the code
//     holds are exactly these;
//   - a mainnet's fee collector (card evm-mainnet-senders): its one immutable (the sink; no getter) holds the sell
//     sender the kit pins on the chain (evmPoolVenues().sellSender), the record's sink is that pin, and the sink has no
//     code; a chain the kit pins none on fails;
//   - no admin: each contract's EIP-1967 implementation, admin and beacon slots are 0, and owner() is not there (it
//     reverts). The code being the build's is the proof; these reads say it in the terms an auditor asks for;
//   - what the contracts call: the PoolManager, the router and WETH, each with the code hash read when the contracts
//     were pinned, and WETH's symbol and name. Robinhood testnet's WETH is an upgradeable proxy (as on Robinhood
//     mainnet), so its implementation slot and that implementation's code hash are pinned too: an upgrade of it
//     fails this check;
//   - every transaction of the run: succeeded, sent by the run's deployer, and each deploy made the record's address;
//   - the run's deployer: no code, a nonce equal to the transactions it sent, and at most DUST wei left.
// Every constant it compares against is pinned here or in the build file; the record gives only addresses and txs.
//   node scripts/live-checks/pool-evm-deploy.mjs [--deployment <file>[,<file>]] [--rpc <url>,<url>] [--record <file>]
//     [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// With no --deployment it checks every chain's record present (pool-evm-deploy.<chain>.json). --rpc applies to a
// single record. --record writes every RPC answer read to <file>, for the test's replay. --write-record, on PASS,
// writes the run record scripts/live-checks/pool-evm-deploy.md (Money path: yes, one Tx line per transaction).
// Runs: once, a contract deploy's read-back (the EVM pools on two testnets, no admin); no host deploy changes it
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "pool-evm-deploy";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECORD = path.join(HERE, "pool-evm-deploy.md");
export const BUILD_FILE = path.join(HERE, "pool-evm-deploy.build.json");
export const BUILD = JSON.parse(readFileSync(BUILD_FILE, "utf8"));
// a testnet's record sits here; a mainnet's in contracts/pool-evm/deployments/ (card pool-evm-deploy-mainnet)
export const deploymentFile = (chain) =>
  Object.hasOwn(MAINNETS, chain) ? path.join(HERE, "../../contracts/pool-evm/deployments", `${chain}.json`) : path.join(HERE, `pool-evm-deploy.${chain}.json`);
/** The one build the code of `name` at `address` on `chain` must be: the frozen older build when the build file pins
 * that exact address to it (a contract deployed before the build moved on, e.g. the v1 SellDelegate), else the current
 * build. Never either one: each address has exactly one build. */
export function pinnedBuild(chain, name, address, build = BUILD) {
  const a = String(address ?? "").toLowerCase();
  // each frozen entry names its contract (`contract`, else its key): the v1 SellDelegate, then the evm-sell-v4 one
  const f = Object.entries(build.frozen ?? {}).find(([k, b]) => (b.contract ?? k) === name && b.at?.[chain]?.toLowerCase() === a);
  return f ? f[1] : build.contracts[name];
}

// @noble/hashes from the helper's own dependencies (apps/ is outside Blindfill, so this check reaches nothing of the
// kit's). A static name, so check:imports reads it (Node 24 loads this ES module through require).
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { keccak_256 } = req("@noble/hashes/sha3.js");

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// contracts/pool-evm/src/lib/Constants.sol NATIVE_ASSET
export const NATIVE_ASSET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
// EIP-1967: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1), .admin and .beacon likewise
export const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
};
// What a run key may keep: dust no transfer moves at a profit. A plain transfer cost about 1.3e11 wei on Base Sepolia
// (21,000 gas at its 6e6 wei gas price, plus an L1 fee of at most 572 wei for 200 bytes) and about 2.1e11 wei on
// Robinhood testnet (21,000 gas at 1e7 wei), read 2026-11-03 03:12Z; 1e13 wei is 0.00001 ETH.
export const DUST = 10n ** 13n;

// Each chain: its id, its two RPCs and their operators, and the contracts the pool's code calls, as read on both RPCs
// on 2026-11-03 between 03:11 and 03:13Z (eth_getCode hashed, eth_call symbol() and name(), eth_getStorageAt).
//   Base Sepolia: the v4 PoolManager and SwapRouter02 at the addresses developers.uniswap.org lists for it; WETH the OP
//   Stack predeploy. sepolia.base.org is Base's own public RPC (docs.base.org), base-sepolia-rpc.publicnode.com
//   PublicNode's (chainid.network, chain 84532).
//   Robinhood testnet: no Uniswap page lists it; the PoolManager's code hash is the one read at the Robinhood mainnet
//   PoolManager (M365), and WETH answers symbol "WETH" and name "WETH". Robinhood has no v3 router there, so no v3
//   adapter (M365). rpc.testnet.chain.robinhood.com is Robinhood's (docs.robinhood.com/chain/connecting),
//   robinhood-sepolia-rpc.publicnode.com PublicNode's (chainid.network, chain 46630).
export const CHAINS = Object.freeze({
  "base-sepolia": {
    chainId: "0x14a34",
    op: true,
    rpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    operators: { "sepolia.base.org": "base", "base-sepolia-rpc.publicnode.com": "publicnode" },
    contracts: ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "UniswapV3Adapter", "SellDelegate"],
    poolManager: { address: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408", codehash: "0x03c45db6d09b14da7c1f7239a5a49697f976d395277e6d2acb6fbed3f9e0249f" },
    router: { address: "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4", codehash: "0x60e9352f5af4eee63b41456f85bf80c63044e98123ad599d41d87f2d068de0be" },
    weth: { address: "0x4200000000000000000000000000000000000006", codehash: "0x83f731a17e6c0cdd04bc6f60b15d3e789e215b71403087b84b48650a1e5cbb21", symbol: "WETH", name: "Wrapped Ether" },
  },
  "robinhood-testnet": {
    chainId: "0xb626",
    op: false,
    rpcs: ["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"],
    operators: { "rpc.testnet.chain.robinhood.com": "robinhood", "robinhood-sepolia-rpc.publicnode.com": "publicnode" },
    contracts: ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "SellDelegate"],
    poolManager: { address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", codehash: "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626" },
    weth: {
      address: "0x7943e237c7f95da44e0301572d358911207852fa", codehash: "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353", symbol: "WETH", name: "WETH",
      implementation: { address: "0xf40600e58a560a988d7b60d61f22f7ab18106ed6", codehash: "0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650" },
    },
  },
});
// The mainnets (card pool-evm-deploy-mainnet): kept apart from CHAINS, the testnets the testnet runs and their checks
// loop over. Their deploy is the owner's paste (deploy.mjs refuses one without --mainnet). Read on 2026-11-05 between
// 17:00:14 and 17:22:19Z, the same on both RPCs of each chain (eth_getCode hashed, eth_call symbol() and name(),
// eth_getStorageAt): the PoolManager, SwapRouter02 and WETH the kit's venue list names (packages/kit/src/trade/evm/
// buy-unpinned.ts). Mainnet keeps both adapters (M365): Robinhood's SwapRouter02 reads on both. Robinhood's WETH (aeWETH)
// is an upgradeable proxy: its implementation is pinned too. mainnet.base.org is Base's own public RPC (docs.base.org),
// rpc.mainnet.chain.robinhood.com Robinhood's (docs.robinhood.com/chain/connecting), the others PublicNode's. Each set
// ends with the fee collector (card evm-mainnet-senders), its sink the sell sender the kit pins on the chain.
export const MAINNETS = Object.freeze({
  base: {
    chainId: "0x2105",
    op: true,
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    operators: { "mainnet.base.org": "base", "base-rpc.publicnode.com": "publicnode" },
    contracts: ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "UniswapV3Adapter", "SellDelegate", "FeeCollector"],
    poolManager: { address: "0x498581ff718922c3f8e6a244956af099b2652b2b", codehash: "0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6" },
    router: { address: "0x2626664c2603336e57b271c5c0b26f421741e481", codehash: "0x38bd640f47df62b2fd5a6755a63f4976ad847dc9b946ae0d145d21d16bb124e4" },
    weth: { address: "0x4200000000000000000000000000000000000006", codehash: "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c", symbol: "WETH", name: "Wrapped Ether" },
  },
  robinhood: {
    chainId: "0x1237",
    op: false,
    rpcs: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
    operators: { "rpc.mainnet.chain.robinhood.com": "robinhood", "robinhood-rpc.publicnode.com": "publicnode" },
    contracts: ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "UniswapV3Adapter", "SellDelegate", "FeeCollector"],
    poolManager: { address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", codehash: "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626" },
    router: { address: "0xcaf681a66d020601342297493863e78c959e5cb2", codehash: "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc" },
    weth: {
      address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", codehash: "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353", symbol: "WETH", name: "WETH",
      implementation: { address: "0xc6b81b429797e0f555440b70cd99e032d7ae947e", codehash: "0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650" },
    },
  },
});
export const MAINNET_IDS = Object.freeze(Object.fromEntries(Object.entries(MAINNETS).map(([n, c]) => [c.chainId, n])));
/** A chain by name, a testnet of CHAINS or a mainnet of MAINNETS; undefined for any other (own keys only). */
export const chainOf = (name) => (Object.hasOwn(CHAINS, name) ? CHAINS[name] : Object.hasOwn(MAINNETS, name) ? MAINNETS[name] : undefined);

export const hex = (b) => "0x" + Buffer.from(b).toString("hex");
export const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
export const keccak = (b) => hex(keccak_256(typeof b === "string" ? bytes(b) : b));
export const selector = (sig) => keccak(new TextEncoder().encode(sig)).slice(0, 10);
export const word = (x) => BigInt(x).toString(16).padStart(64, "0");
const addrWord = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** The runtime's length, its keccak256 with every immutable's bytes zeroed, and each immutable's word(s) (one entry per
 * immutable, the distinct 32-byte words found at its places) */
export function runtimeOf(code, immutables) {
  const b = bytes(code);
  const masked = Uint8Array.from(b);
  const words = immutables.map((starts) => [...new Set(starts.map((s) => (s + 32 <= b.length ? hex(b.subarray(s, s + 32)) : "short")))]);
  for (const starts of immutables) for (const s of starts) masked.fill(0, s, Math.min(s + 32, b.length));
  return { length: b.length, masked: keccak(masked), words };
}

/** abi.encodePacked(address, uint256, address) hashed, mod p: State.sol's SCOPE */
export const scopeOf = (pool, chainId, asset) =>
  BigInt(keccak("0x" + pool.toLowerCase().slice(2) + word(chainId) + asset.toLowerCase().slice(2))) % P;

/** An ABI string return value, or null */
function abiString(h) {
  try {
    const b = bytes(h);
    const off = Number(BigInt(hex(b.subarray(0, 32))));
    const n = Number(BigInt(hex(b.subarray(off, off + 32))));
    return Buffer.from(b.subarray(off + 32, off + 32 + n)).toString("utf8");
  } catch {
    return null;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// Each call's tries: 1.5 s more wait per try, 67.5 s of waits over 10, more than a provider's one-minute throttle window
// (rpc.mainnet.chain.robinhood.com answered HTTP 429 with no Retry-After for about 61 s, packages/wallet/src/pool/evm.ts
// EVM_LOG_THROTTLE_TRIES, read 5 Nov 13:55Z); at 5 tries (15 s) a good deploy's check failed there.
export const RPC_TRIES = 10;
/** One JSON-RPC call, RPC_TRIES tries at most: a transient failure (the fetch throws; a 429 or a 5xx; a -32029 / -32429
 * rate answer) is retried with backoff. A JSON-RPC error answer is never retried: it is the node's word, and it is
 * thrown with its `rpcError`. Re-sending a signed transaction is safe, since it keeps its signature. */
export async function rpc(fetchFn, url, method, params, sleep = sleepMs, tries = RPC_TRIES) {
  for (let i = 1; ; i++) {
    let r, j, transient;
    try {
      r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      j = await r.json().catch(() => null);
      transient = r.status === 429 || r.status >= 500 || [-32029, -32429].includes(j?.error?.code) ? new Error(`${method}: HTTP ${r.status} ${JSON.stringify(j?.error ?? null).slice(0, 80)}`) : null;
    } catch (e) {
      transient = new Error(`${method}: ${e?.cause?.code ?? e?.message ?? e}`);
    }
    if (transient) {
      if (i >= tries) throw transient;
      await sleep(1500 * i);
      continue;
    }
    if (!j) throw new Error(`${method}: HTTP ${r.status}, no JSON`);
    if (j.error) throw Object.assign(new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`), { rpcError: j.error });
    return j.result;
  }
}
const call = (fetchFn, url, to, data, sleep) => rpc(fetchFn, url, "eth_call", [{ to, data }, "latest"], sleep);

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Two RPCs of two operators of the chain; a dry run (an anvil fork of the chain) is read on loopback hosts only. */
export function operatorProblems(rpcs, d) {
  const two = rpcs.slice(0, 2);
  if (two.length < 2) return [`only ${two.length} RPC(s); want two of two operators`];
  if (d.dryRun) return two.every((u) => LOOPBACK.has(hostOf(u))) ? [] : ["a dry-run record read on a non-loopback RPC"];
  const ops = new Set(two.map((u) => chainOf(d.chain)?.operators[hostOf(u)]).filter(Boolean));
  return ops.size < 2 ? [`only ${ops.size} known ${d.chain} operator(s) in ${two.join(", ")}; want two`] : [];
}

/** Each contract's getters on the record's chain: [signature, the word it must return]; the words its immutables hold
 * (also scripts/live-checks/evm-venues-pin.mjs's) */
export function gettersOf(d) {
  const chain = chainOf(d.chain);
  const at = (name) => String(d.contracts?.[name]?.address ?? "").toLowerCase();
  return {
    WithdrawalVerifier: [],
    PrivacyPoolSimple: [
      ["ASSET()", addrWord(NATIVE_ASSET)],
      ["WITHDRAWAL_VERIFIER()", addrWord(at("WithdrawalVerifier"))],
      ["SCOPE()", "0x" + word(scopeOf(at("PrivacyPoolSimple"), chain.chainId, NATIVE_ASSET))],
    ],
    UniswapV4Adapter: [["POOL_MANAGER()", addrWord(chain.poolManager.address)], ["WETH()", addrWord(chain.weth.address)]],
    UniswapV3Adapter: [["ROUTER()", addrWord(chain.router?.address ?? "0x")]],
    // the v1 delegate (frozen in the build file) has one immutable and no POOL_MANAGER; every later one holds the
    // chain's PoolManager too
    SellDelegate: [["WETH()", addrWord(chain.weth.address)], ...(pinnedBuild(d.chain, "SellDelegate", at("SellDelegate")).immutables.length === 2 ? [["POOL_MANAGER()", addrWord(chain.poolManager.address)]] : [])],
    // no getter: its one immutable, the sink, is held to the kit's sell sender pin in check()
    FeeCollector: [],
  };
}

/** The record's check on two RPCs; `venues` is the kit's venue list (evmPoolVenues(), its sell sender pins), loaded only
 * for a set that holds the fee collector */
export async function check({ deployment: d, fetchFn = fetch, rpcs, sleep = sleepMs, venues }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  const chain = chainOf(d.chain);
  if (!chain) {
    say(false, `the record's chain is one of ${[...Object.keys(CHAINS), ...Object.keys(MAINNETS)].join(", ")}: ${d.chain}`);
    return { ok, lines };
  }
  rpcs ??= chain.rpcs;
  for (const p of operatorProblems(rpcs, d)) say(false, p);
  const deployer = String(d.deployer ?? "").toLowerCase();
  const at = (name) => String(d.contracts?.[name]?.address ?? "").toLowerCase();
  const names = Object.keys(d.contracts ?? {});
  say(names.length === chain.contracts.length && chain.contracts.every((n) => /^0x[0-9a-f]{40}$/.test(at(n))),
    `the record names ${chain.contracts.join(", ")} on ${d.chain}: ${names.join(", ") || "none"}`);
  const getters = gettersOf(d);
  // the fee collector's sink (card evm-mainnet-senders): the record's, and the sell sender the kit pins on the chain
  const collects = chain.contracts.includes("FeeCollector");
  const sink = String(d.contracts?.FeeCollector?.sink ?? "").toLowerCase();
  let pin = "";
  if (collects) {
    venues ??= (await import("../../packages/kit/src/index.ts")).evmPoolVenues();
    pin = Object.hasOwn(venues, d.chain) ? String(venues[d.chain]?.sellSender ?? "").toLowerCase() : "";
    say(/^0x[0-9a-f]{40}$/.test(pin) && sink === pin, `the record's FeeCollector sink ${sink || "(none)"} is the sell sender the kit pins on ${d.chain}: ${pin || "none"}`);
  }
  const txs = d.txs ?? [];
  say(txs.length > 0, `the record lists the run's transactions: ${txs.length}`);
  for (const url of rpcs.slice(0, 2)) {
    const on = `on ${url}`;
    try {
      const id = await rpc(fetchFn, url, "eth_chainId", [], sleep);
      say(id === chain.chainId, `chain id ${id} is ${d.chain}'s ${chain.chainId} ${on}`);
      if (collects && /^0x[0-9a-f]{40}$/.test(sink)) {
        const sc = await rpc(fetchFn, url, "eth_getCode", [sink, "latest"], sleep);
        say(sc === "0x", `the sink ${sink} has no code (no EIP-7702 delegation) ${on}: ${sc === "0x" ? "none" : sc.slice(0, 50)}`);
      }
      for (const name of chain.contracts) {
        const a = at(name);
        if (!a) continue; // the record line above failed already
        const b = pinnedBuild(d.chain, name, a);
        const code = await rpc(fetchFn, url, "eth_getCode", [a, "latest"], sleep);
        const r = runtimeOf(code, b.immutables);
        say(r.length === b.length && r.masked === b.masked,
          `${name} ${a} code is the build's: ${r.length} bytes (build ${b.length}), immutables zeroed keccak256 ${r.masked} (build ${b.masked}) ${on}`);
        const want = getters[name];
        const held = r.words.map((w) => (w.length === 1 ? w[0] : `${w.length} words`)).sort();
        if (name === "FeeCollector") say(held.length === 1 && pin !== "" && held[0] === addrWord(pin), `FeeCollector's immutable holds one word, the sell sender the kit pins on ${d.chain} ${pin || "(none)"} ${on}: ${held.join(", ") || "none"}`);
        else say(JSON.stringify(held) === JSON.stringify(want.map(([, w]) => w).sort()),
          `${name}'s ${b.immutables.length} immutable(s) each hold one word, the ones its getters must return ${on}: ${held.join(", ") || "none"}`);
        for (const [sig, w] of want) {
          const got = await call(fetchFn, url, a, selector(sig), sleep).catch((e) => `error ${e.message}`);
          say(got === w, `${name}.${sig} returns ${w} ${on}: ${got}`);
        }
        for (const [slot, s] of Object.entries(EIP1967)) {
          const v = await rpc(fetchFn, url, "eth_getStorageAt", [a, s, "latest"], sleep);
          say(BigInt(v) === 0n, `${name}'s EIP-1967 ${slot} slot is 0 ${on}: ${v}`);
        }
        const owner = await call(fetchFn, url, a, selector("owner()"), sleep).then((v) => v, (e) => (e.rpcError ? "reverts" : `error ${e.message}`));
        say(owner === "reverts" || owner === "0x", `${name} has no owner(): ${owner} ${on}`);
      }
      const deps = [["PoolManager", chain.poolManager], ...(chain.contracts.includes("UniswapV3Adapter") ? [["SwapRouter02", chain.router]] : []), ["WETH", chain.weth]];
      if (chain.weth.implementation) deps.push(["WETH's implementation", chain.weth.implementation]);
      for (const [label, c] of deps) {
        const code = await rpc(fetchFn, url, "eth_getCode", [c.address, "latest"], sleep);
        say(code !== "0x" && keccak(code) === c.codehash, `${label} ${c.address} code hash ${code === "0x" ? "(no code)" : keccak(code)} is the pinned ${c.codehash} ${on}`);
      }
      for (const f of ["symbol", "name"]) {
        const s = abiString(await call(fetchFn, url, chain.weth.address, selector(`${f}()`), sleep));
        say(s === chain.weth[f], `WETH's ${f}() is "${chain.weth[f]}" ${on}: ${JSON.stringify(s)}`);
      }
      if (chain.weth.implementation) {
        const v = await rpc(fetchFn, url, "eth_getStorageAt", [chain.weth.address, EIP1967.implementation, "latest"], sleep);
        say(v.toLowerCase() === addrWord(chain.weth.implementation.address), `WETH's implementation slot holds the pinned ${chain.weth.implementation.address} ${on}: ${v}`);
      }
      for (const t of txs) {
        const rc = await rpc(fetchFn, url, "eth_getTransactionReceipt", [t.hash], sleep);
        const made = t.contract ? at(t.contract) : null;
        say(!!rc && rc.status === "0x1" && rc.from?.toLowerCase() === deployer && (made === null ? !rc.contractAddress : rc.contractAddress?.toLowerCase() === made),
          `${t.step} ${t.hash} succeeded, from the deployer${made ? `, made ${t.contract} ${made}` : ""} ${on}${rc ? `: status ${rc.status}, from ${rc.from}, contract ${rc.contractAddress ?? "none"}` : ": no receipt"}`);
      }
      const dcode = await rpc(fetchFn, url, "eth_getCode", [deployer, "latest"], sleep);
      const nonce = BigInt(await rpc(fetchFn, url, "eth_getTransactionCount", [deployer, "latest"], sleep));
      const bal = BigInt(await rpc(fetchFn, url, "eth_getBalance", [deployer, "latest"], sleep));
      say(dcode === "0x" && nonce === BigInt(txs.length) && bal <= DUST,
        `deployer ${deployer} has no code, sent exactly the record's ${txs.length} transactions and keeps at most ${DUST} wei ${on}: code ${dcode.length > 2 ? "yes" : "none"}, nonce ${nonce}, ${bal} wei`);
    } catch (e) {
      say(false, `read ${on}: ${String(e.message).split("\n")[0]}`);
    }
  }
  return { ok, lines };
}

export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const json = await r.json().catch(() => null);
    answers.push({ url, method, params, status: r.status, json });
    return { ok: r.ok, status: r.status, json: async () => json };
  };
  return { answers, fetchFn: wrapped };
}

/**
 * The run record's text from the deployment records, after a PASS: every transaction of each run, money path. The
 * testnets' is this check's (pool-evm-deploy.md); the mainnets' is pool-evm-deploy-mainnet.mjs's, with `mainnet` and its
 * key (pool-evm-deploy-mainnet.md): a mainnet record never folds into the testnets' file, nor a testnet's into it.
 */
export function runRecord(ds, { mainnet = false, key = KEY } = {}) {
  for (const d of ds) {
    if (d.dryRun || !chainOf(d.chain)) throw new Error(`no run record for ${d.dryRun ? "a dry run" : d.chain}`);
    if (Object.hasOwn(MAINNETS, d.chain) !== mainnet) throw new Error(mainnet ? `${d.chain} is a testnet: its run record is ${path.basename(RECORD)}` : `${d.chain} is a mainnet: its run record is pool-evm-deploy-mainnet.md (node scripts/live-checks/pool-evm-deploy-mainnet.mjs --write-record)`);
  }
  return [
    `CARD ${key} / live: PASS`,
    "Money path: yes",
    ...ds.flatMap((d) => d.txs.map((t) => `Tx: ${d.chain} ${t.hash}`)),
    "",
    ...ds.flatMap((d) => [
      `${d.chain} (chain id ${BigInt(chainOf(d.chain).chainId)}), contracts/pool-evm/script/deploy.mjs at ${d.at}. Its steps, in the order of its Tx lines above: ${d.txs.map((t) => t.step).join(", ")}.`,
      `${chainOf(d.chain).contracts.map((n) => `${n} ${d.contracts[n].address}`).join(", ")}; each one's code is the build's (${d.build}), read by this live check on ${chainOf(d.chain).rpcs.join(" and ")}. No contract has an owner, an admin or an upgrade path.`,
      `Deployer ${d.deployer}, a run key that lived only in the run, funded with ${d.need} wei (the printed need) and swept back to ${d.return} at the run's end.`,
      "",
    ]),
    mainnet
      ? "The addresses the contracts call (the v4 PoolManager, SwapRouter02 and WETH) are the kit's venue list's, each code hash read on both RPCs and pinned in pool-evm-deploy.mjs MAINNETS; Robinhood's WETH is an upgradeable proxy whose implementation is pinned too."
      : "The testnet addresses the contracts call are read on chain, not taken from a published page, for Robinhood testnet (no Uniswap page lists it): its PoolManager has the code hash of the Robinhood mainnet PoolManager, and WETH answers symbol and name \"WETH\" behind an upgradeable proxy whose implementation this check pins (M365).",
    "",
  ].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
  try {
    const files = opt("--deployment") ? opt("--deployment").split(",") : [...Object.keys(CHAINS), ...Object.keys(MAINNETS)].map(deploymentFile).filter(existsSync);
    if (files.length === 0) throw new Error("no deployment record (pool-evm-deploy.<chain>.json) to check");
    const ds = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
    // the testnets' run record only: a mainnet record's is pool-evm-deploy-mainnet.mjs --write-record's, refused here
    // before any read
    if (args.includes("--write-record")) runRecord(ds.map((d) => ({ ...d, dryRun: false })));
    const rec = recorder();
    let ok = true;
    for (const d of ds) {
      const rpcs = opt("--rpc") && ds.length === 1 ? opt("--rpc").split(",") : undefined;
      const r = await check({ deployment: d, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
      for (const l of r.lines) console.log(`live-check ${KEY} ${d.chain}: ${l}`);
      ok &&= r.ok;
    }
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    if (ok && args.includes("--write-record")) {
      writeFileSync(RECORD, runRecord(ds));
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RECORD)}`);
    }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
