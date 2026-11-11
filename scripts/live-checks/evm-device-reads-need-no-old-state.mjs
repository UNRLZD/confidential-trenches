#!/usr/bin/env node
// Live check of card evm-device-reads-need-no-old-state: the device's Base and Robinhood binds and syncs ask no block
// state older than a few seconds. A keyless operator keeps a block's state seconds to minutes (Pocket and publicnode
// refused 15 to 242 s back, read 2026-11-10 21:50-22:30Z), so the signing page reads each period's fee at its turn,
// while the period's first block is fresh, and holds it for the period; and its sync reads the pool's root times at the
// newest block, not at an anchor minutes old. Read now:
//   - SIGN_HOST's /app.js holds the sync's fresh-block root-time read (its words "is below the anchor", from
//     packages/wallet/src/pool/evm.ts timesAt), so the deployed page is one that reads no old anchor;
//   - for each mainnet, as the page runs it (CHILD, packages/wallet/scripts/no-old-state-live.ts: the wallet's own
//     evmEpochBlock and evmBindChainFee on the kit's read list, under the wallet's lag retries):
//       the hold at the next period's turn + 3 s binds on two operators that agree, its fee read while the period's
//       first block is under FEE_AGE_BOUND_MS old; PASS needs it on both chains;
//       a bind 30 s in finds the same first block by headers and asks no state (stateReads 0);
//       the pool's root time read at a fresh block on two operators of the list agrees and is non-zero (0 only for a
//       pool with no leaf yet, whose root 0 the pool never timed).
// A seat that gives no answer (a 429, a timeout) alone is INCONCLUSIVE, never a pass; two operators that differ fail. A
// provider that does not know a fresh block yet is read again under the wallet's lag retries (the child reads every step
// under evmRetryLag, 5 reads 2 s apart, as the page does) and, still behind on the last, is INCONCLUSIVE naming it
// (lagging, provider-answer.mjs laggingOf); one that knows the block and answers wrong still fails.
// The residue it does not check (removed by card device-evm-read-residuals): a page loaded mid-period whose first
// block no two operators still keep waits for the next turn, at most 65 s on "Making proof" with no error; Robinhood
// at +55 s, 1 of 3 periods read 2026-11-10 23:20-23:29Z (robinhood.com alone kept it; drpc.org, pocket.network and
// publicnode.com refused it), Base 0 of 5 (packages/signpage/src/pool-testnet.ts EVM_TURN_PASS_MS; the bound is held by
// test/pool-testnet-evm-queue.test.ts "a fresh load has no proof until the turn").
// After: sign
//   node scripts/live-checks/evm-device-reads-need-no-old-state.mjs [--record <file>] [--answer <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
import "../net-window.mjs";
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXIT, laggingLine, laggingOf, verdictOf } from "./provider-answer.mjs";

const KEY = "evm-device-reads-need-no-old-state";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** SIGN_HOST: the signing page's own origin. */
export const SIGN = "https://confidential.unrealized.trade";
/** The oldest the period's first block may be when the hold's fee answers are in: the shortest state window measured
 *  on the chains' read lists, robinhood-rpc.publicnode.com's (5 of 5 pool reads under 10 s back answered, 12 of 12 at
 *  10 s and more refused, 2026-11-10 23:21-23:37Z); a hold slower than that would be refused by that operator. */
export const FEE_AGE_BOUND_MS = 10_000;
/** The words of the sync's fresh-block read (timesAt) in the page's bundle. */
export const MARKER = "is below the anchor";
/** The wallet's own reads, run as a child (the kit's entry is this file's only reach into Blindfill). */
export const CHILD = path.join(REPO, "packages/wallet/scripts/no-old-state-live.ts");
const childArgs = () => ["--import", pathToFileURL(path.join(REPO, "scripts/net-window.mjs")).href, CHILD];
const NO_ANSWER = /no answer in \d+ ms|HTTP 429|rate limit|fetch failed|timeout/i;

/** The verdict on a run { sign: { appJs, marker }, chains: { base: { hold, bind, times }, robinhood: {...} } }. */
export function judge(run) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const say = (ok, s) => (lines.push(`${ok ? "ok " : "BAD"} ${s}`), ok || (bad = true));
  const two = (x) => Array.isArray(x?.operators) && x.operators.length === 2 && x.operators[0] !== x.operators[1];
  const lagged = (x, what) => {
    const hosts = x?.ok === true ? null : laggingOf(x);
    if (hosts) (quiet = true), lines.push(laggingLine(what, hosts));
    return hosts !== null;
  };
  say(run?.sign?.marker === true, `SIGN_HOST /app.js (${run?.sign?.bytes ?? "?"} bytes) holds the sync's fresh-block root-time read ("${MARKER}")`);
  for (const chain of ["base", "robinhood"]) {
    const c = run?.chains?.[chain];
    if (!c) {
      say(false, `${chain}: not read`);
      continue;
    }
    const h = c.hold ?? {};
    if (h.ok === true) {
      say(two(h), `${chain}: the period's fee held at its turn (block ${h.block}, ${h.atMs} ms past the turn) on ${h.hosts?.join(" and ") ?? "?"}`);
      say(Number.isFinite(h.feeAgeMs) && h.feeAgeMs >= 0 && h.feeAgeMs < FEE_AGE_BOUND_MS, `${chain}: the fee read while the period's first block was ${h.feeAgeMs ?? "?"} ms old (under ${FEE_AGE_BOUND_MS} ms)`);
    }
    else if (lagged(h, `${chain}: the hold at the turn`)) {
      // a provider behind the fresh block on the last lag retry: INCONCLUSIVE, named
    }
    else if (NO_ANSWER.test(String(h.error)) && !/answered differently/.test(String(h.error))) {
      quiet = true;
      lines.push(`--  ${chain}: the hold's reads gave no answer (${String(h.error).slice(0, 160)}): INCONCLUSIVE`);
    } else say(false, `${chain}: the period's fee was not held at its turn (${h.name ?? "Error"}: ${String(h.error).slice(0, 200)})`);
    if (h.ok === true) {
      const b = c.bind ?? {};
      if (!lagged(b, `${chain}: the bind 30 s in`)) say(b.ok === true && b.sameHash === true && b.stateReads === 0, `${chain}: a bind 30 s in found the same first block by headers and asked no state (${b.stateReads ?? "?"} state reads${b.error ? `; ${String(b.error).slice(0, 120)}` : ""})`);
    }
    const t = c.times ?? {};
    if (t.ok === true && t.empty === true) say(two(t) && /^0x0*$/.test(String(t.value)), `${chain}: the pool holds no leaf yet (root 0, never timed): its time read at a fresh block on ${t.hosts?.join(" and ") ?? "?"}, 0 on both`);
    else if (t.ok === true) say(two(t) && !/^0x0*$/.test(String(t.value)), `${chain}: the pool's root time read at a fresh block on ${t.hosts?.join(" and ") ?? "?"}`);
    else if (lagged(t, `${chain}: the pool's root time at a fresh block`)) {
      // a provider behind the fresh block on the last lag retry: INCONCLUSIVE, named
    }
    else if (NO_ANSWER.test(String(t.error))) {
      quiet = true;
      lines.push(`--  ${chain}: the root time read gave no answer: INCONCLUSIVE`);
    } else say(false, `${chain}: the pool's root time at a fresh block was not read (${String(t.error ?? `the value ${t.value}`).slice(0, 200)})`);
  }
  return { ok: !bad && !quiet, verdict: verdictOf(bad, quiet), lines };
}

/** The run: SIGN_HOST's bundle and the wallet's reads, now. */
export async function read(fetchFn = fetch) {
  const child = new Promise((res, no) => execFile(process.execPath, childArgs(), { cwd: REPO, timeout: 240_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) => (e ? no(new Error(`${KEY}: the child failed: ${String(stderr).slice(-300)}`)) : res(stdout))));
  const r = await fetchFn(`${SIGN}/app.js`, { redirect: "error" });
  if (r.status !== 200) throw new Error(`/app.js: HTTP ${r.status}`);
  const js = await r.text();
  const chains = JSON.parse(String(await child).trim().split("\n").at(-1));
  return { check: KEY, at: new Date().toISOString(), sign: { bytes: js.length, marker: js.includes(MARKER) }, chains };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    console.log(`${KEY}: ${v.verdict}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`${KEY}: error ${e?.stack ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
