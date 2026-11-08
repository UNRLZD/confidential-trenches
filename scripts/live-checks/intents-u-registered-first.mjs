#!/usr/bin/env node
// Live check of card intents-u-registered-first on SIGN_HOST (https://confidential.unrealized.trade). A deposit id U
// whose whole life is inside intents.near leaves no lasting public trace (intents.near deletes a zero balance and may
// prune a V1 nonce), so restore could read a used U as unused. The card makes U's registration on the USDC token that
// trace, and the signing page is the gate: it signs no intent of U's until storage_balance_of(U) on USDC reads
// registered on both of its RPCs, so a broken-in helper that skips the registration gets no signature. What this check
// proves, and only that: the served /app.js is the one index.html pins (its sha384), and its text carries the gate,
// each part found by a mark of the bundle's shape (the minifier renames, never restructures it):
//   - the id-intent rule refuses an intent of a U (every kind: the refund move, the pool refund carry, a withdraw by
//     transfer or ft_withdraw) unless both RPCs' reads say registered (packages/signpage/src/rules/refund.ts);
//   - the follow's one read at one block on both RPCs (wallet readMoveAt) reads storage_balance_of(U) on the token
//     beside intents.near's balance, salt and nonce, null or a NEP-145 balance and nothing else, kept per RPC;
//   - the refund move asks no quote and opens no key while either read says unregistered (wallet runRefundMove);
//   - the pool refund carry's read names the mainnet USDC token (main.ts).
// The helper's half (POST /v1/intents and the status hook register U before its first intent) sends a storage_deposit
// only for a real signed intent or a real 1Click refund, so no read on the deployed helper shows it without money:
// its proof is apps/helper/src/intents/carry.test.ts at the released commit, and the mainnet run's record
// (scripts/live-checks/intents-u-registered-first.md, read back by the money gate) once the owner runs it.
// It does not prove those lines run: that is the signing page's tests at the released commit (test/rules-refund.test.ts,
// test/refund-move.test.ts) and the wallet's (test/deposit-refund.test.ts, test/deposit-follow.test.ts), and that the
// served files are that commit's build is signpage-release's.
// After: sign
//   node scripts/live-checks/intents-u-registered-first.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "intents-u-registered-first";
export const SIGN = "https://confidential.unrealized.trade";
/** NEAR mainnet's USDC (the vault's token; packages/kit/src/near/networks.ts). */
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
/** Each part of the gate's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "the id-intent rule refuses a U's intent unless both RPCs read it registered": new RegExp(
    `if\\((${I})\\.role===\`U\`&&\\((${I})\\[0\\]\\.registered!==!0\\|\\|\\2\\[1\\]\\.registered!==!0\\)\\)return ${I}\\(\`unregistered\`\\)`,
  ),
  "the follow's one read takes storage_balance_of(U) on the token at the same block, null or a balance, per RPC": new RegExp(
    `(${I})\\((${I}),(${I}),\`current_salt\`,\\{\\},(${I})\\),(${I})===null\\?Promise\\.resolve\\(null\\):\\1\\(\\2,\\3,\`is_nonce_used\`,\\{account_id:(${I}),nonce:\\5\\},\\4\\),\\1\\(\\2,(?!\\3,)${I},\`storage_balance_of\`,\\{account_id:\\6\\},\\4\\)\\]\\);[^;]*?return null;let (${I})=${I};return \\7!==null&&\\(typeof \\7!=\`object\`\\|\\|Array\\.isArray\\(\\7\\)\\|\\|typeof \\7\\.total!=\`string\`\\|\\|!${I}\\.test\\(\\7\\.total\\)\\)\\?null:\\{[^{}]*registered:\\7!==null\\}`,
  ),
  "the read keeps each RPC's registration as it answered": new RegExp(
    `\\{blockTimeNs:(${I})\\.timeNs,held:\\1\\.held,registered:\\1\\.registered\\},\\{blockTimeNs:(${I})\\.timeNs,held:\\2\\.held,registered:\\2\\.registered\\}\\]`,
  ),
  "the refund move asks no quote while either read says unregistered": new RegExp(
    `\\[(${I}),(${I})\\]=${I}\\.reads;if\\(\\1\\.held!==\\2\\.held\\|\\|\\1\\.held<=0n\\)return\\{kind:\`refused\`,why:\`held\`\\};if\\(\\1\\.registered!==!0\\|\\|\\2\\.registered!==!0\\)return\\{kind:\`refused\`,why:\`unregistered\`\\}`,
  ),
  "the pool refund carry reads the registration on mainnet's USDC": new RegExp(
    `read:\\((${I}),(${I})\\)=>${I}\\(\`intents\\.near\`,\\1\\.refund_id,\\2,\\1\\.origin,${I}\\(\\),(${I})\\.mainnet\\.usdc\\)`,
  ),
});

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), carries: Object.fromEntries(Object.entries(MARKS).map(([k, w]) => [k, w.test(js)])), usdc: js.includes(USDC) };
}

/** The verdict on an answer { index, sha384, carries, usdc }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(MARKS)) if (a?.carries?.[k] !== true) bad(`the served bundle has no ${k}`);
  if (a?.usdc !== true) bad("the served bundle does not name mainnet's USDC");
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
