#!/usr/bin/env node
// Live check of card evm-quote-token-priced-from-our-reads: a Base or Robinhood coin whose tape is the vendor's rows
// (apps/helper/src/data/evm/swaps.ts noneTrades) and whose pool is quoted in a third token (Base USEF 0x1668cd48 on
// USEF/ZORA, Uniswap v4; Robinhood fBOMB 0x84d6bb25 on r33/fBOMB, Ramses Legacy) has the rows our own reads renew
// priced through that token's own route at their block: the answer names how many (`evm-quote-usd;desc="N rows priced
// from chain at their block"`) and never the vendor's last rate's age (`evm-vendor-price;desc="usd read A ms ago"`),
// which before the card every such row carried.
// Each coin's trades are read as a page holds them, every POLL_MS for HOLD_MS; then, per coin:
//   - every answer is 200;
//   - at least MIN_VENDOR answers are the vendor's rows (evm-vendor-read named), so the tape is the one judged;
//   - no answer names evm-vendor-price.
// The rows priced from chain (evm-quote-usd) are printed: a coin that traded in the hold shows them, a quiet one none.
// A coin with too few vendor answers to judge: INCONCLUSIVE (exit 2, provider-answer.mjs nothingToJudge), never a pass.
// A coin every read of which the helper answers 404 is gone (it carries the coin no more) and is named, not judged; with
// no coin judged the run is INCONCLUSIVE (card evm-quote-check-skips-a-gone-coin).
// After: helper
// Serial: evm-keyed 400 (its Base and Robinhood tape reads draw the keyed providers)
//   node scripts/live-checks/evm-quote-token-priced-from-our-reads.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error or INCONCLUSIVE (nothing to judge) exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { nothingToJudge } from "./provider-answer.mjs";
import { writeFileSync } from "node:fs";

const KEY = "evm-quote-token-priced-from-our-reads";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** The card's coins, each a pool quoted in a third token the vendor names as its top pool (19 Nov 13:5xZ). */
export const COINS = {
  base: "0x1668cd48f31d869fca21eb826ca60e94cffc018c",
  robinhood: "0x84d6bb25d3b013c784be60dc598c920588f452bc",
};
export const CHAINS = ["base", "robinhood"];
export const POLL_MS = 2_000;
export const HOLD_MS = 60_000;
export const MIN_VENDOR = 10;
const VENDOR = /(?:^|,)\s*evm-vendor-read;desc="rows read (\d+) ms ago"/;
const PRICE = /(?:^|,)\s*evm-vendor-price;desc="usd read (\d+) ms ago"/;
const THROUGH =
  /(?:^|,)\s*evm-quote-usd;desc="(\d+) rows priced from chain at their block"/;

const obj = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
const arr = (v) => (Array.isArray(v) ? v : []);

/** The run: each chain's coin read every POLL_MS for HOLD_MS. */
export async function read(
  base = BASE,
  fetchFn = fetch,
  wait = (ms) => new Promise((ok) => setTimeout(ok, ms)),
  now = Date.now,
) {
  const b = base.replace(/\/$/, "");
  const chains = {};
  for (const chain of CHAINS) {
    const reads = [];
    const end = now() + HOLD_MS;
    for (;;) {
      const at = now();
      const r = await fetchFn(
        `${b}/v1/market/trades?chain=${chain}&token=${COINS[chain]}&limit=50`,
        { headers: { origin: APP } },
      );
      const text = await r.text();
      let a = {};
      try {
        a = obj(JSON.parse(text));
      } catch {}
      reads.push({
        at,
        status: r.status,
        timing: r.headers.get("server-timing") ?? "",
        src: a.src ?? null,
        n: arr(a.trades).length,
      });
      if (now() + POLL_MS > end) break;
      await wait(POLL_MS);
    }
    chains[chain] = { coin: COINS[chain], reads };
  }
  return { base: b, at: new Date(now()).toISOString(), chains };
}

/** PASS, FAIL or null (a coin with too few vendor answers to judge, or no coin judged), with one line per rule (a failed
 *  rule: BAD). Card evm-quote-check-skips-a-gone-coin: a coin the helper carries no more, every read answered 404 (Base
 *  USEF 0x1668cd48 on helper 70328a60c, 25 Nov 10:4xZ, DexScreener naming no pair for it), is named gone and not judged. */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  let none = false;
  let judged = 0;
  for (const chain of CHAINS) {
    const reads = arr(obj(obj(r.chains)[chain]).reads);
    const tag = `${chain} ${String(COINS[chain]).slice(0, 10)}`;
    if (reads.length > 0 && reads.every((x) => x.status === 404)) {
      lines.push(`--  ${tag}: gone, every one of its ${reads.length} answers 404 (the helper carries it no more), not judged`);
      continue;
    }
    const vendor = reads.filter((x) => VENDOR.test(String(x.timing)));
    if (vendor.length < MIN_VENDOR) {
      lines.push(
        `--  ${tag}: ${vendor.length} vendor answers of ${reads.length}, too few to judge`,
      );
      none = true;
      continue;
    }
    const not200 = reads.filter((x) => x.status !== 200);
    say(
      not200.length === 0,
      `${tag}: every trades answer 200: ${not200.length ? not200.map((x) => x.status).join(",") : "yes"}`,
    );
    const aged = vendor.filter((x) => PRICE.test(String(x.timing)));
    say(
      aged.length === 0,
      `${tag}: ${vendor.length} vendor answers, none naming the vendor's rate's age: ${aged.length ? `${aged.length} name it (${PRICE.exec(String(aged[0].timing))[0].replace(/^,?\s*/, "")})` : "none"}`,
    );
    const through = Math.max(
      0,
      ...vendor.map((x) => Number(THROUGH.exec(String(x.timing))?.[1] ?? 0)),
    );
    lines.push(`--  ${tag}: rows priced from chain at their block: ${through}`);
    judged++;
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: bad ? false : none || judged === 0 ? null : true, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const r = await read(opt("--base", BASE));
    if (opt("--record"))
      writeFileSync(opt("--record"), `${JSON.stringify(r, null, 1)}\n`);
    const { ok, lines } = judge(r);
    for (const l of lines) console.log(l);
    if (ok === null) {
      const n = nothingToJudge(KEY, r.base);
      console.log(n.line);
      process.exit(n.code);
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
