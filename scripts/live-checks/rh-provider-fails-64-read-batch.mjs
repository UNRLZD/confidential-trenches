#!/usr/bin/env node
// Live check of card rh-provider-fails-64-read-batch: every Robinhood provider the kit pins for a quote answers the
// kit's own batch in full. A quote sends its reads to two providers at once as JSON-RPC batches of CALLS_PER_BATCH
// aggregate3 calls of the venue's `reads.perCall` reads (packages/kit/src/checks/evm/quote.ts readBoth), so a pinned
// provider that cannot answer that batch is dead weight on every one, and a second such would leave a quote with no
// pair. rpc-robinhood.globalstake.io answered the gas-starve check's call of 64 reads HTTP 500 in eight runs on 10 Nov
// 04:36-04:55Z (evm-quote-read-gas-starve.answers.json); read again 17 Nov 23:3xZ-00:1xZ it answered every size from 1
// to 256 real reads and the kit's batch of 3 x 64 in full, as the four others did, so the kit keeps 64 and all five,
// and this check reads it again after every app deploy.
// What it reads, read only: on each pinned provider, its latest block, then at that block's hash one batch shaped as
// the kit sends one, each call EVM_READ_GAS_CODE at Multicall3 with EVM_READ_CALL_GAS (the kit's exports), its reads
// real exact-in quotes (QuoterV2 quoteExactInputSingle, WETH to the venue's middle USDG, the 0.01% pool, about 105,000
// gas each), the batch's body within the venue's maxBytes. It passes when every pinned provider answers every call
// with all of its reads quoted (success 1, behind the code's marker). A batch not answered in full is read again once
// (provider-answer.mjs), then a control is read at once: one call of 6 of the same reads (the kit's re-read size,
// quote.ts READ_AGAIN_PER_CALL). FAIL: a JSON-RPC error that is not a throttle (dRPC's code 31 to a batch of 4 calls); a
// batch no-answer (an HTTP 5xx or 413, a body that is not the batch's answers, a timeout) or a read not quoted where the
// control is quoted in full: the provider answers a smaller request and not the kit's, the card's fault (on 10 Nov
// globalstake answered the gas-starve check's 6-read calls and its 64-read call HTTP 500, eight runs of eight).
// INCONCLUSIVE, named, and no FAIL: a provider that answers nothing (its latest block, or the batch and the control
// both: a passing fault, as globalstake's HTTP 500 to that check on GitHub's runners in 3 of 25 runs, 14-17 Nov, while
// it answered every size from this Mac) or throttles (429, a rate limit's words); never a PASS on fewer than every
// pinned provider.
//   node scripts/live-checks/rh-provider-fails-64-read-batch.mjs [--record <file> --as good|bad] [--answer <file> --as good|bad]
//     [--calls <n>] [--per-call <n>]   a batch other than the kit's, to record a bad answer (judged against the kit's)
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
// After every app deploy, as the kit's other EVM quote checks: a pinned provider can change what it answers any day
// After: app
// Bundle: out EVM RPC quotes
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EVM_READ_CALL_GAS, EVM_READ_GAS_CODE } from "../../packages/kit/src/index.ts";
import { gasOf } from "./evm-quote-read-gas-starve.mjs";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT, rpcAnswer, rpcBatchAnswer, verdictOf } from "./provider-answer.mjs";

export { EXIT };

const KEY = "rh-provider-fails-64-read-batch";
const CHAIN = "robinhood";
/** The kit's calls per JSON-RPC batch (quote.ts CALLS_PER_BATCH, module-private: robinhood.drpc.org's free plan answers a
 *  batch of 4 calls code 31 "Batch of more than 3 requests are not allowed on free plan", read 17 Nov 23:5xZ) */
export const CALLS_PER_BATCH = 3;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const USDG_FEE = 100;
/** The control's reads: the kit's re-read size (quote.ts READ_AGAIN_PER_CALL, module-private) */
export const CONTROL_READS = 6;
const w = (v) => BigInt(v).toString(16).padStart(64, "0");

/** The kit's batch shape on Robinhood now: its pinned providers and its reads' limits */
export function kitShape(venues = mainnetVenues()) {
  const v = venues[CHAIN];
  return { providers: [...(v.providers ?? [])], perCall: v.reads.perCall, maxBytes: v.reads.maxBytes, calls: CALLS_PER_BATCH };
}

/** aggregate3((address,bool,bytes)[]): `n` exact-in quotes of WETH to USDG on the venue's QuoterV2, 1 to n x 0.001 ETH */
function aggregate(v, n) {
  const el = Array.from({ length: n }, (_, k) => {
    const data = "c6a5026a" + w(v.weth) + w(v.middles[0]) + w(10n ** 15n * BigInt(k + 1)) + w(USDG_FEE) + w(0);
    return w(v.quoters.v3) + w(1) + w(0x60) + w(data.length / 2) + data + "0".repeat((64 - (data.length % 64)) % 64);
  });
  let at = 32 * el.length;
  const offs = el.map((e) => {
    const o = w(at);
    at += e.length / 2;
    return o;
  });
  return "0x82ad56cb" + w(0x20) + w(el.length) + offs.join("") + el.join("");
}

/** The batch's calls at `hash`, each as the kit sends it: [method, params] */
export function batchOf(v, hash, calls, perCall) {
  const call = ["eth_call", [{ to: MULTICALL3, data: aggregate(v, perCall), gas: "0x" + EVM_READ_CALL_GAS.toString(16) }, { blockHash: hash, requireCanonical: true }, { [MULTICALL3]: { code: EVM_READ_GAS_CODE } }]];
  return Array.from({ length: calls }, () => call);
}

/** One call's answer kept for the record: each read's success digit, and its gas used least and most, or why not */
function kept(a) {
  if (a.noAnswer !== undefined) return { noAnswer: a.noAnswer };
  if (a.error !== undefined) return { error: a.error };
  const g = gasOf(a.result);
  if (g === null) return { notCode: String(JSON.stringify(a.result)).slice(0, 140) };
  const gas = g.map((x) => x[1]);
  return { ok: g.map((x) => x[0]).join(""), gas: [Math.min(...gas), Math.max(...gas)] };
}

/** Every pinned Robinhood provider's answer to the kit's batch (or `calls` x `perCall`, for a bad answer) */
export async function collect({ calls, perCall } = {}) {
  const v = mainnetVenues()[CHAIN];
  const kit = kitShape();
  const shape = { calls: calls ?? kit.calls, perCall: perCall ?? kit.perCall, maxBytes: kit.maxBytes };
  const reads = [];
  for (const url of kit.providers) {
    const provider = new URL(url).host;
    const head = await rpcAnswer(url, "eth_getBlockByNumber", ["latest", false], { nullNoAnswer: true });
    if (head.noAnswer !== undefined || typeof head.result?.hash !== "string") {
      reads.push({ provider, head: { noAnswer: head.noAnswer ?? `${provider}: no latest block (${String(JSON.stringify(head.error ?? head.result)).slice(0, 100)})` } });
      continue;
    }
    const batch = batchOf(v, head.result.hash, shape.calls, shape.perCall);
    const t = performance.now();
    const a = await rpcBatchAnswer(url, batch);
    const ms = Math.round(performance.now() - t);
    const answer = a.answers !== undefined ? { status: a.status, calls: a.answers.map(kept) } : { status: a.status, ...(a.noAnswer !== undefined ? { noAnswer: a.noAnswer } : { error: a.error }) };
    const full = answer.calls?.length === shape.calls && answer.calls.every((c) => c.ok === "1".repeat(shape.perCall));
    // a batch not quoted in full: the control, one call of CONTROL_READS of the same reads at the same block, at once
    const [method, params] = batchOf(v, head.result.hash, 1, CONTROL_READS)[0];
    const control = full ? undefined : kept(await rpcAnswer(url, method, params));
    reads.push({ provider, head: { number: head.result.number, hash: head.result.hash }, bytes: a.bytes, ms, answer, ...(control === undefined ? {} : { control }) });
    console.log(`${provider}: ${ms} ms, HTTP ${a.status ?? "none"}`);
  }
  return { at: new Date().toISOString(), chain: CHAIN, code: EVM_READ_GAS_CODE, shape, providers: kit.providers.map((u) => new URL(u).host), reads };
}

// a no-answer that is a throttle (provider-answer.mjs names a 429 and a rate limit's words so), never the batch's fault
const throttled = (why) => /HTTP 429|rate limit/i.test(String(why));
const cut = (x) => String(typeof x === "string" ? x : JSON.stringify(x)).slice(0, 140);

/** PASS where every provider the kit pins answered the kit's batch in full; FAIL on a provider that answered its latest
 *  block but not the batch, or a read not quoted; else INCONCLUSIVE where a provider answered nothing or throttled */
export function judge(a, kit = kitShape()) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const line = (good, s) => {
    lines.push(`${good ? "ok " : "BAD"} ${s}`);
    if (!good) bad = true;
  };
  const shape = a?.shape ?? {};
  line(a?.code === EVM_READ_GAS_CODE, "the run's code is the kit's EVM_READ_GAS_CODE");
  line(shape.calls === kit.calls && shape.perCall === kit.perCall && shape.maxBytes === kit.maxBytes, `the batch is the kit's: ${shape.calls} calls of ${shape.perCall} reads within ${shape.maxBytes} bytes (the kit: ${kit.calls} of ${kit.perCall} within ${kit.maxBytes})`);
  const read = (a?.reads ?? []).map((r) => r.provider);
  const pinned = kit.providers.map((u) => new URL(u).host);
  line(pinned.length >= 2 && pinned.every((p) => read.includes(p)), `every provider the kit pins on ${CHAIN} was read: ${pinned.filter((p) => !read.includes(p)).join(", ") || pinned.length + " of " + pinned.length}`);
  for (const r of a?.reads ?? []) {
    if (r.head?.noAnswer !== undefined) {
      quiet = true;
      lines.push(`--- ${r.provider}: no answer to its latest block (${cut(r.head.noAnswer)}): INCONCLUSIVE`);
      continue;
    }
    line(Number.isSafeInteger(r.bytes) && r.bytes <= shape.maxBytes, `${r.provider}: the batch's body is ${r.bytes} bytes, within ${shape.maxBytes}`);
    const x = r.answer ?? {};
    // a fault of the batch's that is no JSON-RPC error: the kit's size, where the control (6 reads, at once) is quoted
    // in full; a passing fault, where it is not (INCONCLUSIVE)
    const small = r.control?.ok === "1".repeat(CONTROL_READS);
    const control = r.control === undefined ? "no control read" : small ? `${CONTROL_READS} reads at once quoted in full` : `${CONTROL_READS} reads at once not quoted either (${cut(r.control.noAnswer ?? r.control.error ?? r.control.notCode ?? r.control.ok)})`;
    const fault = (what, why) => {
      if (throttled(why)) {
        quiet = true;
        lines.push(`--- ${r.provider}${what}: throttled (${cut(why)}): INCONCLUSIVE`);
      } else if (small) line(false, `${r.provider}${what}: answers ${control} but not the kit's batch: ${cut(why)}`);
      else {
        quiet = true;
        lines.push(`--- ${r.provider}${what}: a passing fault, ${control}: ${cut(why)}: INCONCLUSIVE`);
      }
    };
    if (x.error !== undefined) {
      line(false, `${r.provider}: answers the kit's batch with an error: ${cut(x.error)}`);
      continue;
    }
    if (x.noAnswer !== undefined) {
      fault("", x.noAnswer);
      continue;
    }
    const calls = Array.isArray(x.calls) ? x.calls : [];
    line(calls.length === shape.calls, `${r.provider}: ${calls.length} answers for ${shape.calls} calls (HTTP ${x.status})`);
    calls.forEach((c, k) => {
      if (c.error !== undefined) line(false, `${r.provider} call ${k + 1}: an error: ${cut(c.error)}`);
      else if (c.noAnswer !== undefined) fault(` call ${k + 1}`, c.noAnswer);
      else if (c.ok === undefined) line(false, `${r.provider} call ${k + 1}: not the code's answer: ${cut(c.notCode)}`);
      else if (c.ok === "1".repeat(shape.perCall)) line(true, `${r.provider} call ${k + 1}: ${shape.perCall} of ${shape.perCall} reads quoted, gas ${c.gas?.join(" to ")}`);
      else line(false, `${r.provider} call ${k + 1}: ${[...c.ok].filter((d) => d === "1").length} of ${shape.perCall} reads quoted (${c.ok.length} answered), ${control}`);
    });
  }
  const verdict = verdictOf(bad, quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  const num = (k) => (arg(k) === undefined ? undefined : Number(arg(k)));
  try {
    let a;
    if (arg("--answer") !== undefined) a = JSON.parse(readFileSync(arg("--answer"), "utf8"))[arg("--as") ?? "good"];
    else a = await collect({ calls: num("--calls"), perCall: num("--per-call") });
    if (arg("--record") !== undefined) {
      const f = arg("--record");
      const all = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
      all[arg("--as") ?? "good"] = a;
      writeFileSync(f, JSON.stringify(all, null, 1) + "\n");
    }
    const { verdict, lines } = judge(a);
    for (const l of lines) console.log(l);
    console.log(`${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
