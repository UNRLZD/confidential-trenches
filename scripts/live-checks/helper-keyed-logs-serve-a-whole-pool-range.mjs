#!/usr/bin/env node
// Live check of card helper-keyed-logs-serve-a-whole-pool-range: HELPER_HOST's keyed Base route (POST
// /v1/rpc/base?keyed=only) answers one eth_getLogs of the Base pool (the kit's pin 0xaa08…99cf) over its whole finalized
// life, from its deploy block 54,325,671, as a fresh device's restore walk asks it (packages/wallet/src/pool/evm.ts
// wideOf). Base's keyed list serves 100 blocks a call (QuickNode's trial 5, dRPC's free keys 100), so before the card the
// route's pages reached 10,000 blocks and refused the pool's 3.6 million with "eth_getLogs range too wide, maximum block
// range: 10000" (live at release 158); the helper now keeps the pool's logs in its store (apps/helper/src/rpc/pool-logs.ts)
// and answers any range of it from there.
// The read: blocks 54,325,671 to the reference's finalized head less TAIL_BLOCKS, with the signing page's Origin; the
// same range on base-rpc.publicnode.com, which serves 50,000 blocks a read, page by page, is the reference.
//   - the helper's 200 result list: PASS when it holds a log, is the reference's log for log (block, index, transaction,
//     data and topics) and came within HELPER_MS; else FAIL;
//   - the helper's range cap naming how far its store is ("pool logs kept to block N" in the error's data): its store
//     still filling after a cold start, INCONCLUSIVE (exit 3); any other refusal or JSON-RPC error (the old cap
//     included): FAIL;
//   - a 429 from the helper, or no answer from the reference: INCONCLUSIVE, the moment's, never the build's.
// After: helper
// Serial: evm-keyed 45
//   node scripts/live-checks/helper-keyed-logs-serve-a-whole-pool-range.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read (each HTTP answer as
//   it came), so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { classify, EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "helper-keyed-logs-serve-a-whole-pool-range";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const REFERENCE = "https://base-rpc.publicnode.com";
export const POOL = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
export const FROM = 54_325_671;
/** Blocks left off the reference's finalized head, so the range is finalized on the helper's own head read too (it reads
 *  it at most every 10 s, rpc.ts FINAL_HEAD_MS). [design: 1,000 blocks, 200 s of Base at 200 ms a block.] */
export const TAIL_BLOCKS = 1_000;
/** The reference's page, its own cap (PublicNode's "maximum block range: 50000"). */
export const REF_PAGE = 50_000;
/** The longest the helper's one read may take. [design: 5 s: an answer from the store sends nothing upstream; the
 *  device's sign-in waits on it.] */
export const HELPER_MS = 5_000;
const cut = (s) => String(s).slice(0, 160);
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);
const hex = (n) => `0x${n.toString(16)}`;
/** A log as compared: its place, transaction, data and topics, lower case. */
const logKey = (l) => JSON.stringify([lower(l?.blockNumber), lower(l?.logIndex), lower(l?.transactionHash), lower(l?.data), (Array.isArray(l?.topics) ? l.topics : []).map(lower)]);
const KEPT = /^pool logs kept to block (\d{1,20})$/;

/** The check on one recorded run: { to, reads: [{ who: "head" | "helper" | "reference", status, body, ms? }] }. */
export function judge({ to, reads }) {
  const lines = [];
  let bad = false, quiet = false;
  const say = (ok, text) => ((bad ||= !ok), lines.push(`${ok ? "ok " : "BAD"} ${text}`));
  const h = reads.findLast((x) => x.who === "helper");
  if (!Number.isSafeInteger(to) || to <= FROM) {
    lines.push("--  reference: no finalized head");
    return { verdict: verdictOf(bad, true), lines };
  }
  const blocks = to - FROM + 1;
  if (!h) {
    say(false, "helper: no read");
    return { verdict: verdictOf(bad, quiet), lines };
  }
  let helper = null;
  if (h.status === 429) (quiet = true), lines.push(`--  helper: 429, busy (${cut(h.body)})`);
  else if (h.status !== 200) say(false, `helper: ${h.status} on ${blocks} blocks, it does not serve the range (${cut(h.body)})`);
  else {
    const a = classify(new URL(BASE).host, h.status, h.body, { page: true });
    const kept = typeof a.error?.data === "string" ? KEPT.exec(a.error.data) : null;
    if (a.noAnswer !== undefined) (quiet = true), lines.push(`--  helper: ${a.noAnswer}`);
    else if (kept !== null) (quiet = true), lines.push(`--  helper: its pool store is still filling, kept to block ${kept[1]} of ${to}`);
    else if (a.error !== undefined) say(false, `helper: a JSON-RPC error on ${blocks} blocks: ${cut(JSON.stringify(a.error))}`);
    else if (!Array.isArray(a.result)) say(false, `helper: not a log list: ${cut(JSON.stringify(a.result))}`);
    else helper = a.result;
  }
  // the reference's pages, in order, each its own last answer (a no-answer is read again once)
  const pages = [];
  for (const x of reads) if (x.who === "reference" && Number.isSafeInteger(x.page) && x.page >= 0) pages[x.page] = x;
  let want = [];
  for (const p of pages) {
    if (p === undefined) {
      (quiet = true), lines.push("--  reference: a page not read");
      want = null;
      break;
    }
    const a = classify(new URL(REFERENCE).host, p.status, p.body);
    if (a.noAnswer !== undefined || !Array.isArray(a.result)) {
      (quiet = true), lines.push(`--  reference: ${a.noAnswer ?? cut(JSON.stringify(a.error ?? a.result))}`);
      want = null;
      break;
    }
    want.push(...a.result);
  }
  if (want !== null && pages.length !== Math.ceil(blocks / REF_PAGE)) (quiet = true), lines.push(`--  reference: ${pages.length} pages read of ${Math.ceil(blocks / REF_PAGE)}`), (want = null);
  if (helper !== null) {
    say(helper.length > 0, `helper: ${helper.length} log(s) over ${blocks} blocks in one read`);
    say(Number.isFinite(h.ms) && h.ms <= HELPER_MS, `helper: answered in ${h.ms} ms (at most ${HELPER_MS})`);
    if (want !== null) {
      const same = helper.length === want.length && helper.every((l, i) => logKey(l) === logKey(want[i]));
      say(same, `helper's logs are the reference's, in order (${helper.length} vs ${want.length})`);
    }
  }
  return { verdict: verdictOf(bad, quiet), lines };
}

export async function read(base = BASE, fetchFn = fetch, reference = REFERENCE) {
  const reads = [];
  // each HTTP answer kept as it came, so the record replays through the shared module's own reading
  const keeper = (who, page) => async (u, init) => {
    const t0 = performance.now();
    const r = await fetchFn(u, init);
    const body = await r.text();
    reads.push({ who, readAt: new Date().toISOString(), status: r.status, body, ...(who === "helper" ? { ms: Math.round(performance.now() - t0) } : {}), ...(page === undefined ? {} : { page }) });
    return new Response(body, { status: r.status, headers: r.headers });
  };
  const head = await rpcAnswer(reference, "eth_getBlockByNumber", ["finalized", false], { fetchFn: keeper("head") });
  const n = typeof head.result?.number === "string" ? Number(BigInt(head.result.number)) : NaN;
  const to = Number.isSafeInteger(n) ? n - TAIL_BLOCKS : null;
  if (to === null || to <= FROM) return { base, to, reads };
  await rpcAnswer(`${base.replace(/\/$/, "")}/v1/rpc/base?keyed=only`, "eth_getLogs", [{ address: POOL, fromBlock: hex(FROM), toBlock: hex(to) }], { fetchFn: keeper("helper"), timeoutMs: 14_000, headers: { origin: SIGN }, redirect: "manual" });
  for (let a = FROM, i = 0; a <= to; a += REF_PAGE, i++) {
    const r = await rpcAnswer(reference, "eth_getLogs", [{ address: POOL, fromBlock: hex(a), toBlock: hex(Math.min(a + REF_PAGE - 1, to)) }], { fetchFn: keeper("reference", i) });
    if (r.noAnswer !== undefined) break;
  }
  return { base, to, reads };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
