#!/usr/bin/env node
// Live check of card cash-withdraw-in-app-to-any-chain: the app's Withdraw sends Cash on to the chain picked in the app,
// as it does a pool's, and SIGN_HOST sends Cash only to a chain it reaches. Reads only: nothing is signed or sent. It
// reads what each host serves (the page, then every script the page names) and checks the bundles hold, each found by a
// mark of the minified bundle's shape:
//   - APP_HOST: the Withdraw tap's withdraw.open carries the arrival chain as `dest` when it is not NEAR
//     (apps/terminal/src/screens/withdraw/withdraw-form.ts withdrawHop: cashHopDest), and Cash's arrival chains are the
//     kit's CASH_WITHDRAW_DESTS, not a list of the app's own (arrivals: cashChains, the list read from the bundle);
//   - SIGN_HOST: withdraw.open's given keeps its `dest` (packages/signpage/src/main.ts givenOf: givenDest), the Cash form
//     takes it when it is a chain the form sends to (src/withdraw/form.ts: destTaken) and refuses any other on its own
//     line, never sending on NEAR in its place (destRefused), and the chains the form sends Cash to are read from the
//     bundle (cashChains: WITHDRAW_CHAINS, the kit's list); the served /app.js is the one index.html pins.
// Each host's cashChains is NEAR first and only chains Cash can reach through 1Click (NEAR, Solana, Base: no USDC on
// Robinhood); with both hosts read, the two lists are equal, so the app offers exactly what the page sends.
// What the form and the page draw and send is held by apps/terminal/test/withdraw-form.test.ts,
// packages/signpage/test/withdraw-form.test.ts (given dest), packages/kit/test/withdraw-given.test.ts and the two-host
// run apps/terminal/test/e2e/signing-sheet/run.mjs (cashwithdrawdest).
// Each host's deploy runs its own half, so a host that lags does not fail the other's deploy.
// The recorded answers are read() over `pnpm --filter terminal build` and packages/signpage/scripts/build-app.mjs builds.
// After: app --host app
// After: sign --host sign
// Bundle: read sign
// Bundle: read app
//   node scripts/live-checks/cash-withdraw-in-app-to-any-chain.mjs [--host app|sign] [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2 (no --host: both).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "cash-withdraw-in-app-to-any-chain";
export const APP = "https://ct-app.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
const N = "[\\w$]+";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
/** The chains Cash can arrive on at all: 1Click's USDC on NEAR, Solana and Base (none on Robinhood). */
export const CASH_REACHABLE = Object.freeze(["near", "solana", "base"]);

// withdrawHop's Cash request: dest when the arrival chain is not NEAR (either order of the ternary)
const APP_HOP = new RegExp(`\\{kind:\`withdraw\\.open\`,params:\\{\\.\\.\\.${N},\\.\\.\\.(?:(${N})===\`near\`\\?\\{\\}:\\{dest:\\1\\}|(${N})!==\`near\`\\?\\{dest:\\2\\}:\\{\\})\\}\\}`);
// arrivals(place): a pool's every chain, Cash's a list held by name (the kit's), not the literal
const APP_ARRIVALS = new RegExp(`function ${N}\\((${N})\\)\\{return \\1\\.kind===\`pool\\.withdraw\`\\?${N}:(${N})\\}`);
// givenOf: the dest kept beside to and max
const SIGN_GIVEN = new RegExp(`\`near\`\\?\\{dest:(${N})\\}:\\{\\};return (${N})\\.max===!0\\?Object\\.freeze\\(\\{to:\\2\\.to,max:!0,\\.\\.\\.(${N})\\}\\)`);
// the Cash form's reach and its given dest: reach = mainnet ? (deps.chains ?? LIST) : [near]; chain = given && reached ? dest : near
const SIGN_REACH = new RegExp(`(${N})=${N}\\.network===\`mainnet\`\\?${N}\\.chains\\?\\?(${N}):\\[\`near\`\\],(${N})=(${N})\\?\\.dest\\?\\?\`near\`,(${N})=\\1\\.includes\\(\\3\\),${N}=\\4&&\\5\\?\\3:\`near\``);
// the Cash form's refusal of a dest it does not reach: its own line, NEAR's name or the pool chain's
const SIGN_REFUSED = new RegExp(`dataset\\.refusal=\`not-available\`,${N}\\(${N},\`not-available\`,${N}\\),${N}\\.textContent=\`\\$\\{${N}===\`near\`\\?\`NEAR\`:`);

/** The list a frozen constant named `name` holds in `js` (through up to 3 names it is set to, as WITHDRAW_CHAINS is to
 *  the kit's list), or null. */
export function listOf(js, name, hops = 3) {
  const at = `(?:^|[,;\\s{(])${name.replace(/\$/g, "\\$")}=`;
  const m = new RegExp(`${at}Object\\.freeze\\(\\[((?:\`[a-z]+\`,?)*)\\]\\)`).exec(js);
  if (m) return [...m[1].matchAll(/`([a-z]+)`/g)].map((x) => x[1]);
  const alias = new RegExp(`${at}(${N})[,;]`).exec(js);
  return alias && hops > 0 ? listOf(js, alias[1], hops - 1) : null;
}

/** What the check keeps of APP_HOST's page scripts. */
export function appFacts(scripts) {
  const js = scripts.join("\n");
  const arr = APP_ARRIVALS.exec(js);
  return { scripts: scripts.length, cashHopDest: APP_HOP.test(js), cashChains: arr ? listOf(js, arr[2]) : null };
}

/** What the check keeps of SIGN_HOST's index and /app.js. */
export function signFacts(index, js) {
  const reach = SIGN_REACH.exec(js);
  return {
    pinned: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] === sha384(js),
    givenDest: SIGN_GIVEN.test(js),
    destTaken: reach !== null,
    destRefused: SIGN_REFUSED.test(js),
    cashChains: reach ? listOf(js, reach[2]) : null,
  };
}

export const SAYS = Object.freeze({
  scripts: "APP_HOST's page names no script",
  cashHopDest: "the app's Withdraw sends Cash with no dest: Cash goes to NEAR whatever chain is picked",
  appChains: "the app's Cash arrival chains are not the kit's list (NEAR first, chains Cash reaches)",
  pinned: "SIGN_HOST's served /app.js is not the one index.html pins",
  givenDest: "SIGN_HOST drops withdraw.open's dest: the app's chain never reaches the Cash form",
  destTaken: "SIGN_HOST's Cash form does not send on the given dest",
  destRefused: "SIGN_HOST's Cash form does not refuse a dest it does not reach on its own line",
  signChains: "SIGN_HOST's Cash chains are not NEAR first and chains Cash reaches",
  agree: "the app offers Cash other chains than SIGN_HOST sends it to",
});

const fine = (l) => Array.isArray(l) && l[0] === "near" && new Set(l).size === l.length && l.every((c) => CASH_REACHABLE.includes(c));

/** The verdict on an answer { app?: appFacts, sign?: signFacts }, each host it holds. */
export function judge(a) {
  const lines = [];
  const bad = (k) => lines.push(`BAD ${SAYS[k]}`);
  if (!a?.app && !a?.sign) lines.push("BAD no host read");
  if (a?.app) {
    if (!(a.app.scripts > 0)) bad("scripts");
    if (a.app.cashHopDest !== true) bad("cashHopDest");
    if (!fine(a.app.cashChains)) bad("appChains");
  }
  if (a?.sign) {
    for (const k of ["pinned", "givenDest", "destTaken", "destRefused"]) if (a.sign[k] !== true) bad(k);
    if (!fine(a.sign.cashChains)) bad("signChains");
  }
  if (a?.app && a?.sign && fine(a.app.cashChains) && fine(a.sign.cashChains) && a.app.cashChains.join() !== a.sign.cashChains.join()) bad("agree");
  return { ok: lines.length === 0, lines };
}

/** What `hosts` serve, read with `fetchFn` (scripts/ci/bundle-checks.mjs passes one that answers from the builds). */
export async function read(fetchFn = fetch, hosts = ["app", "sign"]) {
  const get = async (origin, path) => {
    const r = await fetchFn(`${origin}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${origin}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const out = {};
  if (hosts.includes("app")) {
    const page = await get(APP, "/");
    const srcs = [...page.matchAll(/<script\b[^>]*\bsrc="(\/[^"]+)"/gi)].map((m) => m[1]);
    if (srcs.length === 0) throw new Error("APP_HOST's page names no script");
    const scripts = [];
    for (const src of srcs) scripts.push(await get(APP, src));
    out.app = appFacts(scripts);
  }
  if (hosts.includes("sign")) out.sign = signFacts(await get(SIGN, "/"), await get(SIGN, "/app.js"));
  return out;
}

/** scripts/ci/bundle-checks.mjs: one host's half on the build. */
export async function bundle(fetchFn, { host }) {
  return judge(await read(fetchFn, [host]));
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const host = arg("--host");
    if (host !== undefined && host !== "app" && host !== "sign") throw new Error("--host is app or sign");
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(fetch, host ? [host] : ["app", "sign"]);
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
