#!/usr/bin/env node
// Live check of card deposit-takes-each-pools-own-coin on SIGN_HOST (https://confidential.unrealized.trade): each pool
// takes its own coin from any outside wallet, so the deposit sheet offers SOL on Solana, ETH on Base and ETH on
// Robinhood beside the USDC rows. What it holds, on the served page, signed out (the sheet's first read):
//   - deposit.assets lists SOL on solana (nep141:sol.omft.near, 9 decimals), ETH on base (nep141:base.omft.near, 18) and
//     ETH on robinhood (nep141:hood.omft.near, 18), each once, after every USDC row, each with max_usd "1000" and a min
//     that is the pool's floor read now: above the pool's least rung (0.01 SOL, 0.001 ETH: one deposit from U_X costs a
//     fee, and on Solana the rent U_X keeps) and under two rungs;
//   - no request the page sends to the helper's 1Click proxy names a pool's own coin: 1Click is asked nothing for a
//     plain send (the USDC rows' probes are kit-deposit-assets-dry's to judge).
// The plain send's address (pool.address with the pool's own coin) needs a signed-in seed, which this run never has:
// it is held by packages/signpage/test/deposit-pool-coin.test.ts and the card's mainnet copy runs. The run is
// kit-deposit-assets-dry's own (its collect: SIGN_HOST top-level framing a probe APP_HOST, the real helper, nothing of
// anyone's named). A page before this card lists the USDC rows alone.
// After: sign
//   node scripts/live-checks/deposit-takes-each-pools-own-coin.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/deposit-takes-each-pools-own-coin.mjs --local [<build dir>] [--record <file>]
//     SIGN_HOST answered from a build dir (index.html and public/ as deploy.mjs builds them), with no dir the build of
//     the tree this file is in (scripts/signpage-built.mjs); the helper and the pools' RPCs are still reached
//   node scripts/live-checks/deposit-takes-each-pools-own-coin.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2; the last line is "<verdict> deposit-takes-each-pools-own-coin", each failure a
// "BAD ..." line.
import { copyFileSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { signBuilt } from "../signpage-built.mjs";
import { named } from "./record-names.mjs";
import { HELPER_1CLICK, SIGN_URL, collect } from "./kit-deposit-assets-dry.mjs";

const KEY = "deposit-takes-each-pools-own-coin";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Each pool's own coin as the card lists it: 1Click's id for it, its chain, symbol, decimals and least rung. */
export const POOL_COINS = Object.freeze([
  Object.freeze({ id: "nep141:sol.omft.near", chain: "solana", symbol: "SOL", decimals: 9, rung: 10_000_000n }),
  Object.freeze({ id: "nep141:base.omft.near", chain: "base", symbol: "ETH", decimals: 18, rung: 1_000_000_000_000_000n }),
  Object.freeze({ id: "nep141:hood.omft.near", chain: "robinhood", symbol: "ETH", decimals: 18, rung: 1_000_000_000_000_000n }),
]);
export const MAX_USD = "1000";
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1 });
const show = (v) => JSON.stringify(v)?.slice(0, 200);

/** A decimal string in base units at `d`, exactly; null when it is not one. */
export function units(s, d) {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return f.length > d ? null : BigInt(i + f.padEnd(d, "0"));
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The verdict on a run (kit-deposit-assets-dry's collect): { verdict, ok, lines }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  if (a?.ready !== true) bad("the shell's ready did not arrive in the APP_HOST frame");
  const signOrigin = (() => {
    try {
      return new URL(a.signUrl).origin;
    } catch {
      return null;
    }
  })();
  const id = a?.ids?.assets;
  const got = (a?.log ?? []).filter((m) => m.fromParent && m.origin === signOrigin && id && m.data?.id === id).map((m) => m.data);
  if (got.length !== 1) bad(`deposit.assets: ${got.length} answer(s) to its id, want 1`);
  const r = got[0];
  const list = r?.ok === true && Array.isArray(r.result?.assets) ? r.result.assets : null;
  if (got.length === 1 && r?.ok !== true) bad(`deposit.assets answered ${r?.ok === false ? `refused ${show(r.error?.code)}` : "neither ok nor refused"}, want ok`);
  else if (got.length === 1 && !list) bad("deposit.assets: no assets list");
  if (list) {
    const ids = list.map((x) => x?.origin_asset);
    const lastUsdc = list.reduce((k, x, i) => (x?.symbol === "USDC" ? i : k), -1);
    if (lastUsdc < 0) bad("deposit.assets lists no USDC row: the rows that work today are gone");
    for (const c of POOL_COINS) {
      const at = ids.indexOf(c.id);
      const label = `deposit.assets ${c.symbol} on ${c.chain}`;
      if (at < 0) {
        bad(`${label} (${c.id}) is not listed`);
        continue;
      }
      if (ids.lastIndexOf(c.id) !== at) bad(`${label} is listed twice`);
      if (at < lastUsdc) bad(`${label} is listed before a USDC row, want after them`);
      const x = list[at];
      if (x.chain !== c.chain) bad(`${label}: chain ${show(x.chain)}, want ${show(c.chain)}`);
      if (x.symbol !== c.symbol) bad(`${label}: symbol ${show(x.symbol)}, want ${show(c.symbol)}`);
      if (x.decimals !== c.decimals) bad(`${label}: decimals ${show(x.decimals)}, want ${c.decimals}`);
      if (x.max_usd !== MAX_USD) bad(`${label}: max_usd ${show(x.max_usd)}, want ${show(MAX_USD)}`);
      const min = units(x.min, c.decimals);
      if (min === null) bad(`${label}: min ${show(x.min)} is not an amount of ${c.symbol}`);
      else if (min <= c.rung) bad(`${label}: min ${x.min} is not above the pool's least rung: one deposit from U_X costs more than the rung`);
      else if (min >= 2n * c.rung) bad(`${label}: min ${x.min} is two rungs or more, not the pool's floor`);
    }
  }
  for (const q of a?.helper ?? []) {
    if (typeof q?.url !== "string" || !q.url.startsWith(HELPER_1CLICK)) continue;
    const coin = POOL_COINS.find((c) => q.body?.originAsset === c.id || q.body?.destinationAsset === c.id);
    if (coin) bad(`the page asked 1Click about ${coin.symbol} on ${coin.chain} (${q.url}): a plain send asks it nothing`);
  }
  const verdict = lines.length > 0 ? "FAIL" : "PASS";
  return { verdict, ok: verdict === "PASS", lines };
}

// ------------------------------------------------------------------------------------------------ main
/** packages/signpage as deploy.mjs build() makes it, minus the prover's setup files: index.html and public/ copied. */
function build() {
  const out = mkdtempSync(path.join(tmpdir(), "ct-dtpc-"));
  copyFileSync(path.join(signBuilt(), "index.html"), path.join(out, "index.html"));
  cpSync(path.join(REPO, "packages/signpage/public"), out, { recursive: true });
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let answer;
  if (opt("--answer")) answer = JSON.parse(readFileSync(opt("--answer"), "utf8"));
  else {
    const local = args.includes("--local");
    const given = local && opt("--local") && !opt("--local").startsWith("--") ? path.resolve(opt("--local")) : null;
    const dir = local ? (given ?? build()) : null;
    const browser = await launchBrowser("chromium");
    try {
      answer = await collect({ browser, signUrl: local ? SIGN_URL : (opt("--url") ?? SIGN_URL), dir, source: local ? `local, SIGN_HOST answered from ${given ? named(given) : "packages/signpage's build (index.html and public/ copied)"}` : "live" });
    } finally {
      await browser.close();
      if (local && !given) rmSync(dir, { recursive: true, force: true });
    }
  }
  if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
  const v = judge(answer);
  for (const l of v.lines) console.log(l);
  console.log(`${v.verdict} ${KEY}`);
  process.exit(EXIT[v.verdict]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERROR ${KEY}: ${e?.stack ?? e}`);
    process.exit(2);
  });
}
