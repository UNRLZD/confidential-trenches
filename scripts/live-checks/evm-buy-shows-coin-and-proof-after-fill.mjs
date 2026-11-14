#!/usr/bin/env node
// Live check of card evm-buy-shows-coin-and-proof-after-fill: SIGN_HOST serves a page that reads Base's and Robinhood's
// positions on its own mainnet lists. Release 144's page read a chain's positions only when its pass list held exactly
// two providers (packages/signpage/src/pool-testnet.ts, minified `r===null||r.passList.length!==2?null:`), while its
// lists hold five on Base and four on Robinhood (pageEvmPoolRpcs), so a filled Base or Robinhood buy never showed its
// coin, nor offered its sale (the owner's XDP buy, 14 Nov 20:46Z). It passes only when, on SIGN_HOST:
//   1. the served /app.js is the one its index.html pins (sha384);
//   2. it carries the EVM positions pass (its agreed balance's refusal, PASS_MARK, src/positions-evm.ts);
//   3. it carries no positions gate on the pass list's size (GATE): no `<x>.passList.length!==<n>?null:`.
// What it cannot see from outside: the page's state itself, which needs a seed with a filled buy; the card's test holds
// it (packages/signpage/test/positions-evm.test.ts, "lists of SIGN_HOST's sizes").
// After: sign
// Bundle: out SIGN_HOST's index.html and /app.js
//   node scripts/live-checks/evm-buy-shows-coin-and-proof-after-fill.mjs [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read (the pin, the bundle's sha384 and the two
//   marks' counts), so the check's test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-buy-shows-coin-and-proof-after-fill";
export const SIGN = "https://confidential.unrealized.trade";
/** src/positions-evm.ts agreedBalance's refusal: only the EVM positions pass carries it. */
export const PASS_MARK = "balanceOf: the two RPCs differ";
/** A positions cache made only on a pass list of one size, as minified (release 144: `r===null||r.passList.length!==2?null:`). */
export const GATE = /\.passList\.length!==\d+\?null:/g;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** What the check keeps of SIGN_HOST: its index's /app.js pin, the served bundle's sha384 and the two marks' counts. */
export function pageFacts(index, js) {
  return { pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null, sha384: sha384(js), marks: { pass: js.split(PASS_MARK).length - 1, gate: [...js.matchAll(GATE)].length } };
}

/** The verdict on one recorded read: { ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const f = rec?.facts ?? {};
  say(typeof f.pin === "string" && f.pin === f.sha384, `the served /app.js is the one index.html pins (${f.pin ?? "no pin"})`);
  say(Number.isInteger(f.marks?.pass) && f.marks.pass >= 1, `the bundle carries the EVM positions pass (${f.marks?.pass ?? "none"} "${PASS_MARK}")`);
  say(f.marks?.gate === 0, `the bundle reads positions on a pass list of any size: no list-size gate (${f.marks?.gate ?? "unread"} found)`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

async function read(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    const [index, js] = await Promise.all([read(`${SIGN}/`), read(`${SIGN}/app.js`)]);
    const rec = { source: `live ${SIGN}`, at: new Date().toISOString(), facts: pageFacts(index, js) };
    const i = process.argv.indexOf("--record");
    if (i > 0) writeFileSync(process.argv[i + 1], `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
