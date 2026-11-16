#!/usr/bin/env node
// Live check of card pool-deposits: SIGN_HOST (https://confidential.unrealized.trade) serves the mainnet build, which
// carries none of the testnet build's pins or providers (test-network-names.mjs SIGN_TESTNET_ONLY), and its EVM
// same-chain deposit (below). It reads SIGN_HOST only (card live-checks-read-mainnet-only: a listed check reads no test
// network). The Solana deposit's slice 2 run on the testnet build's devnet pool (pool-deposits.run.json, written from
// packages/signpage/scripts/pool-deposit-devnet.mjs) is a record no deploy changes: the check's test replays its
// recorded devnet reads (signpage-pool-notes's check), and the money gate reads its transactions back.
// After: sign
// Bundle: out the served index.html and /app.js against the release lists
//   node scripts/live-checks/pool-deposits.mjs [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2.
// Slice 3 (the EVM same-chain deposit, release-83): SIGN_HOST's index.html pins the /app.js it serves (its sha384), and
// that bundle carries the EVM deposit, as minified: U^evm's HKDF label (derive/keys.ts depositIdEvm), the rule's own
// refusals (rules/pool.ts checkEvmDeposit) and the runner's reads (src/pool-deposit-evm.ts). What each does is held by
// the card's tests; the recorded answers are evmFacts() over a tree's packages/signpage/index.html and public/app.js.
// Slice 3's review fold: the served /app.js is a released build from release-83 on (a releases/release-<N>.json, N >= 83,
// names its sha384 for SIGN_HOST): a tree whose tests route pool.deposit on Base and Robinhood to the runner
// (test/pool-testnet-evm-deposit.test.ts). A build with that route removed still carries the runner (the load's settle
// pass calls it), so no string in the bundle tells the two apart; the release ledger does. The Base Sepolia run of the
// EVM path is in pool-deposits.md (its Tx lines), read back by the money gate.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIGN_TESTNET_ONLY } from "./test-network-names.mjs";

const KEY = "pool-deposits";
export const RUN = new URL("./pool-deposits.run.json", import.meta.url);

const SIGN_HOST = "https://confidential.unrealized.trade";
/** SIGN_HOST's /app.js: its status, size and which of SIGN_TESTNET_ONLY it carries. */
export async function readSignFlow(fetchFn = fetch) {
  const r = await fetchFn(`${SIGN_HOST}/app.js`, { redirect: "error" });
  const text = await r.text();
  return { status: r.status, bytes: text.length, found: SIGN_TESTNET_ONLY.filter((s) => text.includes(s)) };
}
/** The mainnet build line on SIGN_HOST's read `sign`. */
export function judgeSign(sign) {
  const ok = sign?.status === 200 && sign.bytes > 0 && Array.isArray(sign.found) && sign.found.length === 0;
  return [`${ok ? "ok  " : "BAD "} SIGN_HOST's /app.js is the mainnet build, with no testnet pin or provider: ${sign ? `${sign.status}, ${sign.bytes} chars, carries [${sign.found.join(", ")}]` : "not read"}`];
}
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
export const ROUTED_FROM = 83;
/** SIGN_HOST's /app.js sha384 in every release list from ROUTED_FROM on (packages/signpage/releases/). */
export function routedReleases(dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases")) {
  const out = new Set();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < ROUTED_FROM) continue;
    const list = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
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

/** The verdict on SIGN_HOST's read `sign` and its EVM facts `evm`. */
export function check({ sign, evm } = {}) {
  const lines = [...judgeSign(sign), ...judgeEvm(evm)];
  return { lines, ok: !lines.some((l) => l.startsWith("BAD")) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const sign = await readSignFlow();
    const evm = await readSignEvm();
    const r = check({ sign, evm });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ at: new Date().toISOString(), sign, evm })}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
