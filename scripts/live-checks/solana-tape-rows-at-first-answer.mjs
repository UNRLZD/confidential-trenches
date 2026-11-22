#!/usr/bin/env node
// Live check of card solana-tape-rows-at-first-answer: a busy Solana coin's trade tape answers rows the first time it is
// asked, also when its newest transactions are failed bot transactions. Before the card the helper's first read of a
// tape walked its newest COLD_SIGS (30) signatures and read only the successful ones (apps/helper/src/data/solana/
// trades.ts walk): helper live run 43689567273 read CjRGc8wH...pump 0 rows at +0 ms (token-page-data-complete-and-fast),
// and at 07:27:09Z that coin's newest 30 signatures held 0 successful transactions, its newest 1000 held 29. Now a first
// read whose newest 30 are not all successful reads one page of 1000 before them and keeps the newest 30 successful.
// It reads, with Origin APP:
//   GET /v1/market/lists?chain=solana                     the busiest pump.fun rows (5m buys at least BUSY), up to PICKS
//   getSignaturesForAddress [mint, {limit: COLD_SIGS}]    on the helper's public Solana providers (trades.ts
//                                                          TRADES_RPCS), the first that answers: how many succeeded
//   GET /v1/market/trades?chain=solana&token=<t>&limit=50 for TAPES of them at once, flooded ones first (at most
//                                                          FLOODED_OK of the newest COLD_SIGS succeeded), each once
// and passes only when the lists answer 200 with a busy pump.fun row, every tape's one answer is 200 JSON with at least
// one trade, every flooded coin's from our own chain read (src "chain": a pump.fun coin trades on the curve or PumpSwap,
// both read by trades.ts), and at least one tape opened is a flooded coin's. A tape answering 0 rows, or a flooded coin's
// answered from a vendor's tape (the helper's own first read held none of its trades, and the tape fell back to its top
// pool's vendor rows, trades.ts poolTape: 0d308d3bc served 9nxbR8JV...pump CoinGecko's 50 rows at 08:54:53Z, its newest 30
// signatures 0 successful; with no vendor answer that is the 0 rows of run 43689567273): FAIL. No flooded coin among the
// busy ones: INCONCLUSIVE (the run proves nothing about the root either way). Card
// solana-flooded-coin-first-answer-holds-rows: each tape's line names its path, the sol-open, sol-whole-cut and
// sol-vendor-read parts of its Server-Timing (trades.ts: how its first read was answered, a cut, a vendor's rows), so a
// red says which way the helper answered (helper-23 run 45018729954's BAD named 9WB75GUz src coingecko and nothing else).
// After: helper
//   node scripts/live-checks/solana-tape-rows-at-first-answer.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

const KEY = "solana-tape-rows-at-first-answer";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
/** The helper's first read's successful signatures (trades.ts COLD_SIGS): a test holds them equal. */
export const COLD_SIGS = 30;
/** A coin whose newest COLD_SIGS signatures hold at most this many successful: before the card its first answer held at
 *  most that many transactions' trades, 0 when none. */
export const FLOODED_OK = 3;
/** A busy row: at least this many 5m buys (token-page-data-complete-and-fast's pick). */
export const BUSY = 10;
export const PICKS = 12;
export const TAPES = 3;
/** The helper's public Solana providers (trades.ts TRADES_RPCS): a test holds them equal. */
export const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The parts of a tape answer's Server-Timing that name how it was answered (trades.ts: sol-open, sol-whole-cut,
 *  sol-vendor-read), each bounded, joined; null when it names none. */
export function pathOf(timing) {
  const parts = String(timing ?? "").slice(0, 4_000).match(/sol-(open|whole-cut|vendor-read);desc="[^"]{0,200}"/g) ?? [];
  return parts.length === 0 ? null : parts.slice(0, 4).join(", ");
}

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** How many of a mint's newest COLD_SIGS signatures succeeded, from the first provider that answers a list, or null. */
async function okOf(mint, fetchFn) {
  for (const url of RPCS) {
    const a = await rpcAnswer(url, "getSignaturesForAddress", [mint, { limit: COLD_SIGS, commitment: "confirmed" }], { fetchFn });
    if (Array.isArray(a.result) && a.result.length <= COLD_SIGS) return { sigs: a.result.length, ok: a.result.filter((s) => s?.err === null || s?.err === undefined).length };
  }
  return null;
}

/** One run against `base`: the lists' busy pump.fun picks with their newest signatures' successes, and each tape's
 *  first answer. */
export async function read(base = BASE, fetchFn = fetch) {
  const get = async (path) => {
    const t0 = performance.now();
    const r = await fetchFn(base + path, { headers: { Origin: APP }, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, type: r.headers.get("content-type") ?? "", timing: r.headers.get("server-timing") ?? "", body: await r.text(), ms: Math.round(performance.now() - t0) };
  };
  const l = await get("/v1/market/lists?chain=solana");
  const seen = new Map();
  for (const rows of Object.values(parse(l.body)?.lists ?? {})) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) if (typeof r?.token === "string" && B58.test(r.token) && !seen.has(r.token)) seen.set(r.token, { mint: r.token, launchpad: r.launchpad, buys_5m: r.buys_5m });
  }
  const busy = [...seen.values()].filter((r) => r.launchpad === "pump.fun" && Number.isSafeInteger(r.buys_5m) && r.buys_5m >= BUSY).sort((a, b) => b.buys_5m - a.buys_5m).slice(0, PICKS);
  const picks = [];
  for (const r of busy) picks.push({ ...r, newest: await okOf(r.mint, fetchFn) });
  const flooded = (p) => p.newest !== null && p.newest.sigs === COLD_SIGS && p.newest.ok <= FLOODED_OK;
  const chosen = [...picks.filter(flooded), ...picks.filter((p) => !flooded(p))].slice(0, TAPES);
  const tapes = await Promise.all(
    chosen.map(async (p) => {
      const a = await get(`/v1/market/trades?chain=solana&token=${p.mint}&limit=50`);
      const b = parse(a.body);
      return { mint: p.mint, flooded: flooded(p), status: a.status, json: /^application\/json/i.test(a.type), rows: Array.isArray(b?.trades) ? b.trades.length : null, src: typeof b?.src === "string" ? b.src : null, filling: b?.filling === true, ms: a.ms, path: pathOf(a.timing) };
    }),
  );
  return { base, readAt: new Date().toISOString(), lists: { status: l.status, busy: busy.length }, picks: picks.map((p) => ({ mint: p.mint, buys_5m: p.buys_5m, newest: p.newest })), tapes };
}

/** The verdict on one run: PASS, FAIL, or INCONCLUSIVE when no tape opened was a flooded coin's. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok === true ? "ok " : ok === null ? "N/A" : "BAD"} ${text}`);
  say(run.lists?.status === 200 && run.lists.busy > 0, `GET lists?chain=solana answers ${run.lists?.status}, ${run.lists?.busy ?? "no"} busy pump.fun row(s)`);
  const tapes = Array.isArray(run.tapes) ? run.tapes : [];
  say(tapes.length > 0, `${tapes.length} tape(s) opened`);
  for (const t of tapes) {
    const p = (run.picks ?? []).find((x) => x.mint === t.mint);
    const newest = p?.newest == null ? "newest signatures not read" : `${p.newest.ok} of its newest ${p.newest.sigs} signatures successful`;
    say(t.status === 200 && t.json === true && Number.isSafeInteger(t.rows) && t.rows > 0 && (!t.flooded || t.src === "chain"), `tape ${t.mint} (${newest}${t.flooded ? ", flooded" : ""}): first answer ${t.status}, ${t.rows ?? "no"} row(s)${t.src ? `, src ${t.src}` : ""}${t.filling ? ", filling" : ""}${typeof t.path === "string" ? `, path [${t.path}]` : ""}, ${t.ms} ms`);
  }
  const floodedSeen = tapes.filter((t) => t.flooded).length;
  say(floodedSeen > 0 ? true : null, floodedSeen > 0 ? `${floodedSeen} flooded coin(s) judged at the first answer` : "no busy coin's newest signatures were mostly failed: the root is not exercised");
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : lines.some((l) => l.startsWith("N/A")) ? "INCONCLUSIVE" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
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
