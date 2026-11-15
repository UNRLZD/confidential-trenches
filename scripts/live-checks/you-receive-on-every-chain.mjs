#!/usr/bin/env node
// Live check of card you-receive-on-every-chain on SIGN_HOST (https://confidential.unrealized.trade): with an amount
// typed, the trade box shows what the user receives and the fee on every chain, from the signing page's own pool.buy.dry
// (read on the device before any signature, never the server's word).
// What it holds, signed out (a dry asked signed out answers not_funded, so the answer's code is read where it ships): the
// served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - sol: Solana's dry above one tap's spend prices the notes a move from Cash brings (src/pools.ts solanaMovedPieces,
//     noteIds `move#<i>`), and cashFirst moves the shortfall that dry sizes (src/cash-to-pool.ts: `short` asked on
//     Solana before the bare gap);
//   - evm: Base's and Robinhood's dry answers cost and out (src/pool-buy-evm.ts, main.ts evmDryWithCash);
//   - near: NEAR's dry is routed on the page (main.ts nearDry) and answers out from one Rhea quote of what the buy
//     swaps (src/near-buy.ts nearBuyDry), and the kit's params take chain near (the chain check pool.move's from and to
//     use, not the pool chains').
// What each does is held by the card's tests (packages/signpage/test/pool-buy-dry.test.ts, cash-to-pool.test.ts,
// near-buy-dry.test.ts, pool-buy-evm-dry-preview.test.ts) and the terminal's harness runs (apps/terminal/test/trade-pool,
// trade-reads-after-buy: You receive and Fee with $2 typed on Solana, Base, Robinhood and NEAR).
// The recorded answers are facts() over a built tree's index.html and app.js (good: this card's branch, built with
// packages/signpage/scripts/build-app.mjs --out) and over SIGN_HOST as served before the card (bad).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/you-receive-on-every-chain.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "you-receive-on-every-chain";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

// Solana: the move's notes the dry prices, and cashFirst's sized shortfall
// (card evm-cash-move-brings-its-fee: `short` asked on every pool chain, after the tap read, not on Solana alone)
const SOL = [/noteId:`move#\$\{[\w$]+\}`,own:(?:!0|true)/, /(?:`solana`|\.amount)&&([\w$]+)\.short\?await \1\.short\(/];
// NEAR: the dry's route and its out from the quote of what W swaps
const NEAR = [/\.chain===`near`\)return [\w$]+\([\w$]+\);if\(\([\w$]+\.chain===`base`/, /([\w$]+)\.amountOut>0n\?[\w$]+\(\1\.amountOut,[\w$]+\):void 0/];
// the kit's params for pool.buy.dry take the trade chains (pool.move's own check), so a NEAR dry is not refused
const nearParams = (js) => {
  const dry = /"pool\.buy\.dry":[\w$]+\(\{chain:([\w$]+),/.exec(js)?.[1];
  const trade = [...js.matchAll(/from:([\w$]+),to:\1,amount:/g)].map((m) => m[1]);
  return dry !== undefined && trade.includes(dry);
};
// Base and Robinhood: the dry's answer carries cost and out beside with_cash and buys (evmBuyDry's own answer, which
// the Solana and NEAR answers do not hold), cost from the tap plan's fees (evmDryCost)
const EVM = [
  /result:\{tap_max:[\w$.]+,[^;]{0,200}with_cash:[^;]{0,120}buys:[^;]{0,120}cost:[^;]{0,120}out:/,
  /\.whole\.reduce\(\(([\w$]+),([\w$]+)\)=>\1\+\2\.fee,0n\)\+/,
];

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), sol: SOL.every((r) => r.test(js)), evm: EVM.every((r) => r.test(js)), near: NEAR.every((r) => r.test(js)) && nearParams(js) };
}

/** The verdict on an answer { index, sha384, sol, evm, near }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.sol !== true) bad("Solana: a buy above one tap's spend gets no You receive or Fee (or its move from Cash is not sized to pay it)");
  if (a?.evm !== true) bad("Base and Robinhood: the dry answers no You receive or Fee");
  if (a?.near !== true) bad("NEAR: the dry is refused or answers no You receive");
  if (lines.length === 0) lines.push("ok  You receive and the Fee for any amount the box can buy, on Solana, Base, Robinhood and NEAR");
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
