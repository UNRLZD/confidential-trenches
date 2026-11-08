#!/usr/bin/env node
// Live check of card kit-sol-pool-deposit-floor (audit S-01) on SIGN_HOST (https://confidential.unrealized.trade). What
// it holds, and only that: the served /app.js is the one index.html pins (its sha384), and the kit's Solana pool deposit
// builder in it (packages/kit/src/trade/solana/pool-deposit.ts solanaPoolDepositIx), as minified, refuses a note under
// the release floor at the rent read, naming the floor (its refusal `the value ... is under the release floor of ...
// lamports at this rent`), and refuses a rent that is no Rent sysvar read. The builder is not deployed on its own: the
// signing page's pool deposit (packages/signpage/src/pool-deposit.ts) is where it runs. What the floor is (twice the
// larger of a relayer's cost on a release that opens a page and the kit's epoch fee, from the rent read; 3,647,120 at
// mainnet rent) is held by the kit's tests (packages/kit/test/pool-deposit.test.ts "S-01") and their mutants
// (packages/kit/test/pool-deposit-mutants.mjs).
// The recorded answers are facts() over packages/signpage/index.html and public/app.js as build-app.mjs wrote them in
// each tree (mainnet, as SIGN_HOST serves; this file reaches no package code: the import check holds it).
// After: sign
//   node scripts/live-checks/kit-sol-pool-deposit-floor.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "kit-sol-pool-deposit-floor";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The minified marks, as the bundle spells them: the floor's refusal with the value and the floor in it, and the
 *  rent's. */
const FLOOR = /the value \$\{[\w$]+\} is under the release floor of \$\{[\w$]+\} lamports at this rent: the note would cost more to release than it holds/;
const RENT = /[`"']the rent is not a Rent sysvar read[`"']/;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), floor: FLOOR.test(js), rent: RENT.test(js) };
}

/** The verdict on an answer { index, sha384, floor, rent }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.floor !== true) bad("the bundle's Solana pool deposit builds a note under the release floor: one that costs more to release than it holds");
  if (a?.rent !== true) bad("the bundle's Solana pool deposit takes no rent read: its floor cannot follow the rent");
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
