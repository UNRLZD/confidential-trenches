#!/usr/bin/env node
// Live check of card sol-buy-rent-back on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and its pool sell (packages/signpage/src/
// pool-sell.ts rentBack), as minified, gives the rent a Solana pool buy locked in W back after a full sell:
//   - the teardown frames' rule (rules/pool.ts checkSolanaTeardownFrames, its refusal `teardown`), which only the pool
//     sell's rent back reaches, with the kit's volume close (close_user_volume_accumulator's discriminator,
//     249,69,164,218,150,103,84,138) that buildSolanaTeardown makes;
//   - the sweep's rule (rules/pool.ts checkSolanaSweep, its refusal `sweep_amount`): every lamport W holds back into the
//     pool as W's next return note, W at 0;
//   - the deposit's rents as the program takes them (rules/pool.ts solanaDepositRents, its refusal `deposit_reads`);
//   - the rent back owed, run again at the next load (pool-sell.ts owedRentBacks, its record meta/owed/rentback-sol).
// What each does on chain is held by its tests in packages/signpage/test/pool-sell.test.ts (the accounts closed, W at 0,
// a partial sell closing nothing) and by the card's devnet run (sol-buy-rent-back.md).
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of each tree (mainnet, as
// SIGN_HOST serves; this file reaches no package code: the import check holds it).
//   node scripts/live-checks/sol-buy-rent-back.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-buy-rent-back";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The minified marks of each piece, as the bundle spells them. */
const TEARDOWN = /[`"']teardown[`"']/;
const VOLUME_CLOSE = /\[249,69,164,218,150,103,84,138\]/;
const SWEEP = /[`"']sweep_amount[`"']/;
const RENTS = /[`"']deposit_reads[`"']/;
const OWED = /[`"']owed\/rentback-sol[`"']/;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), teardown: TEARDOWN.test(js), volumeClose: VOLUME_CLOSE.test(js), sweep: SWEEP.test(js), rents: RENTS.test(js), owed: OWED.test(js) };
}

/** The verdict on an answer { index, sha384, teardown, volumeClose, sweep, rents, owed }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.teardown !== true || a?.volumeClose !== true) bad("the bundle's pool sell runs no teardown: W's token and volume accounts keep their rent after a full sell");
  if (a?.sweep !== true) bad("the bundle's pool sell sweeps nothing: what W holds after a full sell stays out of the pool");
  if (a?.rents !== true) bad("the bundle prices a deposit's rents by its own formula, not as the program takes them: a sweep can leave W short or holding some");
  if (a?.owed !== true) bad("the bundle owes no rent back: one a closed page or a provider's fault stops never runs again");
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
