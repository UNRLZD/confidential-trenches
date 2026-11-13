#!/usr/bin/env node
// Live check of card near-quote-under-the-pace: the mainnet signing page reads NEAR's FastNEAR seat through the
// helper's POST /v1/rpc/near?keyed=only (FastNEAR's key at its pace, packages/kit/src/near/networks.ts NEAR_NETWORKS
// seat), dRPC device-direct, and the helper gives one page its busiest 10 s there with no 429 (apps/helper/src/rpc/
// rpc.ts RPC_PAGE_NEED near, 30). Before it, the page read FastNEAR's keyless URL at 0.39 a second: its two height reads
// skewed (lag refusals), and a quote took 12.8 s at p50 (the read-only mainnet build of 12 Nov). This reads, after
// every sign and helper deploy:
//   - SIGN_HOST's index.html and the /app.js it pins (its sha384): the served script names the seat's URL;
//   - the seat's CORS answer to the page's origin (the preflight of a JSON POST, and the POST's allow-origin);
//   - Rhea's metadata on the seat at the final block, then at that block less a few on the seat and on dRPC: one
//     block hash, the same bytes (the seat and dRPC are a pair the page can trust when they agree);
//   - then WINDOW cheap reads (view_account of "near") in one of the helper's fixed 10 s windows, spread over
//     SPREAD_MS, each after the last answered, as the page's reads spread under its own pace of the seat.
// It passes when the script names the seat, the seat allows the page's origin, the two seats agree, and every read of
// the window answers 200 with a JSON-RPC answer. A 429 in the window is a FAIL (the helper refused one page's
// busiest 10 s); a 5xx or no answer is a provider down, INCONCLUSIVE, never a pass. Every read goes through
// provider-answer.mjs with the page's Origin. About 34 reads of the seat and one of dRPC, nothing signed, no money.
// After: sign helper
// Bundle: out the helper's NEAR seat (its CORS answer to the page's origin, a mainnet read beside dRPC's, one page's 10 s window of reads); the bundle's naming of the seat is held by packages/kit/test/near-networks.test.ts and the page's wiring by packages/signpage/src/main.ts
//   node scripts/live-checks/near-quote-under-the-pace.mjs [--record <file>]
//   node scripts/live-checks/near-quote-under-the-pace.mjs --answer <file>     judge a recorded run, no network
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "<verdict> near-quote-under-the-pace".
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT, pageRefuses, preflight, preflightRefuses, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "near-quote-under-the-pace";
export const SIGN = "https://confidential.unrealized.trade";
/** The seat as the page names it (NEAR_NETWORKS.mainnet.seat; the test holds the two equal), and dRPC's NEAR URL. */
export const SEAT = "https://ct-api.unrealized.trade/v1/rpc/near?keyed=only";
export const DRPC = "https://near.drpc.org";
/** One page's busiest 10 s on the seat (RPC_PAGE_NEED near; the test holds the two equal). */
export const WINDOW = 30;
export const WINDOW_MS = 10_000;
const INTO_WINDOW_MS = 1_000;
export const SPREAD_MS = 7_000;
/** The pair read is this many blocks under the seat's final, so dRPC has it too. */
export const BACK = 5;
const EXCHANGE = "v2.ref-finance.near";
const metadata = (at) => ({ request_type: "call_function", account_id: EXCHANGE, method_name: "metadata", args_base64: "e30=", ...at });
const VIEW = { request_type: "view_account", finality: "final", account_id: "near" };
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const sha256 = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The verdict on a run { index, app: { sha384, names }, preflight, final: post, pair: { seat: post, drpc: post },
 *  window: { reads: [{ i, status, ok, why? }] } }, each post { status, acao, noAnswer? | error? | height, hash, sha256 }:
 *  { verdict, ok, lines, exit }. */
export function judge(a) {
  const lines = [];
  let quiet = false;
  const say = (ok, m) => lines.push(`${ok ? "OK" : "BAD"} ${m}`);
  const no = (m) => ((quiet = true), lines.push(`NO-ANSWER ${m}`));
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  say(pin !== undefined && pin === a?.app?.sha384, "the served /app.js is the one index.html pins");
  say((a?.app?.names ?? []).includes(SEAT), `the page's script names the seat ${SEAT}`);
  const p = a?.preflight;
  const off = preflightRefuses(SEAT, p, SIGN);
  if (off !== null) say(false, off);
  else if (p?.noAnswer !== undefined) no(p.noAnswer);
  else say(true, `the seat's preflight from ${SIGN}: ${p.status}, allow-origin ${p.acao}`);
  // a post's answer: refused by the page, no answer, a JSON-RPC error, or a read
  const post = (what, url, q) => {
    const refused = pageRefuses(url, q, SIGN);
    if (refused !== null) return say(false, refused), null;
    if (q?.noAnswer !== undefined) return no(`${what}: ${q.noAnswer}`), undefined;
    if (q?.error !== undefined || !Number.isSafeInteger(q?.height) || typeof q?.hash !== "string" || typeof q?.sha256 !== "string")
      return say(false, `${what}: ${q?.error !== undefined ? `error ${JSON.stringify(q.error).slice(0, 80)}` : "no block height, hash or result"}`), null;
    return q;
  };
  const final = post("the seat's final read", SEAT, a?.final);
  if (final) say(true, `the seat read Rhea's metadata at final ${final.height}`);
  const s = post("the seat's pair read", SEAT, a?.pair?.seat);
  const d = post("dRPC's pair read", DRPC, a?.pair?.drpc);
  if (s && d) {
    const same = s.height === d.height && s.hash === d.hash && s.sha256 === d.sha256;
    say(same, same ? `the seat and dRPC agree at ${s.height} (block ${s.hash.slice(0, 12)}, result ${s.sha256.slice(0, 12)})` : `the seat and dRPC disagree: ${JSON.stringify({ seat: [s.height, s.hash, s.sha256.slice(0, 12)], drpc: [d.height, d.hash, d.sha256.slice(0, 12)] })}`);
  }
  const reads = Array.isArray(a?.window?.reads) ? a.window.reads : [];
  const refused = reads.find((x) => x.status === 429);
  const down = reads.find((x) => x.status !== 429 && !x.ok);
  if (refused) say(false, `the window: read ${refused.i + 1} of ${WINDOW} refused 429: the helper does not give one page its busiest 10 s on the seat`);
  else if (down) no(`the window: read ${down.i + 1} not served (${down.why ?? `HTTP ${down.status}`}): a provider down, not the share`);
  else if (reads.length !== WINDOW) say(false, `the window: ${reads.length} reads recorded, the window is ${WINDOW}`);
  else say(true, `the window: ${WINDOW} of ${WINDOW} served in one 10 s window`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { verdict, ok: verdict === "PASS", lines, exit: EXIT[verdict] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One NEAR query as the page sends it, kept small: its status, allow-origin, and the block and the result's hash. */
async function ask(url, params, fetchFn) {
  const a = await rpcAnswer(url, "query", params, { fetchFn, headers: { origin: SIGN }, redirect: "error" });
  const out = { status: a.status ?? null, acao: a.acao ?? null };
  if (a.noAnswer !== undefined) out.noAnswer = a.noAnswer;
  else if (a.error !== undefined) out.error = a.error;
  else if (a.result?.error !== undefined) out.error = a.result.error;
  else Object.assign(out, { height: a.result?.block_height, hash: a.result?.block_hash, sha256: sha256(a.result?.result ?? a.result?.amount ?? null) });
  return out;
}

/** Reads SIGN_HOST, the seat and dRPC as the page does. `clock` is the epoch ms (tests move it in `wait`). */
export async function read(fetchFn = fetch, { wait = sleep, clock = Date.now } = {}) {
  const index = await (await fetchFn(`${SIGN}/`, { signal: AbortSignal.timeout(20_000) })).text();
  const js = await (await fetchFn(`${SIGN}/app.js`, { signal: AbortSignal.timeout(20_000) })).text();
  const run = { at: new Date(clock()).toISOString(), index, app: { sha384: sha384(js), names: [SEAT].filter((u) => ['"', "'", "`"].some((q) => js.includes(`${q}${u}${q}`))) } };
  run.preflight = await preflight(SEAT, SIGN, { fetchFn });
  run.final = await ask(SEAT, metadata({ finality: "final" }), fetchFn);
  if (Number.isSafeInteger(run.final.height)) {
    const at = { block_id: run.final.height - BACK };
    run.pair = { seat: await ask(SEAT, metadata(at), fetchFn), drpc: await ask(DRPC, metadata(at), fetchFn) };
  }
  const now = clock();
  const start = Math.ceil((now - INTO_WINDOW_MS) / WINDOW_MS) * WINDOW_MS + INTO_WINDOW_MS + WINDOW_MS; // the next whole window
  await wait(Math.max(0, start - now));
  const reads = [];
  for (let i = 0; i < WINDOW; i++) {
    const left = start + Math.round((i * SPREAD_MS) / WINDOW) - clock();
    if (left > 0) await wait(left);
    const a = await rpcAnswer(SEAT, "query", VIEW, { fetchFn, headers: { origin: SIGN }, redirect: "error" });
    const ok = a.noAnswer === undefined && a.status === 200;
    reads.push(ok ? { i, status: a.status, ok } : { i, status: a.status ?? null, ok, why: String(a.noAnswer ?? `HTTP ${a.status}`).slice(0, 120) });
    if (!ok) break; // the window's verdict is named: nothing more is sent
  }
  run.window = { reads };
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
