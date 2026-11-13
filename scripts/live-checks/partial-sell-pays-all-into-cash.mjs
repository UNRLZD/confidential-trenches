#!/usr/bin/env node
// Live check of card partial-sell-pays-all-into-cash on SIGN_HOST (https://confidential.unrealized.trade). After any
// Solana pool sell, everything the sale paid is in Cash: a partial sell's deposit back is signed before the sale lands
// (min out less the reserve), so right after the fill W's keep sweep deposits all W holds above its keep (the next
// sell's need) as W's next note, and the sell box's You receive counts both notes.
// What it proves, and only that: the served /app.js is the one index.html pins (its sha384), and its text carries the
// card's rules, each found by a mark of the bundle's shape (the minifier renames, never restructures them):
//   - a sell that filled runs, after its answer, the keep sweep when W still holds tokens and the rent back when it
//     holds none, on both of the sale's verdict paths (its note's mark, and a sale with no deposit back);
//   - the keep sweep: W's lamports less the sweep's fee, the deposit's rents and W's keep, on the grid, none under the
//     sweep's floor, checked by the keep sweep's rule with the keep as its hold;
//   - the keep sweep's rule (its own, so the full sell's sweep rule is as before): the deposit alone, W left at the hold
//     and under one grid step more, the note on the grid and at least 0.005 SOL;
//   - the preview: one W's partial sale pays in both notes, at the expected out and at min out.
// It does not prove those lines run: that is the tests at the released commit (packages/signpage/test/pool-sell.test.ts
// "card partial-sell-pays-all-into-cash", packages/signpage/test/pool-sell-dry.test.ts). Base and Robinhood need no
// change: their SellDelegate deposits all the sale gained less the fee (contracts/pool-evm/src/SellDelegate.sol sell).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/partial-sell-pays-all-into-cash.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "partial-sell-pays-all-into-cash";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
const R = String.raw;
const BT = "`";
/** A mark whose named groups name other code the bundle must hold too: `more(groups)` gives each further pattern. */
const tied = (main, more) => ({
  test(js) {
    const g = main.exec(js)?.groups;
    return Boolean(g) && more(g).every((p) => new RegExp(p).test(js));
  },
});
/** A mark found at least `n` times. */
const times = (re, n) => ({ test: (js) => [...js.matchAll(new RegExp(re, "g"))].length >= n });

/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "a filled sell runs the keep sweep while W holds tokens, the rent back when it holds none, on both verdict paths": times(
    R`filled${BT}&&\((${I})\.back=(${I})\?(${I}):(${I})\)`,
    2,
  ),
  "the keep sweep: W's lamports less the sweep's fee, the deposit's rents and W's keep, on the grid, none under the floor, checked with the keep as its rule's hold": tied(
    new RegExp(R`let (?<rest>${I})=(?<lam>${I})-(?<fee>${I})-(?<rents>${I})\((?<rent>${I}),(?<sz>${I}),(?<dep>${I})\.held\)-(?<x>${I})\.keep,(?<v>${I})=(?<note>${I})\(\k<rest>\),(?<fl>${I})=[^;]{0,60};if\(\k<v><\k<fl>\)return ${I}\(${BT}floor${BT}`),
    (g) => [R`${I}\(${I},\{[^;]{0,200}?\},${esc(g.lam)},${esc(g.rent)},${esc(g.dep)}\.held,${esc(g.x)}\.keep\)`],
  ),
  "the keep sweep's rule: the deposit alone, W left at the hold and under one grid step more, the note on the grid and at least 0.005 SOL": new RegExp(
    R`if\((${I})\.ixs\.length!==1\)return ${I}\(${BT}instructions${BT}\);let (${I})=${I}\(\1\.ixs\[0\],[^;]*;if\([^;]*\|\|typeof (${I})!=${BT}bigint${BT}\|\|\3<=0n\)return ${I}\(${BT}sweep_reads${BT}\);let (${I})=${I}-\2-${I}-${I}\([^)]*\);return \4<\3\|\|\4>=\3\+1000000n\?${I}\(${BT}keep_amount${BT}\):\2%1000000n!=0n\|\|\2<5000000n\|\|`,
  ),
  "the preview: one W's partial sale pays in both notes, at the expected out and at min out": new RegExp(
    R`return\{out:(${I})\+(${I})\((${I})\),minOut:\1\+\2\((${I})\),priority:${I},network:[^}]*?\2\(\3\)>0n\?`,
  ),
});

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle carries. */
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
  for (const k of Object.keys(MARKS)) if (a?.carries?.[k] !== true) bad(`the served bundle has no ${k}`);
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
