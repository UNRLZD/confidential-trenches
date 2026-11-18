#!/usr/bin/env node
// Live check of card robinhood-spread-tapes-fill-inside-45s: a Robinhood coin whose newest 50 trades lie over hours
// fills its whole trade list inside the live checks' 45 s, as a busy coin does, with the listed coins opened at once
// (apps/helper/src/data/evm/swaps.ts readBack: a located read back's named blocks are asked of drpc too, in one batch,
// so daybreak's 7 posts a second is no longer every spread coin's floor). Before the card the deployed helper
// (bf32abde9, live run 44232297919, 18 Nov 04:01Z) left 11 of the 12 listed coins still filling 45.5 to 46.0 s after
// their first read.
// It reads Robinhood's Discover lists at HELPER_HOST, takes up to TOKENS listed tokens (Trending 1h, then Trending 5m,
// then New, each once; --address <a> reads that one alone), reads GET /v1/market/trades?chain=robinhood&token=<t>&limit=50
// for all of them at once, and reads each filling tape again until it fills (tape-read.mjs). It passes only when every
// tape answers 200 and fills inside FILLED_MS, and at least one of them is a spread coin: 50 trades over SPREAD_MS or
// more, so a run of busy coins alone proves nothing. Each tape's fill time and the hours its 50 trades span are printed.
// Then, REOPEN_AFTER_MS later (past the helper's IDLE_MS, when nobody's reads keep a book read), it reads every tape that
// settled whole again, all at once (card robinhood-spread-tapes-fill-inside-45s, second slice: an idle book was deleted
// with its read back, so a coin opened again a minute on was read from nothing; live run 44263447481, 8 coins still
// filling past 45 s when helper-robinhood-capacity opened them after this check). It passes only when each reopened
// tape answers whole at once (not filling: a reopen read from nothing answers filling first) and still holds the newest
// trade it held before; a reopen that answers filling is read on and its fill time printed.
// After: helper
// Serial: evm-keyed 135 (after a Solana check: the listed Robinhood tapes it opens at once draw the keyed Robinhood providers)
//   node scripts/live-checks/robinhood-spread-tapes-fill-inside-45s.mjs [--base <url>] [--address <a>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { tokensOf } from "./helper-robinhood-capacity.mjs";
import { FILLED_MS, fillingOf, filledVerdict, readFilled } from "./tape-read.mjs";

const KEY = "robinhood-spread-tapes-fill-inside-45s";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TRADES = 50;
/** A coin whose newest 50 trades span this or more is a spread coin [design: 2 h, a trade every 2.4 minutes or fewer;
 *  the card's coins span 3 to 16 hours (swaps-back-resume.test.ts SPACING), a busy listed coin's 50 a few minutes]. */
export const SPREAD_MS = 2 * 3_600_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
/** How long after the first pass the tapes are read again: past the helper's IDLE_MS (60 s, apps/helper/src/data/evm/
 *  swaps.ts) and two of its ticks, so each book has stopped being read. */
export const REOPEN_AFTER_MS = 75_000;

async function get(base, path, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(60_000) });
    const body = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), body: "", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** A tape's shape: "tape" when it is { trades: [...], src: "chain", as_of_ms }, else what is wrong. */
function shapeOf(body) {
  try {
    const j = JSON.parse(body);
    if (!Array.isArray(j.trades)) return "no trades list";
    if (j.src !== "chain") return `src ${JSON.stringify(j.src)}`;
    if (!Number.isSafeInteger(j.as_of_ms)) return "no as_of_ms";
    return "tape";
  } catch {
    return "not JSON";
  }
}

/** A settled tape's trade count and the ms its trades span (newest t_ms less oldest), null when it holds no times. */
export function spanOf(body) {
  try {
    const ts = JSON.parse(body).trades.map((r) => r?.t_ms).filter((t) => Number.isSafeInteger(t));
    return { n: ts.length, span_ms: ts.length < 2 ? null : Math.max(...ts) - Math.min(...ts) };
  } catch {
    return { n: 0, span_ms: null };
  }
}

/** A tape's newest trade's tx, or null. */
const newestOf = (body) => {
  try {
    const tx = JSON.parse(body).trades[0]?.tx;
    return typeof tx === "string" ? tx : null;
  } catch {
    return null;
  }
};

export async function read(base = BASE, fetchFn = fetch, o = {}) {
  const at = new Date().toISOString();
  const one = typeof o.address === "string" && ADDRESS.test(o.address) ? o.address : null;
  const lists = one === null ? await get(base, "/v1/market/lists?chain=robinhood", fetchFn) : null;
  const tokens = one !== null ? [one] : lists.status === 200 ? tokensOf(lists.body) : [];
  const answers = await Promise.all(
    tokens.map(async (t) => {
      const path = `/v1/market/trades?chain=robinhood&token=${t}&limit=${TRADES}`;
      const a = await get(base, path, fetchFn);
      const d = { address: t, status: a.status, ms: a.ms, shape: a.status === 200 ? shapeOf(a.body) : null, ...(a.error ? { error: a.error } : {}), ...(a.status !== 200 ? { body: a.body.slice(0, 120) } : {}) };
      let last = a.body;
      if (a.status === 200 && fillingOf(a.body))
        Object.assign(d, {
          filling: true,
          filled: await readFilled(
            async () => {
              const b = await get(base, path, fetchFn);
              if (b.status === 200) last = b.body;
              return b;
            },
            shapeOf,
            o,
          ),
        });
      if (a.status === 200 && !fillingOf(last)) Object.assign(d, spanOf(last));
      // kept out of the record: the tx beside the token is matched here, never written (gitleaks reads 64-hex values)
      Object.defineProperty(d, "newest", { value: a.status === 200 && !fillingOf(last) && shapeOf(last) === "tape" ? newestOf(last) : null, enumerable: false });
      return d;
    }),
  );
  // the tapes that settled whole, read again once their books are idle
  const settled = answers.filter((d) => d.newest !== null);
  await (o.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))))(o.reopenAfterMs ?? REOPEN_AFTER_MS);
  const reopen = await Promise.all(
    settled.map(async (d) => {
      const path = `/v1/market/trades?chain=robinhood&token=${d.address}&limit=${TRADES}`;
      const a = await get(base, path, fetchFn);
      const r = { address: d.address, status: a.status, ms: a.ms, shape: a.status === 200 ? shapeOf(a.body) : null, ...(a.error ? { error: a.error } : {}), ...(a.status !== 200 ? { body: a.body.slice(0, 120) } : {}) };
      let last = a.body;
      if (a.status === 200 && fillingOf(a.body))
        Object.assign(r, {
          filling: true,
          filled: await readFilled(
            async () => {
              const b = await get(base, path, fetchFn);
              if (b.status === 200) last = b.body;
              return b;
            },
            shapeOf,
            o,
          ),
        });
      if (a.status === 200 && !fillingOf(last)) {
        let txs = [];
        try {
          txs = JSON.parse(last).trades.map((x) => x?.tx);
        } catch {}
        Object.assign(r, { n: spanOf(last).n, kept: txs.includes(d.newest) });
      }
      return r;
    }),
  );
  return { base, at, ...(one === null ? { lists: { status: lists.status, ms: lists.ms, tokens: tokens.length } } : { address: one }), answers, reopen_after_ms: o.reopenAfterMs ?? REOPEN_AFTER_MS, reopen };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const n = run.answers?.length ?? 0;
  if (run.address === undefined) say(run.lists?.status === 200 && n >= 1 && n === run.lists.tokens, `GET /v1/market/lists?chain=robinhood answers ${run.lists?.status}, ${n} listed tokens read`);
  else say(n === 1 && run.answers[0].address === run.address, `${run.address} read alone`);
  let spread = 0;
  for (const a of run.answers ?? []) {
    const ok = a.status === 200 && a.shape === "tape";
    const hours = a.span_ms == null ? "" : `, ${a.n} trades over ${(a.span_ms / 3_600_000).toFixed(1)} h`;
    if (!ok) {
      say(false, `trades ${a.address}: ${a.status}${a.status === 200 ? ` ${a.shape}` : ` ${a.body ?? ""}`}${a.error ? ` ${a.error}` : ""} in ${a.ms} ms`);
      continue;
    }
    const v = a.filling === true ? filledVerdict(a.filled) : { ok: true, text: `answered whole in ${a.ms} ms` };
    say(v.ok, `trades ${a.address}: ${v.text}${hours}`);
    if (v.ok && a.n === TRADES && a.span_ms >= SPREAD_MS) spread++;
  }
  say(spread > 0, `${spread} spread coin(s) filled inside ${FILLED_MS} ms (${TRADES} trades over ${SPREAD_MS / 3_600_000} h or more)`);
  // every tape that settled is read again past the helper's IDLE_MS: it fills inside FILLED_MS and still holds its newest
  // trade of before (a run with no second pass proves nothing of a reopen)
  const whole = (run.answers ?? []).filter((a) => a.status === 200 && a.shape === "tape" && (a.filling !== true || a.filled?.filling === false) && a.n > 0);
  if (!Array.isArray(run.reopen) || !(run.reopen_after_ms >= REOPEN_AFTER_MS)) say(false, `no reopen read past ${REOPEN_AFTER_MS} ms`);
  else {
    say(run.reopen.length >= whole.length && whole.length > 0, `${run.reopen.length} tape(s) read again ${run.reopen_after_ms} ms on, of ${whole.length} settled`);
    for (const r of run.reopen) {
      if (r.status !== 200 || r.shape !== "tape") {
        say(false, `reopen ${r.address}: ${r.status}${r.status === 200 ? ` ${r.shape}` : ` ${r.body ?? ""}`}${r.error ? ` ${r.error}` : ""} in ${r.ms} ms`);
        continue;
      }
      // the kept list answers whole at once: a reopen that answers filling read the coin again from nothing
      const text = r.filling === true ? `answered filling in ${r.ms} ms, read again from nothing (${filledVerdict(r.filled).text})` : `answered whole at once in ${r.ms} ms`;
      say(r.filling !== true && r.kept === true, `reopen ${r.address}: ${text}, ${r.n ?? 0} trades${r.kept === true ? ", its newest of before held" : ", its newest of before NOT held"}`);
    }
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE), fetch, { address: opt("--address") });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
