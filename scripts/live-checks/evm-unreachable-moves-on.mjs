#!/usr/bin/env node
// Live check of card evm-unreachable-moves-on on SIGN_HOST (https://confidential.unrealized.trade). A quote's request
// that made no connection (packages/kit/src/checks/evm/quote.ts ask, Unreachable) was asked of the same provider again
// 0.5, 1 and 1.5 s on whatever other provider was left: four failed posts and 3 s a request. In a browser every failure
// with no response is one: a reset, a name that did not resolve, and Robinhood's own 429, which CORS refuses ("*,*").
// Now, while another provider is left, it goes there at once, as a 429 does; the last provider left is asked again as
// before. What it holds on what is deployed, and only that: the served /app.js is the one index.html pins (its sha384),
// and in it, as minified, ask's refusal reads the request's spare for a throttle and a refused connection alike:
//   if(!(e instanceof A||e instanceof B)||i===3||n?.spare?.()===!0)throw   (before: ||e instanceof A&&n?.spare?.()===!0)
//   (card evm-warm-tap-ends-inside-two-seconds: then ||n?.done?.()===!0, a round already agreed asks no more)
// That the request moves and the last one is still retried is the kit's tests FU1 and FU2
// (packages/kit/test/evm-quote-attacks.test.ts); this check holds that the deployed page carries that code.
// The recorded answers: facts() over this card's SIGN_HOST build (scripts/signpage-built.mjs on its branch) and
// SIGN_HOST as served on 18 Nov (read 06:09Z), before this card.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-unreachable-moves-on.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-unreachable-moves-on";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const ID = "[\\w$]+";
// ask: a refusal whose spare clause stands alone, for any failure that reaches it (a throttle or a refused connection)
const MOVES = new RegExp(`if\\(!\\((${ID}) instanceof ${ID}\\|\\|\\1 instanceof ${ID}\\)\\|\\|${ID}===3\\|\\|${ID}\\?\\.spare\\?\\.\\(\\)===!0(?:\\|\\|${ID}\\?\\.done\\?\\.\\(\\)===!0)?\\)throw`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and whether the bundle holds the mark. */
export function facts(index, js) {
  return { index, sha384: sha384(js), moves: MOVES.test(js) };
}

export const NO_MOVE = "BAD a request that made no connection is asked of its provider again while another provider is left (ask's spare reads a throttle only)";

/** The verdict on an answer { index, sha384, moves }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.moves !== true) bad(NO_MOVE);
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
