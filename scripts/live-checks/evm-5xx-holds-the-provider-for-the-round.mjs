#!/usr/bin/env node
// Live check of card evm-5xx-holds-the-provider-for-the-round on SIGN_HOST (https://confidential.unrealized.trade). A
// quote's reads go out as batches, each to two providers at once, queued in each provider's gate
// (packages/kit/src/checks/evm/quote.ts readBoth, agreeing, gated). Before this card a provider that answered HTTP 5xx
// was still sent every batch queued behind its failed one, each failing in turn: a USDG tap on Robinhood drew 36 HTTP
// 500s of rpc-robinhood.globalstake.io, p50 1,057 ms each, and took 34.8 s (card rh-provider-fails-64-read-batch, 18 Nov).
// Now a 5xx holds the provider for the rest of its round. What it holds on what is deployed, and only that: the served
// /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - gate: the provider's gate marks it down on an HTTP 5xx before its slot frees (gated's `.catch`, which calls the
//     request's `down` hook), so the request next in its gate already moves;
//   - round: each request of a round carries the `down` hook that adds its provider to the round's set (agreeing), the
//     set every batch of the round reads as its request would leave the gate;
//   - scan: the scan's refusal for a provider that answered 5xx in this quote, which sends its later requests to the next.
// That the hold moves the batches and ends with the round is the kit's tests FH1-FH3 and SP5xx
// (packages/kit/test/evm-quote-attacks.test.ts); this check holds that the deployed page carries that code.
// The recorded answers: facts() over this card's SIGN_HOST build (scripts/signpage-built.mjs on its branch) and
// SIGN_HOST as served on 18 Nov (read 03:16Z), before this card.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-5xx-holds-the-provider-for-the-round.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-5xx-holds-the-provider-for-the-round";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const ID = "[\\w$]+";
// gated: `.catch(e=>{throw f(e)&&t?.down?.(),e})`, the 5xx test and the request's down hook before the error goes on
const GATE = new RegExp(`\\.catch\\((${ID})=>\\{throw ${ID}\\(\\1\\)&&${ID}\\?\\.down\\?\\.\\(\\),\\1\\}\\)`);
// agreeing: the request's hooks end `down:()=>void c?.add(l[r])`, its provider added to the round's set
const ROUND = new RegExp(`down:\\(\\)=>void ${ID}\\?\\.add\\(${ID}\\[${ID}\\]\\)`);
// scanGateOf: the refusal that sends a request the next would be handed there unsent
export const SCAN = "the scan provider answered HTTP 5xx in this quote";

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), gate: GATE.test(js), round: ROUND.test(js), scan: js.includes(SCAN) };
}

export const NO_GATE = "BAD a provider's gate does not mark it down on an HTTP 5xx before its slot frees: the batch next in its gate is sent to it";
export const NO_ROUND = "BAD a round's requests carry no hook that holds a provider that answered HTTP 5xx: every batch of the round is still sent to it";
export const NO_SCAN = `BAD the scan sends a provider that answered HTTP 5xx its later requests (${JSON.stringify(SCAN)} not in the bundle)`;

/** The verdict on an answer { index, sha384, gate, round, scan }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.gate !== true) bad(NO_GATE);
  if (a?.round !== true) bad(NO_ROUND);
  if (a?.scan !== true) bad(NO_SCAN);
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
