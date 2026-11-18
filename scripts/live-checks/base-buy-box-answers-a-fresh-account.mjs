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
// Judged, on Base and on Robinhood (card evm-snapshots-fresh-at-every-cut: Robinhood's 16 Nov snapshot was 1,550,613
// blocks behind on 18 Nov): each served snapshot reads back (pools, a block), the chain's head is read on two providers
// within SNAPSHOT_HEAD_SPREAD_MAX of each other, the snapshot is at most SNAPSHOT_BEHIND_MAX behind the lower head and
// never past it, and one sync from it on the venue's two index readers, as the device runs it (kit evmPoolIndexRefresh),
// ends whole within SYNC_MAX_MS. The bounds are the release cut's own (packages/signpage/scripts/release-list.mjs, 12
// hours and 2 minutes at each chain's measured rate; release.test.mjs holds the two tables equal), so a list the cut
// takes passes here after its deploy. Reads only: no key, no transaction, no money moves.
// After: sign
// Bundle: out SIGN_HOST's EVM snapshots and each chain's head
//   node scripts/live-checks/base-buy-box-answers-a-fresh-account.mjs [--sign <origin>] [--site <dir>] [--record <file>]
//     --site reads the snapshots from a build folder (<dir>/evm-index/<chain>.json) instead of SIGN_HOST: a commit's run
//     before its deploy. PASS exit 0, FAIL exit 1, error exit 2. --record writes the run for the test's replay.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evmPoolIndexFromSnapshot, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

const KEY = "base-buy-box-answers-a-fresh-account";
export const SIGN = "https://confidential.unrealized.trade";
/** The chains judged and their bounds, the release cut's (release-list.mjs SNAPSHOT_BEHIND_MAX and
 *  SNAPSHOT_HEAD_SPREAD_MAX): 12 hours and 2 minutes at Base's 5 and Robinhood's 9.5 blocks a second. */
export const MAX_BEHIND = Object.freeze({ base: 216_000, robinhood: 410_400 });
export const HEAD_SPREAD_MAX = Object.freeze({ base: 600, robinhood: 1_140 });
export const CHAINS = Object.freeze(Object.keys(MAX_BEHIND));
/** The longest one sync from a served snapshot may take: half the dry's index wait (EVM_DRY_INDEX_WAIT_MS 20 s), so
 *  the first quote starts on the index with time left inside the box's watch. */
export const SYNC_MAX_MS = 10_000;
const READ_MS = 30_000;

/** One chain's lines over its read { snapshot: { status, bytes, through?, pools? }, heads: [n|null, n|null],
 *  sync: { ms, served, coversThrough, requests, getLogs, limited } | null }. */
function chainLines(chain, c, say) {
  const s = c?.snapshot ?? {};
  const read = s.status === 200 && Number.isSafeInteger(s.through) && Number.isSafeInteger(s.pools) && s.pools > 0;
  say(read, `[${chain}] snapshot HTTP ${s.status ?? "not read"}, ${s.bytes ?? 0} bytes, ${s.pools ?? 0} pools, through ${s.through ?? "none"}`);
  const heads = (c?.heads ?? []).filter((h) => Number.isSafeInteger(h) && h > 0);
  const spread = heads.length === 2 ? Math.max(...heads) - Math.min(...heads) : null;
  if (heads.length < 2) say(false, `[${chain}] head read on ${heads.length} of 2 providers`);
  else if (spread > HEAD_SPREAD_MAX[chain]) say(false, `[${chain}] the providers' heads ${heads[0]} and ${heads[1]} are ${spread} blocks apart (at most ${HEAD_SPREAD_MAX[chain]})`);
  else if (read) {
    const head = Math.min(...heads);
    const behind = head - s.through;
    const rate = MAX_BEHIND[chain] / 43_200;
    say(behind >= 0 && behind <= MAX_BEHIND[chain], `[${chain}] snapshot ${behind} blocks behind the head ${head} (at most ${MAX_BEHIND[chain]}, about ${Math.round(behind / rate / 3600)} h at ${rate} blocks a second)`);
  }
  const y = c?.sync;
  say(y?.served === true && Number.isFinite(y.ms) && y.ms <= SYNC_MAX_MS, `[${chain}] a fresh device's sync from it ${y ? `${y.served ? "whole" : "partial"} in ${y.ms} ms, ${y.requests?.join("+") ?? "?"} posts, ${y.getLogs?.join("+") ?? "?"} getLogs, ${y.limited?.join("+") ?? "?"} limited` : "not run"} (at most ${SYNC_MAX_MS} ms)`);
}

/** The verdict on a run { sign, chains: { <chain>: chain read } }: { ok, lines }. A run recorded before Robinhood was
 *  judged ({ snapshot, heads, sync } at its top) is Base's read alone, and Robinhood unread fails. */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok " : "BAD"} ${text}`);
  };
  const chains = run?.chains ?? (run?.snapshot ? { base: { snapshot: run.snapshot, heads: run.heads, sync: run.sync } } : {});
  for (const chain of CHAINS) chainLines(chain, chains[chain], say);
  return { ok, lines };
}

/** One chain's read: its served (or `site`'s) snapshot, its head on the first two providers that name it, and one sync
 *  from the snapshot on the venue's index readers. */
async function readChain(chain, v, sign, site) {
  const c = { snapshot: {}, heads: [], sync: null };
  let text;
  if (site !== null) {
    try {
      text = readFileSync(path.join(site, "evm-index", `${chain}.json`), "utf8");
      c.snapshot.status = 200;
    } catch {
      c.snapshot.status = 404;
    }
  } else {
    const r = await fetch(`${sign}/evm-index/${chain}.json`, { signal: AbortSignal.timeout(READ_MS) }).catch((e) => ({ status: `error ${e?.name ?? e}` }));
    c.snapshot.status = r.status;
    text = typeof r.text === "function" && r.status === 200 ? await r.text() : undefined;
  }
  c.snapshot.bytes = text?.length ?? 0;
  let ix = null;
  try {
    ix = text === undefined ? null : evmPoolIndexFromSnapshot(JSON.parse(text), { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap });
  } catch {
    ix = null;
  }
  if (ix !== null) Object.assign(c.snapshot, { through: ix.through, pools: ix.pools.length });
  for (const url of v.providers) {
    if (c.heads.length === 2) break;
    const a = await rpcAnswer(url, "eth_blockNumber", [], { headers: { origin: sign }, timeoutMs: READ_MS });
    if (typeof a.result === "string" && /^0x[0-9a-f]+$/i.test(a.result)) c.heads.push(Number(a.result));
  }
  if (ix !== null) {
    const t0 = performance.now();
    const { sync, served } = await evmPoolIndexRefresh(chain, ix).catch(() => ({ sync: null, served: false }));
    const st = sync?.stats;
    c.sync = { ms: Math.round(performance.now() - t0), served, coversThrough: sync?.coversThrough ?? null, ...(st ? { requests: st.requests, getLogs: st.getLogs, limited: st.limited } : {}) };
  }
  return c;
}

/** One run: each chain's read, one after the other (a sync's posts never share a provider's pace with another's). */
export async function read(sign = SIGN, site = null, venues = mainnetVenues()) {
  const run = { sign, site: site === null ? null : "a build folder at SIGN_HOST's name", at: new Date().toISOString(), chains: {} };
  for (const chain of CHAINS) run.chains[chain] = await readChain(chain, venues[chain], sign, site);
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
