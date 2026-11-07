#!/usr/bin/env node
// Live check of card evm-sell-no-release-in-flight on SIGN_HOST (https://sign.confidential.unrealized.trade), audit
// E-01: no EVM sale is built for a one-time wallet W while a release to W is not final on two RPCs, so a hostile route
// can never pass minOut with a release's ETH. W's key lives only on the signing page, so its bundle is the one place a
// Sell can be built and signed; the kit's sell builder (packages/kit/src/trade/evm/quoted.ts evmQuotedSell) refuses
// release_in_flight unless it holds the kit's verdict on W's releases with nothing pending (sell-releases.ts).
// What it proves, and only that: the served /app.js is the one index.html pins (its sha384), and when that bundle
// carries the kit's EVM sell builder (any of BUILDER's refusals, string literals the minifier keeps), it carries every
// line of the guard in GUARD with it. A bundle with no EVM sell builder passes, saying so: it can build no sale at all.
// That is SIGN_HOST today (read 7 Nov 19:35Z: the page's EVM flows land with signpage-evm-pool-trade, and the bundler
// drops the builder no flow calls); the check holds the guard to ship with the builder the day a flow takes it in.
// It does not prove the guard runs: a bundle edited so the guard does nothing, its texts kept, passes. That the guard
// refuses is the kit's test at the released commit (test/evm-sell-quote.test.ts, card evm-sell-no-release-in-flight,
// and its mutants in test/evm-quote-mutants.mjs); that the served files are that commit's build is signpage-release's.
// The recorded answers: SIGN_HOST as served (good, no builder), the kit's sell builder bundled at this card's commit
// (good, the builder and the guard) and at the commit before it (bad, the builder alone), and planted bundles.
//   node scripts/live-checks/evm-sell-no-release-in-flight.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-sell-no-release-in-flight";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The kit's EVM sell builder and signer, by their refusals: a bundle with any of them can build or sign a Sell. */
export const BUILDER = Object.freeze([
  "a sell is built only from a quote evmPoolSellQuote returned",
  "W signs only a sell evmPoolBuildSell returned",
  "W signs only a sell evmPoolBuildSellUnpinned returned for this chain",
]);
/** Each line of the guard, by its text (sell-releases.ts). */
export const GUARD = Object.freeze({
  "the builder refuses a sell without the kit's verdict on W's releases": "a sell is built only with W's releases read by evmSellReleases",
  "a verdict made for another chain or another W is refused": "the releases read is another chain's or another W's",
  "a release landed above the finalized block holds the sell until that block is final": "above the finalized block: the sell waits until block ",
  "a release sent and not landed holds the sell until it lands final or its deadline passes": "was sent and has not landed: the sell waits until it lands in a final block or a final block's time passes its deadline ",
  "the refusal's code": "release_in_flight",
});

/** What the check keeps of the reads: the index, the served bundle's sha384, whether it carries the sell builder, and
 *  which lines of the guard it carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), builds: BUILDER.some((b) => js.includes(b)), carries: Object.fromEntries(Object.entries(GUARD).map(([k, t]) => [k, js.includes(t)])) };
}

/** The verdict on an answer { index, sha384, builds, carries }. */
export function judge(a) {
  const lines = [];
  const say = (ok, m) => lines.push(`${ok ? "ok " : "BAD"} ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) say(false, "SIGN_HOST's index.html pins no /app.js");
  else say(pin === a.sha384, pin === a.sha384 ? "SIGN_HOST's served /app.js is the one index.html pins" : "SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.builds !== "boolean") say(false, "the answer does not say whether the bundle carries the EVM sell builder");
  else if (!a.builds) say(true, "the served bundle carries no EVM sell builder: it builds and signs no sale");
  else {
    say(true, "the served bundle carries the EVM sell builder");
    for (const k of Object.keys(GUARD)) say(a.carries?.[k] === true, `${a.carries?.[k] === true ? "the guard is in it" : "the served bundle builds a sale without the guard"}: ${k}`);
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
