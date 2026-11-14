#!/usr/bin/env node
// Live check of card evm-pool-amounts-are-standard-sizes: every amount that enters or leaves the mainnet Base and
// Robinhood pools after the fix's first transaction is a standard size, a rung of the 1-2-5 ladder from 0.001 ETH (the
// wallet's EVM_LADDER: one = 100,000,000,000,000 wei, the pool's MIN_DEPOSIT, min = 1,000,000,000,000,000 wei). Read
// 14 Nov 10:0xZ: Base's pool holds one deposit, 0.01 ETH; Robinhood's a 0.002 ETH deposit, a 0.002 ETH buy and a sale's
// deposit back of 1,880,137,434,291,065 wei (SellDelegate deposits what the sale brought less the fee).
// For each pool, on two public RPCs of two operators (RPCS):
//   1. the finalized block on each, and the lower of the two as the read's end;
//   2. every Deposited, Withdrawn and Bought of the pool from its deploy block to that end (contracts/pool-evm/src/
//      interfaces/IPrivacyPool.sol: Deposited's _value, the amount that enters; Withdrawn's and Bought's _value, the
//      amount that leaves), in pages, and each row's block time;
// and passes when both RPCs read the same rows, every deposit at or after --from is a rung, and every release at or
// after --from is a rung but the last remainders of notes made before the fix: at most one per deposit before --from
// (a note's line ends in at most one remainder off the ladder, released whole once: the circuit has one input and
// withdrawnValue is public), as pool-amounts-are-standard-sizes.mjs judges the Solana pool.
// Runs: pending evm-pool-amounts-are-standard-sizes, it needs --from, the time this card's build went live on SIGN_HOST:
// the release that ships it adds `// After: sign --from <that time>` here, so no run before it reads the old build's sizes
//   node scripts/live-checks/evm-pool-amounts-are-standard-sizes.mjs --from <ISO time> [--record <file>] [--answer <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (an RPC that gives no answer after its retries)
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

// keccak from the helper's own dependency, as pool-evm-deploy.mjs takes it (the root package names none)
const { keccak_256 } = createRequire(new URL("../../apps/helper/package.json", import.meta.url))("@noble/hashes/sha3.js");

const KEY = "evm-pool-amounts-are-standard-sizes";
/** The ladder, wei: one and the least rung (the wallet's EVM_LADDER; the test holds them equal). */
export const ONE = 100_000_000_000_000n;
export const MIN = 1_000_000_000_000_000n;
/** The mainnet pools (contracts/pool-evm/deployments/<chain>.json PrivacyPoolSimple), the block of each one's deploy
 *  transaction, the two RPCs of two operators that answer its logs from that block with no key (read 14 Nov 10:0xZ:
 *  mainnet.base.org answered "request limit reached" at 10,000 blocks, base.drpc.org takes 10,000 at most free,
 *  base.api.pocket.network's backends at most 10,001, robinhood-rpc.publicnode.com refuses old blocks without a token),
 *  the page each takes, in blocks, and how many pages it is asked at once (rpc.mainnet.chain.robinhood.com answered
 *  HTTP 429 at 4 at once, 14 Nov 10:1xZ). */
export const POOLS = Object.freeze({
  base: Object.freeze({ pool: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf", deployBlock: 54325671, rpcs: Object.freeze(["https://base-rpc.publicnode.com", "https://base.api.pocket.network"]), pages: Object.freeze([50_000, 10_000]), lanes: Object.freeze([2, 4]) }),
  robinhood: Object.freeze({ pool: "0x9306359433127c4f3be426f6faeb00a3c41f66db", deployBlock: 108420674, rpcs: Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://rpc-robinhood.globalstake.io"]), pages: Object.freeze([100_000, 100_000]), lanes: Object.freeze([1, 1]) }),
});
const topic = (s) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex");
export const TOPICS = Object.freeze({
  deposit: topic("Deposited(address,uint256,uint256,uint256,uint256)"),
  withdraw: topic("Withdrawn(address,address,uint256,uint256,uint256,uint256)"),
  buy: topic("Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)"),
});

/** Whether `x` wei is a rung: d x 10^k x ONE, d in {1, 2, 5}, at least MIN. */
export function isRung(x) {
  if (typeof x !== "bigint" || x < MIN || x % ONE !== 0n) return false;
  let q = x / ONE;
  while (q % 10n === 0n) q /= 10n;
  return q === 1n || q === 2n || q === 5n;
}

// ------------------------------------------------------------------------------------------------ the verdict
/** One pool's verdict on { rpcs, pool, rows: [rows on RPC 0, rows on RPC 1] }, each row { tx, index, block, time (unix
 *  s), kind (deposit | withdraw | buy), value (wei, a decimal string) }, from `from` (unix s) on. */
function judgeChain(chain, c, from, bad) {
  const want = POOLS[chain];
  const pair = Array.isArray(c?.rpcs) && c.rpcs.length === 2 && c.rpcs.every((u, i) => u === want.rpcs[i]);
  if (!pair) return bad(`${chain}: the reads are not on the two public RPCs ${want.rpcs.join(" and ")}`), null;
  if (c.pool !== want.pool) return bad(`${chain}: the pool read is not ${want.pool}`), null;
  const rows = Array.isArray(c.rows) && c.rows.length === 2 && c.rows.every(Array.isArray) ? c.rows : null;
  if (!rows) return bad(`${chain}: the pool's events are not read on both RPCs`), null;
  const key = (r) => `${r.tx} ${r.index} ${r.block} ${r.time} ${r.kind} ${r.value}`;
  const [a, b] = rows.map((list) => list.map(key).sort());
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return bad(`${chain}: the two RPCs read the pool's events differently`), null;
  let before = 0;
  let after = 0;
  let off = 0;
  for (const r of [...rows[0]].sort((x, y) => x.block - y.block || x.index - y.index)) {
    let v;
    try {
      v = BigInt(r.value);
    } catch {
      bad(`${chain} ${r.tx}: a value that is not a whole number`);
      continue;
    }
    if (!Number.isSafeInteger(r.time)) bad(`${chain} ${r.tx}: no block time`);
    if (!["deposit", "withdraw", "buy"].includes(r.kind)) bad(`${chain} ${r.tx}: an event that is no deposit or release`);
    if (r.time < from) {
      if (r.kind === "deposit") before += 1;
      continue;
    }
    after += 1;
    if (r.kind === "deposit" && !isRung(v)) bad(`${chain} ${r.tx}: a deposit of ${v} wei, off the ladder`);
    if (r.kind !== "deposit" && !isRung(v)) {
      off += 1;
      if (off > before) bad(`${chain} ${r.tx}: a ${r.kind} release of ${v} wei, off the ladder, past the ${before} remainders of notes made before the fix`);
    }
  }
  return `${chain}: ${rows[0].length} events, ${before} deposits before the fix, ${after} from it, ${off} remainder release${off === 1 ? "" : "s"} off the ladder`;
}

/** The verdict on a record { from, chains: { base, robinhood } }. */
export function judge(rec) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const from = typeof rec?.from === "string" ? Date.parse(rec.from) / 1000 : NaN;
  if (!Number.isFinite(from)) bad("no --from: the time of the fix's first transaction is not named");
  const chains = rec?.chains;
  const names = chains && typeof chains === "object" ? Object.keys(chains).sort() : [];
  if (names.join(",") !== Object.keys(POOLS).sort().join(",")) bad(`the reads are not of both pools, ${Object.keys(POOLS).join(" and ")}: ${names.join(", ") || "none"}`);
  if (lines.length > 0) return { ok: false, lines };
  const oks = Object.keys(POOLS).map((ch) => judgeChain(ch, chains[ch], from, bad));
  if (lines.length === 0) for (const o of oks) lines.push(`ok ${o}`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

// ------------------------------------------------------------------------------------------------ the reads
// each read through provider-answer.mjs rpcAnswer: a no-answer (no HTTP answer, a 429, a 5xx, a rate limit) is read
// again with a growing pause, and after the last one the run is INCONCLUSIVE (exit 3), never FAIL or PASS
class NoAnswer extends Error {}
const callOn = (url) => async (method, params) => {
  let a;
  for (let i = 0; i < 8; i++) {
    a = await rpcAnswer(url, method, params);
    if (a.noAnswer === undefined) break;
    await new Promise((s) => setTimeout(s, 1_000 * 2 ** Math.min(i, 4)));
  }
  if (a.noAnswer !== undefined) throw new NoAnswer(a.noAnswer);
  if (a.error !== undefined) throw new Error(`${new URL(url).host}: ${method}: ${JSON.stringify(a.error).slice(0, 160)}`);
  return a.result;
};
const hex = (n) => "0x" + n.toString(16);
const word = (data, i) => BigInt("0x" + data.slice(2 + 64 * i, 66 + 64 * i));
const KIND = Object.freeze(Object.fromEntries(Object.entries(TOPICS).map(([k, t]) => [t, k])));

/** The pool's rows on one RPC up to block `to`, oldest first, in pages of `page` blocks, `lanes` of them at once. */
async function rowsOn(url, p, to, page, lanes) {
  const call = callOn(url);
  const ranges = [];
  for (let a = p.deployBlock; a <= to; a += page) ranges.push([a, Math.min(a + page - 1, to)]);
  const pages = new Array(ranges.length);
  let next = 0;
  const lane = async () => {
    for (let i = next++; i < ranges.length; i = next++) pages[i] = await call("eth_getLogs", [{ address: p.pool, topics: [Object.values(TOPICS)], fromBlock: hex(ranges[i][0]), toBlock: hex(ranges[i][1]) }]);
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  const logs = pages.flat();
  const times = new Map();
  const rows = [];
  for (const l of logs) {
    const kind = KIND[l.topics?.[0]];
    if (kind === undefined || l.removed) continue;
    const block = Number(BigInt(l.blockNumber));
    if (!times.has(block)) times.set(block, Number(BigInt((await call("eth_getBlockByNumber", [hex(block), false])).timestamp)));
    // Deposited: _commitment, _label, _value, _precommitmentHash; Withdrawn and Bought: _feeRecipient, _value, ...
    const value = kind === "deposit" ? word(l.data, 2) : word(l.data, 1);
    rows.push({ tx: l.transactionHash.toLowerCase(), index: Number(BigInt(l.logIndex)), block, time: times.get(block), kind, value: value.toString() });
  }
  return rows;
}

async function readChain(chain) {
  const p = POOLS[chain];
  const fin = await Promise.all(p.rpcs.map(async (u) => Number(BigInt((await callOn(u)("eth_getBlockByNumber", ["finalized", false])).number))));
  const to = Math.min(...fin);
  return { rpcs: p.rpcs, pool: p.pool, to, rows: await Promise.all(p.rpcs.map((u, k) => rowsOn(u, p, to, p.pages[k], p.lanes[k]))) };
}

export async function read(from) {
  const chains = {};
  for (const ch of Object.keys(POOLS)) chains[ch] = await readChain(ch);
  return { from, chains };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(arg("--from"));
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    if (e instanceof NoAnswer) {
      console.error(`INCONCLUSIVE ${KEY}: ${e.message}`);
      process.exit(EXIT.INCONCLUSIVE);
    }
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
