#!/usr/bin/env node
// Live check of card evm-sell-hook-intrablock: on Robinhood mainnet a ban's evidence reads the reverted trade's own
// trace on the venue's trace pair (packages/kit/src/trade/evm/buy-unpinned.ts traceProviders: dRPC and Pocket) and
// replays at that prestate with ArbOS's state left out (packages/kit/src/checks/evm/quote.ts tracedPre, preOverOf). Bans
// there hold only while both providers serve the trace and the replay is taken, so this reads, for the newest Robinhood
// transactions that call a contract (no transaction of ours, nothing signed):
//   - each trace provider's debug_traceTransaction, prestateTracer (disableCode) and callTracer, each its own request as
//     the kit asks them, both answering, the two prestates equal as JSON and each holding ArbOS's state account (Nitro's
//     block-start state is in the trace);
//   - the replay: an eth_call at the transaction's parent with the block's number, time and base fee and its prestate,
//     ArbOS's state left out, as the state override, on two operators of the kit's Robinhood read list
//     (evmReadProvidersOf; card device-evm-fee-read-walks-operators): each runs it (an output or an execution revert).
//     A seat that refuses the block's state (dRPC's code 27 "Unknown state", a pruned node's "historical state ... is
//     not available", "missing trie node") or gives no JSON-RPC answer is walked past to the list's next operator, and
//     the replay holds only on two operators (the kit's evmRpcOperator) that ran it; any other refusal (the override
//     refused, as with ArbOS's state kept) fails. Robinhood's own, Pocket and publicnode each ran an eth_call with a state
//     and a block override at a parent block (read 2026-11-10 21:1xZ). The outcome itself is shown, not judged: a
//     replay may differ from the real run (a 7 Nov 16:24Z read found one: 0xed59ff1c in block 108542534 succeeded, its
//     replay reverted), which is why no ban rests on a replay alone.
// A trace is kept as read time's digest (sha-256 of the prestate's sorted JSON, its accounts, the call frame's error and
// output), so a record stays small.
// It passes when at least 3 transactions were read and every read and replay holds. It runs after every app deploy
// (apps/terminal/scripts/deploy.mjs LIVE_CHECKS): the kit ships in the app's bundle and its bans fail open, so a pin
// that changes or a provider that stops serving traces would turn Robinhood's trace evidence off without a sound.
// After: app
//   node scripts/live-checks/evm-sell-hook-intrablock.mjs [--record <file>]
// A provider that does not know the transaction or its block yet (Robinhood makes a block every 0.1 s, and the newest
// transactions are a second or so old: a trace answered null or "not found", a replay seat's "header not found" or
// "unknown block") is read again, LAG_TRIES times LAG_WAIT_MS apart, and still behind on the last read is INCONCLUSIVE
// naming it (`lagging`), never FAIL; a provider that knows them and answers wrong still fails.
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. Reads only.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { evmRpcOperator } from "../../packages/kit/src/index.ts";

const KEY = "evm-sell-hook-intrablock";
/** A provider behind the transaction or its block: read again this often, this far apart (the wallet's EVM_LAG_TRIES and
 *  EVM_LAG_WAIT_MS). */
export const LAG_TRIES = 5;
export const LAG_WAIT_MS = 2_000;
const NOT_KNOWN = /not found|unknown block|unknown transaction|header not found/i;
/** An answer (a JSON-RPC answer, or a batch of them) from a provider that does not hold the transaction or block yet. */
export const notKnown = (a) => [a].flat().some((x) => x && typeof x === "object" && (("result" in x && x.result === null) || NOT_KNOWN.test(String(x.error?.message ?? ""))));
const ARBOS = "0xa4b05fffffffffffffffffffffffffffffffffff";
const COUNT = 3;

const post = async (url, body, fetchFn) => {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { http: r.status, body: t.slice(0, 200) };
  }
};
const qty = (v) => "0x" + BigInt(v).toString(16);
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return String(u);
  }
};
/** The kit's override from a prestate: every account but ArbOS's state (the kit's preOverOf, without its bounds). */
export function overOf(pre) {
  const out = {};
  for (const [a, v] of Object.entries(pre ?? {})) {
    if (a.toLowerCase() === ARBOS) continue;
    out[a] = { ...(v.balance ? { balance: v.balance } : {}), ...(v.nonce !== undefined ? { nonce: qty(v.nonce) } : {}), ...(v.code ? { code: v.code } : {}), ...(v.storage && Object.keys(v.storage).length ? { stateDiff: v.storage } : {}) };
  }
  return out;
}

/** A trace answer's digest: the batch [prestateTracer, callTracer] both answered, or what came back instead. */
export function digestOf(answer) {
  const ok = Array.isArray(answer) && answer.length === 2 && answer.every((x) => x && typeof x.result === "object" && x.result !== null);
  if (!ok) return { ok: false, answer: JSON.stringify(answer).slice(0, 300) };
  const pre = answer.find((x) => x.id === 1)?.result ?? {};
  const call = answer.find((x) => x.id === 2)?.result ?? {};
  const sorted = JSON.stringify(Object.entries(pre).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { ok: true, pre: createHash("sha256").update(sorted).digest("hex"), accounts: Object.keys(pre).map((a) => a.toLowerCase()).sort(), error: call.error ?? null, output: call.output ?? null };
}

/** A replay's answer: it ran (an output or an execution revert). */
const ranOf = (a) => typeof a?.result === "string" || (a?.error?.code === 3 && /execution reverted/i.test(String(a?.error?.message ?? "")));
/** A seat's refusal that is the seat's, not the replay's: the block's state not kept, or no JSON-RPC answer. */
const STATE_REFUSED = /unknown state|historical state \S* ?is not available|missing trie node|header not found/i;
const seatRefused = (a) => !ranOf(a) && (a?.http !== undefined || a?.error === undefined ? a?.result === undefined : STATE_REFUSED.test(String(a.error?.message ?? "")));

/** A replay seat still behind the block on its last read: walked past, as a seat's own refusal. */
const behindOf = (r) => r?.lagging === true && notKnown(r.answer);

/** The verdict on a run { trace: [url, url], quote: [url, url], txs: [{ hash, traces: [{ url, digest }], replays: [{ url, answer }] }] }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const txs = Array.isArray(run?.txs) ? run.txs : [];
  say(Array.isArray(run?.trace) && run.trace.length === 2 && run.trace[0] !== run.trace[1], `the kit's Robinhood trace pair: ${JSON.stringify(run?.trace)}`);
  say(txs.length >= COUNT, `transactions read: ${txs.length} (want ${COUNT} or more)`);
  for (const t of txs) {
    const h = String(t.hash).slice(0, 10);
    const tr = Array.isArray(t.traces) ? t.traces : [];
    const behind = tr.filter((x) => x.digest?.ok !== true && x.lagging === true);
    if (behind.length > 0) {
      for (const x of behind) lines.push(`--  [${h}] ${hostOf(x.url)} did not know the transaction yet after ${LAG_TRIES} reads ${LAG_WAIT_MS} ms apart: INCONCLUSIVE`);
      for (const x of tr.filter((y) => !behind.includes(y))) say(x.digest?.ok === true, `[${h}] ${x.url} answers both traces: ${x.digest?.ok === true ? "yes" : x.digest?.answer}`);
      continue;
    }
    for (const x of tr) say(x.digest?.ok === true, `[${h}] ${x.url} answers both traces: ${x.digest?.ok === true ? "yes" : x.digest?.answer}`);
    const d = tr.map((x) => (x.digest?.ok === true ? x.digest : null));
    say(tr.length === 2 && d.every((x) => x !== null) && d[0].pre === d[1].pre, `[${h}] the two prestates are equal as JSON`);
    for (const [i, x] of d.entries()) say(x?.accounts?.includes(ARBOS) === true, `[${h}] ${tr[i]?.url}'s prestate holds ArbOS's state account`);
    const reverted = typeof d[0]?.error === "string";
    const replays = Array.isArray(t.replays) ? t.replays : [];
    for (const r of replays) {
      const a = r.answer ?? {};
      if (!ranOf(a) && (seatRefused(a) || behindOf(r))) {
        lines.push(`ok  [${h}] walked past ${hostOf(r.url)}: ${JSON.stringify(a).slice(0, 120)}`);
        continue;
      }
      say(d[0] !== null && ranOf(a), `[${h}] the replay at its prestate runs on ${r.url}: ${JSON.stringify(a).slice(0, 160)} (the transaction ${reverted ? "reverted" : "succeeded"})`);
    }
    const ran = replays.filter((r) => ranOf(r.answer));
    const ops = new Set(ran.map((r) => evmRpcOperator(r.url)));
    const two = ran.length === 2 && ops.size === 2 && !ops.has(null);
    const lagged = replays.filter((r) => r.lagging === true && !ranOf(r.answer));
    if (!two && lagged.length > 0 && replays.every((r) => ranOf(r.answer) || seatRefused(r.answer ?? {}) || behindOf(r))) lines.push(`--  [${h}] replayed on ${ran.length} operator(s): ${lagged.map((r) => hostOf(r.url)).join(" and ")} did not know the block yet after ${LAG_TRIES} reads ${LAG_WAIT_MS} ms apart: INCONCLUSIVE`);
    else say(two, `[${h}] replayed on two operators: ${ran.map((r) => hostOf(r.url)).join(" and ") || "none"}`);
  }
  const ok = lines.length > 0 && lines.every((l) => l.startsWith("ok ") || (l.startsWith("-- ") && l.endsWith(": INCONCLUSIVE")));
  const verdict = !ok ? "FAIL" : lines.some((l) => l.startsWith("-- ")) ? "INCONCLUSIVE" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** The run: the kit's own pins, the newest Robinhood transactions that call a contract. */
export async function read(fetchFn = fetch, over = overOf, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))) {
  // a read again while its provider does not know the transaction or block yet: { answer, lagging }
  const untilKnown = async (f) => {
    let answer;
    for (let t = 1; t <= LAG_TRIES; t++) {
      answer = await f();
      if (!notKnown(answer)) return { answer, lagging: false };
      if (t < LAG_TRIES) await sleep(LAG_WAIT_MS);
    }
    return { answer, lagging: true };
  };
  const { evmPoolVenues, evmReadProvidersOf } = await import("../../packages/kit/src/index.ts");
  const v = evmPoolVenues().robinhood;
  const trace = [...(v.traceProviders ?? [])];
  // the kit's read list, walked for two operators that run the replay (card device-evm-fee-read-walks-operators)
  const quote = [...evmReadProvidersOf(v)];
  const rpc = async (url, method, params) => post(url, { jsonrpc: "2.0", id: 1, method, params }, fetchFn);
  const head = BigInt((await rpc(quote[0], "eth_getBlockByNumber", ["latest", false])).result.number);
  const txs = [];
  // a few blocks back, so every provider holds the block
  for (let n = head - 10n; txs.length < COUNT && n > head - 60n; n--) {
    const b = (await rpc(quote[0], "eth_getBlockByNumber", [qty(n), true])).result;
    for (const tx of b?.transactions ?? []) {
      if (txs.length >= COUNT || tx.type === "0x6a" || tx.to === null || tx.input === "0x") continue;
      const traces = [];
      const answers = [];
      for (const url of trace) {
        const one = async (id, tracer) => ({ ...(await post(url, { jsonrpc: "2.0", id, method: "debug_traceTransaction", params: [tx.hash, tracer] }, fetchFn)), id });
        const got = await untilKnown(async () => [await one(1, { tracer: "prestateTracer", tracerConfig: { disableCode: true } }), await one(2, { tracer: "callTracer" })]);
        answers.push({ url, ...got });
      }
      for (const { url, answer, lagging } of answers) traces.push({ url, digest: digestOf(answer), ...(lagging ? { lagging } : {}) });
      const pre = Array.isArray(answers[0]?.answer) ? answers[0].answer.find((x) => x.id === 1)?.result : undefined;
      const call = { from: tx.from, to: tx.to, data: tx.input, gas: tx.gas, value: tx.value, ...(tx.maxFeePerGas ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : { gasPrice: tx.gasPrice }) };
      const env = { number: b.number, time: b.timestamp, baseFeePerGas: b.baseFeePerGas };
      const replays = [];
      // in the list's order until two operators ran it; a seat's own refusal (the state, no answer) walks on, any other
      // answer ends the walk there (the verdict fails it)
      const ran = new Set();
      for (const url of quote) {
        if (ran.size === 2) break;
        const op = evmRpcOperator(url);
        if (ran.has(op)) continue;
        const { answer, lagging } = await untilKnown(() => rpc(url, "eth_call", [call, { blockHash: b.parentHash }, over(pre), env]).catch((e) => ({ http: 0, body: String(e?.message ?? e).slice(0, 120) })));
        replays.push({ url, answer, ...(lagging ? { lagging } : {}) });
        if (ranOf(answer)) ran.add(op);
        else if (!seatRefused(answer) && !lagging) break;
      }
      txs.push({ hash: tx.hash, block: b.number, readAt: new Date().toISOString(), traces, replays });
    }
  }
  return { trace, quote, txs };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--record");
  try {
    const run = await read();
    if (i >= 0) writeFileSync(args[i + 1], `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`${r.verdict} ${KEY}`);
    process.exit({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 }[r.verdict]);
  } catch (e) {
    console.error(`${KEY}: ${e.message}`);
    process.exit(2);
  }
}
