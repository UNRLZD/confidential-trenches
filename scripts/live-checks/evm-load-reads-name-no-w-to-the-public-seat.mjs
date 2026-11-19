#!/usr/bin/env node
// Live check of card evm-load-reads-name-no-w-to-the-public-seat on SIGN_HOST (https://confidential.unrealized.trade). A
// page load with a refused buy's ETH on an EVM W (Base, Robinhood) ran the carry pass at its state reads with no tap,
// and each pass named its W to the pool's two RPCs, both public providers (pool-testnet.ts MAINNET_POOL_RPCS): its
// nonce, balance, estimate and deposit, so one load's passes showed one provider several of the user's Ws together.
// The signing page (src/pool-testnet.ts evmRead and evmCarry, src/pool-carry-evm.ts idleReads) now runs that pass idle
// until the page's first tap's drawn time (the rent backs' backsSchedule.acted): each refused buy's W read on the
// helper's route alone (/v1/rpc/{chain}, eth_getBalance, as positions read every W) and shown RETURNING at its chain's
// price (src/positions.ts evmReturningWallets), nothing signed or sent; past it a pass reads its one W on both RPCs
// before W signs, and a refusal in the page's own buy still carries at once. What it proves, and only that: the served
// /app.js is the one index.html pins (its sha384), and its text carries these rules, each found by a mark of the
// bundle's shape (the minifier renames, never restructures them):
//   - a state read's carry pass is idle until the page's first tap's drawn time, the flag handed to the pass;
//   - an idle pass returns at the owed Ws, before any W is drawn, and reads each W's balance on the helper's route;
//   - the page shows each idle read RETURNING, at its chain's price.
// The testnet build's moves (its finder reads on the helper's devnet route) are folded out of SIGN_HOST's bundle, so
// no mark reads them: test/pool-testnet.test.ts holds them. It does not prove those lines run: that is the signing
// page's tests at the released commit (test/pool-testnet-evm-queue.test.ts "evm-load-reads-name-no-w-to-the-public-
// seat", every pool RPC call naming W counted), and that the served files are that commit's build is signpage-release's.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-load-reads-name-no-w-to-the-public-seat.mjs [--record <file>] [--answer <file> | --build <packages/signpage>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-load-reads-name-no-w-to-the-public-seat";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
const R = String.raw;
/** A mark whose named groups name other code the bundle must hold too: `more(groups)` gives each further pattern. */
const tied = (main, more) => ({
  test(js) {
    const g = main.exec(js)?.groups;
    return Boolean(g) && more(g).every((p) => new RegExp(p).test(js));
  },
});

/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "a state read's carry pass is idle until the page's first tap's drawn time, the flag handed to the pass": tied(
    new RegExp(R`for\(let (${I}) of (${I})\)(?<c>${I})\(\1,!(${I})\.acted\(\)\);`),
    (g) => [R`(?:^|[,;\s])${esc(g.c)}=\((${I}),(${I})=!1\)=>\{[^]{0,1500}?\.\.\.\2\?\{idle:(${I})\}:\{\}\}\)`],
  ),
  "an idle pass returns at the owed Ws, before any W is drawn, and reads each W's balance on the helper's route": tied(
    new RegExp(R`if\((?<h>${I})\.idle!==void 0\)return await (?<f>${I})\(\k<h>,\k<h>\.idle,(${I})\);let (${I})=(${I})\(\3,\k<h>\.random\)\[0\]`),
    (g) => [R`async function ${esc(g.f)}\((${I}),(${I}),(${I})\)\{[^]{0,200}?await \2\(` + "`eth_getBalance`" + R`,\[(${I})\.w,` + "`latest`" + R`\],\1\.signal\)`],
  ),
  "the page shows each idle read RETURNING, at its chain's price": tied(
    new RegExp(R`function (?<f>${I})\((${I}),(${I})\)\{let (${I})=\[\];for\(let (${I}) of \2\)\{let (${I})=\3\(\5\.chain\);if\(\6===null\|\|\5\.wei<=0n\)continue;[^]{0,80}?\.push\(\{chain:\5\.chain,address:\5\.address,role:` + "`fresh`" + R`,size:(${I}),state:` + "`RETURNING`" + R`\}\)\}return \4\}`),
    (g) => [R`${esc(g.f)}\((${I})\.evmReturning\(\),(${I})=>(${I})\.get\(\2\)\)`, R`evmReturning:\(\)=>\[\.\.\.(${I})\.values\(\)\]`],
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
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : arg("--build") ? facts(readFileSync(`${arg("--build")}/index.html`, "utf8"), readFileSync(`${arg("--build")}/public/app.js`, "utf8")) : await read();
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
