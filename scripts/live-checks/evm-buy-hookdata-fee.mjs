#!/usr/bin/env node
// Live check of card evm-buy-hookdata-fee (review fold 2 MEDIUM-A): every pinned EVM provider answers the relay fee's
// state reads at a block a proof's life (POOL_LIFE_MAX_MS, 600 s) old. The fee is bound to the epoch's first block: the
// device reads the chain fee there before it binds (packages/wallet/src/pool/evm.ts bind), and the helper reads the
// pool's tree depth and the chain fee there when it prices a proof's epoch, up to 600 s back (apps/helper/src/pool/
// evm.ts feeOf). A provider that prunes state sooner refuses those reads: robinhood-sepolia-rpc.publicnode.com kept
// about 15 s ("historical state <root> is not available" at 20 s, read 2026-11-04 20:10Z), so a bind started 15 s or
// more into an epoch failed. For each chain the kit pins (evmPoolVenues, every provider it lists: a device's two fee
// RPCs may be any two of them):
//   - the newest block on the first provider, then the last block at least 600 s older than it (by block time), read by
//     number on both providers, one hash on both;
//   - at that hash, on each provider alone: every chain fee read (the kit's evmPoolChainFeeReads) and, where the chain
//     pins a pool, the pool's currentTreeDepth(), each answered with a word.
// Any error, a missing answer or two hashes fails it.
//   node scripts/live-checks/evm-buy-hookdata-fee.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes the run as the good run of evm-buy-hookdata-fee.answers.json, and as its bad run a real run with
// Robinhood testnet's second provider the old pin, robinhood-sepolia-rpc.publicnode.com (which must fail).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolChainFeeReads, evmPoolGas, evmPoolVenues } from "../../packages/kit/src/index.ts";

const KEY = "evm-buy-hookdata-fee";
/** The oldest block a proof's fee is read at, s: the helper's POOL_LIFE_MAX_MS (apps/helper/src/pool/evm.ts). */
export const AGE_S = 600;
/** The pool's tree depth view (State.sol currentTreeDepth), keccak256("currentTreeDepth()")[0..4]. */
const TREE_DEPTH = "0x4a2b75c8";
/** The pin this card replaced, for the recorded bad run. */
export const OLD_RH_TESTNET = "https://robinhood-sepolia-rpc.publicnode.com";

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
      const j = await r.json();
      if (j?.error) return { error: `RPC error ${j.error.code}: ${j.error.message}` };
      if (!r.ok) return { error: `HTTP ${r.status}` };
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
    // a block keeps only what the check reads, so the record stays small
    const kept = method === "eth_getBlockByNumber" && a.result && typeof a.result === "object" ? { result: { number: a.result.number, timestamp: a.result.timestamp, hash: a.result.hash } } : a;
    log.push({ url, method, params, ...kept });
    return kept;
  };
  return { transport, log };
}

/** A transport that answers each call with the recorded answer to that same call; none recorded is an error. */
export function replayer(log) {
  const answers = new Map();
  for (const e of log) answers.set(JSON.stringify([e.url, e.method, e.params]), e);
  return async (url, method, params) => {
    const e = answers.get(JSON.stringify([url, method, params]));
    if (e === undefined) return { error: `no recorded answer to ${method} ${JSON.stringify(params)} on ${url}` };
    return "error" in e ? { error: e.error } : { result: e.result };
  };
}

const host = (u) => new URL(u).host;
const hex = (n) => `0x${n.toString(16)}`;
const WORD = /^0x[0-9a-fA-F]{64}/;

/** The chains and providers the kit pins, with each chain's reads; `over` replaces a chain's providers (the bad run). */
export function pinned(over = {}) {
  return Object.entries(evmPoolVenues()).map(([chain, v]) => {
    const reads = [...evmPoolChainFeeReads(chain, evmPoolGas(0)), ...(v.pool ? [{ to: v.pool, data: TREE_DEPTH }] : [])];
    return { chain, providers: over[chain] ?? v.providers, reads };
  });
}

async function call(transport, url, method, params) {
  const a = await transport(url, method, params);
  if ("error" in a) throw new Error(`${host(url)}: ${method}: ${a.error}`);
  return a.result;
}

/** The check: { ok, lines }, every chain read; `chains` is pinned()'s list. */
export async function check(transport, chains = pinned()) {
  const lines = [];
  let ok = true;
  for (const { chain, providers, reads } of chains) {
    try {
      if (!Array.isArray(providers) || providers.length < 2) throw new Error("fewer than two pinned providers");
      const [first] = providers;
      const blockAt = async (n) => {
        const b = await call(transport, first, "eth_getBlockByNumber", [hex(n), false]);
        if (b === null || typeof b?.hash !== "string") throw new Error(`${host(first)}: no block ${n}`);
        return { n, t: BigInt(b.timestamp), hash: b.hash.toLowerCase() };
      };
      const head = await call(transport, first, "eth_getBlockByNumber", ["latest", false]);
      const top = { n: BigInt(head.number), t: BigInt(head.timestamp) };
      const want = top.t - BigInt(AGE_S);
      // the last block at or before `want`: from a block known to be older, halving the gap
      let lo = 0n, hi = top.n, step = 1024n;
      for (;;) {
        const k = top.n > step ? top.n - step : 0n;
        const b = await blockAt(k);
        if (b.t <= want || k === 0n) {
          lo = k;
          break;
        }
        hi = k;
        step *= 2n;
      }
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if ((await blockAt(mid)).t <= want) lo = mid;
        else hi = mid;
      }
      const at = await blockAt(lo);
      if (at.t > want) throw new Error(`no block ${AGE_S} s old on ${host(first)}`);
      for (const u of providers) {
        const b = await call(transport, u, "eth_getBlockByNumber", [hex(at.n), false]);
        if (typeof b?.hash !== "string" || b.hash.toLowerCase() !== at.hash) throw new Error(`${host(u)}: block ${at.n} is ${b?.hash}, not ${at.hash}`);
        for (const r of reads) {
          const v = await call(transport, u, "eth_call", [{ to: r.to, data: r.data }, { blockHash: at.hash }]);
          if (typeof v !== "string" || !WORD.test(v)) throw new Error(`${host(u)}: ${r.data.slice(0, 10)} at ${r.to}: ${JSON.stringify(v)}, not a word`);
        }
      }
      lines.push(`${chain}: block ${at.n} (${at.hash}), ${top.t - at.t} s older than the newest (${top.n}): ${providers.map(host).join(" and ")} each answered its ${reads.length} fee reads (${reads.map((r) => r.data.slice(0, 10)).join(", ")}) there`);
    } catch (e) {
      ok = false;
      lines.push(`${chain}: ${e?.message ?? e}`);
    }
  }
  return { ok, lines };
}

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const rec = recorder();
  const r = await check(rec.transport);
  for (const l of r.lines) console.log(`${r.ok ? "PASS" : "FAIL"} ${l}`);
  if (record) {
    const bad = recorder();
    const rh = evmPoolVenues()["robinhood-testnet"].providers;
    const b = await check(bad.transport, pinned({ "robinhood-testnet": [rh[0], OLD_RH_TESTNET] }).filter((c) => c.chain === "robinhood-testnet"));
    for (const l of b.lines) console.log(`(bad run) ${b.ok ? "PASS" : "FAIL"} ${l}`);
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: rec.log, bad: bad.log }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(r.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
