#!/usr/bin/env node
// Live check of card solana-written-accounts-whole on SIGN_HOST (https://sign.confidential.unrealized.trade). The
// signing page bundles the kit's Solana checks, so the device that signs a Jupiter build runs the ones SIGN_HOST serves.
// What it proves, and only that: the served /app.js is the one index.html pins (its sha384), and its text carries these
// lines of S11's rule on every token account of the wallet's the tx writes, each found by a mark of the bundle's shape
// (the minifier renames, never restructures them; packages/kit/src/checks/solana/checks.ts):
//   - the 165-byte base compared field by field, to its last byte, and the account's size with it;
//   - the providers' agreement on every byte, the lamports and the program of each such account before;
//   - the refusal of a wSOL account, of the account of the token and of any other such account left changed;
//   - the refusal of a close of the account of the token the providers disagreed on before.
// It does not prove those lines run or refuse: a bundle edited so S11 or one of its rules does nothing, with every mark
// kept, passes it (the independent review planted eight such bundles, 7 Nov). That the rules refuse is the kit's unit
// and flow tests' at the released commit (test/solana-quote.test.ts, test/solana-flow-replay.test.ts), and that the
// served files are that commit's build is signpage-release's (the release list against a fresh build). A check that ran
// the served S11 itself would need to execute the page's bundle outside its page; no sha of one release is pinned here,
// since every later release changes app.js. The recorded planted bundles with a mark's line changed or gone each FAIL.
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
  "S11 a written account keeps its size": new RegExp(`\\.\\.\\.(${I})\\.length===(${I})\\.length\\?\\[\\]:\\[\`size\`\\]`),
  "S11 the providers agree on every byte, the lamports and the program": new RegExp(`(${I})\\.owner===(${I})\\.owner&&\\1\\.lamports===\\2\\.lamports&&${I}\\(\\1\\.data,\\2\\.data\\)`),
  "S11 a wSOL account left with any field but its amount changed is refused": new RegExp(`!${I}\\|\\|${I}\\.length\\?${I}\\.push\\(\`the wallet's wSOL account \\$\\{${I}\\.key\\} is left with its `),
  "S11 the account of the token left with any field but its amount changed is refused": new RegExp(`${I}\\.length&&${I}\\.push\\(\`the wallet's account of the token \\$\\{${I}\\.key\\} is left with its `),
  "S11 any other account of the wallet's held to its lamports too": new RegExp(`${I}\\.lamports!==${I}\\.lamports\\)&&${I}\\.push\\(\`the wallet's account \\$\\{${I}\\.key\\} moves: `),
  "S11 a close of the account of the token the providers disagreed on is refused": new RegExp(`${I}\\.push\\(\`the providers disagree on the wallet's account of the token \\$\\{${I}\\.key\\}, which the tx closes\``),
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
