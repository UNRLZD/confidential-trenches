#!/usr/bin/env node
// Live check of card device-evm-fee-read-walks-operators: the device's Base and Robinhood reads (the bind's chain fee at
// an epoch's first block, the Verify page's pool reads) go through the kit's evmTwoOperators over the kit's read list
// (evmReadProvidersOf(evmPoolVenues()[chain])), two operators of it agreeing. For each mainnet, read now:
//   - every seat of the list answers eth_chainId with the chain's id, and its CORS preflight admits the signing page's
//     origin and the app's (the device reads from both pages);
//   - the bind's own fee read (the kit's evmPoolChainFeeReads) at a block 60 s back (the oldest first block a bind
//     reads), by its hash, on every seat: the seats that answer agree on every word, and two operators at least answer
//     (one that refuses that block's state, dRPC's code 27 "Unknown state", is what the walk is for, and is named);
//   - the kit's walk itself over the list binds that read on two operators, their answers equal.
// It fails on a wrong chain id, a page origin refused, two seats that answer differently, fewer than two operators that
// keep the block's state (the bind would fail now), or a walk that does not bind. A seat that gives no answer (a 429, a
// timeout, no JSON-RPC body) is named and left out; fewer than two operators judged for that reason is INCONCLUSIVE.
// After: app sign
//   node scripts/live-checks/device-evm-fee-read-walks-operators.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, preflight, preflightRefuses, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "device-evm-fee-read-walks-operators";
const CHAINS = { base: 8453, robinhood: 4663 };
const ORIGINS = ["https://sign.confidential.unrealized.trade", "https://ct-app.unrealized.trade"];
const AGE_S = 60;
const hostOf = (u) => new URL(u).host;

/** The verdict on a run { chains: { [chain]: { list, block, seats: [{ url, operator, chainId, cors: [p, p], fee }], walk } } }. */
export function judge(run) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const say = (ok, s) => (lines.push(`${ok ? "ok " : "BAD"} ${s}`), ok || (bad = true));
  for (const chain of Object.keys(CHAINS)) {
    const c = run?.chains?.[chain];
    if (!c || !Array.isArray(c.seats) || c.seats.length === 0) {
      say(false, `${chain}: no seats read`);
      continue;
    }
    say(new Set(c.seats.map((s) => s.operator)).size === c.seats.length && c.seats.length >= 3, `${chain}: the list seats ${c.seats.length} operators (${c.seats.map((s) => hostOf(s.url)).join(", ")}), three at least, one seat each`);
    for (const s of c.seats) {
      const h = hostOf(s.url);
      if (s.chainId?.noAnswer) lines.push(`--  ${chain} ${h}: eth_chainId no answer (${s.chainId.noAnswer})`);
      else say(typeof s.chainId?.result === "string" && Number(BigInt(s.chainId.result)) === CHAINS[chain], `${chain} ${h}: chain id ${s.chainId?.result ?? JSON.stringify(s.chainId?.error)}`);
      for (const [i, origin] of ORIGINS.entries()) {
        const why = preflightRefuses(s.url, s.cors?.[i], origin);
        say(why === null, `${chain} ${h}: CORS from ${origin}${why ? `: ${why}` : ""}`);
      }
    }
    const answered = c.seats.filter((s) => Array.isArray(s.fee?.result));
    const refused = c.seats.filter((s) => s.fee?.error !== undefined);
    const silent = c.seats.filter((s) => s.fee?.noAnswer !== undefined);
    for (const s of refused) lines.push(`--  ${chain} ${hostOf(s.url)}: refused the fee read at block ${c.block?.number} (${JSON.stringify(s.fee.error).slice(0, 100)}): walked past`);
    for (const s of silent) lines.push(`--  ${chain} ${hostOf(s.url)}: no answer to the fee read (${s.fee.noAnswer})`);
    const words = new Set(answered.map((s) => JSON.stringify(s.fee.result)));
    say(words.size <= 1, `${chain}: the ${answered.length} seat(s) that answered the fee read agree${words.size > 1 ? `: ${[...words].join(" vs ")}` : ""}`);
    const ops = new Set(answered.map((s) => s.operator));
    if (ops.size < 2 && ops.size + new Set(silent.map((s) => s.operator)).size >= 2) {
      quiet = true;
      lines.push(`--  ${chain}: ${ops.size} operator(s) answered the fee read, the rest gave no answer: INCONCLUSIVE`);
    } else say(ops.size >= 2, `${chain}: ${ops.size} operators keep the state of block ${c.block?.number} (${AGE_S} s back): ${answered.map((s) => hostOf(s.url)).join(", ") || "none"}`);
    const w = c.walk;
    say(Array.isArray(w?.hosts) && w.hosts.length === 2 && w.operators?.[0] !== w.operators?.[1] && w.agree === true, `${chain}: the kit's walk binds the fee read on ${w?.hosts?.join(" and ") ?? `none (${w?.error ?? "not run"})`}`);
  }
  return { ok: !bad && !quiet, verdict: verdictOf(bad, quiet), lines };
}

/** The run: the kit's lists, read now. */
export async function read(fetchFn = fetch) {
  const { evmPoolVenues, evmReadProvidersOf, evmRpcOperator, evmTwoOperators, evmPoolChainFeeReads, evmPoolGas } = await import("../../packages/kit/src/index.ts");
  const v = evmPoolVenues();
  const chains = {};
  for (const chain of Object.keys(CHAINS)) {
    const list = [...evmReadProvidersOf(v[chain])];
    const at = (n) => rpcAnswer(list[0], "eth_getBlockByNumber", [n, false], { fetchFn });
    const head = (await at("latest")).result;
    const back = (await at(`0x${(BigInt(head.number) - 1000n).toString(16)}`)).result;
    const perBlock = Number(BigInt(head.timestamp) - BigInt(back.timestamp)) / 1000;
    const block = (await at(`0x${(BigInt(head.number) - BigInt(Math.round(AGE_S / perBlock))).toString(16)}`)).result;
    const reads = evmPoolChainFeeReads(chain, evmPoolGas(20));
    const fee = async (url) => {
      const got = [];
      for (const r of reads) {
        const a = await rpcAnswer(url, "eth_call", [{ to: r.to, data: r.data }, { blockHash: block.hash }], { fetchFn, judgeStateMiss: true });
        if (a.result === undefined) return a;
        got.push(a.result);
      }
      return { result: got };
    };
    const seats = [];
    for (const url of list) {
      seats.push({ url, operator: evmRpcOperator(url), chainId: await rpcAnswer(url, "eth_chainId", [], { fetchFn }), cors: [await preflight(url, ORIGINS[0], { fetchFn }), await preflight(url, ORIGINS[1], { fetchFn })], fee: await fee(url) });
    }
    let walk;
    try {
      const two = await evmTwoOperators(list.map((url) => ({ url, rpc: url }))).read(
        `${chain} fee`,
        async (url) => {
          const a = await fee(url);
          if (!Array.isArray(a.result)) throw new Error(a.noAnswer ?? JSON.stringify(a.error));
          return a.result;
        },
        (x, y) => JSON.stringify(x) === JSON.stringify(y),
      );
      walk = { hosts: two.map((x) => x.host), operators: two.map((x) => x.operator), agree: true };
    } catch (e) {
      walk = { error: String(e?.message ?? e).slice(0, 200) };
    }
    chains[chain] = { list, block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, seats, walk };
  }
  return { check: KEY, at: new Date().toISOString(), chains };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--record");
  try {
    const run = await read();
    if (i >= 0) writeFileSync(args[i + 1], `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.verdict}`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`${KEY}: error ${e?.stack ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
