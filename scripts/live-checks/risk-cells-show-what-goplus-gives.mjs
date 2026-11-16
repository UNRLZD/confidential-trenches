#!/usr/bin/env node
// Live check of card risk-cells-show-what-goplus-gives: an EVM token page's contract cells are what GoPlus gives for the
// token, no more and no less (apps/helper/src/data/goplus.ts, evm/token.ts). For Base and Robinhood, the first COINS
// coins of the helper's Trending (1h) list are each asked of GoPlus directly (GOPLUS, keyless, one call every GAP_MS),
// and their page on GET /v1/market/token is read every POLL_MS for READ_MS until it holds a GoPlus cell. Then, for each
// coin GoPlus answers with a result for it (whatever its code: SNDKc answered code 3 with a partial result, 16 Nov):
//   - every cell GoPlus names (mint_auth from is_mintable, freeze_auth from transfer_pausable and is_blacklisted, dev_bps
//     from creator_percent, tax from buy_tax and sell_tax, honeypot from is_honeypot) is served with src goplus;
//   - a cell GoPlus names nothing for is not served with src goplus (nothing inferred);
//   - each chain has at least one coin GoPlus answered.
// After: helper
//   node scripts/live-checks/risk-cells-show-what-goplus-gives.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "risk-cells-show-what-goplus-gives";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const GOPLUS = "https://api.gopluslabs.io/api/v1/token_security";
export const CHAINS = { base: 8453, robinhood: 4663 };
export const COINS = 3;
export const CELLS = ["mint_auth", "freeze_auth", "dev_bps", "tax", "honeypot"];
export const READ_MS = 20_000;
export const POLL_MS = 2_000;
/** GoPlus's free tier answered three back-to-back calls with one non-JSON reply (goplus.ts header): one call each GAP_MS. */
export const GAP_MS = 2_000;

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const flagged = (v) => v === "0" || v === "1";
const share = (v) => typeof v === "string" && /^\d{1,3}(\.\d{1,30})?$/.test(v) && Number(v) <= 1;

/** The cells GoPlus's entry for a token names a value for, as GoPlus writes them (the check's own reading of its
 *  fields, not the helper's code). */
export function named(entry) {
  const e = obj(entry);
  const out = [];
  if (flagged(e.is_mintable)) out.push("mint_auth");
  if (e.transfer_pausable === "1" || e.is_blacklisted === "1" || (e.transfer_pausable === "0" && e.is_blacklisted === "0")) out.push("freeze_auth");
  if (share(e.creator_percent)) out.push("dev_bps");
  if (share(e.buy_tax) && share(e.sell_tax)) out.push("tax");
  if (flagged(e.is_honeypot)) out.push("honeypot");
  return out;
}

/** The run: for each chain the Trending coins, each one's GoPlus entry (its code and fields), and its page's cells. */
export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const json = async (url, init) => {
    const r = await fetchFn(url, init);
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: null };
    }
  };
  const chains = {};
  let gapUntil = 0;
  for (const [chain, id] of Object.entries(CHAINS)) {
    const l = await json(`${b}/v1/market/lists?chain=${chain}`, { headers: { origin: APP } });
    const coins = [...new Set(arr(obj(obj(l.body).lists).trending_1h).map((r) => obj(r).token).filter((t) => typeof t === "string" && /^0x[0-9a-f]{40}$/.test(t)))].slice(0, COINS);
    const out = [];
    for (const address of coins) {
      if (now() < gapUntil) await wait(gapUntil - now());
      const g = await json(`${GOPLUS}/${id}?contract_addresses=${address}`, { headers: { accept: "application/json" } });
      gapUntil = now() + GAP_MS;
      const entry = obj(obj(obj(g.body).result)[address]);
      const goplus = { status: g.status, code: obj(g.body).code ?? null, has_result: Object.keys(entry).length > 0, named: named(entry) };
      const end = now() + READ_MS;
      const pages = [];
      for (;;) {
        const p = await json(`${b}/v1/market/token?chain=${chain}&token=${address}`, { headers: { origin: APP } });
        const risk = obj(obj(p.body).risk);
        const cells = Object.fromEntries(CELLS.map((k) => [k, obj(risk[k]).src ?? null]));
        pages.push({ status: p.status, cells });
        if ((p.status === 200 && CELLS.some((k) => cells[k] === "goplus")) || now() + POLL_MS > end) break;
        await wait(POLL_MS);
      }
      out.push({ address, goplus, pages });
    }
    chains[chain] = { lists_status: l.status, coins: out };
  }
  return { base: b, at: new Date(now()).toISOString(), chains };
}

/** PASS or FAIL with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  for (const chain of Object.keys(CHAINS)) {
    const c = obj(obj(r.chains)[chain]);
    const answered = arr(c.coins).filter((x) => x.goplus?.has_result === true);
    say(answered.length > 0, `${chain}: GoPlus answered ${answered.length} of ${arr(c.coins).length} Trending coins with a result (codes ${arr(c.coins).map((x) => x.goplus?.code).join(",")})`);
    for (const x of answered) {
      const last = arr(x.pages).at(-1);
      const cells = obj(last?.cells);
      const missing = x.goplus.named.filter((k) => cells[k] !== "goplus");
      const made = CELLS.filter((k) => !x.goplus.named.includes(k) && cells[k] === "goplus");
      say(last?.status === 200 && missing.length === 0, `${chain} ${x.address} serves every cell GoPlus names (${x.goplus.named.join(", ") || "none"}) src goplus (page ${last?.status}): ${missing.length ? `missing ${missing.join(", ")}` : "yes"}`);
      say(made.length === 0, `${chain} ${x.address} serves no cell src goplus that GoPlus names nothing for: ${made.join(", ") || "none"}`);
    }
  }
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
