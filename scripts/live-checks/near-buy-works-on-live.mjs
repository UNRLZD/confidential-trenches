#!/usr/bin/env node
// Live check of card near-buy-works-on-live: SIGN_HOST's vault hand-off (packages/signpage/src/withdraw/handoff.ts) asks
// the relayer's fee quote after its slow reads and lets a quote whose window would close before the send go before the
// note is RESERVED (QuoteStale), proving again on a fresh quote; its reads are on the helper's keyed seat. Without it a
// NEAR buy's payout was sent past the helper's 100-block quote window, refused fee_too_low, and its note held RESERVED
// with nothing paid (live 14 Nov 20:5xZ: Cash read $4.32 of $5.47 and every later NEAR buy ended Failed at Private
// balance). What it holds on what is deployed, and only that:
//   - SIGN_HOST's served /app.js is the one its index.html pins (sha384);
//   - its code carries the stale-quote refusal (MARK below), which only the fixed hand-off throws.
// The recorded answers: facts() over this card's SIGN_HOST build (scripts/signpage-built.mjs at the card's branch) and
// SIGN_HOST as served at release 144 (read 14 Nov 21:30Z).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/near-buy-works-on-live.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "near-buy-works-on-live";
export const SIGN = "https://confidential.unrealized.trade";
/** handoff.ts QuoteStale's message: in the bundle only where the hand-off checks the quote's window before RESERVED. */
export const MARK = "the fee quote's window closes before the request could be sent";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** What the check keeps of the reads: the index, the bundle's sha384 and its mark. */
export function facts(index, js) {
  return { index, sha384: sha384(js), window_held: js.includes(MARK) };
}

/** The verdict on an answer { index, sha384, window_held }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.window_held !== true) bad(`SIGN_HOST's hand-off sends a request past its fee quote's window (${JSON.stringify(MARK)} not in the bundle): a payout refused fee_too_low holds its note`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error", headers: { "cache-control": "no-cache" } });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  return facts(index, await get("/app.js"));
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
