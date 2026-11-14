#!/usr/bin/env node
// Live check of card withdraw-in-app-to-any-chain on APP_HOST (https://ct-app.unrealized.trade): one withdraw form, in
// the app, that sends to any chain. Reads only: nothing is signed or sent. What it holds, and only that, each found by a
// mark of the minified bundle's shape in the scripts APP_HOST's page names:
//   - poolRow: Portfolio's pool row opens the app's own Withdraw on that pool (apps/terminal/src/routes/portfolio-taps.ts
//     tapOf: pool-withdraw is { to: "withdraw", from: chain }), and the app holds no tap that opens SIGN_HOST's own pool
//     form with the chain only (the earlier { to: "pool.withdraw", params: { chain } }: the owner met that form's
//     unlabelled chain picker on the live app, 14 Nov 17:40Z);
//   - hopDest: the Withdraw tap's pool.withdraw carries the arrival chain as `dest` when it is not the pool's own
//     (src/screens/withdraw/withdraw-form.ts withdrawHop);
//   - addressOnArrival: the address is checked on the arrival chain, one the place can reach (checkWithdraw over
//     arrivals: a pool's every chain, Cash's NEAR or the kit's list of Cash's chains), never on the place's own chain.
// What the form draws and sends at 390 and 1440 is apps/terminal/test/withdraw-form/run.mjs; SIGN_HOST's Confirm for
// that message is test/e2e/signing-sheet/run.mjs (poolwithdrawdest); the shapes are test/withdraw-form.test.ts.
// The recorded answers are facts() over `pnpm --filter terminal build` builds.
// After: app
// Bundle: read app
//   node scripts/live-checks/withdraw-in-app-to-any-chain.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "withdraw-in-app-to-any-chain";
export const APP = "https://ct-app.unrealized.trade";
const N = "[\\w$]+";

// tapOf's pool row: the app's own Withdraw on that pool
const ROW_IN_APP = new RegExp(`kind===\`pool-withdraw\`\\)return ${N}\\.includes\\((${N})\\.chain\\)\\?\\{to:\`withdraw\`,from:\\1\\.chain\\}`);
// the earlier pool row: SIGN_HOST's own pool form with the chain only
const ROW_BARE = /\{to:`pool\.withdraw`,params:\{chain:/;
// withdrawHop's pool request: dest when the arrival chain is not the pool's own (either order of the ternary)
const HOP_DEST = new RegExp(`\\{kind:\`pool\\.withdraw\`,params:\\{chain:(${N})\\.chain,\\.\\.\\.${N},\\.\\.\\.(?:(${N})===\\1\\.chain\\?\\{\\}:\\{dest:\\2\\}|(${N})!==\\1\\.chain\\?\\{dest:\\3\\}:\\{\\})\\}\\}`);
// arrivals(place): a pool's every chain, Cash's NEAR, or the kit's CASH_WITHDRAW_DESTS by name since card
// cash-withdraw-in-app-to-any-chain (whose own check reads that list); checkWithdraw's address: arrivals(place).includes(dest)
// && fits on dest
const ARRIVALS = new RegExp(`function (${N})\\((${N})\\)\\{return \\2\\.kind===\`pool\\.withdraw\`\\?${N}:(?:\\[\`near\`\\]|${N})\\}`);

/** What the check keeps of APP_HOST's page scripts: how many, and the marks read from them. */
export function facts(scripts) {
  const js = scripts.join("\n");
  const arr = ARRIVALS.exec(js);
  const esc = (s) => s.replace(/[$]/g, "\\$");
  return {
    scripts: scripts.length,
    poolRow: ROW_IN_APP.test(js),
    poolRowBare: ROW_BARE.test(js),
    hopDest: HOP_DEST.test(js),
    addressOnArrival: arr !== null && new RegExp(`${esc(arr[1])}\\(${N}\\)\\.includes\\((${N})\\)&&${N}\\(\\1,${N}\\)\\?\`ok\`:\`bad\``).test(js),
  };
}

export const SAYS = Object.freeze({
  scripts: "APP_HOST's page names no script",
  poolRow: "Portfolio's pool row does not open the app's own Withdraw on its pool",
  poolRowBare: "the app still opens SIGN_HOST's own pool withdraw form with the chain only: a second withdraw form",
  hopDest: "the Withdraw tap's pool.withdraw carries no dest: the app's form withdraws only to the pool's own chain",
  addressOnArrival: "the app's form does not check the address on the chain the money arrives on",
});

/** The verdict on an answer { scripts, poolRow, poolRowBare, hopDest, addressOnArrival }. */
export function judge(a) {
  const lines = [];
  if (!(a?.scripts > 0)) lines.push(`BAD ${SAYS.scripts}`);
  for (const k of ["poolRow", "hopDest", "addressOnArrival"]) if (a?.[k] !== true) lines.push(`BAD ${SAYS[k]}`);
  if (a?.poolRowBare !== false) lines.push(`BAD ${SAYS.poolRowBare}`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${APP}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${APP}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const page = await get("/");
  const srcs = [...page.matchAll(/<script\b[^>]*\bsrc="(\/[^"]+)"/gi)].map((m) => m[1]);
  if (srcs.length === 0) throw new Error("APP_HOST's page names no script");
  const scripts = [];
  for (const src of srcs) scripts.push(await get(src));
  return facts(scripts);
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
