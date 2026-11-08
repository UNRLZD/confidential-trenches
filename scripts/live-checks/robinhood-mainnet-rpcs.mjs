#!/usr/bin/env node
// Live check of card robinhood-mainnet-rpcs: the device syncs the Robinhood mainnet pool on two independent RPC
// operators. The kit's Robinhood pool list (evmPoolProvidersOf(evmPoolVenues().robinhood), the wallet's evmPair: the
// first two the seats) must seat two providers of two operators (the kit's evmRpcOperator), each of which, read now:
//   - answers eth_chainId 0x1237 (4663);
//   - answers the pool's filter (the pinned pool once pool-evm-deploy pins it, the v4 PoolManager until then, with the
//     pool's three event topics in one position) over 10,000 blocks to its head, and over 10,000 blocks 1,000,000 back:
//     the sync's page (packages/wallet/src/pool/evm.ts EVM_LOG_PAGE_BLOCKS), from a pool's deploy block to the head;
//   - answers the PoolManager's Swap logs over the same 100 blocks as the other seat, log for log, some logs in them
//     (about 70 to 100 a 100 blocks, read 2026-11-07 02:5xZ), at the head and 1,000,000 blocks back: two seats that
//     agree on no logs, or only at the head, prove nothing about the history the sync reads.
// It fails on a list whose seats are one operator, on a seat that refuses or lacks a read (robinhood-rpc.publicnode.com:
// HTTP 403 "Archive requests require a personal token" from 1,000 blocks), and on two seats whose logs differ. A refused
// log read is asked again twice, as the wallet's pager asks a refusal of a size the provider answered (Pocket's backends
// differ: EVM_LOG_REFUSED_AGAIN).
// After: helper
//   node scripts/live-checks/robinhood-mainnet-rpcs.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every answer read, as the good run of robinhood-mainnet-rpcs.answers.json, and two bad runs: a real
// run on the pair the device had before (Robinhood's own and PublicNode, PublicNode's refusals in it), and the good
// answers under a list of one operator twice.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolProvidersOf, evmPoolVenues, evmRpcOperator } from "../../packages/kit/src/index.ts";

const KEY = "robinhood-mainnet-rpcs";
export const CHAIN_ID = "0x1237";
/** The pool's three events (packages/wallet/src/pool/evm.ts EVM_POOL_EVENTS), keccak256 of each signature. */
export const POOL_TOPICS = Object.freeze([
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549", // Deposited(address,uint256,uint256,uint256,uint256)
  "0xfabb9e7afa4ef595f60e1ae9041b2b311b4acb27aeaed4b11b6f2abf689af10a", // Withdrawn(address,address,uint256,uint256,uint256,uint256)
  "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d", // Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)
]);
/** Uniswap v4's Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24). */
export const SWAP4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
export const PAGE = 10_000;
export const BACK = 1_000_000;
const TRIES = 3;

/** The kit's Robinhood mainnet pool list, and the address its filter reads. */
export function kitList() {
  const v = evmPoolVenues().robinhood;
  return { list: [...(evmPoolProvidersOf(v) ?? [])], address: (v.pool ?? v.poolManager).toLowerCase(), poolManager: v.poolManager.toLowerCase() };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSON-RPC call over the network: { result } or { error }; a 429, a 5xx or a failed fetch is tried 4 times. */
export async function post(url, method, params) {
  for (let t = 1; ; t++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      if ((r.status === 429 || r.status >= 500) && t < 4) {
        await pause(1000 * t);
        continue;
      }
      const j = await r.json().catch(() => null);
      if (j?.error) return { error: `HTTP ${r.status} RPC error ${j.error.code}: ${j.error.message}` };
      if (!r.ok || j === null) return { error: `HTTP ${r.status}` };
      return { result: j.result };
    } catch (e) {
      if (t < 4) {
        await pause(1000 * t);
        continue;
      }
      return { error: `fetch failed: ${e?.message ?? e}` };
    }
  }
}

/** A live transport that keeps every answer, in order. */
export function recorder() {
  const log = [];
  const transport = async (url, method, params) => {
    const a = await post(url, method, params);
    log.push({ url, method, params, ...a });
    return a;
  };
  return { transport, log };
}

/** A transport that answers each call with the recorded answers to that same call, in their order; past the last, the
 *  last again. */
export function replayer(log) {
  const queues = new Map();
  for (const e of log) {
    const k = JSON.stringify([e.url, e.method, e.params]);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(e);
  }
  return async (url, method, params) => {
    const q = queues.get(JSON.stringify([url, method, params]));
    const e = q?.length > 1 ? q.shift() : q?.[0];
    if (e === undefined) return { error: `no recorded answer to ${method} ${JSON.stringify(params)} on ${url}` };
    return "error" in e ? { error: e.error } : { result: e.result };
  };
}

const host = (u) => new URL(u).host;
/** An operator: the kit's one rule (evmRpcOperator), the helper's and the kit's tests' too. */
export const operatorOf = (u) => evmRpcOperator(u);
const hx = (n) => `0x${n.toString(16)}`;
const digest = (logs) => createHash("sha256").update(JSON.stringify(logs.map((l) => [l.blockHash, l.logIndex, l.transactionHash, l.data, l.topics]))).digest("hex").slice(0, 16);

/** The check: { ok, lines }. `list` and `address`: the kit's (kitList) unless a test names others. */
export async function check(transport, { list, address, poolManager } = kitList()) {
  const lines = [];
  try {
    if (!Array.isArray(list) || list.length < 2) throw new Error(`the pool list holds ${list?.length ?? 0} providers, not a pair`);
    const seats = list.slice(0, 2);
    for (const u of seats) if (operatorOf(u) === null) throw new Error(`${JSON.stringify(u)} is not an http or https URL`);
    if (operatorOf(seats[0]) === operatorOf(seats[1])) throw new Error(`the two seats are one operator (${operatorOf(seats[0])}): ${seats.map(host).join(" and ")}`);
    const ask = async (url, method, params, what) => {
      let a;
      for (let t = 1; t <= TRIES; t++) {
        a = await transport(url, method, params);
        if (!("error" in a)) return a.result;
      }
      throw new Error(`${host(url)}: ${what}: ${a.error}`);
    };
    const heads = [];
    for (const url of seats) {
      const id = await ask(url, "eth_chainId", [], "eth_chainId");
      if (typeof id !== "string" || id.toLowerCase() !== CHAIN_ID) throw new Error(`${host(url)}: eth_chainId ${JSON.stringify(id)}, not ${CHAIN_ID}`);
      const head = BigInt(await ask(url, "eth_blockNumber", [], "eth_blockNumber"));
      heads.push(head);
      const logs = async (from, what) => {
        const r = await ask(url, "eth_getLogs", [{ address, topics: [POOL_TOPICS], fromBlock: hx(from), toBlock: hx(from + BigInt(PAGE) - 1n) }], what);
        if (!Array.isArray(r)) throw new Error(`${host(url)}: ${what}: not a list of logs`);
        return r.length;
      };
      const atHead = await logs(head - BigInt(PAGE) + 1n, `the pool's filter over ${PAGE} blocks to the head`);
      const back = await logs(head - BigInt(BACK), `the pool's filter over ${PAGE} blocks ${BACK} back`);
      lines.push(`${host(url)} (${operatorOf(url)}): chain ${CHAIN_ID}, head ${head}; the pool's filter on ${address} over ${PAGE} blocks to the head ${atHead} logs, ${PAGE} blocks ${BACK} back ${back} logs`);
    }
    // the same 100 blocks on both, under both heads, and the same 100 blocks 1,000,000 back
    const low = heads[0] < heads[1] ? heads[0] : heads[1];
    for (const [from, where] of [[low - 1_100n, "at the head"], [low - BigInt(BACK), `${BACK} back`]]) {
      const swaps = [];
      for (const url of seats) {
        const r = await ask(url, "eth_getLogs", [{ address: poolManager, topics: [SWAP4], fromBlock: hx(from), toBlock: hx(from + 99n) }], `the PoolManager's Swap logs ${where}`);
        if (!Array.isArray(r)) throw new Error(`${host(url)}: the PoolManager's Swap logs ${where}: not a list`);
        swaps.push({ n: r.length, d: digest(r) });
      }
      if (swaps[0].d !== swaps[1].d) throw new Error(`the seats' Swap logs ${where} over blocks ${from}-${from + 99n} differ: ${swaps.map((s, k) => `${host(seats[k])} ${s.n} logs ${s.d}`).join(", ")}`);
      if (swaps[0].n === 0) throw new Error(`the seats' Swap logs ${where} over blocks ${from}-${from + 99n}: no logs on either, so their agreement proves nothing`);
      lines.push(`both seats: the PoolManager's Swap logs ${where} over blocks ${from}-${from + 99n}, ${swaps[0].n} logs, digest ${swaps[0].d} on both`);
    }
    return { ok: true, lines };
  } catch (e) {
    lines.push(`${e?.message ?? e}`);
    return { ok: false, lines };
  }
}

/** The pair the device had before: the quote list's first, PublicNode, beside Robinhood's own. */
export const BEFORE = Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"]);
/** A list of one operator twice. */
export const ONE_OPERATOR = Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://rpc.testnet.chain.robinhood.com"]);

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const kit = kitList();
  const rec = recorder();
  const r = await check(rec.transport, kit);
  for (const l of r.lines) console.log(`${r.ok ? "PASS" : "FAIL"} ${l}`);
  if (record) {
    const before = recorder();
    const b = await check(before.transport, { ...kit, list: [...BEFORE] });
    if (b.ok) throw new Error("the pair before passed: no bad run to record");
    writeFileSync(
      record,
      `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: { list: kit.list, address: kit.address, poolManager: kit.poolManager, log: rec.log }, before: { list: [...BEFORE], address: kit.address, poolManager: kit.poolManager, log: before.log }, oneOperator: { list: [...ONE_OPERATOR], address: kit.address, poolManager: kit.poolManager, log: rec.log } }, null, 1)}\n`,
    );
    console.log(`recorded ${record}`);
  }
  console.log(r.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
