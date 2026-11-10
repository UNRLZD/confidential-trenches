#!/usr/bin/env node
// Live check of card device-evm-fee-read-walks-operators: the device's Base and Robinhood bind reads its chain fee on
// two operators of the kit's read list (evmReadProvidersOf(evmPoolVenues()[chain]), the kit's evmTwoOperators), so one
// operator that lacks a block's state, hangs or errs is walked past. Read now, for each mainnet:
//   - every list seat answers eth_chainId with the chain's id, and its CORS preflight admits both pages' origins (the
//     signing page's and the app's, page-evm-rpc-csp.mjs PAGES), since the device reads from both;
//   - the bind, as the device runs it (CHILD, packages/wallet/scripts/bind-fee-live.ts): the wallet's own functions in
//     bind's order (packages/wallet/src/pool/evm.ts:
//     evmEpochBlock on the pool's pair, the tree depth there, evmBindChainFee on the walk), under the wallet's lag
//     retries (evmRetryLag), at the current period's first block; when that fails, again at the next period's first
//     block, as the proof queue's next pass does while the period's proof still lives (a proof bound in one period is
//     taken through the next: packages/wallet/src/pool/queue.ts take). PASS when it binds on two operators that agree
//     within that time; FAIL when it does not, or two that answered differ;
//   - beside it, one walk of the fee read at the block 60 s back (the oldest first block a bind reads): bound is an ok
//     line; not bound while the bind did bind is a WARN naming the seats that lacked the state, never silent;
//   - each seat's own fee read at that block, one ask each: a "--" line with how many held the state.
// The depth is the pool's own currentTreeSize() at the block, read on two operators of the list (the device counts its
// sync's leaves there, the same number, with no state read; a cold sync from the deploy block is the pool pair's own
// limit, carded apart). The bind's helper fee answer is not read here: this card's end state is the device's own read. A seat that
// gives no answer (a 429, a timeout) is named; an answer that is wrong (a chain id, a refused origin) fails.
// After: app sign
//   node scripts/live-checks/device-evm-fee-read-walks-operators.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
import "../net-window.mjs";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PAGES } from "./page-evm-rpc-csp.mjs";
import { EXIT, preflight, preflightRefuses, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "device-evm-fee-read-walks-operators";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The wallet's own bind reads, run as a child (the kit's entry is this file's only reach into Blindfill). */
export const CHILD = path.join(REPO, "packages/wallet/scripts/bind-fee-live.ts");
export const childArgs = () => ["--import", pathToFileURL(path.join(REPO, "scripts/net-window.mjs")).href, CHILD];
const CHAINS = { base: 8453, robinhood: 4663 };
export const ORIGINS = Object.freeze([new URL(PAGES.sign).origin, new URL(PAGES.app).origin]);
const AGE_S = 60;
const EPOCH_MS = 60_000;
const hostOf = (u) => new URL(u).host;

/** The verdict on a run { chains: { [chain]: { block, seats: [{ url, operator, chainId, cors: [p, p], fee }], walk, bind } } }. */
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
    // the bind, as the device runs it
    const tries = Array.isArray(c.bind?.tries) ? c.bind.tries : [];
    const bound = tries.find((t) => t.ok === true);
    const differ = tries.find((t) => t.ok !== true && t.name === "EvmOperatorsDiffer");
    for (const t of tries.filter((x) => x.ok !== true)) lines.push(`--  ${chain}: the bind at the period from ${t.start} did not bind (${t.name}: ${String(t.error).slice(0, 160)})`);
    if (differ) say(false, `${chain}: two operators answered the bind's fee read differently (${String(differ.error).slice(0, 160)})`);
    else if (bound) say(Array.isArray(bound.hosts) && new Set(bound.operators ?? []).size >= 2, `${chain}: the bind read the chain fee at block ${bound.block} (the period from ${bound.start}${bound === tries[0] ? "" : ", the next period, as the queue's next pass"}) on ${bound.hosts?.join(" and ") ?? "?"}`);
    else if (tries.length > 0 && tries.every((t) => t.name === "noAnswer")) {
      quiet = true;
      lines.push(`--  ${chain}: the bind's reads gave no answer: INCONCLUSIVE`);
    } else say(false, `${chain}: the bind did not bind in this period or the next (${tries.length} tries)`);
    // one walk at the block 60 s back, and each seat at it
    const answered = c.seats.filter((s) => Array.isArray(s.fee?.result));
    const lacking = c.seats.filter((s) => s.fee?.error !== undefined);
    lines.push(`--  ${chain}: ${AGE_S} s back (block ${c.block?.number}), ${answered.length} of ${c.seats.length} operators held the state on one ask${lacking.length ? `; lacking: ${lacking.map((s) => hostOf(s.url)).join(", ")}` : ""}`);
    const words = new Set(answered.map((s) => JSON.stringify(s.fee.result)));
    say(words.size <= 1, `${chain}: the ${answered.length} seat(s) that answered the fee read ${AGE_S} s back agree${words.size > 1 ? `: ${[...words].join(" vs ")}` : ""}`);
    const w = c.walk;
    if (Array.isArray(w?.hosts) && w.hosts.length === 2 && w.operators?.[0] !== w.operators?.[1] && w.agree === true) lines.push(`ok  ${chain}: one walk bound the fee read ${AGE_S} s back on ${w.hosts.join(" and ")}`);
    else if (bound) lines.push(`WARN ${chain}: ${AGE_S} s back, ${answered.length} of ${c.seats.length} operators held the state on one ask: ${answered.map((s) => hostOf(s.url)).join(", ") || "none"}; the walk did not bind there (${String(w?.error ?? "not run").slice(0, 140)})`);
    else lines.push(`--  ${chain}: one walk ${AGE_S} s back did not bind either (${String(w?.error ?? "not run").slice(0, 140)})`);
  }
  return { ok: !bad && !quiet, verdict: verdictOf(bad, quiet), lines };
}

/** The run: the kit's lists and the wallet's bind functions, read now. */
export async function read(fetchFn = fetch) {
  const { evmPoolVenues, evmReadProvidersOf, evmRpcOperator, evmTwoOperators, evmPoolChainFeeReads, evmPoolGas } = await import("../../packages/kit/src/index.ts");
  const v = evmPoolVenues();
  // the bind's own reads run in the wallet's child (CHILD), both chains at once beside the reads below
  const child = new Promise((res, no) => execFile(process.execPath, childArgs(), { cwd: REPO, timeout: 300_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) => (e ? no(new Error(`${KEY}: the bind child failed: ${String(stderr).slice(-300)}`)) : res(stdout))));
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
    for (const url of list) seats.push({ url, operator: evmRpcOperator(url), chainId: await rpcAnswer(url, "eth_chainId", [], { fetchFn }), cors: [await preflight(url, ORIGINS[0], { fetchFn }), await preflight(url, ORIGINS[1], { fetchFn })], fee: await fee(url) });
    let walk;
    try {
      const two = await evmTwoOperators(list.map((url) => ({ url, rpc: url }))).read(
        `${chain} fee ${AGE_S} s back`,
        async (url) => {
          const a = await fee(url);
          if (!Array.isArray(a.result)) throw new Error(a.noAnswer ?? JSON.stringify(a.error));
          return a.result;
        },
        (x, y) => JSON.stringify(x) === JSON.stringify(y),
      );
      walk = { hosts: two.map((x) => x.host), operators: two.map((x) => x.operator), agree: true };
    } catch (e) {
      walk = { error: String(e?.message ?? e).slice(0, 300) };
    }
    chains[chain] = { list, block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, seats, walk };
  }
  const binds = JSON.parse(String(await child).trim().split("\n").at(-1));
  for (const chain of Object.keys(chains)) chains[chain].bind = binds[chain] ?? { tries: [] };
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
