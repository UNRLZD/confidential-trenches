#!/usr/bin/env node
// Live check of card pool-deposits: the signing page's same-chain Solana deposit, built, priced and its mark read by the
// kit (packages/kit/src/trade/solana/pool-deposit.ts) since slice 2, landed a note on the devnet pool its testnet build
// pins, and SIGN_HOST (https://sign.confidential.unrealized.trade) still serves the mainnet build, which carries no testnet pin. The run is pool-deposits.run.json,
// written from packages/signpage/scripts/pool-deposit-devnet.mjs (runPoolDeposit, src/pool-deposit.ts, at this card's
// code, a seed made in that run). The reads are signpage-pool-notes's, on each of two devnet RPCs of two operators at
// finalized: the deposit tx with no error, paid and signed by the run's U, calling the pinned program; the mark at the
// run's value and nonce, the program's; the label leaf keccak256(scope, nonce) mod p and the state leaf the note's
// commitment, both worked out here; U at 0 lamports (the kit's cost was exactly what the program took).
//   node scripts/live-checks/pool-deposits.mjs [--precommitment <hex>] [--record <file>]
// --precommitment reads another precommitment in the run's place (the recorded bad answer). PASS exit 0, FAIL exit 1,
// error exit 2.
// Slice 3 (the EVM same-chain deposit, release-77): SIGN_HOST's index.html pins the /app.js it serves (its sha384), and
// that bundle carries the EVM deposit, as minified: U^evm's HKDF label (derive/keys.ts depositIdEvm), the rule's own
// refusals (rules/pool.ts checkEvmDeposit) and the runner's reads (src/pool-deposit-evm.ts). What each does is held by
// the card's tests; the recorded answers are evmFacts() over a tree's packages/signpage/index.html and public/app.js.
// Slice 3's review fold: the served /app.js is a released build from release-77 on (a releases/release-<N>.json, N >= 77,
// names its sha384 for SIGN_HOST): a tree whose tests route pool.deposit on Base and Robinhood to the runner
// (test/pool-testnet-evm-deposit.test.ts). A build with that route removed still carries the runner (the load's settle
// pass calls it), so no string in the bundle tells the two apart; the release ledger does. The Base Sepolia run of the
// EVM path is in pool-deposits.md (its Tx lines), read back by the money gate.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEVNET_PROVIDERS, recorder } from "./pool-sol-deploy.mjs";
import { check as checkRun, readSignFlow } from "./signpage-pool-notes.mjs";

const KEY = "pool-deposits";
export const RUN = new URL("./pool-deposits.run.json", import.meta.url);

const SIGN_HOST = "https://sign.confidential.unrealized.trade";
/** The EVM deposit's marks in SIGN_HOST's bundle, each a string the minifier keeps. */
export const EVM_MARKS = Object.freeze({
  // derive/keys.ts depositIdEvm: U^evm's HKDF label
  "U^evm derivation": "onetime/in/evm",
  // rules/pool.ts checkEvmDeposit: its refusal of a deposit into a pool the page does not pin
  "deposit rule": "evm_not_pinned",
  // the note store's EVM send record (notes/store.ts evmSends)
  "send record": "evmSends",
  // src/pool-deposit-evm.ts, the runner itself: a read only it makes
  "runner": "the deposit's gas estimate",
  // src/pool-deposit-evm.ts: the pool's label tree depth, read for the tree's gas headroom over the estimate
  "tree headroom": "currentLabelTreeDepth()",
});
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
/** What the check keeps of SIGN_HOST's page: the /app.js pin in index.html, the served bundle's sha384, and which marks it holds. */
export function evmFacts(index, js) {
  return { pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null, sha384: sha384(js), marks: Object.fromEntries(Object.entries(EVM_MARKS).map(([k, m]) => [k, js.includes(m)])) };
}
export async function readSignEvm(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN_HOST}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return evmFacts(await get("/"), await get("/app.js"));
}
/** The first release whose tree routes pool.deposit on Base and Robinhood to the runner with this fold. */
export const ROUTED_FROM = 77;
/** SIGN_HOST's /app.js sha384 in every release list from ROUTED_FROM on (packages/signpage/releases/). */
export function routedReleases(dir = new URL("../../packages/signpage/releases/", import.meta.url)) {
  const out = new Set();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < ROUTED_FROM) continue;
    const list = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    for (const x of list.hosts?.SIGN_HOST?.files ?? []) if (x.path === "/app.js") out.add(x.sha384);
  }
  return out;
}
/** The EVM lines on SIGN_HOST's facts `e`, against the release lists' SIGN_HOST bundles `routed`. */
export function judgeEvm(e, routed = routedReleases()) {
  const lines = [];
  const say = (pass, text) => lines.push(`${pass ? "ok  " : "BAD "} ${text}`);
  say(typeof e?.pin === "string" && e.pin === e.sha384, `EVM: SIGN_HOST's served /app.js is the one index.html pins: ${e?.pin ?? "no pin"} / ${e?.sha384 ?? "not read"}`);
  for (const k of Object.keys(EVM_MARKS)) say(e?.marks?.[k] === true, `EVM: SIGN_HOST's bundle carries the EVM deposit's ${k} (${EVM_MARKS[k]})`);
  say(routed.has(e?.sha384), `EVM: SIGN_HOST's /app.js is a release-${ROUTED_FROM}-or-later build, whose flow routes pool.deposit on Base and Robinhood to the runner: ${e?.sha384 ?? "not read"}`);
  return lines;
}

/** The verdict for this card's run (with `precommitment` in its place when given), read through `fetchFn`, SIGN_HOST's
 *  read `sign`, and SIGN_HOST's EVM facts `evm`. */
export async function check({ run = JSON.parse(readFileSync(RUN, "utf8")), evm, ...rest } = {}) {
  const r = await checkRun({ run, ...rest });
  const lines = [...r.lines, ...judgeEvm(evm)];
  return { ...r, lines, ok: r.ok && !lines.some((l) => l.startsWith("BAD")) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = JSON.parse(readFileSync(RUN, "utf8"));
    const rec = recorder();
    const sign = await readSignFlow();
    const precommitment = opt("--precommitment") ?? run.precommitment;
    const evm = await readSignEvm();
    const r = await check({ run, precommitment, fetchFn: opt("--record") ? rec.fetchFn : fetch, sign, evm });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ precommitment, rpcs: DEVNET_PROVIDERS, at: new Date().toISOString(), sign, evm, answers: rec.answers })}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
