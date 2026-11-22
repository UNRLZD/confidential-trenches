#!/usr/bin/env node
// Live check of card helper-tape-handover: right after a helper deploy a Base or Robinhood coin's trade list answers its
// first read as full as the old helper held it. Since the card the old helper hands each book it holds, open or at rest
// (its pool, settled block, swaps and bars), to the next in its warm file (apps/helper/src/data/evm/swaps.ts state
// `books`), and the next one goes on from the settled block; before it every book started over from the chain's cold
// window (VENUES.base.cold, about 5 minutes of Base), so a quiet coin's first answer held a few rows or none and filled
// from the chain over the next minutes (helper update 22, rolled back 22 Nov 10:57Z; live run 45011614034).
// Read, with no key and no transaction:
//   - GET <helper>/v1/health: its X-Helper-Started header and commit;
//   - for each chain, GET /v1/market/lists?chain=<chain>, then for its first COINS coins (or --token <chain>:<address>)
//     GET /v1/market/trades?chain=<chain>&token=<t>&limit=50 with Origin APP, every POLL_MS until it is not filling or
//     FILLED_MS (tape-read.mjs) from its first read has passed, each answer's Server-Timing kept (2,000 chars at most).
// Judged: the helper names its start; a coin's first answer is short when its last answer holds a row its first did not
// at or before the first answer's newest row (and, a first answer under 50 rows, anywhere below it): rows the first
// answer should have held, filled in after it. Rows newer than its newest are the blocks since (a book at rest reads them
// after its first answer, as on the old helper) and are not judged. Card helper-tape-handover-judges-handed-books: only a
// book the old helper handed over is judged. Its answer names it in its Server-Timing (HANDED, swaps.ts HANDED_TIMING),
// and its first answer short FAILs. A book the old helper did not hand over (one it never held, or an old helper whose
// warm file holds no books, as helper-24's rollback to 90776a37e on 22 Nov 13:17Z) opens cold: its short first answer is
// named, not failed (before the card every short first answer on a young helper FAILed, a cold one too).
// Its runs are helper-tape-handover.answers.json, replayed by its .test.mjs.
// After: helper
// Serial: evm-keyed 3 (first of the group: it reads each tape's first answer nearest the deploy; its Base and Robinhood tape reads draw the keyed providers)
//   node scripts/live-checks/helper-tape-handover.mjs [--base <url>] [--token <chain>:<0x..>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, verdictOf } from "./provider-answer.mjs";
import { FILLED_MS } from "./tape-read.mjs";

export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["base", "robinhood"];
/** A helper younger than this is named as just started. [design: one with helper-evm-tapes-survive-a-restart] */
export const RESTART_MS = 20 * 60_000;
export const LIMIT = 50;
const COINS = 3;
const POLL_MS = 1_000;
const TIMEOUT_MS = 15_000;
/** The Server-Timing part a trades answer carries when its book came from the handover (apps/helper/src/data/evm/swaps.ts
 *  HANDED_TIMING); a string from the network, read by this bounded pattern only. */
export const HANDED = /(?:^|,)\s*evm-handed;/;
/** Whether an answer's recorded Server-Timing names its book as handed over. */
export const handedOf = (a) => typeof a?.timing === "string" && a.timing.length <= 2_000 && HANDED.test(a.timing);

/** The rows of an answer's body as [tx, t_ms], or null when it holds none in that shape. */
const rowsOf = (b) => (Array.isArray(b?.trades) ? b.trades.filter((r) => typeof r?.tx === "string" && Number.isFinite(r?.t_ms)).map((r) => [r.tx, r.t_ms]) : null);

/** One run: the health's start, each chain's coins and their first and last tape answers. Never throws. */
export async function read(base = BASE, fetchFn = fetch, tokens = {}) {
  const root = String(base).replace(/\/$/, "");
  const get = async (path) => {
    const at = Date.now();
    try {
      const r = await fetchFn(`${root}${path}`, { headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { at, status: r.status, started: r.headers.get("x-helper-started"), timing: (r.headers.get("server-timing") ?? "").slice(0, 2_000), body: (await r.text()).slice(0, 200_000) };
    } catch (e) {
      return { at, error: String(e?.message ?? e).slice(0, 200) };
    }
  };
  const h = await get("/v1/health");
  let commit = null;
  try {
    commit = JSON.parse(h.body ?? "null")?.commit ?? null;
  } catch {}
  const run = { at: new Date().toISOString(), base: root, health: { at: h.at, status: h.status ?? null, error: h.error ?? null, started: h.started ?? null, commit }, chains: {} };
  for (const chain of CHAINS) {
    let coins = tokens[chain] === undefined ? [] : [tokens[chain]];
    let lists = null;
    if (coins.length === 0) {
      const l = await get(`/v1/market/lists?chain=${chain}`);
      lists = { status: l.status ?? null, error: l.error ?? null };
      try {
        coins = [...new Set(Object.values(JSON.parse(l.body ?? "null")?.lists ?? {}).flat().map((r) => r?.token).filter((t) => /^0x[0-9a-f]{40}$/.test(String(t))))].slice(0, COINS);
      } catch {
        coins = [];
      }
    }
    const tapes = [];
    for (const coin of coins) {
      const answers = [];
      const t0 = Date.now();
      for (;;) {
        const a = await get(`/v1/market/trades?chain=${chain}&token=${coin}&limit=${LIMIT}`);
        let b = null;
        try {
          b = JSON.parse(a.body ?? "null");
        } catch {}
        answers.push({ at: a.at, status: a.status ?? null, error: a.error ?? null, filling: b?.filling === true, src: b?.src ?? null, timing: a.timing ?? null, rows: rowsOf(b) });
        if (a.status !== 200 || b?.filling !== true || Date.now() - t0 >= FILLED_MS) break;
        await new Promise((ok) => setTimeout(ok, POLL_MS));
      }
      // the first and the last answer whole, the reads between counted
      tapes.push({ coin, reads: answers.length, first: answers[0], last: answers.at(-1) });
    }
    run.chains[chain] = { lists, tapes };
  }
  return run;
}

/** The rows the last answer holds that the first should have held (see the header), as [tx, t_ms]. */
export function missed(first, last) {
  const f = first?.rows ?? [];
  const l = last?.rows ?? [];
  if (f.length === 0) return l;
  const had = new Set(f.map(([tx]) => tx));
  const newest = Math.max(...f.map(([, t]) => t));
  const oldest = Math.min(...f.map(([, t]) => t));
  return l.filter(([tx, t]) => !had.has(tx) && t <= newest && (f.length < LIMIT || t >= oldest));
}

/** The verdict of a run on `chains` (every chain the check reads unless a replay names fewer): { ok, verdict, lines }. */
export function judge(run, chains = CHAINS) {
  const lines = [];
  let bad = false;
  const say = (ok, what) => {
    lines.push(`${ok ? "GOOD" : "BAD"} ${what}`);
    if (!ok) bad = true;
  };
  const h = run?.health ?? {};
  const started = /^[1-9][0-9]{12}$/.test(String(h.started ?? "")) ? Number(h.started) : null;
  if (h.status !== 200) say(false, `/v1/health answered ${h.status ?? h.error}`);
  else say(started !== null && started <= h.at, `/v1/health names the helper's start: X-Helper-Started ${JSON.stringify(h.started)} (commit ${h.commit ?? "none"})`);
  const ageMs = started === null ? null : h.at - started;
  const young = ageMs !== null && ageMs < RESTART_MS;
  if (ageMs !== null) lines.push(`--  the helper started ${Math.round(ageMs / 1_000)} s before the health read (${young ? "within" : "past"} ${RESTART_MS / 60_000} min${young ? ": a deploy" : ""})`);
  for (const chain of chains) {
    const tapes = run?.chains?.[chain]?.tapes ?? [];
    if (tapes.length === 0) {
      say(false, `[${chain}] no coin read (lists ${JSON.stringify(run?.chains?.[chain]?.lists ?? null)})`);
      continue;
    }
    for (const t of tapes) {
      const f = t.first ?? {};
      const l = t.last ?? f;
      const tag = `[${chain} ${t.coin}]`;
      if (f.status !== 200 || f.rows === null) {
        say(false, `${tag} its first read answered ${f.status ?? f.error}${f.status === 200 ? " with no rows list" : ""}`);
        continue;
      }
      const miss = missed(f, l);
      const handed = handedOf(f);
      const what = `${handed ? "handed over" : "cold"}, first answer ${f.rows.length} rows${f.filling ? " (filling)" : ""}, last ${l.rows?.length ?? 0} rows ${(((l.at ?? f.at) - f.at) / 1_000).toFixed(1)} s on after ${t.reads} read(s)`;
      if (miss.length === 0) say(true, `${tag} ${what}: every row of its span there at its first answer`);
      else if (handed) say(false, `${tag} ${what}: ${miss.length} row(s) at or below its first answer's span filled in after it on a helper ${ageMs === null ? "of unnamed age" : `${Math.round(ageMs / 1_000)} s old`} (oldest ${new Date(Math.min(...miss.map(([, x]) => x))).toISOString()})`);
      else lines.push(`--  ${tag} ${what}: ${miss.length} row(s) filled in after its first answer; its book was not handed over (it opened cold), so it is named, not judged`);
    }
  }
  const verdict = verdictOf(bad, false);
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
    console.log(`${r.verdict} helper-tape-handover`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`helper-tape-handover: ${e?.message ?? e}`);
    process.exit(2);
  }
}
