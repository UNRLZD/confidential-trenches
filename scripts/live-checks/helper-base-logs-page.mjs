#!/usr/bin/env node
// Live check of card helper-base-logs-page: HELPER_HOST's keyed Base route (POST /v1/rpc/base?keyed=only), the signing
// page's log seat when its public Base providers are blocked, answers an eth_getLogs over 10,000 blocks. Its keyed list
// is QuickNode's trial (5 blocks) and dRPC's free keys (100 blocks), so before the card the route answered 503 upstream
// past 100 blocks (live 15 Nov 02:37Z) and a pool withdraw sent from such a page was never read back; the helper now pages
// the range inside dRPC's span and joins the pages (apps/helper/src/rpc/rpc.ts pagedLogs).
// The read: the Base pool's logs (the kit's pin 0xaa08…99cf) over blocks 57,490,000 to 57,499,999, finalized, which hold
// 11 of its logs (base-rpc.publicnode.com, 15 Nov 02:5xZ), with the signing page's Origin; the same read on
// base-rpc.publicnode.com, which serves 50,000 blocks a read, is the reference.
//   - the helper's 503, 400, any other refusal or a JSON-RPC error (its range cap included): FAIL;
//   - its 200 result list: PASS when it holds a log and is the reference's, log for log (block, index, transaction, data
//     and topics); else FAIL;
//   - a 429 from the helper, or no answer from the reference: INCONCLUSIVE (exit 3), the moment's, never the build's.
// After: helper
//   node scripts/live-checks/helper-base-logs-page.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read (each HTTP answer as
//   it came), so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { classify, EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "helper-base-logs-page";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const REFERENCE = "https://base-rpc.publicnode.com";
export const POOL = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
export const FROM = 57_490_000;
export const TO = 57_499_999;
export const FILTER = Object.freeze({ address: POOL, fromBlock: `0x${FROM.toString(16)}`, toBlock: `0x${TO.toString(16)}` });
const cut = (s) => String(s).slice(0, 160);
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);
/** A log as compared: its place, transaction, data and topics, lower case. */
const logKey = (l) => JSON.stringify([lower(l?.blockNumber), lower(l?.logIndex), lower(l?.transactionHash), lower(l?.data), (Array.isArray(l?.topics) ? l.topics : []).map(lower)]);

/** The check on one recorded run: { reads: [{ who: "helper" | "reference", status, body }] }, the last HTTP answer of
 *  each (a no-answer is read again once). */
export function judge({ reads }) {
  const lines = [];
  let bad = false, quiet = false;
  const say = (ok, text) => ((bad ||= !ok), lines.push(`${ok ? "ok " : "BAD"} ${text}`));
  const h = reads.findLast((x) => x.who === "helper");
  const ref = reads.findLast((x) => x.who === "reference");
  if (!h) {
    say(false, "helper: no read");
    return { verdict: verdictOf(bad, quiet), lines };
  }
  let helper = null;
  if (h.status === 429) (quiet = true), lines.push(`--  helper: 429, busy (${cut(h.body)})`);
  else if (h.status !== 200) say(false, `helper: ${h.status} on ${TO - FROM + 1} blocks, it does not serve the range (${cut(h.body)})`);
  else {
    const a = classify(new URL(BASE).host, h.status, h.body, { page: true });
    if (a.noAnswer !== undefined) (quiet = true), lines.push(`--  helper: ${a.noAnswer}`);
    else if (a.error !== undefined) say(false, `helper: a JSON-RPC error on ${TO - FROM + 1} blocks: ${cut(JSON.stringify(a.error))}`);
    else if (!Array.isArray(a.result)) say(false, `helper: not a log list: ${cut(JSON.stringify(a.result))}`);
    else helper = a.result;
  }
  let want = null;
  if (!ref) (quiet = true), lines.push("--  reference: no read");
  else {
    const a = classify(new URL(REFERENCE).host, ref.status, ref.body);
    if (a.noAnswer !== undefined || !Array.isArray(a.result)) (quiet = true), lines.push(`--  reference: ${a.noAnswer ?? cut(JSON.stringify(a.error ?? a.result))}`);
    else want = a.result;
  }
  if (helper !== null) {
    say(helper.length > 0, `helper: ${helper.length} log(s) over ${TO - FROM + 1} blocks`);
    if (want !== null) {
      const same = helper.length === want.length && helper.every((l, i) => logKey(l) === logKey(want[i]));
      say(same, `helper's logs are the reference's, in order (${helper.length} vs ${want.length})`);
    }
  }
  return { verdict: verdictOf(bad, quiet), lines };
}

export async function read(base = BASE, fetchFn = fetch, reference = REFERENCE) {
  const reads = [];
  const ask = (who, url, opts) => {
    // each HTTP answer kept as it came, so the record replays through the shared module's own reading
    const keep = async (u, init) => {
      const r = await fetchFn(u, init);
      const body = await r.text();
      reads.push({ who, readAt: new Date().toISOString(), status: r.status, body });
      return new Response(body, { status: r.status, headers: r.headers });
    };
    return rpcAnswer(url, "eth_getLogs", [FILTER], { fetchFn: keep, timeoutMs: 14_000, ...opts });
  };
  await ask("helper", `${base.replace(/\/$/, "")}/v1/rpc/base?keyed=only`, { headers: { origin: SIGN }, redirect: "manual" });
  await ask("reference", reference, {});
  return { base, reads };
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
