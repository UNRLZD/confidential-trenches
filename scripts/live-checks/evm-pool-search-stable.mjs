#!/usr/bin/env node
// Live check of card evm-pool-search-stable: a graduated Pons coin's Robinhood tape is its v4 pool's trades, never the
// curve it left. The helper's discovery took its candidates from the coin's transfers in the last five minutes, and the
// Pons factory's record always added the curve: a graduated coin with no transfer in those minutes had its dead curve as
// its only candidate and its tape answered no trades (ZOLVA 0x8e045494 and VETO 0x0d099caf: 0 trades on the deployed
// helper 16 Nov 22:4xZ, while DexScreener counted 278 and 16 transactions on their v4 pools over the day).
// The coins: KNOWN, then the deployed Robinhood lists' tokens, each one whose Pons record (getLaunchedToken on the
// factory, read at one block on both RPCS, which must answer alike) is PoolCreated, at most COINS. Each one's pool is
// worked out from its record as the factory keys it (token and pairToken sorted, poolFee, tickSpacing, the factory's
// memeHook, read alike on both), and its swaps over the newest WINDOW blocks are read on LOGS_RPC, less the hook's own.
// Each coin with a swap there is opened as the page reads it (GET /v1/market/trades?chain=robinhood&token=<t>&limit=50,
// again every POLL_MS while it says filling, BOUND_MS at most). It passes only when every answer is 200 and each tape
// settles holding trades from our own reads (src chain): a coin whose pool swapped in the window has trades in a tape
// that reads back a day. A tape settled with none while its pool swapped (the curve read): FAIL. The trades that are
// its graduated pool's swaps are counted and shown, not required: a coin's tape is its busiest pool's, which may be
// another. No graduated coin with a swap in the window: INCONCLUSIVE.
// After: helper
// Serial: evm-keyed 210 (its Robinhood tape reads draw the keyed providers)
//   node scripts/live-checks/evm-pool-search-stable.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read (each coin's record
//   phase, pool, its swaps' transactions and the tape's answers), so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

// keccak from the helper's own dependencies (apps/ is outside Blindfill), as evm-pool-amounts-are-standard-sizes reads it
const { keccak_256 } = createRequire(new URL("../../apps/helper/package.json", import.meta.url))("@noble/hashes/sha3.js");
const KEY = "evm-pool-search-stable";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Two keyless Robinhood RPCs that answer eth_call at a block, and the one that answers eth_getLogs over WINDOW blocks. */
export const RPCS = ["https://robinhood.daybreak-rpc.network", "https://rpc-robinhood.blockmachine.io"];
export const LOGS_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/** ZOLVA and VETO, the card's two coins. */
export const KNOWN = ["0x8e04549484d0612be8373a0263b11928a5f7681f", "0x0d099caf7e87626c8327f01471a142d244900f7f"];
export const COINS = 4;
/** The blocks of swaps read: the most rpc.mainnet.chain.robinhood.com takes in one eth_getLogs (about 2.7 hours). */
export const WINDOW = 100_000;
export const POLL_MS = 3_000;
export const BOUND_MS = 180_000;
const PHASE_POOL_CREATED = 2;
const hex = (b) => Buffer.from(b).toString("hex");
const sel = (sig) => hex(keccak_256(Buffer.from(sig))).slice(0, 8);
const SWAP = `0x${hex(keccak_256(Buffer.from("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")))}`;
const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const word = (r, i) => (typeof r === "string" && /^0x([0-9a-f]{64})+$/.test(r) && r.length >= 2 + 64 * (i + 1) ? r.slice(2 + 64 * i, 2 + 64 * (i + 1)) : null);
const pad = (a) => a.slice(2).padStart(64, "0");
const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** The v4 pool id the factory keys a PoolCreated record's pool by (PonsV2LaunchFactory _poolIdFor), or null. */
export function poolOf(token, record, hook) {
  const [t, pair, fee, spacing, phase, exists] = [0, 4, 6, 7, 10, 14].map((i) => word(record, i));
  if (record?.length !== 2 + 64 * 15 || `0x${t?.slice(24)}` !== token || BigInt(`0x${exists}`) !== 1n || Number(BigInt(`0x${phase}`)) !== PHASE_POOL_CREATED) return null;
  const p = `0x${pair.slice(24)}`;
  const [c0, c1] = token < p ? [token, p] : [p, token];
  return `0x${hex(keccak_256(Buffer.from(`${pad(c0)}${pad(c1)}${fee}${spacing}${pad(hook)}`, "hex")))}`;
}

/** Each read's result, or undefined, with each provider no-answer (rpcAnswer: read again once) named in `quiet`;
 *  AT_ONCE reads at a time. */
export const AT_ONCE = 4;
async function reads(url, calls, fetchFn, quiet) {
  const out = new Array(calls.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: AT_ONCE }, async () => {
      for (let i = next++; i < calls.length; i = next++) {
        const a = await rpcAnswer(url, calls[i][0], calls[i][1], { fetchFn });
        if (a.noAnswer !== undefined) quiet.push(a.noAnswer);
        out[i] = a.result;
      }
    }),
  );
  return out;
}
async function get(url, fetchFn) {
  const r = await fetchFn(url, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  return { status: r.status, body: await r.text() };
}
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

export async function readRun(base = BASE, { fetchFn = fetch, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = () => performance.now() } = {}) {
  const b = base.replace(/\/$/, "");
  const l = await get(`${b}/v1/market/lists?chain=robinhood`, fetchFn);
  const listed = Object.values(obj(parse(l.body)?.lists)).flatMap((rows) => arr(rows).map((r) => obj(r).token)).filter((t) => typeof t === "string" && ADDR.test(t));
  const tokens = [...new Set([...KNOWN, ...listed])];
  const quiet = [];
  const [n] = await reads(RPCS[0], [["eth_blockNumber", []]], fetchFn, quiet);
  if (typeof n !== "string" || !/^0x[0-9a-f]+$/i.test(n)) return { base, readAt: new Date().toISOString(), head: null, hook: null, quiet, lists: { status: l.status, tokens: listed.length }, coins: [] };
  const head = Number(BigInt(n)) - 20;
  const at = `0x${head.toString(16)}`;
  const calls = [["eth_call", [{ to: FACTORY, data: `0x${sel("memeHook()")}` }, at]], ...tokens.map((t) => ["eth_call", [{ to: FACTORY, data: `0x${sel("getLaunchedToken(address)")}${pad(t)}` }, at]])];
  const [a, c] = await Promise.all(RPCS.map((u) => reads(u, calls, fetchFn, quiet)));
  const hook = a[0] === c[0] && word(a[0], 0) !== null ? `0x${word(a[0], 0).slice(24)}` : null;
  const coins = [];
  for (const [i, token] of tokens.entries()) {
    if (coins.length >= COINS || hook === null) break;
    if (a[i + 1] === undefined || a[i + 1] !== c[i + 1]) continue;
    const pool = poolOf(token, a[i + 1], hook);
    if (pool !== null) coins.push({ coin: token, pool });
  }
  const lo = `0x${(head - WINDOW + 1).toString(16)}`;
  const logs = await reads(LOGS_RPC, coins.map((x) => ["eth_getLogs", [{ address: POOL_MANAGER, topics: [SWAP, x.pool], fromBlock: lo, toBlock: at }]]), fetchFn, quiet);
  for (const [i, x] of coins.entries()) {
    const got = logs[i];
    x.swaps = Array.isArray(got) ? got.filter((g) => obj(g).topics?.[1] === x.pool && `0x${String(obj(g).topics?.[2]).slice(26)}` !== hook).map((g) => g.transactionHash).slice(-50) : null;
  }
  for (const x of coins.filter((y) => y.swaps?.length > 0)) {
    const t0 = now();
    x.answers = [];
    for (;;) {
      const r = await get(`${b}/v1/market/trades?chain=robinhood&token=${x.coin}&limit=50`, fetchFn);
      const j = obj(parse(r.body));
      x.answers.push({ t: Math.round(now() - t0), status: r.status, src: typeof j.src === "string" ? j.src : null, filling: j.filling === true, txs: arr(j.trades).map((t) => obj(t).tx).filter((t) => typeof t === "string" && TX.test(t)) });
      if (r.status !== 200 || j.filling !== true || now() - t0 >= BOUND_MS) break;
      await sleep(POLL_MS);
    }
    // the settled tape's transactions are what is judged: the answers before it keep their count
    for (const r of x.answers.slice(0, -1)) (r.n = r.txs.length), delete r.txs;
  }
  return { base, readAt: new Date().toISOString(), head, hook, quiet, lists: { status: l.status, tokens: listed.length }, coins };
}

/** The verdict on one run: PASS, FAIL, or INCONCLUSIVE when no graduated coin swapped in the window. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok === true ? "ok " : ok === null ? "N/A" : "BAD"} ${text}`);
  // the lists only add coins to KNOWN: their outage is no verdict on the pool search
  say(true, `GET lists?chain=robinhood answers ${run.lists?.status}, ${run.lists?.tokens ?? "no"} token(s)`);
  // a provider that answered nothing usable is no verdict (provider-answer.mjs): a coin whose record or swaps it left
  // unread is not judged, and the hook unread is INCONCLUSIVE, never FAIL
  const quiet = arr(run.quiet);
  if (quiet.length > 0) lines.push(`--  ${quiet.length} read(s) a provider left unanswered: ${[...new Set(quiet)].slice(0, 3).join("; ")}`);
  say(typeof run.hook === "string" && ADDR.test(run.hook) ? true : quiet.length > 0 ? null : false, `the factory's memeHook read alike on both RPCs: ${run.hook}`);
  const coins = arr(run.coins);
  const swapped = coins.filter((x) => x.swaps?.length > 0);
  say(swapped.length > 0 ? true : null, `${coins.length} graduated coin(s), ${swapped.length} with a swap of its pool in the newest ${WINDOW} blocks`);
  for (const x of swapped) {
    const answers = arr(x.answers);
    const last = answers.at(-1);
    const off = answers.find((r) => r.status !== 200);
    say(answers.length > 0 && off === undefined, `${x.coin}: ${answers.length} answer(s)${off === undefined ? ", every one 200" : `, one ${off.status} at ${off.t} ms`}`);
    if (last === undefined || off !== undefined) continue;
    const ours = new Set(x.swaps);
    const hit = last.txs.filter((t) => ours.has(t)).length;
    say(!last.filling && last.src === "chain" && last.txs.length > 0, `${x.coin}: ${last.filling ? `still filling at ${last.t} ms` : `settled at ${last.t} ms`} with ${last.txs.length} trade(s) from ${last.src}, ${hit} of them swaps of its pool ${x.pool.slice(0, 10)} (${x.swaps.length} in the window)`);
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : lines.some((l) => l.startsWith("N/A")) ? "INCONCLUSIVE" : "PASS";
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
