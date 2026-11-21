#!/usr/bin/env node
// Live check of card helper-robinhood-route-serves-a-device-sync: a device's Robinhood pool index sync through the
// deployed helper's keyed route (POST /v1/rpc/robinhood?keyed=only, the kit's second index reader, buy-unpinned.ts
// `index`) is never refused by the helper's own limiter while the page's other reads have spent the address's share.
// On 21 Nov a fresh device's first Robinhood quote at a 6-day snapshot age met one 429 from this route on each of
// three runs, 34-35 s each: the sync drew on the same share of 30 in 10 s as the passes (packages/wallet/src/pool/
// buy-wallets.ts), and the kit holds a reader 30 s on a 429 (quote.ts EVM_PROVIDER_HOLD_MS). The helper now gives the
// index's reads their own allowance per address (apps/helper/src/rpc/rpc.ts INDEX_CLIENT).
// One run, from one address: one sync from SIGN_HOST's Robinhood snapshot cut back AGE_DAYS (the kit's
// evmPoolIndexRefresh, both its readers, as the device runs it), every post to the route kept, and beside it for the
// whole sync the page's other reads on this route at the share less ROOM, N - ROOM calls in 10 s spread evenly, each an
// eth_blockNumber: the passes are 18 in 10 s a tab (buy-wallets.ts), two tabs 36, past the share, so a page may hold
// the share at its edge, and the sync's head read (one call on the share) must still fit. 18 a tab alone left the share
// room enough at main: 23 passes and the sync's 12 posts answered 200 (21 Nov 17:2xZ), where a 29-call spend before it
// had the head read refused, Retry-After 1, and the sync took 43.1 s (17:1xZ). Judged:
// - the route names a caller's share (RateLimit-Policy "client";q=N) past ROOM, and the page's other reads came at
//   least HELD of N - ROOM in each 10 s of the sync (a run that never held the share at its edge proves nothing);
// - every pass read and every post of the sync to the route answered 200, none 429, and the kit counted no limited
//   batch on the route;
// - the sync ended whole, served (the index the kit keeps), through at least the snapshot's own block.
// The sync's time is printed, not judged: Robinhood's own RPC, its other reader, sets most of it. A snapshot not read, or
// a sync that ended unserved with Robinhood's own RPC refusing it while the route answered every post, is INCONCLUSIVE.
// Reads only: no key, no transaction, no money moves.
// After: helper
// Serial: evm-keyed 415 (its reads at the share's edge and its sync draw the helper's keyed Robinhood providers)
//   node scripts/live-checks/helper-robinhood-route-serves-a-device-sync.mjs [--helper <origin>] [--sign <origin>]
//     [--record <file>]. PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes the run for the
//     test's replay.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { evmPoolIndexFromSnapshot, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

const KEY = "helper-robinhood-route-serves-a-device-sync";
export const HELPER = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** The share's calls in 10 s the page's other reads leave: the sync's head read, and two for the passes' spacing
 *  against the helper's fixed window (limits.ts clientWindow). */
export const ROOM = 3;
/** The least share of N - ROOM a 10 s the other reads must have come at over the sync (their answers' time comes off it). */
export const HELD = 0.8;
/** The snapshot's age the card names. */
export const AGE_DAYS = 6;
/** Robinhood's own blocks a day: 1,641,600 in 47.7 h (scripts/live-checks/evm-pool-index.mjs AGED, read 21 Nov). */
export const BLOCKS_A_DAY = Math.round((1_641_600 / 47.7) * 24);
const READ_MS = 30_000;

/** The route's share for one caller in its window, from its RateLimit-Policy ("client";q=N;w=10), or null. */
export const shareOf = (policy) => {
  const m = /"client";q=(\d+);w=(\d+)/.exec(policy ?? "");
  return m === null ? null : Number(m[1]);
};

/** One run: { policy, passes: [status], snapshot: { status, through }, sync: { served, coversThrough, ms, limited } | null,
 *  posts: [{ at, ms, status, retryAfter, calls, methods }] } (posts: the sync's to the route alone). */
export async function read(helper = HELPER, sign = SIGN, fetchFn = fetch) {
  const route = `${helper.replace(/\/$/, "")}/v1/rpc/robinhood?keyed=only`;
  // one of the page's other reads, through rpcAnswer: its status as the judge reads it, 200 for an answer, 429 for the
  // route's refusal (a no-answer rpcAnswer names "HTTP 429"), else its words
  const statusOf = (a) => (a.noAnswer !== undefined ? (/\bHTTP 429\b/.test(a.noAnswer) ? 429 : `no answer (${a.noAnswer})`) : a.error !== undefined ? `error ${JSON.stringify(a.error).slice(0, 80)}` : 200);
  const ask = (id) => rpcAnswer(route, "eth_blockNumber", [], { fetchFn, timeoutMs: READ_MS, keep: ["ratelimit-policy"], id });
  const v = mainnetVenues().robinhood;
  const s = await fetchFn(`${sign.replace(/\/$/, "")}/evm-index/robinhood.json`, { signal: AbortSignal.timeout(READ_MS) }).catch(() => null);
  const snap = s !== null && s.status === 200 ? await s.json().catch(() => null) : null;
  if (snap === null || !Number.isSafeInteger(snap.through)) return { policy: null, passes: [], snapshot: { status: s?.status ?? "not read" }, sync: null, posts: [] };
  const cut = snap.through - AGE_DAYS * BLOCKS_A_DAY;
  const aged = { ...snap, through: cut, spans: snap.spans.filter((x) => x[0] <= cut).map((x) => [x[0], Math.min(x[1], cut)]), pools: snap.pools.filter((p) => p[5] <= cut) };
  const ix = evmPoolIndexFromSnapshot(aged, { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap });
  const posts = [];
  const t0 = performance.now();
  const kept = async (input, init) => {
    const u = String(input instanceof Request ? input.url : input);
    const at = Math.round(performance.now() - t0);
    let methods = [];
    try {
      const b = JSON.parse(String(init?.body ?? ""));
      methods = (Array.isArray(b) ? b : [b]).map((x) => x.method);
    } catch {}
    const one = (status, r) => ({ at, ms: Math.round(performance.now() - t0) - at, status, retryAfter: r?.headers.get("retry-after") ?? null, wait: /\brpc-wait;dur=(\d+)/.exec(r?.headers.get("server-timing") ?? "")?.[1] ?? null, calls: methods.length, methods: [...new Set(methods)].join(",") });
    let r;
    try {
      r = await fetchFn(input, init);
    } catch (e) {
      // a post the kit gave up on (its 10 s time limit) is the route's too: kept as no answer
      if (u === route) posts.push(one(`no answer (${e?.name ?? e})`));
      throw e;
    }
    if (u === route) posts.push(one(r.status, r));
    return r;
  };
  // the page's other reads beside the sync: the share less ROOM in each 10 s, spread evenly, from its start to its end
  const first = await ask(0);
  const policy = first.kept?.["ratelimit-policy"] ?? null;
  const share = shareOf(policy);
  if (share === null || share <= ROOM) return { policy, passes: [statusOf(first)], snapshot: { status: s.status, through: snap.through, aged: cut }, sync: null, posts: [] };
  const passes = [statusOf(first)];
  let syncing = true;
  // each read sent on its turn, not after the last one's answer: the answers' time never slows the pace
  const sent = [];
  const passing = (async () => {
    const start = performance.now();
    for (let i = 1; syncing; i++) {
      sent.push(ask(i).then(statusOf, () => "no answer"));
      const left = start + (i * 10_000) / (share - ROOM) - performance.now();
      if (left > 0 && syncing) await new Promise((f) => setTimeout(f, left));
    }
  })();
  const { sync, served } = ix === null ? { sync: null, served: false } : await evmPoolIndexRefresh("robinhood", ix, kept).catch(() => ({ sync: null, served: false }));
  syncing = false;
  await passing;
  passes.push(...(await Promise.all(sent)));
  return {
    policy,
    passes,
    snapshot: { status: s.status, through: snap.through, aged: cut },
    sync: sync === null ? null : { served, coversThrough: sync.coversThrough, ms: sync.stats.ms, limited: sync.stats.limited, failed: sync.stats.failed },
    posts,
  };
}

/** The verdict on one recorded run: { verdict: PASS | FAIL | INCONCLUSIVE, lines }. */
export function judge(run) {
  const lines = [];
  let fail = false;
  let open = false;
  const say = (ok, text) => {
    if (ok === false) fail = true;
    if (ok === null) open = true;
    lines.push(`${ok === true ? "ok " : ok === null ? "N/A" : "BAD"} ${text}`);
  };
  const snap = run?.snapshot ?? {};
  if (snap.status !== 200 || run?.sync === null || run?.sync === undefined) {
    say(null, `Robinhood's snapshot HTTP ${snap.status ?? "not read"}${snap.status === 200 ? ", the sync ended in a throw" : ""}`);
    return { verdict: "INCONCLUSIVE", lines };
  }
  const share = shareOf(run?.policy);
  say(share !== null && share > ROOM, `the route's share for one caller: ${share ?? "no RateLimit-Policy"} in 10 s, the page's other reads ${share === null ? "none" : share - ROOM} of it`);
  const passes = Array.isArray(run?.passes) ? run.passes : [];
  const passRefused = passes.filter((x) => x !== 200);
  const least = share === null ? Infinity : Math.floor((share - ROOM) * (run.sync.ms / 10_000) * HELD);
  say(passes.length >= least, `the page's other reads held the share at its edge: ${passes.length} in ${run.sync.ms} ms, at least ${least}`);
  say(passes.length > 0 && passRefused.length === 0, `the page's other reads beside the sync: ${passes.length - passRefused.length} of ${passes.length} answered 200${passRefused.length > 0 ? ` (${passRefused.join(", ")})` : ""}`);
  const posts = Array.isArray(run?.posts) ? run.posts : [];
  const refused = posts.filter((p) => p.status !== 200);
  say(posts.length > 0 && refused.length === 0, `the sync's ${posts.length} posts to the route: ${refused.length === 0 ? "every one 200" : refused.map((p) => `${p.status} at ${p.at} ms${p.retryAfter ? ` (Retry-After ${p.retryAfter})` : ""}`).join(", ")}`);
  const y = run?.sync;
  if (y) {
    say((y.limited?.[1] ?? 0) === 0, `the kit counted ${y.limited?.[1] ?? 0} limited batch(es) on the route`);
    const whole = y.served === true && Number.isSafeInteger(y.coversThrough) && y.coversThrough >= snap.through;
    const ownRefused = (y.limited?.[0] ?? 0) > 0 || (y.failed?.[0] ?? 0) > 0;
    say(whole || (ownRefused && refused.length === 0 ? null : false), `the sync from ${AGE_DAYS} days back (block ${snap.aged}) ended ${whole ? "whole" : "not whole"}, through ${y.coversThrough ?? "none"} (the snapshot's ${snap.through}), in ${y.ms} ms; Robinhood's own: ${y.limited?.[0] ?? 0} limited, ${y.failed?.[0] ?? 0} failed`);
  }
  return { verdict: fail ? "FAIL" : open ? "INCONCLUSIVE" : "PASS", lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  try {
    const run = await read(opt("--helper") ?? HELPER, opt("--sign") ?? SIGN);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ at: new Date().toISOString(), ...run }, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`${verdict} ${KEY}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.log(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
