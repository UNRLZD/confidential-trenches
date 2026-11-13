#!/usr/bin/env node
// Live check of card buy-any-amount-on-every-chain on SIGN_HOST (https://confidential.unrealized.trade): Max is
// everything the user holds on the chain, and any amount up to it buys in one tap.
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified:
//   - evm_max: an EVM proof's tap spend is its chunk less its relay fee (packages/wallet/src/pool/balances.ts
//     evmTapSpendOf), summed across the chain's sets on Base and Robinhood (poolBalances' tapMax), so Max is every
//     ready note's spend, not the largest one;
//   - evm_rest: the plan's rest is bought by its note's own W through the pinned adapter (the rule's
//     buy(address,address,uint256,bytes) call, src/rules/pool.ts evmAdapterBuyData) and kept in W's rest record
//     (src/pool-buy-evm-rest.ts EVM_WBUY_KEY "owed/wbuy-evm"), so an amount that is not a whole note buys;
//   - sol_max: Solana's Max is every ready note's spend, one buy leg a set (src/pool-buy.ts, the page's legs).
// What each does is held by the card's tests (packages/signpage/test/pool-buy-evm.test.ts's legs and rest leg,
// rules-pool-evm-any-amount.test.ts, pool-carry-evm.test.ts's rest W, packages/wallet/test/pool-balances.test.ts)
// and its Base mainnet fork run (packages/signpage/scripts/pool-fork-evm-buy.mjs with an amount).
// The recorded answers are facts() over a built tree's index.html and app.js (good: this card's branch, built with
// packages/signpage/scripts/build-app.mjs --out) and over SIGN_HOST as served before the card (bad).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/buy-any-amount-on-every-chain.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "buy-any-amount-on-every-chain";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
// evmTapSpendOf: a piece's chunk less its fee cap, 0 when the fee is not under it
const EVM_SPEND = /([\w$]+)\.chunk>\1\.feeCap\?\1\.chunk-\1\.feeCap:0n/;
// poolBalances: the sets' spends summed on Base and Robinhood
const EVM_SUM = new RegExp(`${Q}base${Q}\\|\\|[\\w$]+\\.chain===?${Q}robinhood${Q}\\)?[^;]{0,40}\\.tapMax\\+=`);
// W's own buy of the rest and its record
const EVM_REST = [/buy\(address,address,uint256,bytes\)/, /owed\/wbuy-evm/];
// Solana: Max is the sum of the legs' spends (poolBalances on solanaTapLegs), and a tap no single set pays runs those
// legs (src/pool-buy.ts poolBuyKind: a split run answers its legs)
const SOL_MAX = [/[\w$]+\([\w$]+,[\w$]+\)\.reduce\(\(([\w$]+),([\w$]+)\)=>\1\+\2\.spend,0n\)/, new RegExp(`\\{split:(?:!0|true)\\}\\);if\\(${Q}legs${Q}in [\\w$]+\\)`)];

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), evm_max: EVM_SPEND.test(js) && EVM_SUM.test(js), evm_rest: EVM_REST.every((r) => r.test(js)), sol_max: SOL_MAX.every((r) => r.test(js)) };
}

/** The verdict on an answer { index, sha384, evm_max, evm_rest, sol_max }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.evm_max !== true) bad("Base and Robinhood Max is one note, not every note held: a buy past it is refused");
  if (a?.evm_rest !== true) bad("an EVM amount that is not a whole note is refused: no W buys the rest");
  if (a?.sol_max !== true) bad("Solana's Max is one set, not every note held");
  if (lines.length === 0) lines.push("ok  Max is everything held on Solana, Base and Robinhood, and any amount up to it buys in one tap");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  return facts(index, await get("/app.js"));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${arg("--answer") ? `answer ${arg("--answer")}` : SIGN})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
