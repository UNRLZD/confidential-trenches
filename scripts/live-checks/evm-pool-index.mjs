#!/usr/bin/env node
// Live check of card evm-pool-index: the device's index of every v4 pool (packages/kit/src/checks/evm/pool-index.ts)
// can be proven on each chain's two index readers as the kit lists them (evmPoolVenues(), through the kit's public
// entry). For Base and Robinhood it reads, as the index does, the newest SPANS spans of `index.span` blocks below N,
// the lower of the two readers' heads: on each reader one batch a span, its Initialize logs and its last block. It
// passes when, on each chain:
//   - the venue lists an index: two readers on two operators (another registrable domain), the first never ours (the
//     device reaches it directly) and the second at most the helper's keyed route for the chain,
//     /v1/rpc/{chain}?keyed=only (card signpage-evm-reads-draw-no-refusal: the money rule's attacker is a broken-in
//     helper, which as one of two readers can make the index refuse, never add or hide a pool), each chain's span (Base
//     10,000 blocks; Robinhood 500,000, which only Robinhood's own and the helper's keyed route serve), the card's margin
//     (Base 474, Robinhood 7,119) and a cap;
//   - each reader answers the browser's CORS preflight of a JSON POST from the app's origin, and its POST, allowing it
//     (the device reads them from the page);
//   - every span is answered on both readers, within TRIES tries each (the kit's INDEX_TRIES: a reader a block behind
//     is asked again, its own head read in the same batch), with its last block in the same batch, under INDEX_SPAN_LOGS logs, the
//     same last-block hash on both (block N's is the pin) and the same pools on both (by pool id), at least one pool in
//     all, each batch within the kit's RPC timeout (10 s);
//   - each reader answers, within TRIES tries, the receipts of the transactions of each span's first RECEIPTS pools,
//     asked as the kit asks them (pool-index.ts: one batch of at most INDEX_RECEIPT_BATCH, 10, which evmJsonRpc splits
//     where the reader refuses it for its size, keeping the reader's most calls a batch: card
//     evm-batch-fits-each-reader, base.api.pocket.network 413 past 5 since 2026-11-18; a request that throws
//     and a receipt answered null or with a rate limit are asked again, anything else is final: review 3 of 7f1ad79a,
//     base.api.pocket.network answered null for 119 of 500 mined Initialize transactions; review 4 of 43f8e45f), each
//     in the span and holding the PoolManager's Initialize of its pool.
//   Every batch is read as the kit reads it (quote.ts evmJsonRpc, pool-index.ts `ask`): an HTTP 429 waits its
//   Retry-After without spending a try, up to the kit's 60 s a batch, and any other status outside 2xx, or an answer that
//   is not a batch, spends one (card robinhood-index-second-reader-serves-receipts: the helper's keyed route refused the
//   third batch of receipts 429 at its 30 requests a caller each 10 s, which the check read as ten receipts answered null).
// What it proves, and only that: the readers the deployed kit names serve the index's reads and agree. That quotes read
// their pools from the index is card evm-pool-index-route's check.
// After: app
// Bundle: out EVM RPC index reads on the venue's two index readers
//   node scripts/live-checks/evm-pool-index.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run, for the test's replay (evm-pool-index.answers.json:
// its bad answer is this script run in a checkout of the kit before this card). Reads only: no key, no transaction, no
// money moves.
// Record: what the run read; a live run that fails keeps it beside its log
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mainnetVenues } from "./mainnet-venues.mjs";

export const KEY = "evm-pool-index";
export const APP_ORIGIN = "https://ct-app.unrealized.trade";
export const OURS = /(^|\.)unrealized\.trade$/i;
export const CHAINS = Object.freeze({ base: { margin: 474, span: 10_000 }, robinhood: { margin: 7_119, span: 500_000 } });
/** The one reader of ours an index may name: the helper's keyed route for the chain, second, never first. */
export const HELPER_READER = (chain) => `https://ct-api.unrealized.trade/v1/rpc/${chain}?keyed=only`;
export const SPANS = 3;
export const SPAN_LOGS = 10_000;
export const TIMEOUT_MS = 10_000;
/** A span's or a receipt's tries on one reader, and the wait before each try past the first: the kit's own (pool-index.ts
 *  INDEX_TRIES and BACKOFF_MS * 2 ** n: 1, 2 then 4 s, which the kit's entry does not export), so a supplier the kit
 *  waits out does not fail a good deploy (review 5 of 610ffe32: base.api.pocket.network needed 4 tries in 3 of 40
 *  batches of 10 receipts, a fixed 1.5 s wait about 3-5% false FAILs a run). */
export const TRIES = 4;
export const BACKOFF_MS = 500;
export const waitBefore = (tries) => BACKOFF_MS * 2 ** (tries - 1);
/** The longest one batch waits on a reader's HTTP 429s, each its Retry-After and never less than the doubling backoff,
 *  spending no try, before a 429 spends one as any failure does: the kit's INDEX_LIMITED_WAIT_MS (pool-index.ts `ask`,
 *  which the kit's entry does not export). Card robinhood-index-second-reader-serves-receipts: the helper's keyed route
 *  takes 30 requests a caller each 10 s (RateLimit-Policy "client";q=30;w=10) and answered this check's 8th Robinhood
 *  post, its third batch of 10 receipts, 429 {"error":{"code":"rate_limited"}} with Retry-After 5 (2026-11-20 01:4xZ
 *  from this Mac; live app runs 44651054036 and 44441930508), which the check read as ten receipts answered null. */
export const LIMITED_WAIT_MS = 60_000;
/** Receipts read a span on each reader, in one batch: the kit's INDEX_RECEIPT_BATCH. */
export const RECEIPTS = 10;
/** A rate limit answered inside a batch, in the kit's words (pool-index.ts `limited`, which the kit does not export). */
const LIMITED = /request limit|rate limit|too many requests|exceeded its compute units per second/i;
const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

const operator = (u) => new URL(u).hostname.split(".").slice(-2).join(".");

/** The verdict on a run: { chains: { [chain]: { index, preflight, heads, spans } } }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const [chain, want] of Object.entries(CHAINS)) {
    const c = run?.chains?.[chain];
    const ix = c?.index;
    if (!ix) {
      say(false, `${chain}: the kit's venue lists no index`);
      continue;
    }
    const rs = Array.isArray(ix.readers) ? ix.readers : [];
    say(rs.length === 2 && operator(rs[0]) !== operator(rs[1]), `${chain}: two index readers on two operators: ${rs.join(", ")}`);
    say(rs.length === 2 && !OURS.test(new URL(rs[0]).hostname) && (!OURS.test(new URL(rs[1]).hostname) || rs[1] === HELPER_READER(chain)), `${chain}: no reader is ours but the second, the helper's keyed route ${HELPER_READER(chain)}`);
    say(ix.span === want.span && ix.margin === want.margin && Number.isInteger(ix.cap) && ix.cap > 0, `${chain}: span ${ix.span} (the card's ${want.span}), margin ${ix.margin} (the card's ${want.margin}), cap ${ix.cap}`);
    for (const u of rs) {
      const p = c.preflight?.[u];
      const allows = (v) => v === "*" || v === APP_ORIGIN;
      say(p !== undefined && p.status >= 200 && p.status < 300 && allows(p.allow) && /content-type|\*/i.test(p.headers ?? "") && allows(p.post), `${chain}: ${u} preflight from ${APP_ORIGIN}: ${p ? `${p.status}, allow-origin ${p.allow}, allow-headers ${p.headers}; POST allow-origin ${p.post}` : "not read"}`);
    }
    const heads = c.heads ?? [];
    say(heads.length === 2 && heads.every((h) => Number.isInteger(h)), `${chain}: both readers answered a head: ${heads.join(", ")}`);
    const n = Math.min(...heads);
    // the kit refuses two heads more than the reorg margin apart (pool-index.ts): a reader that far behind is no reader
    say(Math.max(...heads) - Math.min(...heads) <= want.margin, `${chain}: the two heads ${Math.max(...heads) - Math.min(...heads)} blocks apart, the margin ${want.margin} at most`);
    const spans = c.spans ?? [];
    say(spans.length === SPANS && spans[0]?.b === n, `${chain}: ${spans.length} spans read, the newest ending at N ${n}`);
    let pools = 0;
    for (const s of spans) {
      const [x, y] = s.on ?? [];
      const both = x && y && typeof x.last === "string" && typeof y.last === "string";
      say(both, `${chain} ${s.a}-${s.b}: both readers answered it with its last block in the same batch`);
      if (!both) continue;
      say(x.last === y.last, `${chain} ${s.a}-${s.b}: the same last block on both${s.b === n ? " (the pin)" : ""}: ${x.last.slice(0, 10)} ${y.last.slice(0, 10)}`);
      say(x.logs < SPAN_LOGS && y.logs < SPAN_LOGS, `${chain} ${s.a}-${s.b}: under ${SPAN_LOGS} logs (${x.logs}, ${y.logs})`);
      const same = JSON.stringify([...x.ids].sort()) === JSON.stringify([...y.ids].sort());
      say(same, `${chain} ${s.a}-${s.b}: the same ${x.ids.length} pools on both${same ? "" : ` (${y.ids.length} on the second)`}`);
      say(x.ms <= TIMEOUT_MS && y.ms <= TIMEOUT_MS && (x.tries ?? 1) <= TRIES && (y.tries ?? 1) <= TRIES, `${chain} ${s.a}-${s.b}: answered in ${x.ms} and ${y.ms} ms, try ${x.tries ?? 1} and ${y.tries ?? 1}`);
      pools += x.ids.length;
      if (x.ids.length === 0) continue;
      const want = Math.min(RECEIPTS, x.ids.length);
      say(s.txs?.length === want && Array.isArray(s.receipts) && s.receipts.length === 2 && s.receipts.every((rs) => Array.isArray(rs) && rs.length === want), `${chain} ${s.a}-${s.b}: its first ${want} pools' receipts read on both readers`);
      for (const [r, rs] of (s.receipts ?? []).entries()) {
        const good = Array.isArray(rs) ? rs.filter((rc) => rc?.block >= s.a && rc.block <= s.b && rc.init === true && rc.tries <= TRIES).length : 0;
        const tries = Array.isArray(rs) ? Math.max(0, ...rs.map((rc) => rc?.tries ?? 0)) : 0;
        say(good === want, `${chain} ${s.a}-${s.b}: reader ${r + 1} answered ${good} of ${want} receipts in the span with their Initialize, try ${tries} at most${good === want ? "" : `: ${JSON.stringify((rs ?? []).find((rc) => !(rc?.init === true)) ?? null)}`}`);
      }
    }
    say(pools > 0, `${chain}: ${pools} pools in the newest ${SPANS * want.span} blocks`);
  }
  return { pass: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

/** A Retry-After header in ms (seconds or an HTTP date), or null. */
const retryAfterMs = (h) => {
  if (h === null || h === undefined || h === "") return null;
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
};

/** Each reader's most calls a batch, where it refused one for its size this run: the kit's own (pace.ts evmBatchMost,
 *  kept for the page's life; card evm-batch-fits-each-reader). */
export const MOST = new Map();
/** A reader's answer that refuses a batch for its size, in the kit's words (quote.ts sizeRefusal, which the kit's entry
 *  does not export): HTTP 413 whatever its body (base.api.pocket.network past 5 calls, 2026-11-18 20:41Z), or a 4xx or
 *  200 whose error names a batch and a size or limit and no rate limit. Returns the maximum it names (null: none), or
 *  undefined where it is no size refusal. */
export function sizeRefusal(status, text) {
  if (status >= 500 || (status > 200 && status < 400)) return undefined;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { message: text };
  }
  const msgs = (Array.isArray(j) ? j.slice(0, 1_000) : [j]).flatMap((a) => (a && typeof a === "object" && a.error?.code !== 3 ? [a.message, a.error?.message] : [])).filter((m) => typeof m === "string" && !/^execution reverted/i.test(m)).map((m) => m.slice(0, 500));
  const m = msgs.find((x) => /\bbatch\b/i.test(x) && /too large|too big|exceed|more than|more items|maximum|\bmax\b|\blimit\b|\bsize\b/i.test(x) && !LIMITED.test(x));
  if (m === undefined) return status === 413 ? null : undefined;
  const k = /\b(\d{1,9})\b/.exec(m);
  return k === null ? null : Number(k[1]);
}
/** One batch to a reader as the kit's evmJsonRpc sends it (quote.ts): past the reader's kept most calls it leaves as
 *  parts, all at once; a batch of more than one call it refuses for its size (sizeRefusal) is asked again as parts of at
 *  most half (or the maximum its refusal names, where smaller and at least 1), and that size is kept for the run. Then,
 *  as the kit reads a status: HTTP 429 is a rate limit, thrown with its Retry-After (ask waits it out, a part's 429 the
 *  whole batch's, as the kit's); any other status outside 2xx is a failure, never an answer to read; and an answer that
 *  is not a batch counts only for a batch of one call, by its id. Answers by the caller's ids. */
async function post(url, body, fetchFn) {
  const t = performance.now();
  const most = MOST.get(url) ?? Infinity;
  if (body.length > most) {
    const parts = [];
    for (let i = 0; i < body.length; i += most) parts.push(body.slice(i, i + most));
    const outs = await Promise.all(parts.map((p) => post(url, p, fetchFn)));
    return { byId: new Map(outs.flatMap((o) => [...o.byId])), ms: Math.round(performance.now() - t) };
  }
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  const said = body.length > 1 ? sizeRefusal(r.status, text) : undefined;
  if (said !== undefined) {
    const half = Math.max(1, Math.floor(body.length / 2));
    MOST.set(url, Math.min(most, Number.isSafeInteger(said) && said >= 1 ? Math.min(half, said) : half));
    const again = await post(url, body, fetchFn);
    return { byId: again.byId, ms: Math.round(performance.now() - t) };
  }
  if (r.status === 429) throw Object.assign(new Error("the reader answered HTTP 429"), { limited: true, afterMs: retryAfterMs(r.headers.get("retry-after")) });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`the reader answered HTTP ${r.status}`);
  const j = JSON.parse(text);
  if (!Array.isArray(j) && !(body.length === 1 && j !== null && typeof j === "object")) throw new Error(`the reader's answer is not a batch: ${String(JSON.stringify(j)).slice(0, 80)}`);
  const arr = Array.isArray(j) ? j : [j];
  return { byId: new Map(arr.map((a) => [a?.id, a])), ms: Math.round(performance.now() - t) };
}

/** One batch on reader `u` as the kit's pool-index `ask` sends it: an HTTP 429 waits its Retry-After, never less than
 *  the doubling backoff, and spends no try, up to LIMITED_WAIT_MS of waiting a batch; past it, or on any other failure,
 *  it throws, which spends the caller's try. `limitedMs`: the time it waited on 429s. */
export async function ask(u, body, fetchFn, sleep) {
  let waited = 0;
  let waits = 0;
  for (;;) {
    try {
      return { ...(await post(u, body, fetchFn)), limitedMs: waited };
    } catch (e) {
      if (e?.limited !== true || waited >= LIMITED_WAIT_MS) throw e;
      const ms = Math.min(Math.max(e.afterMs ?? 0, BACKOFF_MS * 2 ** waits++), LIMITED_WAIT_MS - waited);
      waited += ms;
      await sleep(ms);
    }
  }
}

/** One reader's answer to the span a..b: its Initialize logs, its last block and its own head, in one batch, asked
 *  again up to TRIES times (the kit's INDEX_TRIES) while it does not hold the last block yet, as the index asks it, so a
 *  supplier a block behind that catches up does not fail a good deploy. */
export async function readSpan(u, pm, a, b, fetchFn, sleep) {
  let last = null;
  for (let tries = 1; tries <= TRIES; tries++) {
    try {
      const { byId, ms, limitedMs } = await ask(u, [
        { jsonrpc: "2.0", id: 0, method: "eth_getLogs", params: [{ address: pm, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics: [INITIALIZE] }] },
        { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
      ], fetchFn, sleep);
      const logs = byId.get(0)?.result;
      const blk = byId.get(1)?.result;
      const head = byId.get(2)?.result;
      last = { logs: Array.isArray(logs) ? logs.length : -1, ids: Array.isArray(logs) ? logs.map((l) => String(l?.topics?.[1]).toLowerCase()) : [], firsts: Array.isArray(logs) ? logs.slice(0, RECEIPTS).map((l) => ({ tx: String(l?.transactionHash).toLowerCase(), id: String(l?.topics?.[1]).toLowerCase() })) : [], last: typeof blk?.hash === "string" && Number(blk.number) === b ? blk.hash.toLowerCase() : null, head: typeof head === "string" ? Number(head) : null, ms, tries, ...(limitedMs > 0 ? { limitedMs } : {}) };
    } catch (e) {
      last = { logs: -1, ids: [], last: null, head: null, ms: TIMEOUT_MS + 1, tries, error: String(e?.message ?? e).slice(0, 120) };
    }
    if (last.last !== null && last.logs >= 0) return last;
    if (tries < TRIES) await sleep(waitBefore(tries + 1));
  }
  return last;
}

/** One reader's receipts of `firsts` ({ tx, id }), in one batch as the kit asks them: each one's block and whether it
 *  holds the PoolManager's Initialize of its pool. A request that throws, and a receipt answered null or with a rate
 *  limit, are asked again up to TRIES times; any other answer is final (pool-index.ts). */
export async function readReceipts(u, pm, firsts, fetchFn, sleep) {
  const out = firsts.map(() => null);
  let left = firsts.map((_, i) => i);
  for (let tries = 1; tries <= TRIES && left.length > 0; tries++) {
    if (tries > 1) await sleep(waitBefore(tries));
    try {
      const { byId, ms, limitedMs } = await ask(u, left.map((i) => ({ jsonrpc: "2.0", id: i, method: "eth_getTransactionReceipt", params: [firsts[i].tx] })), fetchFn, sleep);
      const lim = limitedMs > 0 ? { limitedMs } : {};
      const again = [];
      for (const i of left) {
        const a = byId.get(i);
        const rc = a?.result;
        const { tx, id } = firsts[i];
        if (rc === null || (rc === undefined && LIMITED.test(String(a?.error?.message ?? "")))) {
          out[i] = { block: null, init: false, ms, tries, answer: rc === null ? "null" : "limited", ...lim };
          again.push(i);
        } else if (rc && typeof rc === "object" && !Array.isArray(rc)) {
          const init = Array.isArray(rc.logs) && rc.logs.some((l) => String(l?.address).toLowerCase() === pm.toLowerCase() && String(l?.topics?.[0]).toLowerCase() === INITIALIZE && String(l?.topics?.[1]).toLowerCase() === id && String(l?.transactionHash).toLowerCase() === tx);
          out[i] = { block: Number(rc.blockNumber), init, ms, tries, ...lim };
        } else out[i] = { block: null, init: false, ms, tries, answer: a === undefined ? "none with its id" : String(JSON.stringify(a?.error ?? rc ?? null)).slice(0, 120), ...lim };
      }
      left = again;
    } catch (e) {
      for (const i of left) out[i] = { block: null, init: false, ms: TIMEOUT_MS + 1, tries, error: String(e?.message ?? e).slice(0, 120) };
    }
  }
  return out;
}

/** One run's reads on the venue list `venues`. */
export async function read(venues, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const chains = {};
  for (const chain of Object.keys(CHAINS)) {
    const v = venues[chain];
    const ix = v?.index;
    if (!ix) {
      chains[chain] = { index: null };
      continue;
    }
    const index = { readers: [...ix.readers], span: ix.span, margin: ix.margin, cap: ix.cap };
    const preflight = {};
    for (const u of ix.readers) {
      try {
        const r = await fetchFn(u, { method: "OPTIONS", headers: { Origin: APP_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const p = await fetchFn(u, { method: "POST", headers: { Origin: APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(TIMEOUT_MS) });
        await p.text();
        preflight[u] = { status: r.status, allow: r.headers.get("access-control-allow-origin"), headers: r.headers.get("access-control-allow-headers"), post: p.headers.get("access-control-allow-origin") };
      } catch (e) {
        preflight[u] = { status: 0, allow: null, headers: null, post: null, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) };
      }
    }
    const heads = await Promise.all(ix.readers.map(async (u) => {
      const h = await ask(u, [{ jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] }], fetchFn, sleep).then((x) => x.byId.get(0)?.result, () => null);
      return typeof h === "string" ? Number(h) : null;
    }));
    const n = Math.min(...heads.filter((h) => h !== null));
    const spans = [];
    for (let i = 0; i < SPANS; i++) {
      const b = n - i * ix.span;
      const a = b - ix.span + 1;
      const on = await Promise.all(ix.readers.map((u) => readSpan(u, v.poolManager, a, b, fetchFn, sleep)));
      const firsts = on[0]?.firsts ?? [];
      const receipts = firsts.length > 0 ? await Promise.all(ix.readers.map((u) => readReceipts(u, v.poolManager, firsts, fetchFn, sleep))) : undefined;
      spans.push({ a, b, on, ...(receipts ? { txs: firsts.map((f) => f.tx), receipts } : {}) });
    }
    // each reader's most calls a batch where it refused one for its size (the kit splits its batches to it)
    const most = Object.fromEntries(ix.readers.filter((u) => MOST.has(u)).map((u) => [u, MOST.get(u)]));
    chains[chain] = { index, preflight, heads, spans, ...(Object.keys(most).length > 0 ? { most } : {}) };
  }
  return { at: new Date().toISOString(), chains };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const run = await read(mainnetVenues());
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run) + "\n");
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    console.log(`${v.pass ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(v.pass ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
