#!/usr/bin/env node
// Live check of card token-page-data-complete-and-fast, step 2: a Solana token page's right-hand fields from the helper's
// own chain reads (apps/helper/src/data/solana/token.ts, first-buyers.ts). The newest pump.fun token on the helper's
// New list (GET /v1/market/lists?chain=solana: a token minutes old, its first trades in reach) is read on
// GET /v1/market/token every POLL_MS for READ_MS (a read the page did not wait for joins a later answer), and passes
// only when:
//   - with the helper's holders provider keyed (GET /v1/health solana.holders), risk.top10_bps is our chain read
//     (src "chain", 0-10000 basis points, an as-of) and the row's top10_bps is that value;
//   - risk.snipers_bps is our chain read of the first trades (src "chain", 0-10000, an as-of) and the row's snipers_bps
//     that value;
//   - risk.bundlers_bps is our chain read too, or none (src "none", v null): never a value with no source;
//   - the row's chg_4h_bps is an integer or null (the tape's own bars, never a guess).
// After: helper
//   node scripts/live-checks/token-page-chain-risk.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "token-page-chain-risk";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const READ_MS = 20_000;
export const POLL_MS = 2_000;

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const bps = (v) => Number.isInteger(v) && v >= 0 && v <= 10_000;
const done = (page) => obj(obj(page.risk).snipers_bps).src === "chain" && obj(obj(page.risk).top10_bps).src === "chain";

const pick = (o, ks) => Object.fromEntries(ks.filter((k) => Object.hasOwn(obj(o), k)).map((k) => [k, o[k]]));
/** What the judge reads of a page answer: the three risk fields and their row cells, the 4h change. */
const kept = (body) => ({ risk: pick(obj(body).risk, ["top10_bps", "snipers_bps", "bundlers_bps"]), row: pick(obj(body).row, ["top10_bps", "snipers_bps", "chg_4h_bps"]) });
/** The run: the health's holders slot, the mint, and each page answer read (its status and what the judge reads). */
export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const h = await fetchFn(`${b}/v1/health`);
  const holders = h.status === 200 ? (obj(obj(JSON.parse(await h.text())).solana).holders ?? null) : null;
  const l = await fetchFn(`${b}/v1/market/lists?chain=solana`, { headers: { origin: APP } });
  const rows = l.status === 200 ? (obj(JSON.parse(await l.text())).lists?.new ?? []) : [];
  const mint = (Array.isArray(rows) ? rows : []).filter((r) => obj(r).launchpad === "pump.fun" && typeof r.token === "string").sort((x, y) => (y.created_s ?? 0) - (x.created_s ?? 0))[0]?.token ?? null;
  const pages = [];
  if (mint !== null) {
    const end = now() + READ_MS;
    for (;;) {
      const r = await fetchFn(`${b}/v1/market/token?chain=solana&token=${mint}`, { headers: { origin: APP } });
      const body = r.status === 200 ? kept(JSON.parse(await r.text())) : null;
      pages.push({ status: r.status, body });
      if ((body !== null && done(body)) || now() + POLL_MS > end) break;
      await wait(POLL_MS);
    }
  }
  return { base: b, at: new Date(now()).toISOString(), holders, lists: l.status, mint, pages };
}

/** PASS or FAIL with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  say(r.mint !== null, `the New list names a pump.fun token (lists ${r.lists}): ${r.mint}`);
  const last = r.pages.at(-1);
  say(last?.status === 200, `its page answers 200 (${r.pages.length} reads): ${last?.status ?? "none"}`);
  const p = obj(last?.body);
  const risk = obj(p.risk);
  const row = obj(p.row);
  const chainField = (k) => {
    const f = obj(risk[k]);
    return f.src === "chain" && bps(f.v) && Number.isFinite(f.as_of_ms);
  };
  if (r.holders === "keyed") say(chainField("top10_bps") && row.top10_bps === risk.top10_bps.v, `top 10 from our chain read: ${JSON.stringify(risk.top10_bps)}, row ${row.top10_bps}`);
  else lines.push(`n/a top 10: the holders provider is ${r.holders}`);
  say(chainField("snipers_bps") && row.snipers_bps === risk.snipers_bps.v, `snipers from our chain read of the first trades: ${JSON.stringify(risk.snipers_bps)}, row ${row.snipers_bps}`);
  const bu = obj(risk.bundlers_bps);
  say(chainField("bundlers_bps") || (bu.src === "none" && bu.v === null), `bundlers our chain read or none: ${JSON.stringify(risk.bundlers_bps)}`);
  say(row.chg_4h_bps === null || Number.isSafeInteger(row.chg_4h_bps), `4h change an integer or none: ${row.chg_4h_bps}`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const r = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(r, null, 1)}\n`);
    const { ok, lines } = judge(r);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
