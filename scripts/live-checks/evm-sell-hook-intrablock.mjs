#!/usr/bin/env node
// Live check of card evm-sell-hook-intrablock: on Robinhood mainnet a ban's evidence reads the reverted trade's own
// trace on the venue's trace pair (packages/kit/src/trade/evm/buy-unpinned.ts traceProviders: dRPC and Pocket) and
// replays at that prestate with ArbOS's state left out (packages/kit/src/checks/evm/quote.ts tracedPre, preOverOf). Bans
// there hold only while both providers serve the trace and the replay is taken, so this reads, for the newest Robinhood
// transactions that call a contract (no transaction of ours, nothing signed):
//   - each trace provider's debug_traceTransaction, prestateTracer and callTracer in one request, both answering, the
//     two prestates equal as JSON and holding ArbOS's state account (Nitro's block-start state is in the trace);
//   - the replay: an eth_call at the transaction's parent with the block's number, time and base fee and its prestate,
//     ArbOS's state left out, as the state override, on two of the venue's quote providers: each runs it (an output or
//     an execution revert), never a refusal of the override or the state. The outcome itself is shown, not judged: a
//     replay may differ from the real run (a 7 Nov 16:24Z read found one: 0xed59ff1c in block 108542534 succeeded, its
//     replay reverted), which is why no ban rests on a replay alone.
// A trace is kept as read time's digest (sha-256 of the prestate's sorted JSON, its accounts, the call frame's error and
// output), so a record stays small.
// It passes when at least 3 transactions were read and every read and replay holds. It runs after every app deploy
// (apps/terminal/scripts/deploy.mjs LIVE_CHECKS): the kit ships in the app's bundle and its bans fail open, so a pin
// that changes or a provider that stops serving traces would turn Robinhood's trace evidence off without a sound.
//   node scripts/live-checks/evm-sell-hook-intrablock.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. Reads only.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const KEY = "evm-sell-hook-intrablock";
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
    for (const x of tr) say(x.digest?.ok === true, `[${h}] ${x.url} answers both traces: ${x.digest?.ok === true ? "yes" : x.digest?.answer}`);
    const d = tr.map((x) => (x.digest?.ok === true ? x.digest : null));
    say(tr.length === 2 && d.every((x) => x !== null) && d[0].pre === d[1].pre, `[${h}] the two prestates are equal as JSON`);
    for (const [i, x] of d.entries()) say(x?.accounts?.includes(ARBOS) === true, `[${h}] ${tr[i]?.url}'s prestate holds ArbOS's state account`);
    const reverted = typeof d[0]?.error === "string";
    const replays = Array.isArray(t.replays) ? t.replays : [];
    for (const r of replays) {
      const a = r.answer ?? {};
      const ran = typeof a.result === "string" || (a.error?.code === 3 && /execution reverted/i.test(String(a.error?.message ?? "")));
      say(d[0] !== null && ran, `[${h}] the replay at its prestate runs on ${r.url}: ${JSON.stringify(a).slice(0, 160)} (the transaction ${reverted ? "reverted" : "succeeded"})`);
    }
    say(replays.length === 2 && replays[0].url !== replays[1].url, `[${h}] replayed on two quote providers`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

/** The run: the kit's own pins, the newest Robinhood transactions that call a contract. */
export async function read(fetchFn = fetch, over = overOf) {
  const { evmPoolVenues } = await import("../../packages/kit/src/index.ts");
  const v = evmPoolVenues().robinhood;
  const trace = [...(v.traceProviders ?? [])];
  // two quote providers that keep the state of the blocks read (publicnode dropped it 20 blocks back in the probe)
  const quote = ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"].filter((u) => v.providers.includes(u));
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
      for (const url of trace) answers.push({ url, answer: await post(url, [{ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [tx.hash, { tracer: "prestateTracer" }] }, { jsonrpc: "2.0", id: 2, method: "debug_traceTransaction", params: [tx.hash, { tracer: "callTracer" }] }], fetchFn) });
      for (const { url, answer } of answers) traces.push({ url, digest: digestOf(answer) });
      const pre = Array.isArray(answers[0]?.answer) ? answers[0].answer.find((x) => x.id === 1)?.result : undefined;
      const call = { from: tx.from, to: tx.to, data: tx.input, gas: tx.gas, value: tx.value, ...(tx.maxFeePerGas ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : { gasPrice: tx.gasPrice }) };
      const env = { number: b.number, time: b.timestamp, baseFeePerGas: b.baseFeePerGas };
      const replays = [];
      for (const url of quote) replays.push({ url, answer: await rpc(url, "eth_call", [call, { blockHash: b.parentHash }, over(pre), env]) });
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
    console.log(r.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: ${e.message}`);
    process.exit(2);
  }
}
