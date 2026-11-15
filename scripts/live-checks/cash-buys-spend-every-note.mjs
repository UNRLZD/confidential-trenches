#!/usr/bin/env node
// Live check of card cash-buys-spend-every-note on SIGN_HOST (https://confidential.unrealized.trade). Before the card a
// Solana buy's move from Cash, its Fee and its Max were sized against Cash's largest note alone, so Cash split over
// notes each under the move refused every buy from it (the owner's $2 buy, 15 Nov 11:58Z). With the card the move is
// planned over every note (packages/signpage/src/cash-to-pool.ts planCashMove), each part held to 1Click's least for
// the route, read live (readOneClickLeast: a dry quote of one unit, whose refusal names the least). What it holds:
//   - the served /app.js is the one index.html pins (its sha384), and in it the least read's mark, the regex literal
//     that reads 1Click's "Amount is too low for bridge, try at least N", as the minifier keeps it;
//   - 1Click, through the helper's proxy, names that least for USDC on NEAR into SOL now: the device's plan and Max are
//     held to it (an answer that names none leaves only each part's own quote, so the check fails to say so).
// That the plan spends every note, never asks a note too small for a part and checks every part's quote before any note
// leaves Cash is packages/signpage/test/cash-buys-spend-every-note.test.ts's. The money run is the owner's $2 buy.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/cash-buys-spend-every-note.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2. Reads only: a dry quote names no account of anyone's, nothing is made or sent.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "cash-buys-spend-every-note";
export const SIGN = "https://confidential.unrealized.trade";
export const ONECLICK = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
// the least read's regex literal, as written in cash-to-pool.ts and kept by the minifier
const MARK = /\/"message"\\s\*:\\s\*"Amount is too low for bridge, try at least \(\\d\{1,30\}\)"\//;
const LEAST = /"message"\s*:\s*"Amount is too low for bridge, try at least (\d{1,30})"/;

export const NO_MARK = "BAD the served page does not read 1Click's least for a move of Cash (the dry quote's refusal)";
export const NO_LEAST = "BAD 1Click names no least for USDC on NEAR into SOL: the device's parts would be held to their own quotes alone";

/** What the check keeps of the reads: the index, the served bundle's sha384, the mark, and 1Click's answer's text. */
export function facts(index, js, oneclick) {
  return { index, sha384: sha384(js), mark: MARK.test(js), oneclick: String(oneclick).slice(0, 2048) };
}

/** The build's half of the verdict: the pin and the least read's mark, which the pull request's own build is held to. */
function buildLines(a, bad) {
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.mark !== true) bad(NO_MARK);
}

/** The verdict on an answer { index, sha384, mark, oneclick }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`);
  buildLines(a, bad);
  const least = LEAST.exec(a?.oneclick ?? "")?.[1];
  if (least === undefined || BigInt(least) <= 0n) bad(NO_LEAST);
  else lines.push(`ok 1Click's least into SOL: ${least} USDC base units`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** The bundle checks' run on a build (scripts/ci/bundle-checks.mjs): its pin and mark; 1Click is past the build, read live only. */
export async function bundle(fetchFn) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const lines = [];
  buildLines(facts(await get("/"), await get("/app.js"), ""), (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`));
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  // the page's own read (cash-to-pool.ts readOneClickLeast): one unit of Cash's USDC into SOL, dry
  const body = {
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", depositType: "INTENTS",
    destinationAsset: "nep141:sol.omft.near", amount: "1", refundTo: "4b742e2fa54135408f95d6be00483527709b33281f3d1836ae3e83371caae5c0", refundType: "INTENTS",
    recipient: "So11111111111111111111111111111111111111112", recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 600_000).toISOString(),
  };
  const oc = await fetchFn(ONECLICK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.text());
  return facts(await get("/"), await get("/app.js"), oc);
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
