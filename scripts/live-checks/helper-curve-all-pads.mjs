#!/usr/bin/env node
// Live check of card helper-curve-all-pads: Discover's Graduating holds every Solana launchpad's tokens on their curve,
// not pump.fun's alone (apps/helper/src/data/solana/lists.ts snapshot, origin.ts reads). It reads GET
// /v1/market/lists?chain=solana at HELPER_HOST with Origin APP_HOST, counts Graduating's rows per launchpad, and
// re-reads here, on a public RPC through origin.ts readOrigins with Jupiter's keyless word as the hint, the launches of
// up to SAMPLE listed tokens not at 10,000 that the helper or Jupiter tags with a pad other than pump.fun. It passes
// only when:
//   - the answer is 200 JSON with a graduating list, each of its rows a launchpad and a curve from 0 to 9,999;
//   - whenever the re-read finds such a token on its curve (0 to 9,999), Graduating holds at least one row of a pad
//     other than pump.fun; with none on a curve it passes and says so.
// The accounts are read through provider-answer.mjs rpcAnswer: Jupiter or the RPC answering nothing usable is a no-answer,
// named, never a wrong answer and never a pass. With none found on a curve and a no-answer in the re-read, the check is
// INCONCLUSIVE: the re-read could not tell.
// After: helper
//   node scripts/live-checks/helper-curve-all-pads.mjs [--base <url>] [--rpc <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read (the lists cut to each row's token,
//   symbol, launchpad and curve; Jupiter's answer; every account read).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { hintsOf, readOrigins } from "../../apps/helper/src/data/solana/origin.ts";

const KEY = "helper-curve-all-pads";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const RPC = "https://api.mainnet-beta.solana.com";
export const JUP = "https://lite-api.jup.ag/tokens/v2/search?query=";
export const PATH = "/v1/market/lists?chain=solana";
const LISTED = ["new", "trending_5m", "trending_1h"];
export const SAMPLE = 20;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUMP = "pump.fun";
const onCurve = (b) => Number.isInteger(b) && b >= 0 && b < 10_000;

/** The listed tokens to re-read: not at 10,000 and not unsettled, those the helper tags with another pad first. */
export function candidates(lists, unsettled = []) {
  const open = new Set(Array.isArray(unsettled) ? unsettled : []);
  const seen = new Set();
  const rows = LISTED.flatMap((k) => (Array.isArray(lists?.[k]) ? lists[k] : [])).filter((r) => r && B58.test(r.token) && !seen.has(r.token) && seen.add(r.token));
  const left = rows.filter((r) => r.curve_bps !== 10_000 && !open.has(r.token) && r.launchpad !== PUMP);
  return [...left.filter((r) => typeof r.launchpad === "string"), ...left.filter((r) => r.launchpad === null)].slice(0, SAMPLE);
}

/** The check of one read: the helper's answer, the launches re-read for its candidates (a Map) and the re-read's
 *  no-answer (null when every read answered). */
export function judge(r, origins, noAnswer = null) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(r.status === 200, `GET ${PATH} answers ${r.status}`);
  let s;
  try {
    s = JSON.parse(r.body);
  } catch {
    s = undefined;
  }
  const g = Array.isArray(s?.lists?.graduating) ? s.lists.graduating : null;
  say(g !== null, `graduating: ${g === null ? "missing" : `${g.length} rows`}`);
  const rows = g ?? [];
  const per = {};
  for (const x of rows) per[x?.launchpad] = (per[x?.launchpad] ?? 0) + 1;
  lines.push(`--  graduating per launchpad: ${JSON.stringify(per)}`);
  const off = rows.filter((x) => typeof x?.launchpad !== "string" || !onCurve(x?.curve_bps));
  say(off.length === 0, `every graduating row is a launchpad's on its curve (0-9,999)${off.length ? `: ${off.length} not, first ${JSON.stringify(off[0])}` : ""}`);
  const others = rows.filter((x) => typeof x?.launchpad === "string" && x.launchpad !== PUMP && onCurve(x.curve_bps)).length;
  const on = [...origins].filter(([, o]) => o != null && o.pad !== PUMP && onCurve(o.curveBps));
  const asked = candidates(s?.lists, s?.unsettled).length;
  lines.push(`--  re-read on chain: ${origins.size} of ${asked} listed tokens off pump.fun and not at 10,000 settled, ${on.length} on a curve`);
  for (const [t, o] of on.slice(0, 5)) lines.push(`--  on a curve: ${t} ${o.pad} ${o.curveBps}`);
  const quiet = on.length === 0 && noAnswer !== null;
  if (quiet) lines.push(`--  the re-read had a no-answer (${noAnswer}): none found on a curve cannot be told: INCONCLUSIVE`);
  else if (on.length === 0) lines.push("ok  no listed token off pump.fun is on a curve now: nothing to hold");
  else say(others > 0, `graduating holds ${others} rows off pump.fun while ${on.length} listed tokens off pump.fun are on a curve`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${PATH}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  return { base, readAt, status: r.status, body: await r.text() };
}

/** The launches of `rows`, re-read here: Jupiter's search for its word, then the accounts on `rpc` through rpcAnswer;
 *  settled ones only. `log` gets Jupiter's answer, every account read and the first no-answer (`noAnswer`). */
export async function reread(rows, fetchFn = fetch, rpc = RPC, log = { jupiter: null, accounts: {}, noAnswer: null }) {
  log.noAnswer ??= null;
  if (rows.length === 0) return new Map();
  let hints = new Map();
  try {
    const j = await fetchFn(`${JUP}${rows.map((r) => r.token).join(",")}`, { headers: { accept: "application/json" } });
    const body = await j.json();
    if (!j.ok || !Array.isArray(body)) throw new Error(`HTTP ${j.status}`);
    log.jupiter = body.map((x) => ({ id: x?.id, launchpad: x?.launchpad, partnerConfig: x?.partnerConfig, graduatedPool: x?.graduatedPool }));
    hints = hintsOf(log.jupiter);
  } catch (e) {
    log.noAnswer = `Jupiter's search: ${e.message}`;
    return new Map();
  }
  const get = async (keys) => {
    const out = [];
    for (let i = 0; i < keys.length; i += 100) {
      const part = keys.slice(i, i + 100);
      const a = await rpcAnswer(rpc, "getMultipleAccounts", [part, { encoding: "base64", commitment: "confirmed" }], { fetchFn });
      const v = a.result?.value;
      if (a.noAnswer !== undefined || !Array.isArray(v) || v.length !== part.length) {
        log.noAnswer ??= a.noAnswer ?? `${new URL(rpc).host}: getMultipleAccounts answered no list of ${part.length} accounts`;
        return undefined;
      }
      part.forEach((k, n) => (log.accounts[k] = v[n]));
      out.push(...v);
    }
    return out;
  };
  return readOrigins(get, rows.map((r) => ({ mint: r.token, hint: hints.get(r.token) })));
}

/** The lists cut to what the judge reads, so a record stays small. */
export function cut(body) {
  try {
    const s = JSON.parse(body);
    for (const k of Object.keys(s.lists ?? {})) if (Array.isArray(s.lists[k])) s.lists[k] = s.lists[k].map((r) => ({ token: r?.token, symbol: r?.symbol, launchpad: r?.launchpad, curve_bps: r?.curve_bps }));
    return JSON.stringify(s);
  } catch {
    return body;
  }
}

export async function check(base = BASE, fetchFn = fetch, rpc = RPC) {
  const answer = await read(base, fetchFn);
  let s = {};
  try {
    s = JSON.parse(answer.body) ?? {};
  } catch {
    s = {};
  }
  const log = { jupiter: null, accounts: {}, noAnswer: null };
  const origins = await reread(candidates(s.lists, s.unsettled), fetchFn, rpc, log);
  return { answer: { ...answer, body: cut(answer.body) }, log, ...judge(answer, origins, log.noAnswer) };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const r = await check(base, fetch, opt("--rpc", RPC));
    for (const l of r.lines) console.log(l);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ answer: r.answer, jupiter: r.log.jupiter, accounts: r.log.accounts })}\n`);
    console.log(`live-check ${KEY}: ${r.verdict} (${base})`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
