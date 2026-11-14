#!/usr/bin/env node
// Live check of card pool-withdraws-to-any-chain on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified:
//   - picker: the pool withdraw form draws a Chain picker (src/withdraw/pool-form.ts, a select with data-input "dest");
//   - request: the exit's 1Click request is the device's own (packages/kit/src/checks/oneclick-exit.ts
//     oneClickExitRequest): the payout as its amount, the typed recipient on the destination chain, the refund
//     ORIGIN_CHAIN to the wallet the run hands it;
//   - runs: both withdraw runs (src/pool-withdraw.ts, src/pool-withdraw-evm.ts) ask the exit with their first W and pay
//     the address it answers, checked as any To before any note moves.
// What each does is held by the card's tests (packages/signpage/test/pool-exit-quote.test.ts, pool-exit.test.ts,
// pool-withdraw-exit.test.ts, pool-withdraw-form.test.ts); a payout that lands on another chain is the owner's run.
// The recorded answers are facts() over each tree's packages/signpage/index.html and public/app.js.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/pool-withdraws-to-any-chain.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-withdraws-to-any-chain";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
const PICKER = new RegExp(`${ID}\\.dataset\\.input=\`dest\``);
const REQUEST = new RegExp(`amount:(${ID})\\.payout\\.toString\\(\\),refundTo:\\1\\.refundTo,refundType:\`ORIGIN_CHAIN\`,recipient:\\1\\.recipient,recipientType:\`DESTINATION_CHAIN\``);
// each run: exit asked with its first W, the answer its To, then the To refusal over that To
const RUN = new RegExp(`(${ID})\\.exit&&\\((${ID})=await \\1\\.exit\\((${ID})\\[0\\](?:\\.w)?\\)\\),${ID}\\(\\2,\\1\\.pin,`, "g");

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), picker: PICKER.test(js), request: REQUEST.test(js), runs: (js.match(RUN) ?? []).length };
}

/** The verdict on an answer { index, sha384, picker, request, runs }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.picker !== true) bad("the pool withdraw form takes no chain: a pool pays only to its own chain");
  if (a?.request !== true) bad("no exit request of the device's own: the payout, the typed recipient and the refund on the pool's chain");
  if (a?.runs !== 2) bad(`${a?.runs ?? 0} of the 2 withdraw runs pay a checked quote's deposit address`);
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
