#!/usr/bin/env node
// Live check of card base-buy-box-answers-a-fresh-account: a fresh device's Base buy box draws a quote, since the pool
// index it starts from is fresh. A device with no kept index starts the Base index sync from SIGN_HOST's
// /evm-index/base.json (packages/signpage/scripts/evm-index-snapshot.mjs, run at the release cut) and reads every block
// past it before its first coin quote; pool.buy.dry waits for that sync at most 20 s (pool-buy-evm.ts
// EVM_DRY_INDEX_WAIT_MS) and then quotes with no index, a 1M-block scan of 60 s and more. Base makes 5 blocks a second
// (block 58,051,548 at 2026-11-16 03:44:45Z, 58,851,461 at 2026-11-18 00:11:07Z), so a snapshot ages 432,000 blocks a
// day. Releases 170 and 171 shipped the 16 Nov snapshot, 800k blocks behind at 2026-11-18 00:11Z: a fresh account's
// first Base dry answered at 73.6 s in a browser on the live hosts (00:36Z), its index sync still reading at 52 s, and
// the box's check read no answer on 5 of 5 coins (live app runs 44189354230, 44201271127).
// Judged: the served snapshot reads back (pools, a block), is at most MAX_BEHIND blocks behind the lower of two Base
// providers' heads and never past it, and one sync from it on the venue's two index readers, as the device runs it (kit
// evmPoolIndexRefresh), ends whole within SYNC_MAX_MS. Reads only: no key, no transaction, no money moves.
// After: sign
// Bundle: out SIGN_HOST's Base snapshot and Base's head
//   node scripts/live-checks/base-buy-box-answers-a-fresh-account.mjs [--sign <origin>] [--site <dir>] [--record <file>]
//     --site reads the snapshot from a build folder (<dir>/evm-index/base.json) instead of SIGN_HOST: a commit's run
//     before its deploy. PASS exit 0, FAIL exit 1, error exit 2. --record writes the run for the test's replay.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evmPoolIndexFromSnapshot, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

const KEY = "base-buy-box-answers-a-fresh-account";
export const SIGN = "https://confidential.unrealized.trade";
/** The most blocks the served snapshot may be behind Base's head: 12 hours at 5 blocks a second. */
export const MAX_BEHIND = 216_000;
/** The longest one sync from the served snapshot may take: half the dry's index wait (EVM_DRY_INDEX_WAIT_MS 20 s), so
 *  the first quote starts on the index with time left inside the box's watch. */
export const SYNC_MAX_MS = 10_000;
const READ_MS = 30_000;

/** The verdict on a run { sign, snapshot: { status, bytes, through?, pools? }, heads: [n|null, n|null],
 *  sync: { ms, served, coversThrough, requests, getLogs, limited } | null }: { ok, lines }. */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok " : "BAD"} ${text}`);
  };
  const s = run?.snapshot ?? {};
  const read = s.status === 200 && Number.isSafeInteger(s.through) && Number.isSafeInteger(s.pools) && s.pools > 0;
  say(read, `[base] snapshot HTTP ${s.status ?? "not read"}, ${s.bytes ?? 0} bytes, ${s.pools ?? 0} pools, through ${s.through ?? "none"}`);
  const heads = (run?.heads ?? []).filter((h) => Number.isSafeInteger(h));
  if (heads.length < 2) say(false, `[base] head read on ${heads.length} of 2 providers`);
  else if (read) {
    const head = Math.min(...heads);
    const behind = head - s.through;
    say(behind >= 0 && behind <= MAX_BEHIND, `[base] snapshot ${behind} blocks behind the head ${head} (at most ${MAX_BEHIND}, about ${Math.round(behind / 5 / 3600)} h at 5 blocks a second)`);
  }
  const y = run?.sync;
  say(y?.served === true && Number.isFinite(y.ms) && y.ms <= SYNC_MAX_MS, `[base] a fresh device's sync from it ${y ? `${y.served ? "whole" : "partial"} in ${y.ms} ms, ${y.requests?.join("+") ?? "?"} posts, ${y.getLogs?.join("+") ?? "?"} getLogs, ${y.limited?.join("+") ?? "?"} limited` : "not run"} (at most ${SYNC_MAX_MS} ms)`);
  return { ok, lines };
}

/** One run: SIGN_HOST's (or `site`'s) Base snapshot, Base's head on the first two providers that name it, and one sync
 *  from the snapshot on the venue's index readers. */
export async function read(sign = SIGN, site = null, venues = mainnetVenues()) {
  const v = venues.base;
  const run = { sign, site: site === null ? null : "a build folder at SIGN_HOST's name", at: new Date().toISOString(), snapshot: {}, heads: [], sync: null };
  let text;
  if (site !== null) {
    try {
      text = readFileSync(path.join(site, "evm-index", "base.json"), "utf8");
      run.snapshot.status = 200;
    } catch {
      run.snapshot.status = 404;
    }
  } else {
    const r = await fetch(`${sign}/evm-index/base.json`, { signal: AbortSignal.timeout(READ_MS) }).catch((e) => ({ status: `error ${e?.name ?? e}` }));
    run.snapshot.status = r.status;
    text = typeof r.text === "function" && r.status === 200 ? await r.text() : undefined;
  }
  run.snapshot.bytes = text?.length ?? 0;
  let ix = null;
  try {
    ix = text === undefined ? null : evmPoolIndexFromSnapshot(JSON.parse(text), { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap });
  } catch {
    ix = null;
  }
  if (ix !== null) Object.assign(run.snapshot, { through: ix.through, pools: ix.pools.length });
  for (const url of v.providers) {
    if (run.heads.length === 2) break;
    const a = await rpcAnswer(url, "eth_blockNumber", [], { headers: { origin: sign }, timeoutMs: READ_MS });
    if (typeof a.result === "string" && /^0x[0-9a-f]+$/i.test(a.result)) run.heads.push(Number(a.result));
  }
  if (ix !== null) {
    const t0 = performance.now();
    const { sync, served } = await evmPoolIndexRefresh("base", ix).catch(() => ({ sync: null, served: false }));
    const st = sync?.stats;
    run.sync = { ms: Math.round(performance.now() - t0), served, coversThrough: sync?.coversThrough ?? null, ...(st ? { requests: st.requests, getLogs: st.getLogs, limited: st.limited } : {}) };
  }
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = await read(arg("--sign") ?? SIGN, arg("--site") ?? null);
    if (arg("--record") !== undefined) writeFileSync(arg("--record"), JSON.stringify(run, null, 1) + "\n");
    const { ok, lines } = check(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.sign}${run.site ? `, ${run.site}` : ""})`);
    process.exit(ok ? EXIT.PASS : EXIT.FAIL);
  } catch (e) {
    console.error(`live-check ${KEY}: error ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
