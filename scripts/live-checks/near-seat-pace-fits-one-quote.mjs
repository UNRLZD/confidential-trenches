#!/usr/bin/env node
// Live check of card near-seat-pace-fits-one-quote: one NEAR buy box quote's reads at its block go out on the helper's
// FastNEAR seat (POST /v1/rpc/near?keyed=only, packages/kit/src/near/networks.ts NEAR_NETWORKS seat) in one burst, and
// the helper answers every one: no 429 from its own pace for FastNEAR's key (apps/helper/src/limits/limits.ts KEYED_PACE
// fastnear, 60 a second, 120 at once, from Dev's published "up to 10,000" requests a minute per key,
// docs.fastnear.com/pricing, read 2026-11-18 02:50Z), from the route's pacer (rpc.ts RPC_KEYED_TOTAL near, 600 a 10 s)
// or from the caller's share (RPC_PAGE_NEED near, 90), and none from FastNEAR. Before it (5 a second, 5 at once, the
// route's 100 a 10 s), a quote's 29 seat reads took about 5 s of the helper's turns or met its 429. This reads, after
// every helper deploy:
//   - the seat's final block (Rhea's metadata at finality final), as a quote reads its block first;
//   - then QUOTE_READS reads at that block, all sent at once with the page's Origin, as the page's pace of the seat
//     (packages/wallet/src/pace.ts PACE.seat, 30 at once) sends one quote's reads: Rhea's metadata, wrap.near's
//     ft_metadata and view_account, each at the block.
// Every HTTP answer's status is kept as it came, the first try included (provider-answer.mjs reads a no-answer again
// once, which would hide a first 429). It passes when the final block reads and every read of the burst answers 200
// with a JSON-RPC answer on its first try; a 429 on any try is a FAIL (one quote does not fit the seat's burst); a 5xx or
// no answer is a provider down, INCONCLUSIVE, never a pass. About 30 reads of the seat, nothing signed, no money.
// After: helper
//   node scripts/live-checks/near-seat-pace-fits-one-quote.mjs [--record <file>]
//   node scripts/live-checks/near-seat-pace-fits-one-quote.mjs --answer <file>     judge a recorded run, no network
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "<verdict> near-seat-pace-fits-one-quote".
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT, pageRefuses, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "near-seat-pace-fits-one-quote";
export const SIGN = "https://confidential.unrealized.trade";
/** The seat as the page names it (NEAR_NETWORKS.mainnet.seat; the test holds the two equal). */
export const SEAT = "https://ct-api.unrealized.trade/v1/rpc/near?keyed=only";
/** One NEAR quote's seat reads at its block with every list kept: DCL 19, Rhea 4, the final block, decimals, the fee
 *  cap about 4 (the app lead's count, 18 Nov 02:39Z); 18 once near-quote-inside-the-kpi lands. The larger is read. */
export const QUOTE_READS = 29;
/** The most ms between the burst's first send and its last: one burst, as the page's pace lets one quote out. */
export const BURST_MS = 100;
const EXCHANGE = "v2.ref-finance.near";
const WRAP = "wrap.near";
const fn = (account_id, method_name, at) => ({ request_type: "call_function", account_id, method_name, args_base64: "e30=", ...at });
/** The burst's i-th read at block `at`: Rhea's metadata, wrap.near's ft_metadata and view_account in turn. */
export const readOf = (i, at) => [fn(EXCHANGE, "metadata", at), fn(WRAP, "ft_metadata", at), { request_type: "view_account", account_id: WRAP, ...at }][i % 3];

/** The verdict on a run { final: { statuses, status, acao, noAnswer? | error? | height }, burst: [{ i, sentMs, statuses,
 *  status, acao, ok, why? }] }: { verdict, ok, lines, exit }. `statuses`: every HTTP status the read met, first try first. */
export function judge(a) {
  const lines = [];
  let quiet = false;
  const say = (ok, m) => lines.push(`${ok ? "OK" : "BAD"} ${m}`);
  const no = (m) => ((quiet = true), lines.push(`NO-ANSWER ${m}`));
  const met429 = (x) => Array.isArray(x?.statuses) && x.statuses.includes(429);
  const f = a?.final;
  const refusedFinal = pageRefuses(SEAT, f, SIGN);
  if (met429(f)) say(false, "the seat's final block read met 429");
  else if (refusedFinal !== null && f?.noAnswer === undefined) say(false, refusedFinal);
  else if (f?.noAnswer !== undefined) no(`the seat's final block read: ${f.noAnswer}`);
  else if (!Number.isSafeInteger(f?.height)) say(false, `the seat's final block read: ${f?.error !== undefined ? `error ${JSON.stringify(f.error).slice(0, 80)}` : "no block height"}`);
  else say(true, `the seat read Rhea's metadata at final ${f.height}`);
  const burst = Array.isArray(a?.burst) ? a.burst : [];
  if (Number.isSafeInteger(f?.height) && !met429(f)) {
    const refused = burst.filter(met429);
    const down = burst.find((x) => !met429(x) && !x.ok);
    const spread = burst.length === 0 ? 0 : Math.max(...burst.map((x) => x.sentMs)) - Math.min(...burst.map((x) => x.sentMs));
    if (burst.length !== QUOTE_READS) say(false, `the burst: ${burst.length} reads recorded, one quote is ${QUOTE_READS}`);
    else if (spread > BURST_MS) say(false, `the burst: its reads were sent over ${spread} ms, not at once (at most ${BURST_MS})`);
    else if (refused.length > 0) say(false, `the burst: ${refused.length} of ${QUOTE_READS} reads met 429 (first read ${refused[0].i + 1}): one quote's reads do not fit the seat's burst`);
    else if (down) no(`the burst: read ${down.i + 1} not served (${down.why ?? `HTTP ${down.status}`}): a provider down, not the pace`);
    else say(true, `the burst: ${QUOTE_READS} of ${QUOTE_READS} reads at block ${f.height} served on their first try, sent within ${spread} ms, the last answered at ${Math.max(...burst.map((x) => x.doneMs ?? 0))} ms`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { verdict, ok: verdict === "PASS", lines, exit: EXIT[verdict] };
}

/** One NEAR query as the page sends it: every HTTP status it met (a fetch that keeps them), its last status and
 *  allow-origin, and its block height or why not. */
async function ask(params, fetchFn) {
  const statuses = [];
  const keeping = async (url, init) => {
    const r = await fetchFn(url, init);
    statuses.push(r.status);
    return r;
  };
  const a = await rpcAnswer(SEAT, "query", params, { fetchFn: keeping, headers: { origin: SIGN }, redirect: "error" });
  const out = { statuses, status: a.status ?? null, acao: a.acao ?? null };
  if (a.noAnswer !== undefined) out.noAnswer = String(a.noAnswer).slice(0, 160);
  else if (a.error !== undefined) out.error = a.error;
  else if (a.result?.error !== undefined) out.error = a.result.error;
  else out.height = a.result?.block_height;
  return out;
}

/** Reads the seat as one quote does: its final block, then QUOTE_READS reads at that block, all at once. */
export async function read(fetchFn = fetch, { clock = () => performance.now(), wall = Date.now } = {}) {
  const run = { at: new Date(wall()).toISOString() };
  run.final = await ask(fn(EXCHANGE, "metadata", { finality: "final" }), fetchFn);
  if (!Number.isSafeInteger(run.final.height) || run.final.statuses.includes(429)) return run;
  const at = { block_id: run.final.height };
  const t0 = clock();
  run.burst = await Promise.all(
    Array.from({ length: QUOTE_READS }, async (_, i) => {
      const sentMs = Math.round(clock() - t0);
      const q = await ask(readOf(i, at), fetchFn);
      const ok = q.noAnswer === undefined && q.status === 200 && q.error === undefined && q.statuses.length === 1;
      const base = { i, sentMs, doneMs: Math.round(clock() - t0), statuses: q.statuses, status: q.status, acao: q.acao, ok };
      return ok ? base : { ...base, why: q.noAnswer ?? (q.error !== undefined ? `error ${JSON.stringify(q.error).slice(0, 80)}` : `HTTP ${q.statuses.join(", then ")}`) };
    }),
  );
  return run;
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(run)}\n`);
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}`);
    process.exit(v.exit);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
