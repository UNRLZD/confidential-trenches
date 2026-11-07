#!/usr/bin/env node
// Live check of card solana-written-accounts-whole on SIGN_HOST (https://sign.confidential.unrealized.trade). The
// signing page bundles the kit's Solana checks, so the device that signs a Jupiter build runs the ones SIGN_HOST serves.
// What it holds, and only that: the served /app.js is the one index.html pins (its sha384), and it carries S11's rule on
// every token account of the wallet's the tx writes, as live code, each read by a mark of the bundle's own shape (the
// minifier renames, never restructures these lines; packages/kit/src/checks/solana/checks.ts):
//   - the 165-byte base read field by field, to its last byte (delegate, state, is_native, delegated_amount and close
//     authority, not the amount and owner alone);
//   - both providers agreeing on the whole base, the lamports and the program of each such account before;
//   - a wSOL account left with any field but its amount changed refused (its refusal reached, not dead text);
//   - the wallet's account of the token left with any field but its amount changed refused;
//   - every other such account held to its lamports as well.
// That each rule refuses is the kit's tests' (test/solana-quote.test.ts: a stranger as delegate or close authority on
// a written account, the held wSOL source and the account of the token, each refused); this check holds that the page
// serving the signer is a build that has them. The recorded planted bundles (the field list cut to owner and amount,
// the providers' agreement on amount alone, the wSOL refusal dead) each FAIL.
//   node scripts/live-checks/solana-written-accounts-whole.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "solana-written-accounts-whole";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "S11 the base read by field, to its last byte (165)": /\[`mint`,0,32\],\[`owner`,32,64\],\[`amount`,64,72\],\[`delegate`,72,108\],\[`state`,108,109\],\[`is_native`,109,121\],\[`delegated_amount`,121,129\],\[`close authority`,129,165\]/,
  "S11 the providers agree on the whole base, lamports and program": new RegExp(`(${I})\\.owner===(${I})\\.owner&&\\1\\.lamports===\\2\\.lamports&&${I}\\(\\1\\.data\\.subarray\\(0,165\\),\\2\\.data\\.subarray\\(0,165\\)\\)`),
  "S11 a wSOL account left with any field but its amount changed is refused": new RegExp(`!${I}\\|\\|${I}\\.length\\?${I}\\.push\\(\`the wallet's wSOL account \\$\\{${I}\\.key\\} is left with its `),
  "S11 the account of the token left with any field but its amount changed is refused": new RegExp(`${I}\\.length&&${I}\\.push\\(\`the wallet's account of the token \\$\\{${I}\\.key\\} is left with its `),
  "S11 any other account of the wallet's held to its lamports too": new RegExp(`${I}\\.lamports!==${I}\\.lamports\\)&&${I}\\.push\\(\`the wallet's account \\$\\{${I}\\.key\\} moves: `),
});

/** What the check keeps of the reads: the index, the served bundle's sha384, and which refusals the bundle carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), carries: Object.fromEntries(Object.entries(MARKS).map(([k, w]) => [k, w.test(js)])) };
}

/** The verdict on an answer { index, sha384, carries }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(MARKS)) if (a?.carries?.[k] !== true) bad(`the served bundle has no rule: ${k}`);
  return { ok: lines.length === 0, lines };
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
