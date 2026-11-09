#!/usr/bin/env node
// Live check of card evm-pool-lists-mainnet: the device syncs the Base and the Robinhood mainnet pools on two
// independent RPC operators each. For each chain the kit's pool list (evmPoolProvidersOf(evmPoolVenues()[chain]), the
// wallet's evmPair: the first two the seats) must seat two providers of two operators (the kit's evmRpcOperator), each
// of which, read now, at the lower of the two seats' heads:
//   - answers eth_chainId (0x2105 Base, 0x1237 Robinhood);
//   - answers the pool's filter (the pinned pool, its three event topics in one position) over 10,000 blocks to the
//     head, 10,000 blocks 1,000,000 back and the 10,000 blocks from the pool's deploy block: the sync's page
//     (packages/wallet/src/pool/evm.ts EVM_LOG_PAGE_BLOCKS), from the deploy block to the head, with the same logs as
//     the other seat in each;
//   - answers the PoolManager's Swap logs over the same 100 blocks as the other seat, log for log, some logs in them, at
//     the head and 1,000,000 back: two seats that agree on a pool with no logs yet prove nothing about history.
// It fails on a list whose seats are one operator, on a seat that refuses or lacks a read (Base's quote list's second,
// blastapi: "You can make eth_getLogs requests with up to a 10 block range"; base-rpc.publicnode.com once the deploy
// block leaves its window: HTTP 403 "Archive requests require a personal token", 5M blocks back on 2026-11-09), and on
// two seats whose logs differ (base.api.pocket.network answered 0 logs 5M back where Sentio and Tenderly answer 142).
// A refused read is asked again twice, as the wallet's pager asks a refusal of a size the provider answered.
// Every read goes through provider-answer.mjs (rpcAnswer, as robinhood-mainnet-rpcs.mjs's recorder reads): a block or
// state a seat does not hold is a wrong answer here, since the check is that the seats keep the history; a seat that
// answers nothing usable on its last try is named and leaves its chain INCONCLUSIVE, never a pass. A wrong answer on
// either chain or SIGN_HOST's policy is FAIL over it.
// And SIGN_HOST (https://confidential.unrealized.trade/), where the device syncs, must answer 200 with a connect-src that
// names every seat's origin: a seat its policy refuses is no seat.
// After: sign
//   node scripts/live-checks/evm-pool-lists-mainnet.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
// --record writes every answer read as the good run of evm-pool-lists-mainnet.answers.json, and a real bad run: Base on
// the pair its sync had before (its quote list's first two, publicnode and blastapi).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolProvidersOf, evmPoolVenues, evmRpcOperator } from "../../packages/kit/src/index.ts";
import { EXIT, verdictOf } from "./provider-answer.mjs";
import { POOL_TOPICS, SWAP4, askOf, recorder, replayer, verdictOfError } from "./robinhood-mainnet-rpcs.mjs";
import { connectSrc, read } from "./page-evm-rpc-csp.mjs";

const KEY = "evm-pool-lists-mainnet";
export const PAGE = 10_000;
export const BACK = 1_000_000;
const TRIES = 3;
export const SIGN_HOST = "https://confidential.unrealized.trade/";
/** Each chain's id and its pool's deploy block (the deploy tx's receipt, read 2026-11-09 05:5xZ on base.api.pocket.network
 *  and rpc.mainnet.chain.robinhood.com: contracts/pool-evm/deployments/<chain>.json's PrivacyPoolSimple tx). */
export const CHAINS = Object.freeze({
  base: Object.freeze({ id: "0x2105", deploy: 54_325_671n }), // tx 0x2e0cba4bfa2c24ae138ade564a027c5d83943340153dec0ad2e278c8c89b23c7
  robinhood: Object.freeze({ id: "0x1237", deploy: 108_420_674n }), // tx 0xb5b5c6c0403e94daf9cf37e5b61f8d6dc9af41d929a3ecf732898e0d9fa88176
});

/** The kit's mainnet pool list of `chain`, and the addresses its reads filter on. */
export function kitList(chain) {
  const v = evmPoolVenues()[chain];
  return { list: [...(evmPoolProvidersOf(v) ?? [])], pool: v.pool.toLowerCase(), poolManager: v.poolManager.toLowerCase() };
}

/** The recorded answers' transport: robinhood-mainnet-rpcs.mjs's, one replay for both checks. */
export { replayer };

const host = (u) => new URL(u).host;
const hx = (n) => `0x${n.toString(16)}`;
const digest = (logs) => createHash("sha256").update(JSON.stringify(logs.map((l) => [l.blockHash, l.logIndex, l.transactionHash, l.data, l.topics]))).digest("hex").slice(0, 16);

/** One chain's check: { verdict, ok, lines }. `kit`: the kit's (kitList) unless a test names another. */
export async function checkChain(transport, chain, kit = kitList(chain)) {
  const lines = [];
  const { id, deploy } = CHAINS[chain];
  try {
    const { list, pool, poolManager } = kit;
    if (!Array.isArray(list) || list.length < 2) throw new Error(`${chain}: the pool list holds ${list?.length ?? 0} providers, not a pair`);
    const seats = list.slice(0, 2);
    for (const u of seats) if (evmRpcOperator(u) === null) throw new Error(`${chain}: ${JSON.stringify(u)} is not an http or https URL`);
    if (evmRpcOperator(seats[0]) === evmRpcOperator(seats[1])) throw new Error(`${chain}: the two seats are one operator (${evmRpcOperator(seats[0])}): ${seats.map(host).join(" and ")}`);
    const ask = (url, method, params, what) => askOf(transport, TRIES, `${chain}: `, url, method, params, what);
    const heads = [];
    for (const url of seats) {
      const got = await ask(url, "eth_chainId", [], "eth_chainId");
      if (typeof got !== "string" || got.toLowerCase() !== id) throw new Error(`${chain}: ${host(url)}: eth_chainId ${JSON.stringify(got)}, not ${id}`);
      heads.push(BigInt(await ask(url, "eth_blockNumber", [], "eth_blockNumber")));
    }
    // every range under both heads, so both seats read the same blocks
    const low = (heads[0] < heads[1] ? heads[0] : heads[1]) - 100n;
    const logsOn = async (url, filter, what) => {
      const r = await ask(url, "eth_getLogs", [filter], what);
      if (!Array.isArray(r)) throw new Error(`${chain}: ${host(url)}: ${what}: not a list of logs`);
      return { n: r.length, d: digest(r) };
    };
    const pages = [
      [low - BigInt(PAGE) + 1n, "to the head"],
      [low - BigInt(BACK) - BigInt(PAGE) + 1n, `${BACK} back`],
      [deploy, "from the deploy block"],
    ];
    for (const [from, where] of pages) {
      const what = `the pool's filter over ${PAGE} blocks ${where} (${from}-${from + BigInt(PAGE) - 1n})`;
      const got = [];
      for (const url of seats) got.push(await logsOn(url, { address: pool, topics: [POOL_TOPICS], fromBlock: hx(from), toBlock: hx(from + BigInt(PAGE) - 1n) }, what));
      if (got[0].d !== got[1].d) throw new Error(`${chain}: the seats' answers to ${what} differ: ${got.map((g, k) => `${host(seats[k])} ${g.n} logs ${g.d}`).join(", ")}`);
      lines.push(`${chain}: ${seats.map((u) => `${host(u)} (${evmRpcOperator(u)})`).join(" and ")}: ${what}, ${got[0].n} logs on both`);
    }
    for (const [from, where] of [[low - 1_100n, "at the head"], [low - BigInt(BACK), `${BACK} back`]]) {
      const what = `the PoolManager's Swap logs ${where} (${from}-${from + 99n})`;
      const got = [];
      for (const url of seats) got.push(await logsOn(url, { address: poolManager, topics: [SWAP4], fromBlock: hx(from), toBlock: hx(from + 99n) }, what));
      if (got[0].d !== got[1].d) throw new Error(`${chain}: the seats' answers to ${what} differ: ${got.map((g, k) => `${host(seats[k])} ${g.n} logs ${g.d}`).join(", ")}`);
      if (got[0].n === 0) throw new Error(`${chain}: ${what}: no logs on either seat, so their agreement proves nothing`);
      lines.push(`${chain}: both seats: ${what}, ${got[0].n} logs, digest ${got[0].d} on both`);
    }
    return { verdict: "PASS", ok: true, lines };
  } catch (e) {
    lines.push(`${e?.message ?? e}`);
    return { verdict: verdictOfError(e), ok: false, lines };
  }
}

/** SIGN_HOST's answer (read: status and CSP) against every seat: { ok, line }. */
export function judgePage(page, kits) {
  const seats = Object.values(kits).flatMap((k) => k.list.slice(0, 2).map((u) => new URL(u).origin));
  if (page?.status !== 200 || typeof page.csp !== "string") return { ok: false, line: `SIGN_HOST ${SIGN_HOST} answered ${page?.status}, ${page?.csp === null ? "no CSP" : "a CSP"}` };
  const allowed = connectSrc(page.csp) ?? [];
  const lacks = seats.filter((o) => !allowed.includes(o));
  return lacks.length ? { ok: false, line: `SIGN_HOST's connect-src lacks ${lacks.join(" ")}` } : { ok: true, line: `SIGN_HOST's connect-src names every seat (${seats.length})` };
}

/** Both chains and SIGN_HOST's policy: { verdict, ok, lines }: FAIL on any wrong answer, else INCONCLUSIVE when a chain
 *  had a seat answer nothing, else PASS. `kits`: each chain's (kitList) unless a test names others. */
export async function check(transport, kits = { base: kitList("base"), robinhood: kitList("robinhood") }, page) {
  const lines = [];
  const p = judgePage(page, kits);
  let bad = !p.ok;
  let quiet = false;
  lines.push(p.line);
  for (const chain of Object.keys(CHAINS)) {
    const r = await checkChain(transport, chain, kits[chain]);
    bad ||= r.verdict === "FAIL";
    quiet ||= r.verdict === "INCONCLUSIVE";
    lines.push(...r.lines);
  }
  const verdict = verdictOf(bad, quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

/** Base's pair before the card: its quote list's first two, which the sync read as its pool list. */
export const BASE_BEFORE = Object.freeze(["https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io"]);

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const kits = { base: kitList("base"), robinhood: kitList("robinhood") };
  const page = await read(SIGN_HOST);
  const rec = recorder();
  const r = await check(rec.transport, kits, page);
  for (const l of r.lines) console.log(`${r.verdict} ${l}`);
  if (record) {
    if (r.verdict !== "PASS") throw new Error(`the good run is ${r.verdict}: no good run to record`);
    const before = recorder();
    const b = await checkChain(before.transport, "base", { ...kits.base, list: [...BASE_BEFORE] });
    if (b.verdict !== "FAIL") throw new Error(`Base's pair before is ${b.verdict}, not FAIL: no bad run to record`);
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: { kits, page, log: rec.log }, baseBefore: { kit: { ...kits.base, list: [...BASE_BEFORE] }, log: before.log } }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(`${r.verdict} ${KEY}`);
  return EXIT[r.verdict];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
