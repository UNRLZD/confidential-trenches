#!/usr/bin/env node
// Live check of card base-tape-never-complete-behind-the-index: a Base or Robinhood coin's trade list is never served as
// complete while the helper's book of it is behind the chain. Live run 44228233209 (18 Nov 03:21Z) read Base
// 0x60858a4b's tape served at 03:21:36.95Z, not filling, without swap 0x0323e3ae in block 58908377: its newest trade in
// block 58908200, the providers' head 58908608, the book's head read some 46 s before behind a paced queue. Since the
// card the tape's answer names the block its book holds every swap to in Server-Timing (apps/helper/src/data/evm/
// swaps.ts readTo: evm-read-to;desc="block N of head M, read S s ago", M the newest head the helper read) and answers
// filling with no whole_ms past BEHIND_MAX (Base 75 blocks or 15 s, Robinhood 150 blocks or 15 s).
// Read, with no key and no transaction, for each chain:
//   - GET <helper>/v1/market/lists?chain=<chain>, then for its first coins (or --token <chain>:<address>) GET
//     /v1/market/trades?chain=<chain>&token=<t>&limit=50 with Origin APP, every POLL_MS until it is not filling or
//     FILLED_MS (tape-read.mjs) has passed; then eth_blockNumber on the chain's providers (swaps.ts SWAP_RPCS), the
//     highest of the first two that answer.
// Judged on each answer: a 200 tape not filling, with its whole_ms (a complete list the page counts by), names
// evm-read-to and claims no more than BEHIND_MAX (M - N blocks, S seconds), and the providers' head read right after
// it is no further past N than BEHIND_MAX's blocks, its ms in the chain's blocks (BLOCK_MS), the blocks between the
// answer and the head read, and LAG_BLOCKS. A tape still filling
// at FILLED_MS on every coin read: INCONCLUSIVE (it claimed no complete list).
// Its recorded runs are base-tape-never-complete-behind-the-index.answers.json, replayed by its .test.mjs.
// After: helper
// Serial: evm-keyed 220 (its Base and Robinhood tape reads draw the keyed providers)
//   node scripts/live-checks/base-tape-never-complete-behind-the-index.mjs [--base <url>] [--token <chain>:<0x..>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BEHIND_MAX, SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { FILLED_MS } from "./tape-read.mjs";

export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["base", "robinhood"];
/** Each chain's block time for the bound in blocks: Base's 200 ms (apps/helper/src/data/evm/lists.ts BLOCK_CLOCK),
 *  Robinhood's ~100 ms (swaps.ts INDEX_SLACK: 500 blocks in 50 s; index-evm-swaps.mjs MARGIN: 60 blocks, 6 s). */
export const BLOCK_MS = { base: 200, robinhood: 100 };
/** Blocks two providers' heads may differ by, and a head read may trail the chain by. [design: Base's lagMax (swaps.ts
 *  VENUES), 20 of Robinhood's 0.1 s blocks] */
export const LAG_BLOCKS = { base: 10, robinhood: 20 };
/** Coins read per chain at most, and how often a filling tape is read again. */
const COINS = 3;
const POLL_MS = 1_000;
const TIMEOUT_MS = 15_000;
const READ_TO = /(?:^|,)\s*evm-read-to;desc="block (\d+) of head (\d+), read (\d+) s ago"/;

/** The block the tape holds every swap to, the newest head the helper read and that head's age in s, from the
 *  answer's Server-Timing; null when it names none. */
export function readToOf(timing) {
  const m = READ_TO.exec(String(timing ?? ""));
  return m === null ? null : { block: Number(m[1]), head: Number(m[2]), ageS: Number(m[3]) };
}

/** The highest head of the first two of the chain's providers that answer: { n, at } or { noAnswer }. */
async function headOf(chain, fetchFn) {
  const got = [];
  const why = [];
  for (const url of SWAP_RPCS[chain]) {
    if (got.length === 2) break;
    const a = await rpcAnswer(url, "eth_blockNumber", [], { fetchFn });
    const n = typeof a.result === "string" && /^0x[0-9a-f]+$/i.test(a.result) ? parseInt(a.result, 16) : null;
    if (n !== null) got.push(n);
    else why.push(a.noAnswer ?? `${new URL(url).host}: ${JSON.stringify(a.error ?? a.result).slice(0, 80)}`);
  }
  return got.length === 2 ? { n: Math.max(...got), at: Date.now() } : { noAnswer: why.join("; ") };
}

/** One run: each chain's coins, their tape answers until one is not filling, and the providers' head after the last.
 *  Never throws: a failed read is recorded. */
export async function read(base = BASE, fetchFn = fetch, tokens = {}) {
  const root = String(base).replace(/\/$/, "");
  const get = async (path) => {
    const at = Date.now();
    try {
      const r = await fetchFn(`${root}${path}`, { headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { at, status: r.status, timing: r.headers.get("server-timing") ?? "", body: (await r.text()).slice(0, 200_000) };
    } catch (e) {
      return { at, error: String(e?.message ?? e).slice(0, 200) };
    }
  };
  const run = { at: new Date().toISOString(), base: root, chains: {} };
  for (const chain of CHAINS) {
    let coins = tokens[chain] === undefined ? [] : [tokens[chain]].flat();
    if (coins.length === 0) {
      const l = await get(`/v1/market/lists?chain=${chain}`);
      try {
        const lists = JSON.parse(l.body ?? "null")?.lists ?? {};
        coins = [...new Set(Object.values(lists).flat().map((r) => r?.token).filter((t) => /^0x[0-9a-f]{40}$/.test(String(t))))].slice(0, COINS);
      } catch {
        coins = [];
      }
      if (coins.length === 0) run.chains[chain] = { lists: { status: l.status ?? null, error: l.error ?? null }, tapes: [] };
    }
    const tapes = [];
    for (const token of coins) {
      const answers = [];
      const t0 = Date.now();
      for (;;) {
        const a = await get(`/v1/market/trades?chain=${chain}&token=${token}&limit=50`);
        let b = null;
        try {
          b = JSON.parse(a.body ?? "null");
        } catch {}
        answers.push({ at: a.at, status: a.status ?? null, error: a.error ?? null, timing: a.timing ?? "", trades: Array.isArray(b?.trades) ? b.trades.length : null, newest: Array.isArray(b?.trades) && b.trades[0] ? { t_ms: b.trades[0].t_ms, tx: b.trades[0].tx } : null, filling: b?.filling === true, whole_ms: b?.whole_ms ?? null, src: b?.src ?? null, as_of_ms: b?.as_of_ms ?? null });
        if (a.status !== 200 || b?.filling !== true || Date.now() - t0 >= FILLED_MS) break;
        await new Promise((ok) => setTimeout(ok, POLL_MS));
      }
      const head = await headOf(chain, fetchFn);
      tapes.push({ coin: token, answers, head });
      if (answers.at(-1)?.status === 200 && answers.at(-1)?.filling === false && answers.at(-1)?.whole_ms !== null) break;
    }
    run.chains[chain] = { ...run.chains[chain], tapes };
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
  for (const chain of CHAINS) {
    const { blocks, ms } = BEHIND_MAX[chain];
    const tapes = run?.chains?.[chain]?.tapes ?? [];
    if (tapes.length === 0) {
      say(false, `[${chain}] no coin read (lists ${JSON.stringify(run?.chains?.[chain]?.lists ?? null)})`);
      continue;
    }
    let complete = 0;
    for (const t of tapes) {
      const tag = `[${chain} ${t.coin}]`;
      for (const a of t.answers ?? []) {
        if (a.status !== 200) {
          lines.push(`--  ${tag} trades answered ${a.status ?? a.error}`);
          continue;
        }
        // a filling tape claims no complete list (a first open past its bound has no book to name a block of); a tape with
        // no whole_ms claims no reach to count by (a coin our reads find no pool of: the vendor's rows or none)
        if (a.filling) continue;
        if (a.whole_ms === null) {
          lines.push(`--  ${tag} a tape with no whole_ms (src ${a.src ?? "none"}, ${a.trades} trades): no complete list claimed`);
          continue;
        }
        complete++;
        const r = readToOf(a.timing);
        if (r === null) {
          say(false, `${tag} served complete (filling ${a.filling}, whole_ms ${a.whole_ms}, ${a.trades} trades) naming no block it is read to (Server-Timing ${JSON.stringify(a.timing)})`);
          continue;
        }
        say(r.head - r.block <= blocks && r.ageS * 1_000 <= ms, `${tag} served complete read to block ${r.block}: ${r.head - r.block} blocks behind the newest head the helper read (at most ${blocks}), that head read ${r.ageS} s before (at most ${ms / 1_000})`);
        if (t.head?.n === undefined) {
          lines.push(`--  ${tag} the providers' head not read (${t.head?.noAnswer ?? "none"})`);
          quiet = true;
          continue;
        }
        const after = Math.max(0, Math.ceil(((t.head.at ?? a.at) - a.at) / BLOCK_MS[chain]));
        const most = blocks + Math.ceil(ms / BLOCK_MS[chain]) + after + LAG_BLOCKS[chain];
        say(t.head.n - r.block <= most, `${tag} served complete read to block ${r.block}, ${t.head.n - r.block} blocks behind the providers' head ${t.head.n} read ${Math.round(((t.head.at ?? a.at) - a.at) / 1_000)} s after it (at most ${most})`);
      }
    }
    if (complete === 0) {
      lines.push(`--  [${chain}] every tape read was filling up to ${FILLED_MS} ms: none claimed a complete list`);
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
    const tokens = {};
    const tk = opt("--token");
    if (tk !== undefined) {
      const [chain, token] = tk.split(":");
      if (!CHAINS.includes(chain) || !/^0x[0-9a-f]{40}$/.test(String(token))) throw new Error("--token <base|robinhood>:<0x lowercase address>");
      tokens[chain] = token;
    }
    const run = await read(opt("--base") ?? BASE, fetch, tokens);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run, null, 1) + "\n");
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`${r.verdict} base-tape-never-complete-behind-the-index`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`base-tape-never-complete-behind-the-index: ${e?.message ?? e}`);
    process.exit(2);
  }
}
