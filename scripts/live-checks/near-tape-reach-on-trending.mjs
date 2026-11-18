#!/usr/bin/env node
// Live check of card near-tape-reach-on-trending: a NEAR coin's tape asked once after a quiet gap claims its reach
// (`whole_ms`), so a token page opened on it counts its buys, sells and volume from its own trades list. The deployed
// helper (main before this card) answered prl.omft.near's, zec.omft.near's and qtc.omft.near's first ask after a
// quiet minute with the unrealized.trade engine's rows read 57, 47 and 37 s before and no whole_ms (18 Nov 15:28:58Z),
// held rows served behind their renewal at any age (apps/helper/src/data/near/engine.ts tradeReads).
// The run: NEAR's first COINS Trending (1h) coins, each tape read once, then QUIET_MS with no read of ours (past
// NEAR_VENDOR_REACH_MS, so what the helper holds is past its bound), then each read once more. Then:
//   - every answer is 200;
//   - each second read came more than NEAR_VENDOR_REACH_MS after its coin's first (else no verdict, exit 2);
//   - a second read from the engine (src not "fastnear", Rhea's own tape, which claims no reach) names its rows' read in
//     Server-Timing (near-vendor-read;desc="rows read A ms ago"), and claims a reach exactly when A is at most
//     NEAR_VENDOR_REACH_MS;
//   - at least MIN_CLAIMED of the COINS second reads claim a reach (one renewal the engine fails is held rows, their age
//     named and no reach claimed).
// After: helper
//   node scripts/live-checks/near-tape-reach-on-trending.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { NEAR_VENDOR_REACH_MS } from "../../apps/helper/src/data/near/engine.ts";

const KEY = "near-tape-reach-on-trending";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const COINS = 3;
export const MIN_CLAIMED = 2;
/** The gap between a coin's two reads: past NEAR_VENDOR_REACH_MS by 2 s. */
export const QUIET_MS = NEAR_VENDOR_REACH_MS + 2_000;
export const ENTRY = "near-vendor-read";
/** Rhea's own tape (apps/helper/src/data/near/trades.ts): claims no reach and names no vendor read. */
export const OWN = "fastnear";

/** The age in ms a Server-Timing names for ENTRY, or null when it names none. */
export function vendorReadOf(timing) {
  const m = new RegExp(`(?:^|,)\\s*${ENTRY};desc="rows read (\\d+) ms ago"`).exec(String(timing ?? ""));
  return m === null ? null : Number(m[1]);
}

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** The run: each coin's first read, QUIET_MS, then its second, each with the time its request was sent. */
export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const get = async (p) => {
    const at = now();
    const r = await fetchFn(`${b}${p}`, { headers: { origin: APP } });
    let body = null;
    try {
      body = JSON.parse(await r.text());
    } catch {}
    return { at, status: r.status, timing: r.headers.get("server-timing") ?? "", body };
  };
  const tape = async (coin) => {
    const t = await get(`/v1/market/trades?chain=near&token=${encodeURIComponent(coin)}&limit=50`);
    const a = obj(t.body);
    return { at: t.at, status: t.status, timing: t.timing, n: arr(a.trades).length, ...(Object.hasOwn(a, "whole_ms") ? { whole_ms: a.whole_ms } : {}), src: a.src ?? null, as_of_ms: a.as_of_ms ?? null };
  };
  const l = await get("/v1/market/lists?chain=near");
  const coins = arr(obj(obj(l.body).lists).trending_1h).map((r) => obj(r).token).filter((t) => typeof t === "string").slice(0, COINS);
  const first = [];
  for (const c of coins) first.push(await tape(c));
  await wait(QUIET_MS);
  const second = [];
  for (const c of coins) second.push(await tape(c));
  return { base: b, at: new Date(now()).toISOString(), lists_status: l.status, coins: coins.map((coin, i) => ({ coin, first: first[i], second: second[i] })) };
}

/** PASS (ok true), FAIL (false) or no verdict (null), with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  const coins = arr(r.coins);
  say(r.lists_status === 200 && coins.length === COINS, `${coins.length} NEAR Trending (1h) coins read (lists ${r.lists_status})`);
  const reads = coins.flatMap((c) => [c.first, c.second]).filter(Boolean);
  const not200 = reads.filter((x) => x.status !== 200);
  say(not200.length === 0, `every trades answer 200: ${not200.length ? not200.map((x) => x.status).join(",") : "yes"}`);
  const short = coins.filter((c) => !(Number.isSafeInteger(c.second?.at) && Number.isSafeInteger(c.first?.at) && c.second.at - c.first.at > NEAR_VENDOR_REACH_MS));
  if (short.length > 0) {
    lines.push(`--  no verdict: ${short.map((c) => String(c.coin).slice(0, 12)).join(", ")} read again within ${NEAR_VENDOR_REACH_MS} ms`);
    return { ok: null, lines };
  }
  let claimed = 0;
  for (const c of coins) {
    const x = c.second;
    const what = `${String(c.coin).slice(0, 12)} asked once ${x.at - c.first.at} ms after its first read (src ${x.src}, ${x.n} trades)`;
    if (x.status !== 200) continue;
    const has = x.whole_ms !== undefined;
    if (has) claimed++;
    if (x.src === OWN) {
      say(!has, `${what}: Rhea's own tape claims no reach`);
      continue;
    }
    const named = vendorReadOf(x.timing);
    say(named !== null && has === named <= NEAR_VENDOR_REACH_MS, `${what}: its rows read ${named ?? "(none named)"} ms before, ${has ? "a reach claimed" : "no reach claimed"} (claimed exactly within ${NEAR_VENDOR_REACH_MS})`);
  }
  say(claimed >= MIN_CLAIMED, `${claimed} of ${coins.length} tapes asked once after a quiet gap claim a reach (at least ${MIN_CLAIMED})`);
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
    console.log(`live-check ${KEY}: ${ok === null ? "ERROR (no verdict)" : ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok === null ? 2 : ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
