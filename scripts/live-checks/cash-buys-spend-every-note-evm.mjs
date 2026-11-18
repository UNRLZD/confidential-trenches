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
//     read as the page reads it: the device's parts and Max are held to it. A walk that ends on a quote short of a
//     least, on a refusal that names none, or short of one USDC on "Failed to get quote", FAILs. One that ends on a blip
//     the device asks again (card cash-least-read-again: "Failed to get quote" at one USDC, "No liquidity available", a
//     429, a 5xx, no answer) proves nothing either way: INCONCLUSIVE, and the run reads again.
// That the plan spends every note, sizes the tap on the rungs its parts land and checks every part's quote before any
// note leaves Cash is packages/signpage/test/cash-buys-spend-every-note-evm.test.ts's. The money run is the owner's Base
// buy from Cash.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/cash-buys-spend-every-note-evm.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. Reads only: a dry quote names no account of anyone's,
// nothing is made or sent.
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

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });
/** The amounts the walk asks, one unit to one USDC: a "Failed to get quote" at the last is a blip, not a walk's end. */
const RUNGS = 7;

/** What the check keeps of the reads: the index, the served bundle's sha384, the mark, and 1Click's answers' texts per
 *  chain, in the order the page asks them, with their HTTP statuses (0: no answer) when read. */
export function facts(index, js, oneclick, status) {
  return { index, sha384: sha384(js), mark: MARK.test(js), oneclick, ...(status === undefined ? {} : { status }) };
}

/** Whether the walk's last answer is a blip the device asks again (cash-to-pool.ts readOneClickLeast): "Failed to get
 *  quote" at one USDC (the walk's last rung), "No liquidity available", a 429, a 5xx or no answer (status 0). An answer
 *  recorded with no status is judged on its text alone. */
export function blipOf(answers, statuses) {
  const all = Array.isArray(answers) ? answers : [];
  if (all.length === 0) return false;
  const t = String(all[all.length - 1]);
  const s = Array.isArray(statuses) ? statuses[all.length - 1] : undefined;
  if (LEAST.test(t)) return false;
  if (FAILED.test(t)) return all.length === RUNGS && all.every((x) => FAILED.test(String(x)));
  return /"message"\s*:\s*"No liquidity available"/.test(t) || s === 0 || s === 429 || (Number.isInteger(s) && s >= 500);
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
  let quiet = false;
  for (const chain of ["base", "robinhood"]) {
    const answers = a?.oneclick?.[chain];
    const least = leastOf(answers);
    if (least !== undefined && least > 0n) lines.push(`ok 1Click's least into ${chain}'s ETH: ${least} USDC base units`);
    else if (least === undefined && blipOf(answers, a?.status?.[chain])) {
      quiet = true;
      const i = answers.length - 1;
      lines.push(`INCONCLUSIVE 1Click gave a blip into ${chain}'s ETH, no least and no refusal (HTTP ${a?.status?.[chain]?.[i] ?? "?"} ${String(answers[i]).slice(0, 120)}): read again`);
    } else bad(noLeast(chain));
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
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
 *  each "Failed to get quote", up to one USDC; every answer's text and HTTP status kept (0: no answer). */
async function oneClickReads(fetchFn, chain) {
  const texts = [];
  const statuses = [];
  for (let amount = 1n; amount <= 1_000_000n; amount *= 10n) {
    const body = {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", depositType: "INTENTS",
      destinationAsset: COIN[chain], amount: amount.toString(), refundTo: "4b742e2fa54135408f95d6be00483527709b33281f3d1836ae3e83371caae5c0", refundType: "INTENTS",
      recipient: "0x1111111111111111111111111111111111111111", recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 600_000).toISOString(),
    };
    const a = await fetchFn(ONECLICK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).then(
      async (r) => ({ status: r.status, text: (await r.text()).slice(0, 2048) }),
      (e) => ({ status: 0, text: `no answer: ${e?.name ?? "failed"}` }),
    );
    texts.push(a.text);
    statuses.push(a.status);
    if (!FAILED.test(a.text)) break;
  }
  return { texts, statuses };
}

export async function read(fetchFn = fetch) {
  const get = getter(fetchFn);
  const base = await oneClickReads(fetchFn, "base");
  const robinhood = await oneClickReads(fetchFn, "robinhood");
  return facts(await get("/"), await get("/app.js"), { base: base.texts, robinhood: robinhood.texts }, { base: base.statuses, robinhood: robinhood.statuses });
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
    console.log(`${v.verdict} ${KEY}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
