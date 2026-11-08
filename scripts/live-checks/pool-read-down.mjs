#!/usr/bin/env node
// Live check of card pool-read-down on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and only
// that: the served /app.js is the one index.html pins (its sha384), and in it, as minified, a provider read that still
// fails after the page's own retry answers "down" (api.ts RETRY_CODES: the same request again runs again), never
// not_allowed, failed or quote_check_failed:
//   - the sell's decimals read (pool-kinds.ts): its frozen down answer;
//   - the buy, the sell and the deposit (pool-buy.ts, pool-sell.ts, pool-deposit.ts): the page's transport fault before
//     anything is signed answers down, three catches in all;
//   - deposit.quote (deposit-wire.ts): a read that throws answers down;
//   - the reference (page-rpc.ts pageReference): its own one-provider refusal beside the kit's, the page's wrap that
//     turns a failed read's null into that fault.
// What each does is held by the card's tests (packages/signpage/test/pool-kinds, pool-buy, pool-sell, pool-deposit and
// deposit-wire, each "card pool-read-down"); the recorded answers are facts() over each tree's packages/signpage/
// index.html and public/app.js (this file reaches no package code: the import check holds it).
//   node scripts/live-checks/pool-read-down.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-read-down";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The minified marks of each piece, as the bundle spells them. */
const Q = "[`\"']";
const KINDS = new RegExp(`Object\\.freeze\\(\\{error:${Q}down${Q}\\}\\)`);
const FLOWS = new RegExp(`instanceof [\\w$]+(\\?|\\)return)\\{error:${Q}down${Q}\\}`, "g");
const WIRE = new RegExp(`\\.catch\\(\\(\\)=>\\{[\\w$]+=\\{error:${Q}down${Q}\\}\\}\\)`);
const REFERENCE = /a reference must never rest on one provider's word/g;
// what landed (the list's length, or card pool-answer-unknown's count: never the list itself, an array always true),
// then the sends that may land: a list, or (card pool-answer-unknown) a call naming the sends of notes still open
const PART = `return\\{stage:${Q}part_filled${Q},txs:`;
const SENT = new RegExp(`if\\((?:([\\w$]+)\\.length\\)${PART}\\1|(?!([\\w$]+)\\)${PART}\\2\\})[\\w$]+\\)${PART}[\\w$]+)\\};if\\([\\w$]+(?:\\(\\))?\\.length\\)return\\{stage:${Q}sent${Q},txs:[\\w$]+(?:\\(\\))?\\}`);
// down before a signature; with the kit's record (card pool-answer-unknown) only in place of its plain failed
const TRADE = new RegExp(`[\\w$]+&&![\\w$]+(?:&&[\\w$]+===${Q}failed${Q})?\\?${Q}down${Q}:`, "g");

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    kinds: KINDS.test(js),
    flows: (js.match(FLOWS) ?? []).length,
    wire: WIRE.test(js),
    references: (js.match(REFERENCE) ?? []).length,
    sent: SENT.test(js),
    trade: (js.match(TRADE) ?? []).length,
  };
}

/** The verdict on an answer { index, sha384, kinds, flows, wire, references, sent, trade }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.kinds !== true) bad("a sell whose decimals read fails on one provider is refused not_allowed: the app takes it as a no");
  if (!(Number.isInteger(a?.flows) && a.flows >= 3)) bad("a pool buy, sell or deposit whose provider read fails before signing is not answered down: the app takes it as a no");
  if (a?.wire !== true) bad("a deposit quote whose read throws is refused not_allowed: the app takes it as a no");
  if (!(Number.isInteger(a?.references) && a.references >= 2)) bad("a pool trade's reference read that fails is answered quote_check_failed: a provider's outage shows as a price check");
  if (a?.sent !== true) bad("a pool deposit whose read fails after its send is answered failed: the app shows a deposit that may land as failed");
  if (!(Number.isInteger(a?.trade) && a.trade >= 2)) bad("a vault buy whose reference read fails before signing is not answered down: the app takes it as a no");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
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
