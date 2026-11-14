#!/usr/bin/env node
// Live check of card first-sign-in-reads-fast: the first-ever restore on a new device reads the Base and Robinhood
// pools about as fast as Solana's. It signs SIGN_HOST (https://confidential.unrealized.trade) in with the published vector's 12 words on an empty store, as
// pool-restore-wired.mjs does (its collect(), the same fresh profile, the same pinned hosts), and reads the page's own
// "restore: <chain> walked" line for each pool (src/pool-restore.ts, once that pool's notes are written). It signs in
// RUNS (3) times, each on a fresh profile, prints each run's gaps, and fails when Base's or Robinhood's median walk is
// more than GAP_MS after Solana's (a run where it never walks counts as slower than any), when Solana does not walk in
// every run, or on any run's error. The median, not each run (the CO, 14 Nov 05:30Z): one sign-in walked Robinhood
// 38.3 s after Solana in a box run at af9aed433 (05:26Z) where the two others walked it at 7.7 and 9.2 s, so one slow
// draw of a provider's backends would undo a sign deploy; the target is the p50.
// The pools' reads start side by side at Continue and each walk takes the page's one turn as its reads end, so a pool
// that walks long after Solana is one whose reads ended late. Before the card the EVM pool sync paged a provider held
// at its range cap one page after another (packages/wallet/src/pool/evm.ts readLogs: rpc.mainnet.chain.robinhood.com's
// 100,000 blocks, base-rpc.publicnode.com's 50,000, about 55 pages each), and the live page at release 133 walked
// Robinhood 13.2 to 16.7 s and Base 11.9 to 19.9 s after Solana (three runs, 14 Nov 03:31Z, box Chrome 156).
// GAP_MS, 12 s, from the card's measure (this checkout's build with the pinned hosts on the network, box Chrome 156,
// 14 Nov 04:38-04:40Z, three runs): Robinhood and Base walked 4.9 and 9.8 s after Solana where both Pocket seats paged
// wide (robinhood.api.pocket.network 50 calls, base.api.pocket.network 83), and 41.1/10.0 s and 10.8/24.5 s where one
// Pocket seat's backends paged narrow (513 and 291 calls). Then a seat refused under a page its provider answered
// walked to a free spare (Robinhood's GlobalStake) and a walking seat's read spread too (evmPair, readLogs): three
// runs 14 Nov 05:21-05:23Z, Robinhood 10.5, 6.4 and 9.0 s after Solana (robinhood.api.pocket.network 24, 19, 22
// requests), Base 3.1, 3.1 and 5.7 s; this check's own three at 05:33-05:34Z (its good answer), Base 6.1, 9.2, 3.0 s
// and Robinhood 3.0, 3.0, 6.2 s, medians 6.1 and 3.0 s.
// After: sign
// Bundle: out a browser
//   node scripts/live-checks/first-sign-in-reads-fast.mjs [--record <file>]                the deployed SIGN_HOST
//   node scripts/live-checks/first-sign-in-reads-fast.mjs --local --net [--record <file>]  this checkout's build with
//     the pinned hosts on the network
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the three runs read, so the test can replay it.
// No money; the account is the published vector's, thrown away with the profile.
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collect } from "./pool-restore-wired.mjs";

const KEY = "first-sign-in-reads-fast";
export const EVM_CHAINS = Object.freeze(["base", "robinhood"]);
/** The most Base's or Robinhood's median walk may come after Solana's (ms): the header's measure. */
export const GAP_MS = 12_000;
/** Sign-ins a verdict takes, each on a fresh profile: the median of three is judged (the CO, 14 Nov 05:30Z: one
 *  sign-in near 10.5 s against a 12 s bound fails on one slow Pocket draw, and the target is the p50). */
export const RUNS = 3;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** One run's gap after Solana for each chain (ms), null where the chain or Solana never walked. */
export function gapsOf(run) {
  const walked = Array.isArray(run?.walked) ? run.walked.filter((w) => isObj(w) && typeof w.chain === "string" && Number.isFinite(w.t)) : [];
  const at = (chain) => walked.find((w) => w.chain === chain)?.t ?? null;
  const sol = at("solana");
  return { solana: sol !== null, ...Object.fromEntries(EVM_CHAINS.map((c) => [c, at(c) === null || sol === null ? null : at(c) - sol])) };
}

/** The verdict on a record of RUNS sign-ins: { ok, lines }. `rec.runs[i].walked`: each "restore: <chain> walked" line
 *  of sign-in i, its chain and time (ms). Each pool's gap after Solana is judged at its median over the runs, a run
 *  where it never walked counting as slower than any; Solana must walk in every run, and any run's error fails. */
export function judge(rec) {
  const lines = [];
  const say = (ok, line) => lines.push(`${ok ? "OK " : "BAD"} ${line}`);
  const runs = Array.isArray(rec?.runs) ? rec.runs : [];
  say(runs.length >= RUNS, `${RUNS} sign-ins recorded (${runs.length})`);
  if (runs.length < RUNS) return { ok: false, lines };
  const gaps = runs.map(gapsOf);
  const noSol = gaps.flatMap((g, i) => (g.solana ? [] : [i + 1]));
  say(noSol.length === 0, `Solana walked in every run (${noSol.length ? `never in runs ${noSol.join(", ")}` : "its line read"})`);
  const ms = (g) => (g === null ? "never" : `${g} ms`);
  for (const chain of EVM_CHAINS) {
    const each = gaps.map((g) => g[chain]);
    const sorted = [...each].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    say(median !== null && median <= GAP_MS, `${chain} walked a median of ${median === null ? "never" : `${median} ms after Solana`} (within ${GAP_MS / 1000} s; runs ${each.map(ms).join(", ")})`);
  }
  const errors = runs.flatMap((r, i) => (Array.isArray(r?.errors) ? r.errors.map((e) => `run ${i + 1}: ${e}`) : []));
  if (errors.length) say(false, `the runs had no error (${errors.join(" | ")})`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    const i = process.argv.indexOf("--record");
    const rec = { source: null, browser: null, runs: [] };
    // one sign-in after another, each on its own fresh profile (collect)
    for (let n = 1; n <= RUNS; n++) {
      const full = await collect({ local: process.argv.includes("--local"), net: process.argv.includes("--net") });
      rec.source ??= full.source;
      rec.browser ??= full.browser;
      rec.runs.push({ at: full.at, walked: full.walked, errors: full.errors });
      const g = gapsOf(rec.runs.at(-1));
      console.log(`run ${n} (${full.at}): ${EVM_CHAINS.map((c) => `${c} ${g[c] === null ? "never" : `${(g[c] / 1000).toFixed(1)} s`}`).join(", ")} after Solana${full.errors?.length ? `, ${full.errors.length} errors` : ""}`);
    }
    if (i > 0) writeFileSync(process.argv[i + 1], `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.browser}, ${rec.runs[0]?.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
