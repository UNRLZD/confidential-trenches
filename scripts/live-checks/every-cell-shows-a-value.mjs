#!/usr/bin/env node
// Live check of card every-cell-shows-a-value: the market cells that were a dash now hold values on the deployed
// helper.
//   - NEAR (apps/helper/src/data/near/engine.ts): GET /v1/market/lists?chain=near answers New and Trending (1h) with
//     rows, and every row of every list has a market cap (a decimal string), a holders count and a launch time (an
//     integer each), from the unrealized.trade engine (src "unrealized");
//   - Base (apps/helper/src/data/goplus.ts): the first token of the helper's Base Trending (1h) list, read on
//     GET /v1/market/token every POLL_MS for READ_MS (a page answered before its GoPlus read landed is read again),
//     has risk.mint_auth, freeze_auth, dev_bps, tax and honeypot each a value with src "goplus".
// After: helper
//   node scripts/live-checks/every-cell-shows-a-value.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "every-cell-shows-a-value";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const READ_MS = 20_000;
export const POLL_MS = 2_000;
export const NEAR_LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"];
export const GOPLUS_CELLS = ["mint_auth", "freeze_auth", "dev_bps", "tax", "honeypot"];

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => Object.hasOwn(obj(o), k)).map((k) => [k, o[k]]));
const landed = (risk) => GOPLUS_CELLS.every((k) => obj(obj(risk)[k]).src === "goplus" && obj(risk)[k].v !== null);

/** The run: each NEAR list's rows (what the judge reads of them), the Base token and each of its page answers' cells. */
export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const n = await fetchFn(`${b}/v1/market/lists?chain=near`, { headers: { origin: APP } });
  const nl = n.status === 200 ? obj(obj(JSON.parse(await n.text())).lists) : {};
  // each row's token kept as "account" and the Base token as "address": the recorded answers hold no "token" key, which
  // gitleaks' generic-api-key rule reads as a secret (.gitleaks.toml)
  const near = Object.fromEntries(NEAR_LISTS.map((k) => [k, (Array.isArray(nl[k]) ? nl[k] : []).map((r) => ({ account: obj(r).token, ...pick(r, ["mc_usd", "holders", "created_s", "src"]) }))]));
  const l = await fetchFn(`${b}/v1/market/lists?chain=base`, { headers: { origin: APP } });
  const bl = l.status === 200 ? obj(obj(JSON.parse(await l.text())).lists) : {};
  const address = (Array.isArray(bl.trending_1h) ? bl.trending_1h : []).find((r) => typeof obj(r).token === "string")?.token ?? null;
  const pages = [];
  if (address !== null) {
    const end = now() + READ_MS;
    for (;;) {
      const r = await fetchFn(`${b}/v1/market/token?chain=base&token=${address}`, { headers: { origin: APP } });
      const risk = r.status === 200 ? pick(obj(JSON.parse(await r.text())).risk, GOPLUS_CELLS) : null;
      pages.push({ status: r.status, risk });
      if ((risk !== null && landed(risk)) || now() + POLL_MS > end) break;
      await wait(POLL_MS);
    }
  }
  return { base: b, at: new Date(now()).toISOString(), near_status: n.status, near, base_status: l.status, address, pages };
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
  say(r.address !== null && r.address !== undefined, `the Base Trending list names a token (lists ${r.base_status}): ${r.address}`);
  const last = (r.pages ?? []).at(-1);
  say(last?.status === 200, `its page answers 200 (${(r.pages ?? []).length} reads): ${last?.status ?? "none"}`);
  const risk = obj(last?.risk);
  for (const k of GOPLUS_CELLS) say(obj(risk[k]).src === "goplus" && risk[k].v !== null && risk[k].v !== undefined, `${k} from GoPlus: ${JSON.stringify(risk[k] ?? null)}`);
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
