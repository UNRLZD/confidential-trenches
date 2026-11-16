#!/usr/bin/env node
// Live check of card every-cell-shows-a-value: the market cells that were a dash now hold values on the deployed
// helper.
//   - NEAR (apps/helper/src/data/near/engine.ts): GET /v1/market/lists?chain=near answers New and Trending (1h) with
//     rows, and every row of every list has a market cap (a decimal string), a holders count and a launch time (an
//     integer each), from the unrealized.trade engine (src "unrealized");
//   - Base's contract cells (apps/helper/src/data/goplus.ts) are held by risk-cells-show-what-goplus-gives.mjs: a cell
//     is GoPlus's when GoPlus names a value for it, so this check's rule that all five hold one failed on a token GoPlus
//     answers in part (SNDKc, code 3, its taxes only: the helper's live run on e2c8c2aa7, 16 Nov 21:11Z).
// After: helper
//   node scripts/live-checks/every-cell-shows-a-value.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "every-cell-shows-a-value";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const NEAR_LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"];

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => Object.hasOwn(obj(o), k)).map((k) => [k, o[k]]));

/** The run: each NEAR list's rows (what the judge reads of them). */
export async function read(base = BASE, fetchFn = fetch, now = Date.now) {
  const b = base.replace(/\/$/, "");
  const n = await fetchFn(`${b}/v1/market/lists?chain=near`, { headers: { origin: APP } });
  const nl = n.status === 200 ? obj(obj(JSON.parse(await n.text())).lists) : {};
  // each row's token kept as "account": the recorded answers hold no "token" key, which
  // gitleaks' generic-api-key rule reads as a secret (.gitleaks.toml)
  const near = Object.fromEntries(NEAR_LISTS.map((k) => [k, (Array.isArray(nl[k]) ? nl[k] : []).map((r) => ({ account: obj(r).token, ...pick(r, ["mc_usd", "holders", "created_s", "src"]) }))]));
  return { base: b, at: new Date(now()).toISOString(), near_status: n.status, near };
}

/** PASS or FAIL with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  const near = obj(r.near);
  say(r.near_status === 200, `NEAR lists answer 200: ${r.near_status}`);
  say((near.new ?? []).length > 0 && (near.trending_1h ?? []).length > 0, `NEAR New and Trending have rows: ${NEAR_LISTS.map((k) => `${k} ${(near[k] ?? []).length}`).join(", ")}`);
  const rows = NEAR_LISTS.flatMap((k) => near[k] ?? []);
  const blank = rows.filter((x) => typeof x.mc_usd !== "string" || !/^\d+(\.\d+)?$/.test(x.mc_usd) || !Number.isSafeInteger(x.holders) || !Number.isSafeInteger(x.created_s));
  say(rows.length > 0 && blank.length === 0, `every NEAR row has a market cap, holders and a launch time: ${rows.length - blank.length} of ${rows.length}${blank.length ? ` (first blank ${JSON.stringify(blank[0])})` : ""}`);
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
