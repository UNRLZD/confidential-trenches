#!/usr/bin/env node
// Live check of card every-tape-and-chart-says-filling-behind-the-head: a coin's live chart on Base and Robinhood, and
// its Solana trade list and chart, are never served as current while the helper's copy is behind the chain (the rule
// card base-tape-never-complete-behind-the-index holds for the Base and Robinhood trade lists, its own check). Since the
// card each such answer names how far it is read in Server-Timing:
//   - Base and Robinhood candles: evm-read-to;desc="block N of head M, read S s ago" (apps/helper/src/data/evm/swaps.ts
//     readTo), current only within BEHIND_MAX (15 s: 75 Base blocks, 150 Robinhood blocks);
//   - Solana trades and candles: sol-read-to;desc="slot N of head H, heard S s ago[, <state>]" (apps/helper/src/data/
//     solana/trades.ts readTo), current only while the stream is heard within SOL_BEHIND_MS (5 s) and no gap is walked.
// Read, with no key and no transaction, for each chain: GET <helper>/v1/market/lists?chain=<chain>, then for its first
// coins (or --token <chain>:<address>) the live chart GET /v1/market/candles?chain=<chain>&token=<t>&tf=1m&limit=2 and,
// on Solana, the tape GET /v1/market/trades?chain=solana&token=<t>&limit=50, with Origin APP, every POLL_MS until it is
// not filling or FILLED_MS (tape-read.mjs) has passed; then the chain's head on its public providers (Base and
// Robinhood eth_blockNumber on swaps.ts SWAP_RPCS, Solana getSlot on trades.ts TRADES_RPCS), the highest of the first
// two that answer.
// Judged on each answer that is not filling and is our own reads (src starts "chain"): it names its read-to entry; its
// own words are within the bound; and the head it names (EVM: the block it is read to) is no further behind the
// providers' head read right after than the bound in the chain's blocks or slots, the time between the answer and that
// read, and LAG. A chart or tape filling on every read, or served from a vendor: INCONCLUSIVE for that path.
// Its recorded runs are every-tape-and-chart-says-filling-behind-the-head.answers.json, replayed by its .test.mjs.
// After: helper
// Serial: evm-keyed 230 (its Base and Robinhood chart reads draw the keyed providers)
//   node scripts/live-checks/every-tape-and-chart-says-filling-behind-the-head.mjs [--base <url>] [--token <chain>:<address>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BEHIND_MAX, SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { SOL_BEHIND_MS, TRADES_RPCS } from "../../apps/helper/src/data/solana/trades.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { FILLED_MS } from "./tape-read.mjs";

export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Each path this card holds: the chain, what is read, and the answer's read-to kind. */
export const PATHS = [
  { chain: "base", what: "candles" },
  { chain: "robinhood", what: "candles" },
  { chain: "solana", what: "trades" },
  { chain: "solana", what: "candles" },
];
/** Each chain's block or slot time: Base's 200 ms (lists.ts BLOCK_CLOCK), Robinhood's ~100 ms (swaps.ts INDEX_SLACK),
 *  Solana's ~400 ms slot (trades.ts wsSource). */
export const BLOCK_MS = { base: 200, robinhood: 100, solana: 400 };
/** The bound on each chain in ms: BEHIND_MAX's on Base and Robinhood, SOL_BEHIND_MS on Solana. */
export const BOUND_MS = { base: BEHIND_MAX.base.ms, robinhood: BEHIND_MAX.robinhood.ms, solana: SOL_BEHIND_MS };
/** Blocks or slots two providers' heads may differ by, and a head read may trail the chain by. [design: Base's
 *  lagMax (swaps.ts VENUES), 20 of Robinhood's 0.1 s blocks, 25 of Solana's slots (10 s: the public RPCs' getSlot at
 *  `finalized` default trails `confirmed` by about 32 slots, so the read asks `confirmed`)] */
export const LAG = { base: 10, robinhood: 20, solana: 25 };
const COINS = 3;
const POLL_MS = 1_000;
const TIMEOUT_MS = 15_000;
const EVM_READ_TO = /(?:^|,)\s*evm-read-to;desc="block (\d+) of head (\d+), read (\d+) s ago"/;
const SOL_READ_TO = /(?:^|,)\s*sol-read-to;desc="slot (\d+) of head (\d+|none), heard (\d+ s ago|never)(?:, (cold|refilling))?"/;

/** The answer's read-to words: { block, head, ageS } (EVM: block and head blocks; Solana: the token's slot, the
 *  stream's newest slot or null, its last message's age or null, its state), or null when it names none. */
export function readToOf(chain, timing) {
  const t = String(timing ?? "");
  if (chain !== "solana") {
    const m = EVM_READ_TO.exec(t);
    return m === null ? null : { block: Number(m[1]), head: Number(m[2]), ageS: Number(m[3]), state: "live" };
  }
  const m = SOL_READ_TO.exec(t);
  return m === null ? null : { block: Number(m[1]), head: m[2] === "none" ? null : Number(m[2]), ageS: m[3] === "never" ? null : parseInt(m[3], 10), state: m[4] ?? "live" };
}

/** The highest head of the first two of the chain's providers that answer: { n, at } or { noAnswer }. */
async function headOf(chain, fetchFn) {
  const urls = chain === "solana" ? TRADES_RPCS : SWAP_RPCS[chain];
  const got = [];
  const why = [];
  for (const url of urls) {
    if (got.length === 2) break;
    const a = chain === "solana" ? await rpcAnswer(url, "getSlot", [{ commitment: "confirmed" }], { fetchFn }) : await rpcAnswer(url, "eth_blockNumber", [], { fetchFn });
    const n = chain === "solana" ? (Number.isSafeInteger(a.result) ? a.result : null) : typeof a.result === "string" && /^0x[0-9a-f]+$/i.test(a.result) ? parseInt(a.result, 16) : null;
    if (n !== null) got.push(n);
    else why.push(a.noAnswer ?? `${new URL(url).host}: ${JSON.stringify(a.error ?? a.result).slice(0, 80)}`);
  }
  return got.length > 0 ? { n: Math.max(...got), at: Date.now(), of: got.length } : { noAnswer: why.join("; ") };
}

/** One run: each path's coins, their answers until one is not filling, and the providers' head after the last. Never
 *  throws: a failed read is recorded. `coins`: { <chain>: address or [addresses] }. */
export async function read(base = BASE, fetchFn = fetch, coins = {}) {
  const root = String(base).replace(/\/$/, "");
  // a list answer is a few hundred KB (Solana's 290 KB, 18 Nov 05:2xZ), cut at 8 MB; a chart or tape at 200 KB
  const get = async (p, max = 200_000) => {
    const at = Date.now();
    try {
      const r = await fetchFn(`${root}${p}`, { headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { at, status: r.status, timing: r.headers.get("server-timing") ?? "", body: (await r.text()).slice(0, max) };
    } catch (e) {
      return { at, error: String(e?.message ?? e).slice(0, 200) };
    }
  };
  const listed = {};
  const run = { at: new Date().toISOString(), base: root, paths: [] };
  for (const { chain, what } of PATHS) {
    if (listed[chain] === undefined) {
      listed[chain] = coins[chain] === undefined ? [] : [coins[chain]].flat();
      if (listed[chain].length === 0) {
        const l = await get(`/v1/market/lists?chain=${chain}`, 8_000_000);
        try {
          const lists = JSON.parse(l.body ?? "null")?.lists ?? {};
          listed[chain] = [...new Set(Object.values(lists).flat().map((r) => r?.token).filter((t) => typeof t === "string" && t.length >= 32 && t.length <= 44))].slice(0, COINS);
        } catch {
          listed[chain] = [];
        }
      }
    }
    const reads = [];
    for (const coin of listed[chain]) {
      const answers = [];
      const t0 = Date.now();
      for (;;) {
        const a = await get(what === "trades" ? `/v1/market/trades?chain=${chain}&token=${coin}&limit=50` : `/v1/market/candles?chain=${chain}&token=${coin}&tf=1m&limit=2`);
        let b = null;
        try {
          b = JSON.parse(a.body ?? "null");
        } catch {}
        const rows = what === "trades" ? b?.trades : b?.candles;
        answers.push({ at: a.at, status: a.status ?? null, error: a.error ?? null, timing: a.timing ?? "", rows: Array.isArray(rows) ? rows.length : null, filling: b?.filling === true, whole_ms: b?.whole_ms ?? null, src: b?.src ?? null, as_of_ms: b?.as_of_ms ?? null });
        if (a.status !== 200 || b?.filling !== true || Date.now() - t0 >= FILLED_MS) break;
        await new Promise((ok) => setTimeout(ok, POLL_MS));
      }
      const head = await headOf(chain, fetchFn);
      reads.push({ coin, answers, head });
      const last = answers.at(-1);
      if (last?.status === 200 && last.filling === false && String(last.src ?? "").startsWith("chain")) break;
    }
    run.paths.push({ chain, what, reads });
  }
  return run;
}

/** The verdict of a run: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const say = (ok, what) => {
    lines.push(`${ok ? "GOOD" : "BAD"} ${what}`);
    if (!ok) bad = true;
  };
  for (const { chain, what } of PATHS) {
    const p = run?.paths?.find((x) => x.chain === chain && x.what === what);
    const name = `${chain} ${what}`;
    if (p === undefined || p.reads.length === 0) {
      say(false, `[${name}] no coin read`);
      continue;
    }
    const ms = BOUND_MS[chain];
    let current = 0;
    for (const r of p.reads) {
      const tag = `[${name} ${r.coin}]`;
      for (const a of r.answers ?? []) {
        if (a.status !== 200) {
          lines.push(`--  ${tag} answered ${a.status ?? a.error}`);
          continue;
        }
        if (a.filling) continue;
        // a vendor's bars or rows (src not ours), or a tape that claims no reach, say nothing of our copy's lag
        // a vendor's bars or rows (src not ours), a tape that claims no reach, or a chart with no bar drawn, say nothing of
        // our copy's lag
        if (!String(a.src ?? "").startsWith("chain") || (what === "trades" && a.whole_ms === null) || (what === "candles" && a.rows === 0)) {
          lines.push(`--  ${tag} src ${a.src ?? "none"}, ${a.rows} rows${what === "trades" ? `, whole_ms ${a.whole_ms}` : ""}: not our copy's claim`);
          continue;
        }
        current++;
        const w = readToOf(chain, a.timing);
        if (w === null) {
          say(false, `${tag} served current (filling ${a.filling}, ${a.rows} rows, src ${a.src}) naming no read-to (Server-Timing ${JSON.stringify(a.timing)})`);
          continue;
        }
        if (chain === "solana") {
          say(w.state === "live" && w.ageS !== null && w.ageS * 1_000 <= ms && w.head !== null, `${tag} served current: the stream ${w.state}, heard ${w.ageS ?? "never"} s before (at most ${ms / 1_000}), its head slot ${w.head ?? "none"}`);
        } else {
          const { blocks } = BEHIND_MAX[chain];
          say(w.head - w.block <= blocks && w.ageS * 1_000 <= ms, `${tag} served current read to block ${w.block}: ${w.head - w.block} blocks behind the newest head the helper read (at most ${blocks}), that head read ${w.ageS} s before (at most ${ms / 1_000})`);
        }
        const mine = chain === "solana" ? w.head : w.block;
        if (mine === null) continue;
        if (r.head?.n === undefined) {
          lines.push(`--  ${tag} the providers' head not read (${r.head?.noAnswer ?? "none"})`);
          quiet = true;
          continue;
        }
        const after = Math.max(0, Math.ceil(((r.head.at ?? a.at) - a.at) / BLOCK_MS[chain]));
        const most = (chain === "solana" ? 0 : BEHIND_MAX[chain].blocks) + Math.ceil(ms / BLOCK_MS[chain]) + after + LAG[chain];
        say(r.head.n - mine <= most, `${tag} its ${chain === "solana" ? "stream's head slot" : "block"} ${mine} is ${r.head.n - mine} behind the providers' head ${r.head.n} read ${Math.round(((r.head.at ?? a.at) - a.at) / 1_000)} s after (at most ${most})`);
      }
    }
    if (current === 0) {
      lines.push(`--  [${name}] no answer claimed our copy current (every read filling, or a vendor's)`);
      quiet = true;
    }
  }
  const verdict = verdictOf(bad, quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const coins = {};
    const tk = opt("--token");
    if (tk !== undefined) {
      const [chain, coin] = tk.split(":");
      if (!["base", "robinhood", "solana"].includes(chain) || !/^[0-9A-Za-z]{32,44}$/.test(String(coin))) throw new Error("--token <base|robinhood|solana>:<address>");
      coins[chain] = coin;
    }
    const run = await read(opt("--base") ?? BASE, fetch, coins);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run, null, 1) + "\n");
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`${r.verdict} every-tape-and-chart-says-filling-behind-the-head`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`every-tape-and-chart-says-filling-behind-the-head: ${e?.message ?? e}`);
    process.exit(2);
  }
}
