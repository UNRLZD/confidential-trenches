#!/usr/bin/env node
// Live check of card solana-legs-checked on SIGN_HOST (https://sign.confidential.unrealized.trade). The signing page
// bundles the kit's Solana checks, so the device that signs a Jupiter build runs the ones SIGN_HOST serves. What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and it carries the card's refusals
// as live code, each read by a mark of the bundle's own shape (the minifier renames, never restructures these lines;
// packages/kit/src/checks/solana/checks.ts):
//   - S6's walk over the legs: a loop over every account the route instruction names (no slice: a walk that starts
//     past any of them, or none, has no such loop), whose refusal of a token account of the wallet's is reached (a
//     dead `0&&` before it breaks the mark) and whose refusal of a leg the device has not read is there; each mark holds
//     "leg account ", which only S6 writes (card solana-written-accounts-whole: "is not read`" alone also came from
//     S11's "which the tx writes, is not read", so a page with no legs check passed);
//   - S11's on the wallet's other token accounts the tx writes: one the simulation moves ("moves: ") or does not read
//     back ("is not read back").
// That each refusal refuses is the kit's tests' (test/solana-shared-route.test.ts, test/solana-quote.test.ts); this
// check holds that the page serving the signer is a build that has them. The recorded planted bundles A (the walk
// starts past every account), B (its wallet-account refusal dead) and C (the walk removed) each FAIL.
//   node scripts/live-checks/solana-legs-checked.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "solana-legs-checked";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
/** Each refusal's mark in the bundle, by what refuses. */
export const MARKS = Object.freeze({
  "S6 the walk over every account the route names": new RegExp(`for\\(let (${I}) of (${I})\\.ixs\\[\\2\\.jupAt\\]\\.accounts\\)\\{if\\(!\\1\\.writable\\|\\|`),
  "S6 a leg that is the wallet's token account": new RegExp(`(${I})\\?\\1\\.some\\((${I})=>${I}\\(\\2,${I}\\.req\\.wallet\\)\\)&&${I}\\.push\\(\`leg account \\$\\{${I}\\.key\\} is a token account of the wallet's\``),
  "S6 a leg the device has not read": new RegExp(`:${I}\\.push\\(\`leg account \\$\\{${I}\\.key\\} is not read\`\\)`),
  "S11 the wallet's account moved": /moves: /,
  "S11 the wallet's account not read back": /is not read back/,
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
  for (const k of Object.keys(MARKS)) if (a?.carries?.[k] !== true) bad(`the served bundle has no refusal: ${k}`);
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
