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
//     under the scan's head, is on the tape (the tape is that pool's, not a side pool an arbitrage also swapped in);
//   - index-evm-swaps's own read and judge of the coin pass (its pool rule: the sampled trades are judged on the busiest
//     pool over the window, each amount that pool's leg).
// A scan with no third-quoted coin is INCONCLUSIVE (exit 3), never a pass.
// After: helper
// Serial: evm-keyed 101 (its tape reads and index-evm-swaps's draw the keyed Base providers)
//   node scripts/live-checks/index-evm-swaps-v4-route-tape.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes the run (every answer read).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BLOCK_CLOCK } from "../../apps/helper/src/data/evm/lists.ts";
import { SWAP_RPCS, TOPIC, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";
import { APP, BASE, judge as judgeSwaps, read as readSwaps, TRADES_PATH } from "./index-evm-swaps.mjs";

const KEY = "index-evm-swaps-v4-route-tape";
/** The scan: 1,500 blocks (5 min of Base's 200 ms blocks), the helper's own cold window (swaps.ts VENUES.base.cold). */
export const SCAN_BLOCKS = 1_500;
export const SCAN_STEP = 500;
export const SCAN_POOLS = 60;
export const KEY_BATCH = 10;
/** The candidates read for a busier pool outside the PoolManager, busiest first. */
export const ELSEWHERE_COINS = 5;
/** Every v2 and v3 factory the helper reads on Base (swaps.ts VENUES.base). */
const FACTORIES = new Set([...VENUES.base.v2, ...VENUES.base.v3]);
export const FILL_MS = 45_000;
export const FILL_EVERY_MS = 3_000;
const sleep = (ms) => new Promise((go) => setTimeout(go, ms));
export const QUOTE_POOLS_MAX = 3;
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
    out.push({ coin: c, pool: p.id, n: p.n });
  }
  return out.sort((a, b) => b.n - a.n || (a.coin < b.coin ? -1 : 1));
}
/** The coin to judge: the busiest candidate the scan read outside the PoolManager and found no busier pool of. */
export function pick(scan) {
  const c = candidates(scan).find((x) => scan.elsewhere?.[x.coin] === null);
  return c === undefined ? null : { coin: c.coin, pool: c.pool };
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
  if (run.scan == null) return { ok: false, verdict: "FAIL", lines: [`BAD the scan was not read on two agreeing providers: ${run.scanError ?? "no answer"}`] };
  const chosen = pick(run.scan);
  if (chosen === null) return { ok: false, verdict: "INCONCLUSIVE", lines: [`-- no third-quoted coin in ${run.scan.pools.length} pools over ${SCAN_BLOCKS} blocks to ${run.scan.head}`] };
  let good = chosen.coin === run.coin && chosen.pool === run.pool ? ok(`the coin ${run.coin}: its busiest pool ${run.pool} is quoted in a third token (${run.scan.pools.find((p) => p.id === run.pool).n} swaps in the scan; no v2 or v3 pool of it busier)`) : bad(`the run judged ${run.coin} ${run.pool}, the scan picks ${chosen.coin} ${chosen.pool}`);
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
  if (run.swaps !== undefined) {
    const v = judgeSwaps(run.swaps);
    for (const l of v.lines) lines.push(`[index-evm-swaps] ${l}`);
    good = (v.ok ? ok("index-evm-swaps passes on the coin") : bad(`index-evm-swaps on the coin: ${v.verdict}`)) && good;
  }
  return { ok: good, verdict: good ? "PASS" : "FAIL", lines };
}

/** One JSON-RPC answer from `url`. */
async function rpc(url, body, fetchFn) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return r.json();
}
/** The same request on providers in turn until two answer it alike (`norm`: the part of an answer that must agree);
 *  null when no two do. */
async function agreed(body, fetchFn, rpcs, norm = (x) => x) {
  const got = [];
  for (const u of rpcs) {
    let a;
    try {
      a = await rpc(u, body, fetchFn);
    } catch {
      continue;
    }
    const s = JSON.stringify(norm(Array.isArray(a) ? a.map((x) => x.result ?? null) : a.result ?? null));
    if ((Array.isArray(a) ? a.every((x) => x.result !== undefined) : a.result !== undefined) && got.includes(s)) return JSON.parse(s);
    got.push(s);
  }
  return null;
}

/** Our own scan of the PoolManager's swaps and the busiest pools' keys (two agreeing providers each). */
export async function scan(fetchFn = fetch, rpcs = SWAP_RPCS.base.filter((u) => !u.includes("mainnet.base.org"))) {
  // two providers' heads differ by a block or two: the scan ends 10 blocks under the lower of the first two answered
  const heads = [];
  for (const u of rpcs) {
    if (heads.length === 2) break;
    try {
      const a = await rpc(u, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, fetchFn);
      if (typeof a.result === "string") heads.push(parseInt(a.result, 16));
    } catch {}
  }
  if (heads.length < 2) return null;
  const head = Math.min(...heads) - 10;
  // SCAN_STEP blocks a read, the span the keyless providers all take (tenderly refused the 1,500 in one, 21 Nov 23:3xZ)
  const logs = [];
  for (let lo = head - SCAN_BLOCKS + 1; lo <= head; lo += SCAN_STEP) {
    // each log as the chain holds it (providers add fields of their own)
    const part = await agreed({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: PM, topics: [TOPIC.swap4], fromBlock: hex(lo), toBlock: hex(Math.min(head, lo + SCAN_STEP - 1)) }] }, fetchFn, rpcs, (ls) => (Array.isArray(ls) ? ls.map((l) => ({ transactionHash: l.transactionHash, blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16), topics: l.topics, data: l.data })) : ls));
    if (!Array.isArray(part)) return null;
    logs.push(...part);
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
    const part = await agreed(top.slice(i, i + KEY_BATCH).map((p, k) => ({ jsonrpc: "2.0", id: k, method: "eth_call", params: [{ to: POSM, data: `0x86b6be7d${p.id.slice(2, 52).padEnd(64, "0")}` }, hex(head)] })), fetchFn, rpcs);
    if (part === null) return null;
    keys.push(...part);
  }
  top.forEach((p, i) => {
    const k = keys[i];
    if (typeof k === "string" && k.length === 2 + 64 * 5) [p.c0, p.c1] = [`0x${k.slice(26, 66)}`, `0x${k.slice(90, 130)}`];
  });
  // the candidates' Transfers over the same blocks: a counterparty with more of them than the v4 pool has swaps, whose
  // factory is a v2 or v3 venue's, is a busier pool of the coin outside the PoolManager (its tape is that pool's)
  const elsewhere = {};
  for (const c of candidates({ head, pools: top }).slice(0, ELSEWHERE_COINS)) {
    const n = new Map();
    for (let lo = head - SCAN_BLOCKS + 1; lo <= head; lo += SCAN_STEP) {
      const part = await agreed({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: c.coin, topics: [TOPIC.transfer], fromBlock: hex(lo), toBlock: hex(Math.min(head, lo + SCAN_STEP - 1)) }] }, fetchFn, rpcs, (ls) => (Array.isArray(ls) ? ls.map((l) => l.topics) : ls));
      if (!Array.isArray(part)) return null;
      for (const t of part) for (const a of [t[1], t[2]]) if (typeof a === "string") n.set(`0x${a.slice(26)}`, (n.get(`0x${a.slice(26)}`) ?? 0) + 1);
    }
    const busier = [...n].filter(([a, k]) => a !== PM && a !== `0x${"0".repeat(40)}` && k > c.n).sort((x, y) => y[1] - x[1]).slice(0, 3);
    const f = busier.length === 0 ? [] : await agreed(busier.map(([a], i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: a, data: "0xc45a0155" }, hex(head)] })), fetchFn, rpcs);
    if (f === null) return null;
    const pool = busier.find((_, i) => typeof f[i] === "string" && f[i].length === 66 && FACTORIES.has(`0x${f[i].slice(26)}`));
    elsewhere[c.coin] = pool === undefined ? null : { pool: pool[0], transfers: pool[1] };
  }
  return { head, pools: top, elsewhere };
}

export async function read(base = BASE, fetchFn = fetch) {
  const s = await scan(fetchFn).catch((e) => (console.error(e.message), null));
  if (s === null) return { base, scan: null, scanError: "no two providers agreed" };
  const chosen = pick(s);
  if (chosen === null) return { base, scan: s };
  // a cold coin's tape answers `filling` until its read is done: read again FILL_EVERY_MS apart, FILL_MS at most (the
  // bound a cold Base tape fills inside, card base-tapes-fill-inside-their-bound)
  let trades;
  for (const t0 = Date.now(); ; await sleep(FILL_EVERY_MS)) {
    const r = await fetchFn(`${base}${TRADES_PATH(chosen.coin)}`, { headers: { Origin: APP }, signal: AbortSignal.timeout(60_000) });
    trades = { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
    if (!/"filling":true/.test(trades.body) || Date.now() - t0 >= FILL_MS) break;
  }
  const swaps = await readSwaps(base, chosen.coin, fetchFn, undefined, "base");
  return { base, scan: s, coin: chosen.coin, pool: chosen.pool, trades, swaps };
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
