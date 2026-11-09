#!/usr/bin/env node
// Live check of card evm-pool-sync-holds: a new page can still sync the Base and Robinhood pools from their deploy
// blocks a week from now. A device keeps each pool's verified hold, so a page that synced once never needs the deploy
// block again; a new device does, from logs two operators give alike (packages/wallet/src/pool/evm.ts evmTreeSync). A
// keyless provider keeps logs for a window only, so for each source the signing page reads a pool's logs from (its pool
// list, MAINNET_POOL_RPCS in packages/signpage/src/pool-testnet.ts, the helper's keyed-only route and the kit's
// EVM_POOL_HISTORY, copied here) this reads now:
//   1. its oldest reachable block: the oldest block n from which a 100-block eth_getLogs of a busy contract (Base's
//      USDC, Robinhood's busiest log address) answers the contract's first log at n or within the chain's slack past it
//      (CHAINS slack, measured), by bisection up to the pool's deploy block; a provider's "earliest available N" words
//      name it at once, and one that answers no logs, refuses, names a later block, or answers logs only from past the
//      slack (a range clamped to its floor, review P3-3) at the deploy block does not reach it;
//   2. the chain's block rate, from the head's time and a block 100,000 back;
//   3. the date the deploy block leaves its window, the window rolling at that rate (an archive reads as decades).
// FAIL when fewer than two operators (the helper's route one, "helper", whatever it reads behind) reach the deploy
// block 7 days from now: then a new device could not sync that pool from two operators within the week. Each source's
// floor and its date are named on its line. INCONCLUSIVE when fewer than two reach it and some source gave no answer.
// SIGN_HOST's connect-src naming each public source is signpage-skeleton's (its pin, POOL_HISTORY).
// Pure reads of public RPCs and the helper's route through provider-answer.mjs: no key, no write.
// After: helper
//   node scripts/live-checks/evm-pool-sync-holds.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (provider-answer.mjs EXIT)
// --record writes every answer read as the good run of evm-pool-sync-holds.answers.json, and the bad run: the good
// answers with every Base source but the helper's route answering no logs from the deploy block down (plantedBad; the
// file's note says so).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "evm-pool-sync-holds";
export const HELPER = "https://ct-api.unrealized.trade";
export const WEEK_S = 7 * 24 * 3600;
/** Blocks a probe reads: a busy contract logs in every such range on each chain (read 2026-11-09 14:50Z). A source
 *  reaches the probe's first block n only when its first log is the contract's at n + `slack` at most (review P3-3:
 *  bloXroute answered a range from under its floor with logs from a later block, which counted as reaching n). */
export const SPAN = 100;
export const CHAINS = Object.freeze([
  {
    name: "base",
    pool: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf",
    from: 54325671,
    // Base's USDC: logs in every 100-block range read
    busy: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    // not a log every block (2026-11-09 18:37Z, its eth_getLogs on base.gateway.tenderly.co, 1,000-block windows):
    // the longest step between two blocks with one 3 at blocks 15M and 20M and 2 at the deploy block (977 of 1,000
    // blocks with one), so 10 holds a probe from 15M up, where every pruned source's floor lies; below, where USDC was young
    // (a gap of 35 at 5M, 226 at 2.8M), a probe can miss and an archive's floor read high: never deeper than it is
    slack: 10,
    sources: [
      { op: "publicnode.com", url: "https://base-rpc.publicnode.com" },
      { op: "pocket.network", url: "https://base.api.pocket.network" },
      { op: "helper", url: `${HELPER}/v1/rpc/base?keyed=only` },
      { op: "blxrbdn.com", url: "https://base.rpc.blxrbdn.com" },
      { op: "tenderly.co", url: "https://base.gateway.tenderly.co" },
    ],
  },
  {
    name: "robinhood",
    pool: "0x9306359433127c4f3be426f6faeb00a3c41f66db",
    from: 108420674,
    // the busiest log address at blocks 1M, 20M, 60M, 100M, 108.4M and 110M (robinhood.drpc.org, 14:50Z)
    busy: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    // no address logs every block: unfiltered single-block eth_getLogs on robinhood.drpc.org at blocks 1M, 20M, 60M,
    // 100M, 108,420,674, 108,420,675, 108,420,700, 110M and two near the head (2026-11-09 18:36Z) share none (the
    // deploy block has one log, another contract's). This one's longest step between two blocks with a log: 26, over 1,000-block
    // windows at 1M, 10M, 20M, 60M, 100M, 105M, 108M, 108.42M, 109M, 110M and the head on
    // rpc.mainnet.chain.robinhood.com (18:36Z; 12 to 22 in most), so 50, about twice it
    slack: 50,
    sources: [
      { op: "robinhood.com", url: "https://rpc.mainnet.chain.robinhood.com" },
      { op: "pocket.network", url: "https://robinhood.api.pocket.network" },
      { op: "helper", url: `${HELPER}/v1/rpc/robinhood?keyed=only` },
    ],
  },
]);

/** judgeStateMiss: a block a provider does not keep is this check's subject, judged, never a no-answer. */
export const live = (url, method, params) => rpcAnswer(url, method, params, { judgeStateMiss: true });

/** The live transport, each answer kept in order: the good run's recording. A list of logs is kept to its first log:
 *  the check judges only whether a list holds one (a 100-block page of a busy contract holds thousands, and the whole
 *  recording ran to 208 MB). */
export function recorder(read = live) {
  const log = [];
  return { log, transport: async (url, method, params) => {
    const a = await read(url, method, params);
    log.push({ url, method, params, ...(method === "eth_getLogs" && Array.isArray(a.result) ? { ...a, result: a.result.slice(0, 1) } : a) });
    return a;
  } };
}

/** Each call answered with the recorded answers to that same call, in order; past the last, the last again; none
 *  recorded: a no-answer. */
export function replayer(log) {
  const queues = new Map();
  for (const e of log) {
    const k = JSON.stringify([e.url, e.method, e.params]);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(e);
  }
  return async (url, method, params) => {
    const q = queues.get(JSON.stringify([url, method, params]));
    const e = q?.length > 1 ? q.shift() : q?.[0];
    if (e === undefined) return { noAnswer: `no recorded answer to ${method} ${JSON.stringify(params)} on ${url}` };
    return "noAnswer" in e ? { noAnswer: e.noAnswer } : "error" in e ? { error: e.error } : { result: e.result };
  };
}

const hex = (n) => `0x${n.toString(16)}`;
const EARLIEST = /earliest available:? (\d+)/i;

/** Whether `url` gives the busy contract's logs from block n (its first log the contract's, at n to n + c.slack):
 *  { yes }, { no, earliest? }, or { quiet }. */
async function reaches(transport, c, url, n) {
  const a = await transport(url, "eth_getLogs", [{ address: c.busy, fromBlock: hex(n), toBlock: hex(n + SPAN - 1) }]);
  if ("noAnswer" in a) return { quiet: a.noAnswer };
  if ("error" in a) {
    const m = EARLIEST.exec(String(a.error?.message ?? ""));
    return { no: true, earliest: m ? Number(m[1]) : undefined, why: String(a.error?.message ?? JSON.stringify(a.error)).slice(0, 80) };
  }
  if (!Array.isArray(a.result)) return { no: true, why: "not a list of logs" };
  if (a.result.length === 0) return { no: true, why: "no logs" };
  const first = a.result[0];
  if (String(first?.address ?? "").toLowerCase() !== c.busy) return { no: true, why: "a first log not the busy contract's" };
  let at;
  try {
    at = Number(BigInt(first.blockNumber));
  } catch {
    return { no: true, why: "a first log with no block number" };
  }
  return at >= n && at <= n + c.slack ? { yes: true } : { no: true, why: `the first log at block ${at}, past ${n} + ${c.slack}` };
}

/** A source's oldest reachable block up to the deploy block: { floor } (at most c.from), { above, why } (it does not
 *  reach the deploy block), or { quiet }. */
async function floorOf(transport, c, url) {
  const top = await reaches(transport, c, url, c.from);
  if (top.quiet) return { quiet: top.quiet };
  if (!top.yes) return { above: top.earliest, why: top.why };
  let lo = 1, hi = c.from;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await reaches(transport, c, url, mid);
    if (r.quiet) return { quiet: r.quiet };
    if (r.yes) hi = mid;
    else if (r.earliest !== undefined && r.earliest > mid) lo = Math.min(r.earliest, hi);
    else lo = mid + 1;
  }
  return { floor: lo };
}

const blockOf = (a) => (a.result && typeof a.result === "object" ? { n: Number(BigInt(a.result.number)), t: Number(BigInt(a.result.timestamp)) } : null);

/** The chain's head and blocks per second, from the first source whose head and a block 100,000 back both answer. */
async function rateOf(transport, c) {
  for (const s of c.sources) {
    const h = blockOf(await transport(s.url, "eth_getBlockByNumber", ["latest", false]));
    if (h === null) continue;
    const b = blockOf(await transport(s.url, "eth_getBlockByNumber", [hex(h.n - 100_000), false]));
    if (b === null || h.t <= b.t) continue;
    return { head: h.n, now: h.t, rate: (h.n - b.n) / (h.t - b.t) };
  }
  return null;
}

const day = (s) => new Date(s * 1000).toISOString().slice(0, 16) + "Z";

/** One chain: its lines and verdict. */
async function chain(c, transport) {
  const r = await rateOf(transport, c);
  if (r === null) return { verdict: "INCONCLUSIVE", lines: [`INCONCLUSIVE ${c.name}: no source answered the head and a block 100,000 back`] };
  const lines = [];
  const reach = new Set();
  const quiet = new Set();
  const floors = await Promise.all(c.sources.map((s) => floorOf(transport, c, s.url)));
  c.sources.forEach((s, i) => {
    const f = floors[i];
    const who = `${c.name} ${s.op} ${new URL(s.url).host}`;
    if (f.quiet) return quiet.add(s.op), lines.push(`quiet ${who}: ${f.quiet}`);
    if (f.floor === undefined) return lines.push(`no    ${who}: does not reach the deploy block ${c.from} (${f.above !== undefined ? `earliest available ${f.above}` : f.why})`);
    const leaves = r.now + (c.from - f.floor) / r.rate;
    const ok = leaves - r.now >= WEEK_S;
    if (ok) reach.add(s.op);
    lines.push(`${ok ? "ok   " : "short"} ${who}: floor ${f.floor}, the deploy block ${c.from} leaves its window ~${day(leaves)}`);
  });
  const head = `${c.name}: head ${r.head} at ${r.rate.toFixed(2)} blocks/s; ${reach.size} operator(s) reach the deploy block 7 days out (${[...reach].join(", ") || "none"})`;
  // silent sources judge nothing, unless even they could not make two
  const could = new Set([...reach, ...quiet]).size;
  const verdict = reach.size >= 2 ? "PASS" : could >= 2 ? "INCONCLUSIVE" : "FAIL";
  return { verdict, lines: [`${verdict} ${head}`, ...lines] };
}

/** `transport` with each host's calls one at a time, `gapMs` apart (the helper's route rate-limits a burst). */
export function paced(transport, gapMs) {
  const turns = new Map();
  return (url, method, params) => {
    const host = new URL(url).host;
    const r = (turns.get(host) ?? Promise.resolve()).then(() => transport(url, method, params));
    turns.set(host, r.then(() => new Promise((ok) => setTimeout(ok, gapMs)), () => {}));
    return r;
  };
}

/** The check on `chains`: { ok, verdict, lines }. */
export async function check(transport, chains = CHAINS) {
  // one chain after the other: the helper's route answers both, within its rate limit
  const rs = [];
  for (const c of chains) rs.push(await chain(c, transport));
  const verdict = verdictOf(rs.some((r) => r.verdict === "FAIL"), rs.some((r) => r.verdict === "INCONCLUSIVE"));
  return { ok: verdict === "PASS", verdict, lines: rs.flatMap((r) => r.lines) };
}

/** The good recording with every Base source but the helper's route answering no logs from the deploy block down: the
 *  bad run (only the helper reaches the deploy block). */
export function plantedBad(good) {
  const base = good.chains[0];
  const helper = base.sources.find((s) => s.op === "helper").url;
  let n = 0;
  const log = good.log.map((e) => {
    if (e.method !== "eth_getLogs" || e.url === helper || !base.sources.some((s) => s.url === e.url) || Number(BigInt(e.params[0].fromBlock)) > base.from) return e;
    n++;
    return { url: e.url, method: e.method, params: e.params, result: [] };
  });
  if (n === 0) throw new Error("no Base log read to plant in");
  return { chains: good.chains, log };
}

async function main(argv) {
  const record = argv.includes("--record") ? argv[argv.indexOf("--record") + 1] : undefined;
  const rec = recorder();
  // live: each host's calls 500 ms apart
  const r = await check(paced(rec.transport, 500));
  for (const l of r.lines) console.log(l);
  if (record) {
    if (r.verdict !== "PASS") throw new Error("the good run did not pass: nothing to record");
    const good = { chains: JSON.parse(JSON.stringify(CHAINS)), log: rec.log };
    const bad = plantedBad(good);
    const b = await check(replayer(bad.log), bad.chains);
    if (b.verdict !== "FAIL") throw new Error(`the planted bad run did not fail: ${b.lines.join(" | ")}`);
    for (const l of b.lines) console.log(`bad: ${l}`);
    const note = {
      good: "a real run from a Mac, read only: every answer each Base and Robinhood pool source and the helper's keyed-only route gave",
      bad: "NOT a real source's answer: the good recording with every Base source but the helper's route answering no logs from the deploy block down, as a window past the deploy block reads (Pocket's answer past its window): only the helper reaches it",
    };
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: { note: note.good, ...good }, bad: { note: note.bad, ...bad } }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(`${r.verdict} ${KEY}`);
  return EXIT[r.verdict];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(EXIT.ERROR)));
