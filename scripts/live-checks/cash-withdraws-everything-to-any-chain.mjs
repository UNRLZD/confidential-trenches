#!/usr/bin/env node
// Live check of card cash-withdraws-everything-to-any-chain on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and it carries the Cash withdraw
// that sends every note (packages/signpage/src/withdraw/form.ts, ./checks.ts, ./handoff.ts): the run's steps, one line
// per withdrawal, drawn as the list whose data-steps is `cash-withdraw` (STEPS).
// What the form and the run do with them (Max is every note less a fee each, the plan spends every note, one withdrawal
// per note in order at the fee the form drew so a note planned whole leaves no change, NEAR alone for now, the run stops
// at the first that does not leave the vault) is held by packages/signpage/test/cash-withdraw-whole.test.ts,
// withdraw-form.test.ts and withdraw-handoff.test.ts. Solana and Base come back, with their own fact here, with the
// carry of a refunded part (card onward-refund-comes-back).
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs builds (mainnet, as SIGN_HOST serves)
// and SIGN_HOST's own answer.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/cash-withdraws-everything-to-any-chain.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "cash-withdraws-everything-to-any-chain";
export const SIGN = "https://confidential.unrealized.trade";
/** The steps list's mark, as the bundler keeps a dataset write. */
export const STEPS = /dataset\.steps\s*=\s*[`"']cash-withdraw[`"']/;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** What the check keeps of the reads: the index, the served bundle's sha384, and the facts read from the bundle. */
export function facts(index, js) {
  return { index, sha384: sha384(js), steps: STEPS.test(js) };
}

/** The verdict on an answer { index, sha384, steps }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.steps !== true) bad("the bundle draws no Cash withdraw steps: Withdraw sends one note, not the whole of Cash");
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${SIGN}${path}: HTTP ${r.status}`);
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
