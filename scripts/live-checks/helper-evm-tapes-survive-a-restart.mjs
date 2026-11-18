#!/usr/bin/env node
// Live check of card helper-evm-tapes-survive-a-restart: right after a deploy, a Base or Robinhood coin's trade list is
// served complete from what the old helper held, not filled again from the chain. Since the card the helper keeps
// Robinhood's chain-wide swap index on its store volume (apps/helper/src/data/evm/index-store.ts) and hands the main
// pools it found to the next helper in its warm file (swaps.ts state `found`), and GET /v1/health names when the process
// started (X-Helper-Started, ms). Before it, the live run after each deploy met tapes still filling: run 44249482613
// (18 Nov 06:22-06:26Z, minutes after the deploy) failed helper-tape-4337-trader and token-stats-count-every-trade, both
// PASS on the same helper warm at 07:00-07:10Z. It turns those two and base-tape-never-complete-behind-the-index green
// after a deploy; this one judges the start itself.
// Read, with no key and no transaction:
//   - GET <helper>/v1/health: its X-Helper-Started header and commit;
//   - for each chain, GET /v1/market/lists?chain=<chain>, then for its first coins (or --token <chain>:<address>) GET
//     /v1/market/trades?chain=<chain>&token=<t>&limit=50 with Origin APP, every POLL_MS until it is not filling or
//     FILLED_MS (tape-read.mjs) from its first read has passed.
// Judged: the helper names its start (an integer ms, not ahead of the read); each chain has a coin whose tape is
// served complete (200, not filling, with whole_ms) within FILLED_MS of its first read. A tape still filling then on
// every coin of a chain FAILs while the helper is younger than RESTART_MS (the start this card is about) and is
// INCONCLUSIVE past it (a warm helper: the restart was not read).
// Its recorded runs are helper-evm-tapes-survive-a-restart.answers.json, replayed by its .test.mjs.
// After: helper
// Serial: evm-keyed 5 (first of the group: it reads the tapes nearest the deploy; its Base and Robinhood tape reads draw the keyed providers)
//   node scripts/live-checks/helper-evm-tapes-survive-a-restart.mjs [--base <url>] [--token <chain>:<0x..>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, verdictOf } from "./provider-answer.mjs";
import { FILLED_MS } from "./tape-read.mjs";

export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["base", "robinhood"];
/** A helper younger than this is judged as just started. [design: 20 min, past the 11 and 15 min after the deploy at
 *  which run 44249482613's two tape checks read their tapes filling] */
export const RESTART_MS = 20 * 60_000;
const COINS = 3;
const POLL_MS = 1_000;
const TIMEOUT_MS = 15_000;

/** One run: the health's start, each chain's coins and their tape answers until one is complete. Never throws. */
export async function read(base = BASE, fetchFn = fetch, tokens = {}) {
  const root = String(base).replace(/\/$/, "");
  const get = async (path) => {
    const at = Date.now();
    try {
      const r = await fetchFn(`${root}${path}`, { headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { at, status: r.status, started: r.headers.get("x-helper-started"), body: (await r.text()).slice(0, 200_000) };
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
        const a = await get(`/v1/market/trades?chain=${chain}&token=${coin}&limit=50`);
        let b = null;
        try {
          b = JSON.parse(a.body ?? "null");
        } catch {}
        answers.push({ at: a.at, status: a.status ?? null, error: a.error ?? null, trades: Array.isArray(b?.trades) ? b.trades.length : null, filling: b?.filling === true, whole_ms: b?.whole_ms ?? null, src: b?.src ?? null });
        if (a.status !== 200 || b?.filling !== true || Date.now() - t0 >= FILLED_MS) break;
        await new Promise((ok) => setTimeout(ok, POLL_MS));
      }
      tapes.push({ coin, answers });
      const last = answers.at(-1);
      if (last?.status === 200 && !last.filling && last.whole_ms !== null) break;
    }
    run.chains[chain] = { lists, tapes };
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
  const h = run?.health ?? {};
  const started = /^[1-9][0-9]{12}$/.test(String(h.started ?? "")) ? Number(h.started) : null;
  if (h.status !== 200) say(false, `/v1/health answered ${h.status ?? h.error}`);
  else say(started !== null && started <= h.at, `/v1/health names the helper's start: X-Helper-Started ${JSON.stringify(h.started)} (commit ${h.commit ?? "none"})`);
  const ageMs = started === null ? null : h.at - started;
  const young = ageMs !== null && ageMs < RESTART_MS;
  if (ageMs !== null) lines.push(`--  the helper started ${Math.round(ageMs / 1_000)} s before the health read (${young ? "within" : "past"} ${RESTART_MS / 60_000} min: ${young ? "a restart, judged" : "warm, a filling tape not judged"})`);
  for (const chain of CHAINS) {
    const tapes = run?.chains?.[chain]?.tapes ?? [];
    if (tapes.length === 0) {
      say(false, `[${chain}] no coin read (lists ${JSON.stringify(run?.chains?.[chain]?.lists ?? null)})`);
      continue;
    }
    const done = tapes.find((t) => {
      const a = t.answers?.at(-1);
      return a?.status === 200 && !a.filling && a.whole_ms !== null && a.at - t.answers[0].at <= FILLED_MS;
    });
    if (done !== undefined) {
      const a = done.answers.at(-1);
      say(true, `[${chain} ${done.coin}] served complete (${a.trades} trades, whole_ms ${a.whole_ms}) ${((a.at - done.answers[0].at) / 1_000).toFixed(1)} s after its first read, ${done.answers.length} read(s)`);
      continue;
    }
    const why = tapes.map((t) => {
      const a = t.answers?.at(-1);
      return `${t.coin}: ${a?.status !== 200 ? `answered ${a?.status ?? a?.error}` : a.filling ? `filling after ${((a.at - t.answers[0].at) / 1_000).toFixed(1)} s` : `no whole_ms (src ${a.src})`}`;
    });
    if (started !== null && !young) {
      lines.push(`--  [${chain}] no tape complete within ${FILLED_MS / 1_000} s on a warm helper (${why.join("; ")})`);
      quiet = true;
    } else say(false, `[${chain}] no tape served complete within ${FILLED_MS / 1_000} s of its first read${young ? ` on a helper ${Math.round(ageMs / 1_000)} s old` : ""} (${why.join("; ")})`);
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
    console.log(`${r.verdict} helper-evm-tapes-survive-a-restart`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`helper-evm-tapes-survive-a-restart: ${e?.message ?? e}`);
    process.exit(2);
  }
}
