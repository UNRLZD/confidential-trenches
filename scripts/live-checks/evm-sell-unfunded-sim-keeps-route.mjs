#!/usr/bin/env node
// Live check of card evm-sell-unfunded-sim-keeps-route on SIGN_HOST (https://sign.confidential.unrealized.trade), review
// a42f9c16 (Low 1): an EVM sale through a pool behind a hook the venue does not list is never priced off a worse pool
// because the pinned sell sender cannot pay for W's sim. W's key lives only on the signing page, and the kit's sell
// quote needs W's signature of the sim (signSim), so its bundle is the one place an EVM sell quote runs. The kit's quote
// (packages/kit/src/checks/evm/quote.ts simmedSells) reads the sender's balance at the block (Multicall3.getEthBalance,
// selector 4d2301cc) and, where it cannot pay the sim's gas, keeps every route at its keep-min value and says the sim
// was skipped (EvmPoolSellQuote.sim), where before it dropped the routes that needed the sim; where the sim runs, it
// runs at one wei above the floor and counts the route at the lower of its keep-min value and W's gain, where before it
// ran at the keep-min value and dropped the route on any shortfall (review of 1c31d81a, M1).
// What it proves, and only that: the served /app.js is the one index.html pins (its sha384), and when that bundle
// carries the kit's EVM sell quote (any of QUOTE's refusals, string literals the minifier keeps), it carries every line
// of the guard in GUARD with it: the balance read, its short branch returning the routes it was given, unfiltered,
// with sim "skipped", and the sim's minOut one wei above the floor. A bundle with no EVM sell quote passes, saying so: it can quote no sale at all. That is SIGN_HOST
// today (read 8 Nov: the page's EVM flows land with signpage-evm-pool-trade, and the bundler drops the quote no flow
// calls); the check holds the guard to ship with the quote the day a flow takes it in.
// It does not prove the guard runs: a bundle edited so the branch is never taken, its text kept, passes. That it keeps
// the routes is the kit's test at the released commit (test/evm-quote-attacks.test.ts PE8 and PE9, and their mutants in
// test/evm-quote-mutants.mjs); that the served files are that commit's build is signpage-release's.
// The recorded answers: SIGN_HOST as served (good, no quote), the kit's sell quote bundled at this card's fix (good,
// the quote and the guard), at the commit before the card (bad, the quote dropping the routes on both paths) and at
// the card's first fix (bad_partial, the skip kept, the sim still at the keep-min value), and planted bundles.
//   node scripts/live-checks/evm-sell-unfunded-sim-keeps-route.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-sell-unfunded-sim-keeps-route";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The kit's EVM sell quote, by its refusals: a bundle with any of them can quote a sale. */
export const QUOTE = Object.freeze([
  "a sell quote takes no route: the device picks the pool",
  "a sell quote takes `bought`, the route of the buy that paid W the token",
]);
/** Each line of the guard, by its text in the minified bundle (the minifier keeps literals and property names, and
 *  writes a string in any of its three quotes). */
export const GUARD = Object.freeze({
  "the quote reads the pinned sell sender's balance before W's sim": /[`"']0x4d2301cc[`"']/,
  "a sender too low to pay the sim keeps every route, none dropped, and the quote says the sim was skipped": /\{routes:[\w$]+,sim:[`"']skipped[`"']\}/,
  "W's sim runs at one wei above the floor, so a route counts at what W gains, never dropped for a shortfall": /hops,minOut:[\w$]+\+1n,nonce:/,
});

/** What the check keeps of the reads: the index, the served bundle's sha384, whether it carries the sell quote, and
 *  which lines of the guard it carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), quotes: QUOTE.some((b) => js.includes(b)), carries: Object.fromEntries(Object.entries(GUARD).map(([k, t]) => [k, t.test(js)])) };
}

/** The verdict on an answer { index, sha384, quotes, carries }. */
export function judge(a) {
  const lines = [];
  const say = (ok, m) => lines.push(`${ok ? "ok " : "BAD"} ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) say(false, "SIGN_HOST's index.html pins no /app.js");
  else say(pin === a.sha384, pin === a.sha384 ? "SIGN_HOST's served /app.js is the one index.html pins" : "SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.quotes !== "boolean") say(false, "the answer does not say whether the bundle carries the EVM sell quote");
  else if (!a.quotes) say(true, "the served bundle carries no EVM sell quote: it quotes no sale");
  else {
    say(true, "the served bundle carries the EVM sell quote");
    for (const k of Object.keys(GUARD)) say(a.carries?.[k] === true, `${a.carries?.[k] === true ? "the guard is in it" : "the served bundle quotes a sale without the guard"}: ${k}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
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
