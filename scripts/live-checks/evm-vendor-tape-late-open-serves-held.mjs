#!/usr/bin/env node
// Live check of card evm-vendor-tape-late-open-serves-held: a Base or Robinhood coin our reads find no pool of is served
// the vendor's rows (apps/helper/src/data/evm/swaps.ts noneTrades, named `evm-vendor-read;desc="rows read A ms ago"` in
// Server-Timing) and bars (noneCandles). Its pool search runs again NONE_MS after the last, inside the open a page's read
// waits on; a search past the open's bound (OPEN_BOUND_MS) or failed answered the tape as our own book's rows, none,
// `filling`, or 503 (a local helper on mainnet served Robinhood fBOMB, held from the vendor, as [] filling src chain at
// 8 s, 18 Nov 15:19:55Z). After the card the held rows and bars answer.
// For each chain (both read at once), the first of its CANDIDATES whose tape answers from the vendor's rows within
// WARM_MS is read as a page holds it: its tape every POLL_MS and its 15m chart every CHART_EVERY reads, for HOLD_MS from
// its first vendor answer (past NONE_MS, so its pool search runs again inside the hold); then:
//   - every tape answer is 200, and is the vendor's (named in Server-Timing) or rows of ours: never an empty answer from
//     our own reads; a coin whose tape turns to rows of ours (its pool search found a pool) is left and the next read;
//   - every chart answer after its first vendor bars is 200 with bars;
//   - the reads whose open ran past OPEN_BOUND_MS (`evm-open;dur=`) are named with what they answered.
// The helper's no-answer (a fetch that failed, its 429, a body that is not JSON) is left out, never judged. A chain with
// no coin held from the vendor for HOLD_MS: error (exit 2), never a pass. No JSON-RPC read: the helper's answers only.
// After: helper
// Serial: evm-keyed 370 (its Base and Robinhood tape and chart reads draw the keyed providers)
//   node scripts/live-checks/evm-vendor-tape-late-open-serves-held.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { NONE_MS, OPEN_BOUND_MS } from "../../apps/helper/src/data/evm/swaps.ts";

const KEY = "evm-vendor-tape-late-open-serves-held";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Coins our reads found no pool of on 18 Nov 19:4xZ, served from the vendor's rows on a local helper at this card: Base
 *  0x1668cd48 and SOGNI (card evm-vendor-tape-refresh-keyed's), Robinhood fBOMB (its one pool a Ramses Legacy pair). */
export const CANDIDATES = {
  base: ["0x1668cd48f31d869fca21eb826ca60e94cffc018c", "0xe014d2a4da6e450f21b5050120d291e63c8940fd"],
  robinhood: ["0x84d6bb25d3b013c784be60dc598c920588f452bc"],
};
export const CHAINS = ["base", "robinhood"];
export const POLL_MS = 2_000;
export const CHART_EVERY = 5;
/** The hold from a coin's first vendor answer: NONE_MS and half a minute, so its pool search runs again inside it. */
export const HOLD_MS = NONE_MS + 30_000;
/** How long a cold open may answer from our own reads before its first vendor answer (evm-vendor-tape-refresh-keyed). */
export const WARM_MS = 20_000;
export const ENTRY = "evm-vendor-read";

/** The age in ms a Server-Timing names for the vendor's rows, or null. */
export function vendorReadOf(timing) {
  const m = new RegExp(`(?:^|,)\\s*${ENTRY};desc="rows read (\\d+) ms ago"`).exec(String(timing ?? ""));
  return m === null ? null : Number(m[1]);
}
/** The open's time a Server-Timing names (`evm-open;dur=N`), or null. */
export function openMsOf(timing) {
  const m = /(?:^|,)\s*evm-open;dur=(\d+)/.exec(String(timing ?? ""));
  return m === null ? null : Number(m[1]);
}

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** The run: each chain at once, each candidate in turn, until one is held from the vendor's rows HOLD_MS. */
export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  /** One read: its status, Server-Timing and body, or `no` (the helper gave no answer to judge). */
  const get = async (p) => {
    const at = now();
    let r;
    try {
      r = await fetchFn(`${b}${p}`, { headers: { origin: APP }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      return { at, no: `no answer (${e?.cause?.code ?? e?.name ?? "fetch failed"})` };
    }
    const text = await r.text().catch(() => "");
    if (r.status === 429) return { at, no: "429" };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { at, no: `HTTP ${r.status}: not JSON` };
    }
    return { at, status: r.status, timing: r.headers.get("server-timing") ?? "", body };
  };
  const one = async (chain) => {
    const coins = [];
    for (const coin of CANDIDATES[chain]) {
      const reads = [];
      const charts = [];
      const warm = now() + WARM_MS;
      let end = null;
      for (let i = 0; ; i++) {
        const t = await get(`/v1/market/trades?chain=${chain}&token=${coin}&limit=50`);
        const a = obj(t.body);
        reads.push(t.no !== undefined ? { at: t.at, no: t.no } : { at: t.at, status: t.status, timing: t.timing, src: a.src ?? null, n: arr(a.trades).length, ...(a.filling === true ? { filling: true } : {}) });
        const vendor = vendorReadOf(t.timing) !== null;
        if (vendor && end === null) end = now() + HOLD_MS;
        if (end !== null && i % CHART_EVERY === 0) {
          const c = await get(`/v1/market/candles?chain=${chain}&token=${coin}&tf=15m&limit=500`);
          const x = obj(c.body);
          charts.push(c.no !== undefined ? { at: c.at, no: c.no } : { at: c.at, status: c.status, src: x.src ?? null, n: arr(x.candles).length, ...(x.filling === true ? { filling: true } : {}) });
        }
        // a coin not served from the vendor's rows within WARM_MS, or whose tape turns to rows of ours, is not judged
        const ours = t.no === undefined && !vendor && arr(a.trades).length > 0;
        if ((end === null && now() + POLL_MS > warm) || (end !== null && (ours || now() + POLL_MS > end))) break;
        await wait(POLL_MS);
      }
      coins.push({ coin, reads, charts });
      if (judgeable(reads)) break;
    }
    return [chain, { coins }];
  };
  return { base: b, at: new Date(now()).toISOString(), chains: Object.fromEntries(await Promise.all(CHAINS.map(one))) };
}

const answered = (x) => x.no === undefined;
const fromVendor = (x) => answered(x) && vendorReadOf(x.timing) !== null;
/** The reads from a coin's first vendor answer on. */
const held = (reads) => {
  const i = arr(reads).findIndex(fromVendor);
  return i < 0 ? [] : arr(reads).slice(i);
};
/** Held from the vendor HOLD_MS (less one poll), never turned to rows of ours. */
function judgeable(reads) {
  const h = held(reads);
  if (h.length === 0) return false;
  const last = h.at(-1);
  const ours = answered(last) && !fromVendor(last) && last.n > 0;
  return !ours && last.at - h[0].at >= HOLD_MS - POLL_MS;
}

/** PASS, FAIL or null (a chain with nothing to judge), with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  let none = false;
  for (const chain of CHAINS) {
    const coins = arr(obj(obj(r.chains)[chain]).coins);
    const c = coins.find((x) => judgeable(x.reads));
    for (const x of coins) if (x !== c) lines.push(`--  ${chain} ${String(x.coin).slice(0, 10)}: ${held(x.reads).length} reads held from the vendor, not judged`);
    if (c === undefined) {
      lines.push(`--  ${chain}: no coin held from the vendor's rows for ${HOLD_MS / 1000} s`);
      none = true;
      continue;
    }
    const tag = `${chain} ${String(c.coin).slice(0, 10)}`;
    const h = held(c.reads);
    const t0 = h[0].at;
    const sec = (x) => `+${Math.round((x.at - t0) / 1000)} s`;
    const got = h.filter(answered);
    const bad = got.filter((x) => x.status !== 200 || (!fromVendor(x) && x.n === 0));
    const what = (x) => `${sec(x)} ${x.status} ${x.n ?? 0} rows${x.filling ? " filling" : ""} src ${x.src}${openMsOf(x.timing) === null ? "" : `, open ${openMsOf(x.timing)} ms`}`;
    say(bad.length === 0, `${tag}: ${got.length} tape answers over ${Math.round((h.at(-1).at - t0) / 1000)} s from its first vendor answer (${h.length - got.length} no-answers left out), each the vendor's rows or ours: ${bad.length ? bad.slice(0, 3).map(what).join("; ") : "yes"}`);
    const late = got.filter((x) => (openMsOf(x.timing) ?? 0) >= OPEN_BOUND_MS);
    lines.push(`--  ${tag}: ${late.length} reads whose open ran past ${OPEN_BOUND_MS} ms${late.length ? `: ${late.slice(0, 3).map(what).join("; ")}` : ""}`);
    const charts = arr(c.charts).filter(answered);
    const first = charts.findIndex((x) => x.status === 200 && x.n > 0 && x.src !== "chain");
    if (first < 0) {
      lines.push(`--  ${tag}: no chart answer with the vendor's bars, the chart not judged`);
      continue;
    }
    const after = charts.slice(first);
    const empty = after.filter((x) => x.status !== 200 || x.n === 0);
    say(empty.length === 0, `${tag}: ${after.length} chart answers from its first vendor bars, each 200 with bars: ${empty.length ? empty.slice(0, 3).map((x) => `${sec(x)} ${x.status} ${x.n} bars${x.filling ? " filling" : ""} src ${x.src}`).join("; ") : "yes"}`);
  }
  // a chain that failed is a FAIL whatever the other; one with nothing to judge and none failed is no verdict
  const failed = lines.some((l) => l.startsWith("BAD"));
  return { ok: failed ? false : none ? null : true, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const r = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(r, null, 1)}\n`);
    const { ok, lines } = judge(r);
    for (const l of lines) console.log(l);
    if (ok === null) {
      console.error(`live-check ${KEY}: ERROR: nothing to judge (${r.base})`);
      process.exit(2);
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
