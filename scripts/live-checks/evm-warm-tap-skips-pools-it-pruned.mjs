#!/usr/bin/env node
// Live check of card evm-warm-tap-skips-pools-it-pruned: a warm Base buy tap asks no pool again that the quote before it
// dropped in its X prune (V4Quoter.quoteExactOutputSingle of Q answering NotEnoughLiquidity), unless the PoolManager
// logged a Swap or ModifyLiquidity of it in between, or the warm tap asks a smaller Q of it. Before the card, release
// 201's kit re-asked about 77 such pools of NVDAc on both providers at every warm tap: 154 of a tap's exact-output reads,
// with taps of 4.9 and 11.8 s (read only from macOS, 24 Nov 16:1xZ).
// It runs the kit's own tap (evmPoolBuyQuoteTap, read only: nothing is signed or sent) on TOKEN (--token <a>; NVDAc by
// default) once cold and once warm, after the Base pool index's sync from SIGN_HOST's snapshot (SIGN, --sign <origin>;
// https://confidential.unrealized.trade/evm-index/base.json, as the page starts a device), and reads each tap's posts: each exact-output
// read's pool (its key), the amount it asks and the block it is read at, and how many of the answers to those posts name
// NotEnoughLiquidity (7a5ed734) and SafeCastOverflow (93dafdf1). For each pool the warm tap asked again, it reads the
// PoolManager's Swap and ModifyLiquidity logs of it between its two reads' blocks on the kit's first Base provider. It
// passes only when every pool the cold tap asked and the warm tap asked again moved: a log of it between the two, or a
// smaller amount asked. A cold tap whose prune dropped nothing (no exact-output read, or no NotEnoughLiquidity) has
// nothing to judge; nor has one whose answers name a SafeCastOverflow (a pool dropped so is asked again by design, and
// these counts do not tell the pools apart).
// After: sign
// Bundle: out EVM RPC quotes
//   node scripts/live-checks/evm-warm-tap-skips-pools-it-pruned.mjs [--token <a>] [--sign <origin>] [--record <file>]
//   PASS exit 0, FAIL 1, error 2 (and nothing to judge). --record writes what the run read, which the check's test replays.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolIndexFromSnapshot, evmPoolIndexRefresh, evmProviderSeats } from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { keccak } from "./pool-evm-deploy.mjs";
import { nothingToJudge, rpcAnswer } from "./provider-answer.mjs";

const KEY = "evm-warm-tap-skips-pools-it-pruned";
export const SIGN = "https://confidential.unrealized.trade";
/** NVDAc on Base (Robinhood's tokenized stock): its route one v3 pool, beside about 77 v4 pools seeded with other
 *  currencies that cannot give its Q (24 Nov 16:1xZ). */
export const TOKEN = "0xb20000000000000000000078ee7ce2fe4908108c";
export const AMOUNT = 10n ** 15n;
/** Base's v4 PoolManager and its events that move a pool's price or liquidity (v4-core IPoolManager.sol). */
export const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const MODIFY_LIQUIDITY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
// quoteExactOutputSingle's selector, the struct's offset word, the pool key's five words, zeroForOne and the amount
const EXACT_OUT = /58733073(0{62}20)((?:[0-9a-f]{64}){7})/g;
const NOT_ENOUGH_LIQUIDITY = "7a5ed734";
const SAFE_CAST_OVERFLOW = "93dafdf1";

const count = (s, x) => s.split(x).length - 1;
const addr = (w) => "0x" + w.slice(24);
/** A pool key's five words as one name, its addresses and numbers as they read (no 64-hex value in a record). */
const nameOf = (w) => [addr(w[0]), addr(w[1]), BigInt("0x" + w[2]), BigInt.asIntN(256, BigInt("0x" + w[3])), addr(w[4])].join("/");
/** The pool's v4 PoolId: keccak256 of its five words. */
const idOf = (name) => {
  const [c0, c1, fee, ts, hooks] = name.split("/");
  const w = (x) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, "0");
  return keccak("0x" + w(c0) + w(c1) + w(fee) + w(ts) + w(hooks)).toLowerCase();
};
/** The exact-output reads a post's JSON-RPC body carries: each one's pool, amount and block (its eth_call's block hash). */
export function exactOutReads(body) {
  let calls;
  try {
    const b = JSON.parse(body);
    calls = Array.isArray(b) ? b : [b];
  } catch {
    return [];
  }
  const out = [];
  for (const c of calls) {
    if (c?.method !== "eth_call") continue;
    const data = String(c.params?.[0]?.data ?? "").toLowerCase();
    const at = c.params?.[1];
    const hash = typeof at === "object" && at !== null ? at.blockHash : at;
    for (const m of data.matchAll(EXACT_OUT)) {
      const w = m[2].match(/.{64}/g);
      out.push({ pool: nameOf(w.slice(0, 5)), amount: String(BigInt("0x" + w[6])), hash: typeof hash === "string" ? hash.toLowerCase() : null });
    }
  }
  return out;
}

async function rpc(url, fetchFn, method, params) {
  const a = await rpcAnswer(url, method, params, { fetchFn });
  if (a.noAnswer !== undefined) throw new Error(`${method}: ${a.noAnswer}`);
  if (a.error !== undefined) throw new Error(`${method}: ${JSON.stringify(a.error).slice(0, 160)}`);
  return a.result;
}

export async function read(fetchFn = fetch, o = {}) {
  const token = (o.token ?? TOKEN).toLowerCase();
  let tap = null;
  // every post the kit sends, read beside it: the exact-output reads it carries and what their answers name
  const counted = async (url, init) => {
    const r = await fetchFn(url, init);
    if (tap === null || typeof init?.body !== "string") return r;
    const reads = exactOutReads(init.body);
    if (reads.length === 0) return r;
    tap.reads.push(...reads);
    const text = await r.clone().text();
    tap.short += count(text, NOT_ENOUGH_LIQUIDITY);
    tap.over += count(text, SAFE_CAST_OVERFLOW);
    return r;
  };
  // the device's start: SIGN_HOST's Base pool index snapshot (as the page serves it), synced to the head; none (a read
  // that fails) syncs from nothing
  const v = mainnetVenues().base;
  const snap = await fetchFn(`${o.sign ?? SIGN}/evm-index/base.json`, { signal: AbortSignal.timeout(30_000) }).then((r) => (r.status === 200 ? r.json() : null)).catch(() => null);
  let ix = null;
  try {
    ix = snap === null ? null : evmPoolIndexFromSnapshot(snap, { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap });
  } catch {
    ix = null;
  }
  const real = globalThis.fetch;
  globalThis.fetch = counted;
  const taps = {};
  try {
    await evmPoolIndexRefresh("base", ix, counted);
    for (const kind of ["cold", "warm"]) {
      tap = { reads: [], short: 0, over: 0 };
      const t0 = performance.now();
      let end;
      try {
        await evmPoolBuyQuoteTap({ chain: "base", token, amountIn: AMOUNT, slippageBps: 300 }, { quote: (req) => evmPoolBuyQuote(req) });
        end = { ok: true };
      } catch (e) {
        end = { ok: false, code: e?.code ?? "thrown" };
      }
      taps[kind] = { ms: Math.round(performance.now() - t0), ...end, ...tap };
      tap = null;
    }
  } finally {
    globalThis.fetch = real;
  }
  // the pools asked in both taps, their two reads' blocks, and the logs of them between on the kit's first provider
  const url = o.rpcUrl ?? evmProviderSeats("base")[0]?.url;
  const coldOf = new Map();
  for (const x of taps.cold.reads) coldOf.set(x.pool, x);
  const again = [...new Map(taps.warm.reads.filter((x) => coldOf.has(x.pool)).map((x) => [x.pool, x])).values()];
  const blocks = {};
  const moved = [];
  if (again.length > 0 && url !== undefined) {
    const hashes = [...new Set(again.flatMap((x) => [x.hash, coldOf.get(x.pool).hash]).filter((h) => h !== null))];
    for (const h of hashes) blocks[h] = Number(BigInt((await rpc(url, fetchFn, "eth_getBlockByHash", [h, false]))?.number ?? "0x0"));
    const ns = Object.values(blocks);
    const logs = await rpc(url, fetchFn, "eth_getLogs", [{ address: POOL_MANAGER, fromBlock: "0x" + Math.min(...ns).toString(16), toBlock: "0x" + Math.max(...ns).toString(16), topics: [[SWAP, MODIFY_LIQUIDITY], again.map((x) => idOf(x.pool))] }]);
    for (const x of again) {
      const [from, to] = [blocks[coldOf.get(x.pool).hash], blocks[x.hash]];
      if (logs.some((l) => l.topics?.[1]?.toLowerCase() === idOf(x.pool) && Number(BigInt(l.blockNumber)) > from && Number(BigInt(l.blockNumber)) <= to)) moved.push(x.pool);
    }
  }
  // the record names blocks by number, never by hash (no 64-hex value in a record: gitleaks)
  const strip = (t) => ({ ...t, reads: t.reads.map(({ hash, ...x }) => ({ ...x, block: hash === null ? null : (blocks[hash] ?? null) })) });
  return { at: new Date().toISOString(), token, snapshot: ix === null ? null : { through: ix.through, pools: ix.pools.length }, cold: strip(taps.cold), warm: strip(taps.warm), moved };
}

export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const cold = run.cold ?? { reads: [] };
  const warm = run.warm ?? { reads: [] };
  const pools = new Set(cold.reads.map((x) => x.pool));
  lines.push(`--  cold tap ${cold.ms} ms ${cold.ok ? "quoted" : `refused ${cold.code}`}: ${cold.reads.length} exact-output reads of ${pools.size} pools, answers naming NotEnoughLiquidity ${cold.short}, SafeCastOverflow ${cold.over}`);
  lines.push(`--  warm tap ${warm.ms} ms ${warm.ok ? "quoted" : `refused ${warm.code}`}: ${warm.reads.length} exact-output reads`);
  if (pools.size === 0 || !(cold.short > 0)) return { ok: false, quiet: true, lines: [...lines, "--  the cold tap's prune dropped no pool: nothing to judge"] };
  if (cold.over > 0) return { ok: false, quiet: true, lines: [...lines, "--  the cold tap's answers name a SafeCastOverflow, which the next tap asks again by design: nothing to judge"] };
  // each pool asked again: moved between its two reads, or asked a smaller amount than any the cold tap asked of it
  const least = new Map();
  for (const x of cold.reads) if (!least.has(x.pool) || BigInt(x.amount) < BigInt(least.get(x.pool))) least.set(x.pool, x.amount);
  const moved = new Set(run.moved ?? []);
  const again = [...new Set(warm.reads.filter((x) => pools.has(x.pool)).map((x) => x.pool))];
  const unmoved = again.filter((p) => !moved.has(p) && warm.reads.some((x) => x.pool === p && BigInt(x.amount) >= BigInt(least.get(p))));
  say(unmoved.length === 0, `${again.length} of the ${pools.size} pools the cold tap's prune asked asked again by the warm tap, ${again.length - unmoved.length} of them moved since or asked less${unmoved.length > 0 ? `; unmoved: ${unmoved.slice(0, 3).join(", ")}${unmoved.length > 3 ? ` and ${unmoved.length - 3} more` : ""}` : ""}`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), quiet: false, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const run = await read(fetch, { token: opt("--token"), sign: opt("--sign") });
    const rec = opt("--record");
    if (rec) writeFileSync(rec, JSON.stringify(run, null, 2) + "\n");
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    if (v.quiet) {
      const n = nothingToJudge(KEY, "base mainnet");
      console.log(n.line);
      process.exit(n.code);
    }
    console.log(`live-check ${KEY}: ${v.ok ? "PASS" : "FAIL"} (base mainnet)`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.log(`live-check ${KEY}: error ${e?.message ?? e}`);
    process.exit(2);
  }
}
