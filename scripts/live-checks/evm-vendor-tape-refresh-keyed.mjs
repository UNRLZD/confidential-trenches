#!/usr/bin/env node
// Live check of card evm-vendor-tape-refresh-keyed: a Base or Robinhood coin's tape served from the vendor's rows
// (apps/helper/src/data/evm/swaps.ts noneTrades, which names `evm-vendor-read;desc="rows read A ms ago"` in
// Server-Timing) is read again within BEHIND_MAX's ms (15 s on both chains) while a page holds it. Before the card a held
// tape's refresh went keyless only, and the keyless window has no room for it (the deployed helper's minute lines 18 Nov
// 12:56-13:48Z stood at 3 of 5, the refresh lane's cap): its rows aged without bound.
// For each chain, the first of its CANDIDATES (coins our reads find no pool of when this check was written, so served
// from the vendor) whose tape answers from the vendor's rows within WARM_MS (a cold open answers filling from our own
// reads first) is read as a page holds it, every POLL_MS for HOLD_MS from its first vendor answer; then:
//   - every answer is 200;
//   - at least MIN_VENDOR answers are the vendor's rows (named in Server-Timing), spanning more than TAPE_FRESH_MS, so a
//     refresh had to land; a coin whose tape turns to our own chain reads part way is left and the next one read;
//   - every vendor answer's rows were read at most BEHIND_MAX[chain].ms before, by the helper's word.
// A chain with no coin served from the vendor long enough to judge: error (exit 2), never a pass.
// After: helper
// Serial: evm-keyed 360 (its Base and Robinhood tape reads draw the keyed providers)
//   node scripts/live-checks/evm-vendor-tape-refresh-keyed.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BEHIND_MAX } from "../../apps/helper/src/data/evm/swaps.ts";
import { TAPE_FRESH_MS } from "../../apps/helper/src/data/solana/token.ts";

const KEY = "evm-vendor-tape-refresh-keyed";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Coins our reads found no pool of on 18 Nov 15:2xZ, served from the vendor's rows on a helper at this card: Base
 *  0x1668cd48 (card evm-vendor-tape-names-its-reach's) and SOGNI (an Aerodrome USDT pool, card
 *  solana-trades-show-on-every-token); Robinhood fBOMB (its one pool a Ramses Legacy pair with WETH). */
export const CANDIDATES = {
  base: ["0x1668cd48f31d869fca21eb826ca60e94cffc018c", "0xe014d2a4da6e450f21b5050120d291e63c8940fd"],
  robinhood: ["0x84d6bb25d3b013c784be60dc598c920588f452bc"],
};
export const CHAINS = ["base", "robinhood"];
export const POLL_MS = 2_000;
export const HOLD_MS = 45_000;
/** How long a coin's tape may answer from our own reads (a cold open, filling) before its first vendor answer: cold
 *  Robinhood fBOMB answered filling from our reads at 8 s on a fresh helper, 18 Nov 15:11Z. [design: two of its 8 s] */
export const WARM_MS = 20_000;
/** Vendor answers a judged coin needs: 2 s apart, more than TAPE_FRESH_MS from first to last. */
export const MIN_VENDOR = 10;
export const ENTRY = "evm-vendor-read";

/** The age in ms a Server-Timing names for the vendor's rows (`evm-vendor-read;desc="rows read A ms ago"`), or null. */
export function vendorReadOf(timing) {
  const m = new RegExp(`(?:^|,)\\s*${ENTRY};desc="rows read (\\d+) ms ago"`).exec(String(timing ?? ""));
  return m === null ? null : Number(m[1]);
}

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** The run: for each chain, each candidate in turn, its trades read every POLL_MS for HOLD_MS, until one held from the
 *  vendor's rows long enough to judge (or the candidates run out). */
export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const get = async (p) => {
    const at = now();
    const r = await fetchFn(`${b}${p}`, { headers: { origin: APP } });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { at, status: r.status, timing: r.headers.get("server-timing") ?? "", body };
  };
  const chains = {};
  for (const chain of CHAINS) {
    const coins = [];
    for (const coin of CANDIDATES[chain]) {
      const reads = [];
      const warm = now() + WARM_MS;
      let end = null;
      for (;;) {
        const t = await get(`/v1/market/trades?chain=${chain}&token=${coin}&limit=50`);
        const a = obj(t.body);
        reads.push({ at: t.at, status: t.status, timing: t.timing, src: a.src ?? null, n: arr(a.trades).length, as_of_ms: a.as_of_ms ?? null, ...(Object.hasOwn(a, "whole_ms") ? { whole_ms: a.whole_ms } : {}) });
        const vendor = vendorReadOf(t.timing) !== null;
        // the hold starts at the first vendor answer (a cold open answers filling from our own reads until it finds no
        // pool, card token-page-data-complete-and-fast); a coin not served from the vendor's rows within WARM_MS, or no
        // longer, is not this check's to judge
        if (vendor && end === null) end = now() + HOLD_MS;
        if (t.status !== 200 || (end === null && now() + POLL_MS > warm) || (end !== null && (!vendor || now() + POLL_MS > end))) break;
        await wait(POLL_MS);
      }
      coins.push({ coin, reads });
      if (judgeable(reads)) break;
    }
    chains[chain] = { coins };
  }
  return { base: b, at: new Date(now()).toISOString(), chains };
}

function vendorReads(reads) {
  return arr(reads).filter((x) => vendorReadOf(x.timing) !== null);
}
function judgeable(reads) {
  const v = vendorReads(reads);
  return v.length >= MIN_VENDOR && v.at(-1).at - v[0].at > TAPE_FRESH_MS;
}

/** PASS, FAIL or null (a chain with nothing to judge), with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  let none = false;
  for (const chain of CHAINS) {
    const coins = arr(obj(obj(r.chains)[chain]).coins);
    const c = coins.find((x) => judgeable(x.reads));
    for (const x of coins) if (x !== c) lines.push(`--  ${chain} ${String(x.coin).slice(0, 10)}: ${vendorReads(x.reads).length} vendor answers of ${arr(x.reads).length}, not judged`);
    if (c === undefined) {
      lines.push(`--  ${chain}: no coin served from the vendor's rows long enough to judge`);
      none = true;
      continue;
    }
    const reads = arr(c.reads);
    const not200 = reads.filter((x) => x.status !== 200);
    const tag = `${chain} ${String(c.coin).slice(0, 10)}`;
    say(not200.length === 0, `${tag}: every trades answer 200: ${not200.length ? not200.map((x) => x.status).join(",") : "yes"}`);
    const v = vendorReads(reads);
    const ages = v.map((x) => vendorReadOf(x.timing));
    const bound = BEHIND_MAX[chain].ms;
    const over = ages.filter((a) => a > bound);
    say(over.length === 0, `${tag}: ${v.length} vendor answers over ${Math.round((v.at(-1).at - v[0].at) / 1000)} s, rows read at most ${Math.max(...ages)} ms before (at most ${bound}): ${over.length ? `${over.length} past it` : "every one"}`);
  }
  // a chain that failed is a FAIL whatever the other; one with nothing to judge and none failed is no verdict
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: bad ? false : none ? null : true, lines };
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
