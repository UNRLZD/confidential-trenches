// Live check of card index-evm-swaps-v4-route-tape: a Base coin whose busiest pool is quoted in a third token (neither
// the chain's USD token nor WETH nor ETH: cbBTC, ZORA, VIRTUAL or any other) has that pool's tape, from the helper's own
// chain reads. Live run 44942886709 (20:05Z, 21 Nov): Base 0x86fb3335's market was its cbBTC v4 pool 0xc265b42f, 332
// swap transactions over the window, and the tape read its USDC pool 0xb26e93a3, 18, the side pool its arbitrages passed
// through; index-evm-swaps judged it on the busiest pool and refused every sampled trade's amount.
//
// The coin is picked by our own reads, never the helper's: the PoolManager's Swap logs of the last SCAN_BLOCKS blocks and
// the PositionManager's key of each of the busiest SCAN_POOLS pools, each read on two providers that agree (SWAP_RPCS).
// A pool is third-quoted when neither currency is USDC, WETH or ETH; its coin is the currency whose busiest pool in the
// scan it is, and that currency is the quote of no more than QUOTE_POOLS_MAX scanned pools (a token many coins are quoted
// in is a quote, not the coin). The busiest such coin is judged. It passes only when:
//   - GET /v1/market/trades?chain=base&token=<coin>&limit=50 answers 200 JSON, X-Helper-Source "chain", with trades;
//   - every swap transaction of the coin's busiest pool in the scan, from the tape's oldest trade's time to MARGIN blocks
//     under the scan's head, is on the tape (index-evm-swaps's pool rule: the tape is the busiest pool's, not a side pool
//     an arbitrage also swapped in).
// index-evm-swaps's own read (each sampled amount its pool's leg) is not run here: it builds its JSON-RPC itself
// (live-checks-provider-answer's NOT_MOVED), and every read of this check goes through provider-answer.mjs, which
// leaves a provider's no-answer out. A scan with no third-quoted coin, or one no two providers answered alike, is
// INCONCLUSIVE (exit 3), never a pass or a FAIL.
// A coin is judged on its tape only when its quote has a market our reads can price it by: the quote traded in the scan
// against USDC, WETH or ETH on Base (a scanned v4 pool of the two, or a v2 or v3 venue's pool its Transfers name;
// `markets`). The busiest candidate whose quote traded against none of them has no pool the helper's tape can price (live
// run 44979250087: Base RALLY 0x19640000's only pool 0xd6951c4c is quoted in ELEVATE, whose one USD market is on
// Ethereum); its trades answer must still be 200 (or 404, a coin no list carries), never a 5xx: the helper answered 503.
// After: helper
// Serial: evm-keyed 101 (the helper's tape read of the coin draws the keyed Base providers)
//   node scripts/live-checks/index-evm-swaps-v4-route-tape.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes the run (every answer read).
// Record: what the run read; a live run that fails keeps it beside its log
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BLOCK_CLOCK } from "../../apps/helper/src/data/evm/lists.ts";
import { SWAP_RPCS, TOPIC, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";
import { APP, BASE, TRADES_PATH } from "./index-evm-swaps.mjs";
import { rpcAnswer, rpcBatchAnswer } from "./provider-answer.mjs";

const KEY = "index-evm-swaps-v4-route-tape";
/** The scan: 1,500 blocks (5 min of Base's 200 ms blocks), the helper's own cold window (swaps.ts VENUES.base.cold). */
export const SCAN_BLOCKS = 1_500;
export const SCAN_STEP = 500;
export const SCAN_POOLS = 40;
/** A provider read's timeout: a 500-block getLogs of the PoolManager runs a few seconds. */
export const READ_MS = 30_000;
/** Key reads KEY_BATCH a post, KEY_EVERY_MS apart: sentio refuses a batch over 5, tenderly paces each call in one at 2/s
 *  (base-tapes' PROVIDER_PACE; live, 21 Nov 23:4xZ, a batch of 10 was 429 on both). */
export const KEY_BATCH = 5;
export const KEY_EVERY_MS = 2_500;
/** The candidates read for a busier pool outside the PoolManager, busiest first. */
export const ELSEWHERE_COINS = 5;
export const DOMINANCE = 2;
/** Every v2 and v3 factory the helper reads on Base (swaps.ts VENUES.base). */
const FACTORIES = new Set([...VENUES.base.v2, ...VENUES.base.v3]);
export const FILL_MS = 45_000;
export const FILL_EVERY_MS = 3_000;
const sleep = (ms) => new Promise((go) => setTimeout(go, ms));
export const QUOTE_POOLS_MAX = 3;
/** A quote's Transfer counterparties read for a v2 or v3 pool against USDC, WETH or ETH, most transfers first. */
export const MARKET_PARTIES = 5;
/** Blocks under the head a tape may not hold yet (index-evm-swaps MARGIN.base). */
export const MARGIN = 120;
const PM = VENUES.base.poolManager;
const POSM = VENUES.base.positionManager;
const BASES = new Set([VENUES.base.usd, VENUES.base.weth, `0x${"0".repeat(40)}`]);
const hex = (n) => `0x${n.toString(16)}`;

/** The coins a scan ({ head, pools: [{ id, n, txs: [[tx, block]], c0, c1 }], elsewhere }) may judge, busiest first:
 *  each whose busiest v4 pool is third-quoted and that no venue's pool outside the PoolManager outtrades
 *  (`elsewhere[coin]`: the v2 or v3 pool whose Transfers of the coin outnumber that pool's swaps, null when none). */
export function candidates(scan) {
  const busiest = new Map();
  const quotes = new Map();
  for (const p of scan.pools) {
    if (typeof p.c0 !== "string" || typeof p.c1 !== "string") continue;
    for (const c of [p.c0, p.c1]) if (!busiest.has(c) || busiest.get(c).n < p.n) busiest.set(c, p);
    if (!BASES.has(p.c0) && !BASES.has(p.c1)) for (const c of [p.c0, p.c1]) quotes.set(c, (quotes.get(c) ?? 0) + 1);
  }
  const out = [];
  for (const [c, p] of busiest) {
    if (BASES.has(p.c0) || BASES.has(p.c1) || BASES.has(c)) continue;
    // the coin is the side that is not many coins' quote
    const other = p.c0 === c ? p.c1 : p.c0;
    if ((quotes.get(c) ?? 0) > QUOTE_POOLS_MAX || (quotes.get(c) ?? 0) > (quotes.get(other) ?? 0)) continue;
    out.push({ coin: c, pool: p.id, n: p.n, quote: other });
  }
  return out.sort((a, b) => b.n - a.n || (a.coin < b.coin ? -1 : 1));
}
/** The coin to judge: the busiest candidate the scan read outside the PoolManager and found no busier pool of, whose
 *  pool clearly carries its trading: the coin's other transactions in the scan (`others[coin]`: those with a Transfer of
 *  it that are not the pool's swaps) are at most 1/DOMINANCE of the pool's swaps. Two pools of a coin near a tie are
 *  each the busier by the window read (live, 21 Nov 23:4xZ: Base 0x95669a65's two third-quoted pools, 5 against 14 swaps
 *  over 1,500 blocks and 65 against 53 over 12,000), so neither is judged. */
export function pick(scan) {
  // a scan recorded before the quotes' markets were read (bad_run_44942886709) names none: its pick stands as it was read
  const c = candidates(scan).find((x) => scan.elsewhere?.[x.coin] === null && typeof scan.others?.[x.coin] === "number" && scan.others[x.coin] * DOMINANCE <= x.n && (scan.markets === undefined || scan.markets[x.quote] != null));
  return c === undefined ? null : { coin: c.coin, pool: c.pool };
}
/** The busiest candidate whose quote traded against no USDC, WETH or ETH pool on Base in the scan (`markets[quote]`
 *  null): no pool the helper's tape can price, so the coin is judged on its answer's status alone. */
export function unpriced(scan) {
  const c = scan.markets === undefined ? undefined : candidates(scan).find((x) => scan.markets[x.quote] === null);
  return c === undefined ? null : { coin: c.coin, pool: c.pool, quote: c.quote };
}

/** Base's block at a time in ms (BLOCK_CLOCK's last era). */
const blockOfMs = (ms) => {
  const e = BLOCK_CLOCK.base.at(-1);
  return e.fromBlock + Math.floor((ms - e.atMs) / e.blockMs);
};

/** The verdict of a run: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const bad = (l) => (lines.push(`BAD ${l}`), false);
  const ok = (l) => (lines.push(`ok  ${l}`), true);
  // the providers' no-answers are theirs, never the helper's: a scan they left unread judges nothing
  if (run.scan == null) return { ok: false, verdict: "INCONCLUSIVE", lines: [`-- the scan was not read on two agreeing providers: ${run.scanUnread ?? "no answer"}`] };
  const chosen = pick(run.scan);
  const un = unpriced(run.scan);
  if (chosen === null && un === null) return { ok: false, verdict: "INCONCLUSIVE", lines: [`-- no third-quoted coin in ${run.scan.pools.length} pools over ${SCAN_BLOCKS} blocks to ${run.scan.head}`] };
  let good = true;
  if (un !== null) {
    const u = run.unpriced;
    const status = u?.trades?.status;
    if (u?.coin !== un.coin) good = bad(`the run read ${u?.coin} as the coin with no market its quote can price, the scan names ${un.coin}`);
    else if (status === 200 || status === 404) ok(`the coin ${un.coin}: its busiest pool ${un.pool} is quoted in ${un.quote}, which traded against no USDC, WETH or ETH pool on Base in the scan: trades ${status}, never a 5xx`);
    else good = bad(`the coin ${un.coin}, whose quote ${un.quote} has no market on Base the tape can price it by: trades ${status} ${u.trades?.body?.slice(0, 80)}, not 200: a listed coin's tape is never a 5xx`);
  }
  if (chosen === null) return { ok: good, verdict: good ? "PASS" : "FAIL", lines: [...lines, `-- no third-quoted coin whose quote has a market on Base in ${run.scan.pools.length} pools: no tape judged`] };
  good = (chosen.coin === run.coin && chosen.pool === run.pool ? ok(`the coin ${run.coin}: its busiest pool ${run.pool} is quoted in a third token (${run.scan.pools.find((p) => p.id === run.pool).n} swaps in the scan, ${run.scan.others[run.coin]} other transactions of the coin; no v2 or v3 pool of it busier)`) : bad(`the run judged ${run.coin} ${run.pool}, the scan picks ${chosen.coin} ${chosen.pool}`)) && good;
  const t = run.trades;
  let rows = [];
  try {
    rows = t?.status === 200 ? JSON.parse(t.body).trades : [];
  } catch {}
  if (t?.status !== 200 || t.headers?.["x-helper-source"] !== "chain" || !Array.isArray(rows) || rows.length === 0) good = bad(`trades: ${t?.status} ${t?.headers?.["x-helper-source"]} with ${rows.length} trades, not a tape of our own reads`) && good;
  else {
    ok(`trades 200 from our own chain reads, ${rows.length} trades`);
    const onTape = new Set(rows.map((r) => r.tx));
    const oldest = blockOfMs(Math.min(...rows.map((r) => r.t_ms)));
    const pool = run.scan.pools.find((p) => p.id === run.pool);
    const want = [...new Set(pool.txs.filter(([, b]) => b >= oldest && b <= run.scan.head - MARGIN).map(([tx]) => tx))];
    const missing = want.filter((tx) => !onTape.has(tx));
    good = (missing.length === 0 ? ok(`all ${want.length} swap transactions of ${run.pool.slice(0, 10)} from the tape's oldest trade (block ${oldest}) to ${MARGIN} blocks under the head are on the tape`) : bad(`${missing.length} of ${want.length} swap transactions of the coin's busiest pool ${run.pool.slice(0, 10)} from the tape's oldest trade (block ${oldest}) are not on the tape: ${missing.slice(0, 5).join(", ")}; the tape is another pool's`)) && good;
  }
  return { ok: good, verdict: good ? "PASS" : "FAIL", lines };
}

/** One provider's answer to `calls` (one [method, params], or a list of them sent as one batch), read through
 *  provider-answer.mjs: `{ result }` (a batch's: every call's result in order), `{ error }` or `{ noAnswer }`. */
async function ask(url, calls, fetchFn) {
  if (!Array.isArray(calls[0])) return rpcAnswer(url, calls[0], calls[1], { fetchFn, timeoutMs: READ_MS });
  const b = await rpcBatchAnswer(url, calls, { fetchFn, timeoutMs: READ_MS });
  if (b.noAnswer !== undefined) return { noAnswer: b.noAnswer };
  if (b.error !== undefined) return { error: b.error };
  // a call that reverts (factory() on a router or an account) is an answer, null; any other error leaves the provider out
  const reverted = (e) => e?.code === 3 || (typeof e?.message === "string" && /^execution reverted/i.test(e.message));
  const gap = b.answers.find((x) => x.noAnswer !== undefined) ?? b.answers.find((x) => x.error !== undefined && !reverted(x.error));
  return gap ?? { result: b.answers.map((x) => (x.error !== undefined ? null : x.result)) };
}
/** The same read on providers in turn until two answer it alike (`norm`: the part of an answer that must agree):
 *  `{ result }`, or `{ unread }` naming why not. A provider's no-answer (a 429, a rate limit, an empty body, a block it
 *  does not hold) or error is left out, never judged: the subject is the helper's tape, not the providers. */
async function agreed(calls, fetchFn, rpcs, norm = (x) => x) {
  const got = [];
  const left = [];
  for (const u of rpcs) {
    const a = await ask(u, calls, fetchFn);
    if (a.result === undefined) {
      left.push(a.noAnswer ?? `${new URL(u).host}: ${JSON.stringify(a.error).slice(0, 80)}`);
      continue;
    }
    const s = JSON.stringify(norm(a.result));
    if (got.includes(s)) return { result: JSON.parse(s) };
    got.push(s);
  }
  return { unread: `${got.length} providers answered ${Array.isArray(calls[0]) ? `a batch of ${calls.length} ${calls[0][0]}` : calls[0]}, no two alike${left.length === 0 ? "" : `; left out: ${left.join("; ")}`}` };
}

/** Our own scan of the PoolManager's swaps and the busiest pools' keys (two agreeing providers each): the scan, or
 *  `{ unread }` naming the read no two providers answered alike. */
export async function scan(fetchFn = fetch, rpcs = SWAP_RPCS.base.filter((u) => !u.includes("mainnet.base.org"))) {
  // two providers' heads differ by a block or two: the scan ends 10 blocks under the lower of the first two answered
  const heads = [];
  for (const u of rpcs) {
    if (heads.length === 2) break;
    const a = await rpcAnswer(u, "eth_blockNumber", [], { fetchFn, timeoutMs: READ_MS });
    if (typeof a.result === "string" && /^0x[0-9a-f]+$/i.test(a.result)) heads.push(parseInt(a.result, 16));
  }
  if (heads.length < 2) return { unread: `${heads.length} providers answered eth_blockNumber` };
  const head = Math.min(...heads) - 10;
  // SCAN_STEP blocks a read, the span the keyless providers all take (tenderly refused the 1,500 in one, 21 Nov 23:3xZ)
  const logs = [];
  for (let lo = head - SCAN_BLOCKS + 1; lo <= head; lo += SCAN_STEP) {
    // each log as the chain holds it (providers add fields of their own)
    const part = await agreed(["eth_getLogs", [{ address: PM, topics: [TOPIC.swap4], fromBlock: hex(lo), toBlock: hex(Math.min(head, lo + SCAN_STEP - 1)) }]], fetchFn, rpcs, (ls) => (Array.isArray(ls) ? ls.map((l) => ({ transactionHash: l.transactionHash, blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16), topics: l.topics, data: l.data })) : ls));
    if (part.unread !== undefined) return part;
    if (!Array.isArray(part.result)) return { unread: "eth_getLogs answered no list" };
    logs.push(...part.result);
  }
  const by = new Map();
  for (const l of logs) {
    const id = l.topics?.[1];
    if (typeof id !== "string") continue;
    const p = by.get(id) ?? { id, n: 0, txs: [] };
    p.n++;
    p.txs.push([l.transactionHash, l.blockNumber]);
    by.set(id, p);
  }
  const top = [...by.values()].sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1)).slice(0, SCAN_POOLS);
  // KEY_BATCH calls a post (the keyless providers cap a batch)
  const keys = [];
  for (let i = 0; i < top.length; i += KEY_BATCH) {
    if (i > 0) await sleep(KEY_EVERY_MS);
    const part = await agreed(top.slice(i, i + KEY_BATCH).map((p) => ["eth_call", [{ to: POSM, data: `0x86b6be7d${p.id.slice(2, 52).padEnd(64, "0")}` }, hex(head)]]), fetchFn, rpcs);
    if (part.unread !== undefined) return part;
    keys.push(...part.result);
  }
  top.forEach((p, i) => {
    const k = keys[i];
    if (typeof k === "string" && k.length === 2 + 64 * 5) [p.c0, p.c1] = [`0x${k.slice(26, 66)}`, `0x${k.slice(90, 130)}`];
  });
  // the candidates' Transfers over the same blocks: a counterparty with more of them than the v4 pool has swaps, whose
  // factory is a v2 or v3 venue's, is a busier pool of the coin outside the PoolManager (its tape is that pool's)
  const elsewhere = {};
  const others = {};
  for (const c of candidates({ head, pools: top }).slice(0, ELSEWHERE_COINS)) {
    const n = new Map();
    const txs = new Set();
    for (let lo = head - SCAN_BLOCKS + 1; lo <= head; lo += SCAN_STEP) {
      const got = await agreed(["eth_getLogs", [{ address: c.coin, topics: [TOPIC.transfer], fromBlock: hex(lo), toBlock: hex(Math.min(head, lo + SCAN_STEP - 1)) }]], fetchFn, rpcs, (ls) => (Array.isArray(ls) ? ls.map((l) => [l.transactionHash, l.topics]) : ls));
      if (got.unread !== undefined) return got;
      const part = got.result;
      if (!Array.isArray(part)) return { unread: "eth_getLogs answered no list" };
      for (const [tx] of part) txs.add(tx);
      for (const [, t] of part) for (const a of [t[1], t[2]]) if (typeof a === "string") n.set(`0x${a.slice(26)}`, (n.get(`0x${a.slice(26)}`) ?? 0) + 1);
    }
    const busier = [...n].filter(([a, k]) => a !== PM && a !== `0x${"0".repeat(40)}` && k > c.n).sort((x, y) => y[1] - x[1]).slice(0, 3);
    // a counterparty with no factory() (an EOA, a router) reverts or answers 0x: judged as no venue's pool
    const fa = busier.length === 0 ? { result: [] } : await agreed(busier.map(([a]) => ["eth_call", [{ to: a, data: "0xc45a0155" }, hex(head)]]), fetchFn, rpcs);
    if (fa.unread !== undefined) return fa;
    const f = fa.result;
    const pool = busier.find((_, i) => typeof f[i] === "string" && f[i].length === 66 && FACTORIES.has(`0x${f[i].slice(26)}`));
    elsewhere[c.coin] = pool === undefined ? null : { pool: pool[0], transfers: pool[1] };
    const own = new Set(top.find((p) => p.id === c.pool).txs.map(([tx]) => tx));
    others[c.coin] = [...txs].filter((tx) => !own.has(tx)).length;
  }
  // each candidate's quote: a market against USDC, WETH or ETH on Base in the scan, null when it traded against none
  const markets = {};
  for (const c of candidates({ head, pools: top }).slice(0, ELSEWHERE_COINS)) {
    if (c.quote in markets) continue;
    const v4 = top.find((p) => (p.c0 === c.quote && BASES.has(p.c1)) || (p.c1 === c.quote && BASES.has(p.c0)));
    if (v4 !== undefined) {
      markets[c.quote] = { pool: v4.id, venue: "v4" };
      continue;
    }
    const n = new Map();
    for (let lo = head - SCAN_BLOCKS + 1; lo <= head; lo += SCAN_STEP) {
      const got = await agreed(["eth_getLogs", [{ address: c.quote, topics: [TOPIC.transfer], fromBlock: hex(lo), toBlock: hex(Math.min(head, lo + SCAN_STEP - 1)) }]], fetchFn, rpcs, (ls) => (Array.isArray(ls) ? ls.map((l) => l.topics) : ls));
      if (got.unread !== undefined) return got;
      if (!Array.isArray(got.result)) return { unread: "eth_getLogs answered no list" };
      for (const t of got.result) for (const a of [t[1], t[2]]) if (typeof a === "string") n.set(`0x${a.slice(26)}`, (n.get(`0x${a.slice(26)}`) ?? 0) + 1);
    }
    const parties = [...n].filter(([a]) => a !== PM && a !== `0x${"0".repeat(40)}`).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, MARKET_PARTIES).map(([a]) => a);
    markets[c.quote] = null;
    if (parties.length === 0) continue;
    await sleep(KEY_EVERY_MS);
    const fa = await agreed(parties.map((a) => ["eth_call", [{ to: a, data: "0xc45a0155" }, hex(head)]]), fetchFn, rpcs);
    if (fa.unread !== undefined) return fa;
    for (const [i, a] of parties.entries()) {
      const f = fa.result[i];
      if (typeof f !== "string" || f.length !== 66 || !FACTORIES.has(`0x${f.slice(26)}`)) continue;
      await sleep(KEY_EVERY_MS);
      const tk = await agreed([["eth_call", [{ to: a, data: "0x0dfe1681" }, hex(head)]], ["eth_call", [{ to: a, data: "0xd21220a7" }, hex(head)]]], fetchFn, rpcs);
      if (tk.unread !== undefined) return tk;
      const [t0, t1] = tk.result.map((x) => (typeof x === "string" && x.length === 66 ? `0x${x.slice(26)}` : null));
      if ((t0 === c.quote && BASES.has(t1)) || (t1 === c.quote && BASES.has(t0))) {
        markets[c.quote] = { pool: a, venue: `0x${f.slice(26)}` };
        break;
      }
    }
  }
  return { head, pools: top, elsewhere, others, markets };
}

export async function read(base = BASE, fetchFn = fetch, rpcs = undefined) {
  const s = await scan(fetchFn, rpcs);
  if (s.unread !== undefined) return { base, scan: null, scanUnread: s.unread };
  const chosen = pick(s);
  const un = unpriced(s);
  // a cold coin's tape answers `filling` until its read is done: read again FILL_EVERY_MS apart, FILL_MS at most (the
  // bound a cold Base tape fills inside, card base-tapes-fill-inside-their-bound)
  const tape = async (coin) => {
    for (const t0 = Date.now(); ; await sleep(FILL_EVERY_MS)) {
      const r = await fetchFn(`${base}${TRADES_PATH(coin)}`, { headers: { Origin: APP }, signal: AbortSignal.timeout(60_000) });
      const trades = { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
      if (!/"filling":true/.test(trades.body) || Date.now() - t0 >= FILL_MS) return trades;
    }
  };
  const run = { base, scan: s };
  if (un !== null) run.unpriced = { coin: un.coin, pool: un.pool, trades: await tape(un.coin) };
  if (chosen !== null) Object.assign(run, { coin: chosen.coin, pool: chosen.pool, trades: await tape(chosen.coin) });
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const run = await read(base);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${base}, ${run.coin ?? "no coin"})`);
    process.exit({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 }[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
