#!/usr/bin/env node
// Live check of card cash-withdraws-everything-to-any-chain on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and it carries the Cash withdraw
// that sends every note, to NEAR or another chain (packages/signpage/src/withdraw/form.ts, ./checks.ts, ./handoff.ts,
// ./onward.ts):
//   - the run's steps, one line per withdrawal, drawn as the list whose data-steps is `cash-withdraw` (STEPS);
//   - the send to another chain, whose quote check's refusal is written out here as ONWARD (onward.ts checkOnwardQuote:
//     each part's own 1Click quote, checked before the vault pays its NEAR deposit address).
// What the form and the run do with them (Max is every note less a fee each, the plan spends every note, one withdrawal
// per note in order at the fee the form drew, each part's quote the device's own with its refund under V, the run stops
// at the first that does not leave the vault) is held by packages/signpage/test/cash-withdraw-whole.test.ts,
// cash-withdraw-onward.test.ts, withdraw-form.test.ts and withdraw-handoff.test.ts.
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
/** The send to another chain: its quote check's refusal, as written in onward.ts. */
export const ONWARD = "onward quote: its deposit address is not a NEAR implicit id";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** What the check keeps of the reads: the index, the served bundle's sha384, and the facts read from the bundle. */
export function facts(index, js) {
  return { index, sha384: sha384(js), steps: STEPS.test(js), onward: js.includes(ONWARD) };
}

/** The verdict on an answer { index, sha384, steps, onward }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.steps !== true) bad("the bundle draws no Cash withdraw steps: Withdraw sends one note, not the whole of Cash");
  if (a?.onward !== true) bad("the bundle has no checked send to another chain: Cash goes out to NEAR only");
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
