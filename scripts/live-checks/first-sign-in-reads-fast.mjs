#!/usr/bin/env node
// Live check of card first-sign-in-reads-fast: the first-ever restore on a new device reads the Base and Robinhood
// pools about as fast as Solana's. It signs SIGN_HOST (https://confidential.unrealized.trade) in with the published vector's 12 words on an empty store, as
// pool-restore-wired.mjs does (its collect(), the same fresh profile, the same pinned hosts), and reads the page's own
// "restore: <chain> walked" line for each pool (src/pool-restore.ts, once that pool's notes are written). It fails when
// Base or Robinhood never walks, or walks more than GAP_MS after Solana.
// The pools' reads start side by side at Continue and each walk takes the page's one turn as its reads end, so a pool
// that walks long after Solana is one whose reads ended late. Before the card the EVM pool sync paged a provider held
// at its range cap one page after another (packages/wallet/src/pool/evm.ts readLogs: rpc.mainnet.chain.robinhood.com's
// 100,000 blocks, base-rpc.publicnode.com's 50,000, about 55 pages each), and the live page at release 133 walked
// Robinhood 13.2 to 16.7 s and Base 11.9 to 19.9 s after Solana (three runs, 14 Nov 03:31Z, box Chrome 156).
// GAP_MS, 12 s, from the card's measure (this checkout's build with the pinned hosts on the network, box Chrome 156,
// 14 Nov 04:38-04:40Z, three runs): Robinhood and Base walked 4.9 and 9.8 s after Solana where both Pocket seats paged
// wide (robinhood.api.pocket.network 50 calls, base.api.pocket.network 83), and 41.1/10.0 s and 10.8/24.5 s where one
// Pocket seat's backends paged narrow (513 and 291 calls): that seat, not the capped one this card spreads, is then the
// read's bound, and this check fails on it.
// After: sign
// Bundle: out a browser
//   node scripts/live-checks/first-sign-in-reads-fast.mjs [--record <file>]                the deployed SIGN_HOST
//   node scripts/live-checks/first-sign-in-reads-fast.mjs --local --net [--record <file>]  this checkout's build with
//     the pinned hosts on the network
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
// No money; the account is the published vector's, thrown away with the profile.
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collect } from "./pool-restore-wired.mjs";

const KEY = "first-sign-in-reads-fast";
export const EVM_CHAINS = Object.freeze(["base", "robinhood"]);
/** The most Base or Robinhood may walk after Solana (ms): the header's measure. */
export const GAP_MS = 12_000;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The verdict on one recorded run: { ok, lines }. `rec.walked`: each "restore: <chain> walked" line, its chain and
 *  time (ms). */
export function judge(rec) {
  const lines = [];
  const say = (ok, line) => lines.push(`${ok ? "OK " : "BAD"} ${line}`);
  const walked = Array.isArray(rec?.walked) ? rec.walked.filter((w) => isObj(w) && typeof w.chain === "string" && Number.isFinite(w.t)) : [];
  const at = (chain) => walked.find((w) => w.chain === chain)?.t ?? null;
  const sol = at("solana");
  say(sol !== null, `Solana walked (${sol === null ? "never" : "its line read"})`);
  for (const chain of EVM_CHAINS) {
    const t = at(chain);
    const gap = t === null || sol === null ? null : t - sol;
    say(gap !== null && gap <= GAP_MS, `${chain} walked ${t === null ? "never" : gap === null ? "with no Solana line to time it by" : `${gap} ms after Solana`} (within ${GAP_MS / 1000} s)`);
  }
  if (rec?.errors?.length) say(false, `the run had no error (${rec.errors.join(" | ")})`);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("OK")), lines };
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
    const full = await collect({ local: process.argv.includes("--local"), net: process.argv.includes("--net") });
    const rec = { source: full.source, at: full.at, browser: full.browser, walked: full.walked, errors: full.errors };
    if (i > 0) writeFileSync(process.argv[i + 1], `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.browser}, ${rec.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
