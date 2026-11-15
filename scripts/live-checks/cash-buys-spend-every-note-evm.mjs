#!/usr/bin/env node
// Live check of card cash-buys-spend-every-note-evm on SIGN_HOST (https://confidential.unrealized.trade). Before the card
// a Base or Robinhood buy's move from Cash, its Fee and its Max were sized against Cash's largest note alone, so Cash
// split over notes each under the move refused every buy from it; and 1Click's least into Base's ETH was no read, since
// 1Click answers "Failed to get quote" to one unit. With the card the move is planned over every note
// (packages/signpage/src/cash-to-pool.ts evmCashPlan), and the least is read past that answer, ten times over each time
// (readOneClickLeast). What it holds:
//   - the served /app.js is the one index.html pins (its sha384), and in it the read's mark, the regex literal that
//     reads 1Click's "Failed to get quote", as the minifier keeps it;
//   - 1Click, through the helper's proxy, names its least for USDC on NEAR into Base's ETH and into Robinhood's ETH now,
//     read as the page reads it: the device's parts and Max are held to it.
// That the plan spends every note, sizes the tap on the rungs its parts land and checks every part's quote before any
// note leaves Cash is packages/signpage/test/cash-buys-spend-every-note-evm.test.ts's. The money run is the owner's Base
// buy from Cash.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/cash-buys-spend-every-note-evm.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2. Reads only: a dry quote names no account of anyone's, nothing is made or sent.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "cash-buys-spend-every-note-evm";
export const SIGN = "https://confidential.unrealized.trade";
export const ONECLICK = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
// the read's regex literal for 1Click's "Failed to get quote", as written in cash-to-pool.ts and kept by the minifier
const MARK = /\/"message"\\s\*:\\s\*"Failed to get quote"\//;
const LEAST = /"message"\s*:\s*"Amount is too low for bridge, try at least (\d{1,30})"/;
const FAILED = /"message"\s*:\s*"Failed to get quote"/;
const COIN = { base: "nep141:base.omft.near", robinhood: "nep141:hood.omft.near" };

export const NO_MARK = "BAD the served page does not read 1Click's least past its \"Failed to get quote\"";
export const noLeast = (chain) => `BAD 1Click names no least for USDC on NEAR into ${chain}'s ETH as the page reads it: the device's parts would be held to their own quotes alone`;

/** What the check keeps of the reads: the index, the served bundle's sha384, the mark, and 1Click's answers' texts per
 *  chain, in the order the page asks them. */
export function facts(index, js, oneclick) {
  return { index, sha384: sha384(js), mark: MARK.test(js), oneclick };
}

/** The build's half of the verdict: the pin and the read's mark, which the pull request's own build is held to. */
function buildLines(a, bad) {
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.mark !== true) bad(NO_MARK);
}

/** The least the page's read takes from 1Click's answers, as cash-to-pool.ts readOneClickLeast does: the first that
 *  names one, past each "Failed to get quote"; undefined otherwise. */
export function leastOf(answers) {
  for (const t of Array.isArray(answers) ? answers : []) {
    const m = LEAST.exec(String(t));
    if (m) return BigInt(m[1]);
    if (!FAILED.test(String(t))) return undefined;
  }
  return undefined;
}

/** The verdict on an answer { index, sha384, mark, oneclick: { base: [..], robinhood: [..] } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`);
  buildLines(a, bad);
  for (const chain of ["base", "robinhood"]) {
    const least = leastOf(a?.oneclick?.[chain]);
    if (least === undefined || least <= 0n) bad(noLeast(chain));
    else lines.push(`ok 1Click's least into ${chain}'s ETH: ${least} USDC base units`);
  }
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

const getter = (fetchFn) => async (path) => {
  const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
  if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
};

/** The bundle checks' run on a build (scripts/ci/bundle-checks.mjs): its pin and mark; 1Click is past the build, read live only. */
export async function bundle(fetchFn) {
  const get = getter(fetchFn);
  const lines = [];
  buildLines(facts(await get("/"), await get("/app.js"), {}), (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`));
  return { ok: lines.length === 0, lines };
}

/** The page's own read (cash-to-pool.ts readOneClickLeast): one unit of Cash's USDC, dry, then ten times as much after
 *  each "Failed to get quote", up to one USDC; every answer's text kept. */
async function oneClickReads(fetchFn, chain) {
  const texts = [];
  for (let amount = 1n; amount <= 1_000_000n; amount *= 10n) {
    const body = {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", depositType: "INTENTS",
      destinationAsset: COIN[chain], amount: amount.toString(), refundTo: "4b742e2fa54135408f95d6be00483527709b33281f3d1836ae3e83371caae5c0", refundType: "INTENTS",
      recipient: "0x1111111111111111111111111111111111111111", recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 600_000).toISOString(),
    };
    const t = (await fetchFn(ONECLICK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.text())).slice(0, 2048);
    texts.push(t);
    if (!FAILED.test(t)) break;
  }
  return texts;
}

export async function read(fetchFn = fetch) {
  const get = getter(fetchFn);
  const oneclick = { base: await oneClickReads(fetchFn, "base"), robinhood: await oneClickReads(fetchFn, "robinhood") };
  return facts(await get("/"), await get("/app.js"), oneclick);
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
