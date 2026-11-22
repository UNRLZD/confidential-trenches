#!/usr/bin/env node
// Live check of card helper-v4-busy-tape-empty: a busy v4 coin's tape shows its trades, never a 200 with none. On 5 Nov
// the deployed helper answered WORM 0x3ba500f1's Robinhood tape 200 with 0 trades while its v4 pools swapped hundreds of
// times an hour (helper-robinhood-capacity fold 8 run, 941b7ba and 7b47b3f, 05:44Z).
// For each chain it reads the Discover lists at HELPER_HOST with Origin APP_HOST and takes the trending coins whose listed
// pool is a v4 pool id, COINS a chain, and opens each tape as the page reads it (GET /v1/market/trades?chain=<c>&token=
// <t>&limit=50, again every POLL_MS while it says filling, BOUND_MS at most). Then, on the chain's two RPCS, which must
// answer alike, it reads the PoolManager's Swap logs of that pool id from the block of the tape's oldest row (or the
// newest WINDOW blocks for a tape with none) to the head.
// A tape is judged against its pool when every row's transaction is one of the pool's swaps (a coin's tape is its
// busiest pool's of a quote of ours, which may be another pool: shown, not judged). It passes only when every answer is
// 200 and settles, each judged tape holds exactly the pool's swaps from its oldest row to its newest, and no swap of the
// pool older than the tape's own time by LAG_S is missing past its newest. A tape settled with none while the pool
// swapped in the window: FAIL. A chain with no tape judged, or the two RPCS not alike: INCONCLUSIVE.
// After: helper
// Serial: evm-keyed 390 (its tapes draw the helper's keyed Base and Robinhood providers)
//   node scripts/live-checks/helper-v4-busy-tape-empty.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's
//   test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

// keccak from the helper's own dependencies (apps/ is outside Blindfill), as evm-pool-search-stable reads it
const { keccak_256 } = createRequire(new URL("../../apps/helper/package.json", import.meta.url))("@noble/hashes/sha3.js");

const KEY = "helper-v4-busy-tape-empty";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const COINS = 2;
export const POLL_MS = 3_000;
export const BOUND_MS = 90_000;
/** A swap this much older than the tape's own time must be on it. [design: 30 s, a few of the helper's follow reads] */
export const LAG_S = 30;
export const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
/** Each chain's PoolManager (apps/helper/src/data/evm/swaps.ts VENUES), two keyless providers that give each log its
 *  blockTimestamp, the widest eth_getLogs span each takes, and the blocks a tape with none is read back over (about
 *  20 minutes of each chain's blocks). Read 2026-11-19 07:2xZ from the Mac: pocket and daybreak answered WORM's pool over
 *  334,442 blocks alike, publicnode and tenderly VVV's over 1,167. */
export const CHAINS = {
  base: { poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b", rpcs: [["https://base-rpc.publicnode.com", 1_000], ["https://base.gateway.tenderly.co", 1_000]], window: 6_000, spanMax: 30_000 },
  robinhood: { poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951", rpcs: [["https://robinhood.api.pocket.network", 25_000], ["https://robinhood.daybreak-rpc.network", 2_000]], window: 11_000, spanMax: 120_000 },
};
const ID = /^0x[0-9a-f]{64}$/;
/** The hook of v4 pool `id` from `key` (the pool's PoolKey, as the helper's GET /v1/market/pools names it: currency0,
 *  currency1, fee, tickSpacing, hooks), only when its keccak-256 is the id, so the helper's word proves nothing by
 *  itself; null otherwise. A swap the hook sends is its own (fees it sells), never a trade: the helper keeps it off the
 *  tape (swaps.ts hookTakes, backBook). Live run 44989861313: Robinhood 0x94641b97's pool 0x338fce55, hook 0xe5e70264
 *  sold the fee coins it held in tx 0xc25ae71f (log 0, the coin from the hook into the PoolManager, USDG out to it and
 *  on to a fee splitter), and this check counted it, and one more, as swaps missing from the tape. */
export function hookOf(id, key) {
  const k = key ?? {};
  const word = (v) => (typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v) ? v.slice(2).padStart(64, "0") : null);
  const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v.toString(16).padStart(64, "0") : null);
  const parts = [word(k.currency0), word(k.currency1), num(k.fee), num(k.tickSpacing), word(k.hooks)];
  if (parts.some((p) => p === null)) return null;
  const h = Buffer.from(keccak_256(Buffer.from(parts.join(""), "hex"))).toString("hex");
  return `0x${h}` === id ? k.hooks : null;
}
const TX = /^0x[0-9a-f]{64}$/;
const arr = (v) => (Array.isArray(v) ? v : []);

/** The pool's Swap logs over `from` to `to` on `url`, a span at a time (halved on a refusal), each as {tx, b, ts}; or
 *  {noAnswer}. */
async function swapsOn(url, span, pm, id, from, to, fetchFn) {
  const out = [];
  let a = from;
  let step = span;
  while (a <= to) {
    const b = Math.min(to, a + step - 1);
    const r = await rpcAnswer(url, "eth_getLogs", [{ address: pm, topics: [SWAP, id], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }], { fetchFn });
    if (!Array.isArray(r.result)) {
      if (step > 100) {
        step = Math.floor(step / 2);
        continue;
      }
      return { noAnswer: r.noAnswer ?? JSON.stringify(r.error ?? r).slice(0, 200) };
    }
    for (const l of r.result) out.push({ tx: l.transactionHash, b: parseInt(l.blockNumber, 16), ts: parseInt(l.blockTimestamp ?? "0x0", 16), s: typeof l.topics?.[2] === "string" ? `0x${l.topics[2].slice(26)}` : null });
    a = b + 1;
  }
  return { logs: out };
}

export async function readRun(base = BASE, { fetchFn = fetch, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = () => performance.now() } = {}) {
  const run = { base, at: new Date().toISOString(), chains: {} };
  for (const [chain, c] of Object.entries(CHAINS)) {
    const coins = [];
    run.chains[chain] = { coins };
    const lr = await fetchFn(`${base}/v1/market/lists?chain=${chain}`, { headers: { Origin: APP } });
    const lists = lr.status === 200 ? await lr.json() : {};
    run.chains[chain].listsStatus = lr.status;
    const pools = lists.pools ?? {};
    const picks = [];
    for (const k of ["trending_5m", "trending_1h", "trending"]) for (const r of arr(lists.lists?.[k])) if (ID.test(pools[r.token] ?? "") && !picks.some((p) => p.coin === r.token) && picks.length < COINS) picks.push({ coin: r.token, pool: pools[r.token] });
    for (const { coin: addr, pool } of picks) {
      const coin = { coin: addr, pool, answers: [] };
      coins.push(coin);
      const t0 = now();
      for (;;) {
        const r = await fetchFn(`${base}/v1/market/trades?chain=${chain}&token=${addr}&limit=50`, { headers: { Origin: APP } });
        let body = null;
        try {
          body = await r.json();
        } catch {}
        const trades = arr(body?.trades);
        coin.answers.push({ status: r.status, filling: body?.filling === true, as_of_ms: body?.as_of_ms ?? null, txs: trades.map((x) => x.tx), ms: Math.round(now() - t0) });
        if (r.status !== 200 || body?.filling !== true || now() - t0 >= BOUND_MS) break;
        await sleep(POLL_MS);
      }
      const last = coin.answers.at(-1);
      if (last.status !== 200 || last.filling) continue;
      const [url0] = c.rpcs[0];
      const head = await rpcAnswer(url0, "eth_blockNumber", [], { fetchFn });
      if (typeof head.result !== "string") {
        coin.noAnswer = head.noAnswer ?? "no head";
        continue;
      }
      coin.head = parseInt(head.result, 16);
      if (last.txs.length > 0) {
        const rc = await rpcAnswer(url0, "eth_getTransactionReceipt", [last.txs.at(-1)], { fetchFn });
        if (typeof rc.result?.blockNumber !== "string") {
          coin.noAnswer = rc.noAnswer ?? "no receipt";
          continue;
        }
        coin.from = parseInt(rc.result.blockNumber, 16);
      } else coin.from = coin.head - c.window + 1;
      if (coin.head - coin.from + 1 > c.spanMax) {
        coin.tooWide = coin.head - coin.from + 1;
        continue;
      }
      // the pool's key as the helper's index names it, proven by its hash at the verdict (hookOf)
      const pr = await fetchFn(`${base}/v1/market/pools?chain=${chain}&token=${addr}`, { headers: { Origin: APP } }).catch(() => null);
      const pa = pr?.status === 200 ? await pr.json().catch(() => null) : null;
      coin.key = arr(pa?.pools).find((p) => p?.id === pool)?.key ?? null;
      coin.reads = [];
      for (const [url, span] of c.rpcs) coin.reads.push({ host: new URL(url).host, ...(await swapsOn(url, span, c.poolManager, pool, coin.from, coin.head, fetchFn)) });
    }
  }
  return run;
}

/** The verdict on a run readRun recorded. */
export function judge(run) {
  const lines = [];
  let bad = false;
  let quiet = false;
  for (const chain of ["base", "robinhood"]) {
    const ch = run.chains?.[chain];
    let judged = 0;
    if (ch?.listsStatus !== 200) {
      lines.push(`BAD ${chain}: lists answered ${ch?.listsStatus}`);
      bad = true;
      continue;
    }
    for (const coin of arr(ch.coins)) {
      const name = `${chain} ${coin.coin} pool ${coin.pool?.slice(0, 10)}`;
      const last = arr(coin.answers).at(-1);
      if (last === undefined || last.status !== 200) {
        lines.push(`BAD ${name}: tape answered ${last?.status}`);
        bad = true;
        continue;
      }
      if (last.filling) {
        lines.push(`BAD ${name}: still filling at ${last.ms} ms`);
        bad = true;
        continue;
      }
      if (coin.noAnswer !== undefined || coin.tooWide !== undefined) {
        lines.push(`--  ${name}: ${coin.noAnswer ?? `its ${last.txs.length} rows span ${coin.tooWide} blocks`}, not judged`);
        continue;
      }
      const reads = arr(coin.reads);
      if (reads.length !== 2 || reads.some((r) => !Array.isArray(r.logs))) {
        lines.push(`--  ${name}: ${reads.map((r) => r.noAnswer).filter(Boolean).join("; ") || "no read"}: INCONCLUSIVE`);
        quiet = true;
        continue;
      }
      const sets = reads.map((r) => JSON.stringify(r.logs.map((l) => `${l.b}:${l.tx}`).sort()));
      if (sets[0] !== sets[1]) {
        lines.push(`--  ${name}: ${reads[0].host} and ${reads[1].host} answered ${reads[0].logs.length} and ${reads[1].logs.length} swaps, not alike: INCONCLUSIVE`);
        quiet = true;
        continue;
      }
      // the hook's own swaps are no trades (hookOf): left out, counted in the line
      const hook = hookOf(coin.pool, coin.key);
      const logs = reads[0].logs.filter((l) => hook === null || l.s !== hook);
      const own = reads[0].logs.length - logs.length;
      const tape = new Set(last.txs);
      if (tape.size === 0) {
        if (logs.length > 0) {
          lines.push(`BAD ${name}: 200 with no trades while the pool swapped ${logs.length} times in blocks ${coin.from}-${coin.head} (${reads.map((r) => r.host).join(", ")})`);
          bad = true;
          judged++;
        } else lines.push(`--  ${name}: no trades and no swap in blocks ${coin.from}-${coin.head}, not judged`);
        continue;
      }
      const inPool = new Set(logs.map((l) => l.tx));
      if (![...tape].every((t) => inPool.has(t))) {
        lines.push(`--  ${name}: ${[...tape].filter((t) => !inPool.has(t)).length} of the tape's ${tape.size} rows are another pool's (the coin's busiest of a quote of ours), not judged`);
        continue;
      }
      judged++;
      const newest = Math.max(...logs.filter((l) => tape.has(l.tx)).map((l) => l.b));
      const inside = new Set(logs.filter((l) => l.b <= newest).map((l) => l.tx));
      const missing = [...inside].filter((t) => !tape.has(t));
      const asOf = Math.floor((last.as_of_ms ?? 0) / 1000);
      const late = logs.filter((l) => l.b > newest && l.ts > 0 && l.ts <= asOf - LAG_S && !tape.has(l.tx));
      if (missing.length > 0 || late.length > 0) {
        lines.push(`BAD ${name}: the tape's ${tape.size} rows against the pool's ${inside.size} swaps in blocks ${coin.from}-${newest}: ${missing.length} missing${late.length > 0 ? `, and ${late.length} swaps past its newest row older than its time by ${LAG_S} s` : ""} (${missing.concat(late.map((l) => l.tx)).slice(0, 3).join(", ")})`);
        bad = true;
      } else lines.push(`ok  ${name}: ${tape.size} trades, the pool's ${inside.size} swaps in blocks ${coin.from}-${newest} on ${reads.map((r) => r.host).join(" and ")}${own > 0 ? `, ${own} swaps its hook sent itself left out` : ""}`);
    }
    if (judged === 0) {
      lines.push(`--  ${chain}: no busy v4 tape judged: INCONCLUSIVE`);
      quiet = true;
    }
  }
  const verdict = verdictOf(bad, quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await readRun(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
