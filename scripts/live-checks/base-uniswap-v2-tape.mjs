#!/usr/bin/env node
// Live check of card base-uniswap-v2-tape: a Base token whose market is a Uniswap v2 pair shows its trades and its chart
// from the deployed helper's own chain reads, every swap the pair logged on the chain on its tape. Before the venue was
// read (card every-cell-shows-a-value, 8a92d76bd) such a token answered an empty tape: 6 of the 41 listed Base tokens
// read on the helper f7f20cdaf, 2026-11-14 05:0xZ, traded only on Uniswap v2 / WETH pairs.
// The factory is Uniswap's own: UniswapV2Factory on Base is 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6 in Uniswap's v2
// deployment list (https://developers.uniswap.org/llms.mdx/docs/protocols/v2/deployments, the page
// docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments redirects to, read 2026-11-18 21:4xZ) and in
// @uniswap/sdk-core 7.20.0 dist/cjs/src/addresses.js V2_FACTORY_ADDRESSES[ChainId.BASE] (8453; the npm tarball's
// sha512 the registry names). Read on chain 2026-11-18 21:45Z at block 59239647 on base-rpc.publicnode.com and
// base.gateway.tenderly.co alike: 13,859 bytes of code (sha256 3abc53f12a9cb8ae...), allPairsLength() 3,078,960, and
// getPair(token, WETH) of four tokens named pairs whose factory(), token0() and token1() give them back.
// It reads:
//   - candidates: GeckoTerminal's uniswap-v2-base pools by 24 h trades (one page), the WETH pairs of a token other than
//     WETH, and for each, until TOKENS are read, the token's own pool list there: a token counts when every pool of it
//     with a trade in the hour is that pair (so the helper's main pool for it can only be the pair). The vendor names
//     candidates only; nothing it says is judged;
//   - on two of the helper's Base providers (SWAP_RPCS, mainnet.base.org passed over for logs: LOGS_REFUSED) that must
//     answer alike, at a block AGREED_BACK under the lower of their heads: the pair's factory(), token0() and token1()
//     and the factory's getPair(token0, token1), which must be FACTORY, the token and WETH, and the pair; then the pair's
//     Uniswap v2 Swap logs over the WINDOW blocks to it (the helper's own cold window, VENUES.base.cold);
//   - the token's tape (GET /v1/market/trades?chain=base&token=<t>&limit=50) and 1m candles at HELPER_HOST with Origin
//     APP_HOST: opened before the chain reads, read again after them up to POLLS times POLL_MS apart while its as_of_ms
//     is short of the newest swap read, or while it answers from anything but the chain (settled: card
//     v2-tape-check-waits-for-the-open; a cold open past its bound answers the vendor's held rows while it fills).
// Judged on each token whose pair two providers confirmed and whose swaps they gave alike: the tape answers 200 with
// src "chain" (the helper read the pair itself), and every swap timed at or before its as_of_ms (less SETTLE_MS) and no
// older than the tape's oldest row when the tape is full is on it by its transaction, with the side the swap's amounts
// give (the token out of the pair: a buy); the candles answer 200 from "chain" and hold a 1m bar at the newest judged
// swap's minute. PASS when a token has a judged swap and nothing is wrong; FAIL on any wrong answer; INCONCLUSIVE (exit
// 3) when no token could be judged (no candidate, providers not alike, no swap in the window).
// After: helper
// Serial: evm-keyed 380 (its Base tape and chart reads draw the keyed providers)
//   node scripts/live-checks/base-uniswap-v2-tape.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's test
//   can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { LOGS_REFUSED } from "../../apps/helper/src/limits/limits.ts";
import { SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "base-uniswap-v2-tape";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const GT = "https://api.geckoterminal.com/api/v2/networks/base";
// written out, not imported from the helper, so the check does not take the venue it checks from the helper (its
// test holds them equal to the helper's BASE_VENUES and TOPIC)
export const FACTORY = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6";
export const WETH = "0x4200000000000000000000000000000000000006";
/** UniswapV2Pair's Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256
 *  amount1Out, address indexed to). */
export const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const SEL = { factory: "0xc45a0155", token0: "0x0dfe1681", token1: "0xd21220a7", getPair: "0xe6a43905" };
/** Tokens read at most, and the judged tokens that end the run. */
export const TOKENS = 4;
export const JUDGE_ENOUGH = 2;
/** The pools GeckoTerminal's list is read for, newest page only. */
export const CANDIDATES = 20;
/** Blocks under the providers' lower head the reads are made at: past a block one of them may not hold yet. */
export const AGREED_BACK = 10;
/** The swaps' window, blocks (5 minutes of Base's 200 ms blocks, the helper's cold window), and one log read's span. */
export const WINDOW = 1_500;
export const SPAN = 750;
/** A tape is opened this long before the chain is read, then read again POLLS times POLL_MS apart at most. */
export const OPEN_MS = 10_000;
export const POLLS = 6;
export const POLL_MS = 5_000;
/** The helper's newest blocks are read again each tick: a swap this close to its as_of_ms is not judged. */
export const SETTLE_MS = 5_000;
/** Whether a tape read ends the reads: the helper's own read of the pair (src "chain") dated SETTLE_MS past the newest
 *  swap read. Card v2-tape-check-waits-for-the-open: an answer from the vendor's held rows is read again, as a cold open
 *  past its bound serves them while it fills (card evm-vendor-tape-late-open-serves-held); live run 45276410984 judged
 *  0x3c46ca0b's one read after the chain reads, src "coingecko", and the helper answered it from the chain at its next
 *  ask. A tape still from the vendor after POLLS reads is judged, and fails, as before. */
export const settled = (tape, newest) => tape.status === 200 && tape.src === "chain" && tape.as_of_ms !== null && tape.as_of_ms - SETTLE_MS >= newest;
export const TRADES_MAX = 50;
/** The pauses, ms, between two provider reads (publicnode refuses past about 6 a second, swaps.ts) and two
 *  GeckoTerminal reads (its keyless 30 a minute). The tests set them to 0. */
export const PACE = { rpcMs: 250, gtMs: 2_100 };

const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const low = (v) => String(v).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const word = (a) => a.slice(2).padStart(64, "0");
const addrOf = (w) => (typeof w === "string" && WORD.test(low(w)) && /^0x0{24}/.test(low(w)) ? `0x${low(w).slice(26)}` : null);

/** One swap log's facts, or null for a log that is not the pair's Uniswap v2 Swap: { tx, index, ts, side } with side
 *  "b" when the token left the pair, "s" when it came in, null when both or neither. */
export function swapOf(log, pair, tokenIs0) {
  if (!isObj(log) || low(log.address) !== pair || !Array.isArray(log.topics) || log.topics.length !== 3 || low(log.topics[0]) !== SWAP_TOPIC) return null;
  const data = low(log.data ?? "");
  if (!/^0x[0-9a-f]{256}$/.test(data) || !TX.test(low(log.transactionHash ?? ""))) return null;
  const w = (i) => BigInt(`0x${data.slice(2 + 64 * i, 66 + 64 * i)}`);
  const [in0, in1, out0, out1] = [w(0), w(1), w(2), w(3)];
  const [tokIn, tokOut] = tokenIs0 ? [in0, out0] : [in1, out1];
  const ts = /^0x[0-9a-f]+$/.test(low(log.blockTimestamp ?? "")) ? parseInt(log.blockTimestamp, 16) : null;
  return { tx: low(log.transactionHash), index: parseInt(log.logIndex, 16), ts, side: tokOut > 0n && tokIn === 0n ? "b" : tokIn > 0n && tokOut === 0n ? "s" : null };
}

/** The check on one run: { base, at, gt, tokens: [{ coin, pair, confirm, swaps, tape, candles }], quiet }. */
export function judge(run) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  let judgedTokens = 0;
  if (run.gt !== 200) lines.push(`--  GeckoTerminal's uniswap-v2-base pools answered ${run.gt}: no candidate`);
  for (const t of run.tokens ?? []) {
    const name = `${t.coin} (pair ${t.pair})`;
    const c = t.confirm;
    if (!isObj(c)) {
      lines.push(`--  ${name}: its pair's factory and tokens not given alike by two providers`);
      continue;
    }
    const pairTokens = [c.asset0, c.asset1].sort().join();
    if (c.factory !== FACTORY || c.back !== t.pair || pairTokens !== [t.coin, WETH].sort().join()) {
      lines.push(`--  ${name}: not a Uniswap v2 WETH pair of the token on chain (factory() ${c.factory}, getPair ${c.back}, tokens ${pairTokens}): passed over`);
      continue;
    }
    if (!Array.isArray(t.swaps)) {
      lines.push(`--  ${name}: its swaps over ${WINDOW} blocks not given alike by two providers`);
      continue;
    }
    const tape = t.tape ?? {};
    if (tape.status !== 200 || !Array.isArray(tape.rows)) {
      bad(`${name}: the tape answered ${tape.status} (${t.swaps.length} swaps on the chain in ${WINDOW} blocks)`);
      continue;
    }
    if (tape.src !== "chain") {
      bad(`${name}: the tape's src is ${JSON.stringify(tape.src)}, not "chain": the helper did not read the pair (${tape.rows.length} rows, ${t.swaps.length} swaps on the chain)`);
      continue;
    }
    const full = tape.rows.length >= TRADES_MAX;
    const oldest = full ? Math.min(...tape.rows.map((r) => r.t_ms)) : -Infinity;
    const judged = t.swaps.filter((s) => s.ts !== null && s.ts * 1000 <= tape.as_of_ms - SETTLE_MS && s.ts * 1000 >= oldest);
    if (judged.length === 0) {
      lines.push(`--  ${name}: no swap of the window to judge (${t.swaps.length} on the chain, the tape dated ${tape.as_of_ms}${full ? `, full back to ${oldest}` : ""})`);
      continue;
    }
    let wrong = 0;
    for (const s of judged) {
      const rows = tape.rows.filter((r) => r.tx === s.tx);
      if (rows.length === 0) {
        wrong++;
        bad(`${name}: swap ${s.tx} (block time ${s.ts}, side ${s.side}) is not on the tape (${tape.rows.length} rows)`);
      } else if (s.side !== null && !rows.some((r) => r.side === s.side)) {
        wrong++;
        bad(`${name}: swap ${s.tx} is a ${s.side === "b" ? "buy" : "sell"} on the chain, the tape says ${rows.map((r) => r.side).join(",")}`);
      }
    }
    const cs = t.candles ?? {};
    const minute = Math.floor(Math.max(...judged.map((s) => s.ts)) / 60) * 60;
    if (cs.status !== 200 || typeof cs.src !== "string" || !cs.src.split(",").includes("chain")) {
      wrong++;
      bad(`${name}: the 1m candles answered ${cs.status} src ${JSON.stringify(cs.src)}, not from our chain reads`);
    } else if (!(cs.bars ?? []).includes(minute)) {
      wrong++;
      bad(`${name}: no 1m bar at ${minute}, the newest judged swap's minute (bars to ${Math.max(...(cs.bars ?? [0]))})`);
    }
    if (wrong === 0) lines.push(`ok  ${name}: all ${judged.length} swap${judged.length === 1 ? "" : "s"} of the window on the tape (src chain, ${tape.rows.length} rows), sides right, a chain bar at ${minute}`);
    judgedTokens++;
  }
  if (judgedTokens === 0) lines.push(`--  no Uniswap v2 Base token judged (${(run.tokens ?? []).length} read): nothing checked`);
  for (const q of run.quiet ?? []) lines.push(`--  ${q}`);
  const failed = lines.some((l) => l.startsWith("BAD"));
  const verdict = verdictOf(failed, judgedTokens === 0);
  return { verdict, exit: EXIT[verdict], lines };
}

async function getJson(url, fetchFn, headers = {}) {
  try {
    const r = await fetchFn(url, { redirect: "manual", headers: { "cache-control": "no-cache", ...headers }, signal: AbortSignal.timeout(30_000) });
    let body = null;
    try {
      body = await r.json();
    } catch {
      // not JSON: judged by its status
    }
    return { status: r.status, body };
  } catch (e) {
    return { status: `no answer (${e.message})`, body: null };
  }
}

/** GeckoTerminal's candidates: [{ coin, pair }] whose token's every pool with a trade in the hour is the pair (the
 *  address kept as "coin": a recorded "token" key is what gitleaks' generic-api-key rule reads as a secret). */
export async function candidates(fetchFn = fetch) {
  const l = await getJson(`${GT}/dexes/uniswap-v2-base/pools?page=1&sort=h24_tx_count_desc`, fetchFn, { accept: "application/json" });
  const out = [];
  if (l.status !== 200 || !Array.isArray(l.body?.data)) return { gt: l.status, list: out };
  const idOf = (rel) => low(rel?.data?.id ?? "").replace(/^base_/, "");
  for (const p of l.body.data.slice(0, CANDIDATES)) {
    if (out.length >= TOKENS) break;
    const pair = low(p?.attributes?.address ?? "");
    const [a, b] = [idOf(p?.relationships?.base_token), idOf(p?.relationships?.quote_token)];
    const token = a === WETH ? b : b === WETH ? a : null;
    if (!ADDR.test(pair) || token === null || !ADDR.test(token) || token === WETH) continue;
    await sleep(PACE.gtMs);
    const tp = await getJson(`${GT}/tokens/${token}/pools`, fetchFn, { accept: "application/json" });
    if (tp.status !== 200 || !Array.isArray(tp.body?.data)) continue;
    const active = tp.body.data.filter((q) => {
      const h1 = q?.attributes?.transactions?.h1;
      return (Number(h1?.buys) || 0) + (Number(h1?.sells) || 0) > 0;
    });
    if (active.length > 0 && active.every((q) => low(q?.attributes?.address ?? "") === pair)) out.push({ coin: token, pair });
  }
  return { gt: l.status, list: out };
}

/** One read two providers answer alike (by `pick`), or null; a provider's no-answer passed over for the next and named
 *  in `quiet`. */
async function agreed(method, params, pick, rpcs, fetchFn, quiet) {
  const got = [];
  for (const url of rpcs) {
    if (got.length === 2) break;
    await sleep(PACE.rpcMs);
    const a = await rpcAnswer(url, method, params, { fetchFn });
    if (a.noAnswer !== undefined) quiet.push(a.noAnswer);
    else if (a.error === undefined && a.result != null) got.push(JSON.stringify(pick(a.result)));
  }
  return got.length === 2 && got[0] === got[1] ? JSON.parse(got[0]) : null;
}

/** What the run reads of one token's pair on the chain: { head, confirm, swaps }. */
export async function readChain(token, pair, fetchFn = fetch, rpcs = SWAP_RPCS.base, quiet = []) {
  const heads = [];
  for (const url of rpcs) {
    if (heads.length === 2) break;
    await sleep(PACE.rpcMs);
    const a = await rpcAnswer(url, "eth_blockNumber", [], { fetchFn });
    if (a.noAnswer !== undefined) quiet.push(a.noAnswer);
    else if (typeof a.result === "string" && /^0x[0-9a-f]+$/i.test(a.result)) heads.push(parseInt(a.result, 16));
  }
  if (heads.length < 2) return { head: null, confirm: null, swaps: null };
  const head = Math.min(...heads) - AGREED_BACK;
  const at = `0x${head.toString(16)}`;
  const call = (to, data) => agreed("eth_call", [{ to, data }, at], (r) => addrOf(r), rpcs, fetchFn, quiet);
  const factory = await call(pair, SEL.factory);
  const token0 = await call(pair, SEL.token0);
  const token1 = await call(pair, SEL.token1);
  const back = token0 && token1 ? await call(FACTORY, `${SEL.getPair}${word(token0)}${word(token1)}`) : null;
  // "asset", as the helper's fixtures name them: a recorded "token0" key is what gitleaks' generic-api-key rule reads
  // as a secret
  const confirm = factory && token0 && token1 && back ? { factory, asset0: token0, asset1: token1, back } : null;
  if (confirm === null || confirm.factory !== FACTORY || confirm.back !== pair) return { head, confirm, swaps: null };
  const tokenIs0 = token0 === token;
  const logRpcs = rpcs.filter((u) => !LOGS_REFUSED.has(u));
  const swaps = [];
  for (let from = head - WINDOW + 1; from <= head; from += SPAN) {
    const to = Math.min(head, from + SPAN - 1);
    const logs = await agreed("eth_getLogs", [{ address: pair, topics: [SWAP_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }], (r) => (Array.isArray(r) ? r.map((l) => swapOf(l, pair, tokenIs0)) : null), logRpcs, fetchFn, quiet);
    if (!Array.isArray(logs) || logs.some((s) => s === null)) return { head, confirm, swaps: null };
    swaps.push(...logs);
  }
  return { head, confirm, swaps };
}

const tapeOf = (a) => ({
  status: a.status,
  src: typeof a.body?.src === "string" ? a.body.src : null,
  as_of_ms: Number.isSafeInteger(a.body?.as_of_ms) ? a.body.as_of_ms : null,
  filling: a.body?.filling === true,
  rows: Array.isArray(a.body?.trades) ? a.body.trades.filter((x) => TX.test(low(x?.tx ?? ""))).map((x) => ({ tx: low(x.tx), side: x.side, t_ms: Number(x.t_ms) })) : null,
});
const candlesOf = (a) => ({ status: a.status, src: typeof a.body?.src === "string" ? a.body.src : null, as_of_ms: Number.isSafeInteger(a.body?.as_of_ms) ? a.body.as_of_ms : null, bars: Array.isArray(a.body?.candles) ? a.body.candles.slice(-30).map((c) => (Array.isArray(c) ? Number(c[0]) : null)) : null });

export async function read(base = BASE, fetchFn = fetch, rpcs = SWAP_RPCS.base) {
  const b = base.replace(/\/$/, "");
  const quiet = [];
  const { gt, list } = await candidates(fetchFn);
  const run = { base: b, at: new Date().toISOString(), gt, tokens: [], quiet };
  const tapeUrl = (t) => `${b}/v1/market/trades?chain=base&token=${t}&limit=${TRADES_MAX}`;
  const candlesUrl = (t) => `${b}/v1/market/candles?chain=base&token=${t}&tf=1m`;
  const helper = { origin: APP };
  // open every tape first: the helper starts reading each pair as it is asked
  for (const c of list) await getJson(tapeUrl(c.coin), fetchFn, helper);
  await sleep(OPEN_MS);
  let judged = 0;
  for (const c of list) {
    if (judged >= JUDGE_ENOUGH) break;
    const chain = await readChain(c.coin, c.pair, fetchFn, rpcs, quiet);
    const newest = Math.max(0, ...(chain.swaps ?? []).map((s) => (s.ts ?? 0) * 1000));
    let tape;
    for (let i = 0; i < POLLS; i++) {
      tape = tapeOf(await getJson(tapeUrl(c.coin), fetchFn, helper));
      if (settled(tape, newest)) break;
      await sleep(POLL_MS);
    }
    const candles = candlesOf(await getJson(candlesUrl(c.coin), fetchFn, helper));
    run.tokens.push({ ...c, ...chain, tape, candles });
    if ((chain.swaps ?? []).length > 0) judged++;
  }
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, exit, lines } = judge(run);
    for (const line of lines) console.log(line);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(exit);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
