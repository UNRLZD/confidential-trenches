#!/usr/bin/env node
// Live check of card evm-pool-index-from-the-first-pool: the deployed helper serves each EVM chain's PoolManager pools
// from its first block, read to its head. The device scans the PoolManager's Initialize logs only the venue's depth back
// (Base 1,000,000 blocks, Robinhood 10,000,000), so a token whose only pool is older was never a candidate for its
// reference; the helper's index closes that, and this check holds it there after every helper deploy.
// It asks GET {helper}/v1/market/pools for the chain's named token, whose named pool was made long before the scan's
// depth, and reads on two public providers, in one batch each, the chain's head and the named pool's slot0 in the
// PoolManager (extsload of its state slot, v4-core StateLibrary). It passes only when:
//   - the answer is the chain's (chainId, PoolManager) and `complete: true`;
//   - `through` is within the device's scan depth of the lower head of the two providers (no block between the index
//     and the device's own scan is left unread) and not past the higher one;
//   - every served pool's key hashes to its id (keccak of the encoded key) and names the token;
//   - the named pool is served, and the PoolManager holds it on both providers (slot0's price above 0), as the device
//     reads every served pool before it counts.
// Every answer is hostile: shapes, sizes and numbers are checked; the helper that errors, times out (15 s) or answers
// something else is a BAD line naming it, and a provider that gives no answer (provider-answer.mjs rpcAnswer: a 429, a
// 5xx, a timeout, a rate limit) leaves the run INCONCLUSIVE naming it, never PASS.
// After: helper --chain robinhood
// (Base's index is off on the helper until its volume is read for its room, server.ts POOL_INDEX_ON: --chain base is run
// by hand until it is on.)
//   node scripts/live-checks/evm-pool-index-from-the-first-pool.mjs --chain <robinhood|base> [--helper <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's test
//   can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { keccak } from "./pool-evm-deploy.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "evm-pool-index-from-the-first-pool";
export const HELPER = "https://ct-api.unrealized.trade";
/** Per chain: its id, PoolManager, the device's scan depth (kit trade/evm/buy-unpinned.ts), two public head providers, and
 *  the named coin and pool. Robinhood's: native/0xb4c8b1f1…507b, fee 0, tick spacing 1, no hook, initialized at block
 *  100,150,105, its token's only pool at or after block 9,505 none newer (a whole backfill of the PoolManager from block 0
 *  on rpc.mainnet.chain.robinhood.com, 2026-11-14 08:12-08:26Z, head 114,027,190); Base's: native/0x36ede8f1…7584, fee 3000, tick spacing 60, no
 *  hook, initialized at block 27,500,318 (base.api.pocket.network, 2026-11-14 08:1xZ), 29.7M blocks before the head. */
export const CHAINS = {
  robinhood: {
    chainId: 4663,
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    depth: 10_000_000,
    heads: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"],
    coin: "0xb4c8b1f18f67d4f25a51f5ead97dc95a79f2507b",
    pool: "0x7d527182d13d1bcdc4be889c2c52489a5fe94263cb427991dc80104dc1150e47",
  },
  base: {
    chainId: 8453,
    poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    depth: 1_000_000,
    heads: ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co"],
    coin: "0x36ede8f188161423640ad60d6930587037cd7584",
    pool: "0x2011c00dc590317504b1c67c1295a277b1ca2adf8133fa12f9f0be9cba2616a2",
  },
};
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 4_000_000;
const ADDR = /^0x[0-9a-f]{40}$/;
const ID = /^0x[0-9a-f]{64}$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]{0,15})$/i;
const word = (n) => BigInt.asUintN(256, n).toString(16).padStart(64, "0");
export const poolIdOf = (k) => keccak("0x" + word(BigInt(k.currency0)) + word(BigInt(k.currency1)) + word(BigInt(k.fee)) + word(BigInt.asUintN(256, BigInt(k.tickSpacing))) + word(BigInt(k.hooks)));

async function read(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  if (text.length > MAX_BYTES) throw new Error(`answer past ${MAX_BYTES} bytes`);
  return { status: r.status, text };
}
/** The pool's state slot in the PoolManager (StateLibrary._getPoolStateSlot: keccak(id, POOLS_SLOT 6)): slot0 there. */
export const stateSlotOf = (id) => keccak(id + word(6n));
const SEL_EXTSLOAD = "0x1e2eaeaf"; // PoolManager.extsload(bytes32)
/** A provider's two reads: its head and the named pool's slot0 (each rpcAnswer's { result } | { error } | { noAnswer }). */
const readOf = async (url, c) => {
  const [head, slot] = await Promise.all([rpcAnswer(url, "eth_blockNumber", []), rpcAnswer(url, "eth_call", [{ to: c.poolManager, data: SEL_EXTSLOAD + stateSlotOf(c.pool).slice(2) }, "latest"])]);
  return { url, head, slot };
};

/** The verdict of one run's reads: { verdict: PASS | FAIL | INCONCLUSIVE, ok, lines }. `reads`: { answer: {status, text}
 *  (the helper's), providers: [{ url, head, slot }, ...] (readOf's). */
export function judge(chain, reads) {
  const c = CHAINS[chain];
  const bad = [];
  const quiet = [];
  const heads = reads.providers.map((p, i) => {
    const host = c.heads[i];
    if (p?.url !== host) bad.push(`BAD provider ${i}: read ${p?.url}, not ${host}`);
    let n = null;
    if (p?.head?.noAnswer !== undefined) quiet.push(`--  ${p.head.noAnswer}`);
    else if (typeof p?.head?.result === "string" && QUANTITY.test(p.head.result) && Number.isSafeInteger(Number(p.head.result))) n = Number(p.head.result);
    else bad.push(`BAD head ${host}: no block number (${JSON.stringify(p?.head).slice(0, 120)})`);
    if (p?.slot?.noAnswer !== undefined) quiet.push(`--  ${p.slot.noAnswer}`);
    else if (typeof p?.slot?.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.slot.result)) bad.push(`BAD pool ${host}: no slot0 of the named pool (${JSON.stringify(p?.slot).slice(0, 120)})`);
    else if ((BigInt(p.slot.result) & ((1n << 160n) - 1n)) === 0n) bad.push(`BAD pool ${host}: the PoolManager does not hold the named pool ${c.pool} (slot0's price 0)`);
    return n;
  });
  if (reads.providers.length !== c.heads.length) bad.push(`BAD providers: ${reads.providers.length} read, not ${c.heads.length}`);
  let a = null;
  try {
    a = reads.answer.status === 200 ? JSON.parse(reads.answer.text) : null;
  } catch {}
  if (a === null || typeof a !== "object") return { verdict: "FAIL", ok: false, lines: [...bad, `BAD helper: status ${reads.answer.status}, no JSON answer`, ...quiet] };
  if (a.chainId !== c.chainId) bad.push(`BAD helper: chainId ${a.chainId}, not ${c.chainId}`);
  if (typeof a.poolManager !== "string" || a.poolManager.toLowerCase() !== c.poolManager) bad.push(`BAD helper: poolManager ${a.poolManager}`);
  if (a.complete !== true) bad.push(`BAD helper: complete ${a.complete}: the backfill has not reached its head`);
  if (!Number.isSafeInteger(a.through)) bad.push(`BAD helper: through ${a.through}`);
  else if (heads.every((h) => h !== null)) {
    const lo = Math.min(...heads);
    const hi = Math.max(...heads);
    if (a.through < lo - c.depth) bad.push(`BAD helper: through ${a.through} is more than the scan's ${c.depth} blocks behind the head ${lo}: blocks between the index and the device's scan are unread`);
    if (a.through > hi) bad.push(`BAD helper: through ${a.through} is past the head ${hi}`);
  }
  if (!Array.isArray(a.pools)) bad.push("BAD helper: no pools list");
  const ids = new Set();
  for (const p of Array.isArray(a.pools) ? a.pools : []) {
    const k = p?.key;
    const okKey = k && ADDR.test(k.currency0) && ADDR.test(k.currency1) && ADDR.test(k.hooks) && Number.isInteger(k.fee) && Number.isInteger(k.tickSpacing) && BigInt(k.currency0) < BigInt(k.currency1);
    if (!okKey || !ID.test(p?.id ?? "")) {
      bad.push(`BAD helper: a malformed pool ${JSON.stringify(p).slice(0, 200)}`);
      continue;
    }
    if (poolIdOf(k) !== p.id) bad.push(`BAD helper: pool ${p.id}'s key hashes to ${poolIdOf(k)}`);
    if (k.currency0 !== c.coin && k.currency1 !== c.coin) bad.push(`BAD helper: pool ${p.id} does not pair ${c.coin}`);
    ids.add(p.id);
  }
  if (!ids.has(c.pool)) bad.push(`BAD helper: the named pool ${c.pool}, made before the scan's depth, is not served`);
  const verdict = verdictOf(bad.length > 0, quiet.length > 0);
  const lines = bad.length ? [...bad, ...quiet] : quiet.length ? quiet : [`OK ${chain}: complete, through ${a.through} (heads ${heads.join(", ")}), ${ids.size} pool(s) of ${c.coin}, the named pool ${c.pool} among them and held on both providers`];
  return { verdict, ok: verdict === "PASS", lines };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const chain = opt("--chain");
  if (!Object.hasOwn(CHAINS, chain ?? "")) {
    console.error(`${KEY}: --chain robinhood|base`);
    process.exit(2);
  }
  const helper = opt("--helper") ?? HELPER;
  const c = CHAINS[chain];
  const failed = (e) => ({ status: 0, text: String(e?.message ?? e) });
  const [answer, ...providers] = await Promise.all([read(`${helper}/v1/market/pools?chain=${chain}&token=${c.coin}`).catch(failed), ...c.heads.map((u) => readOf(u, c))]);
  const reads = { answer, providers };
  const record = opt("--record");
  if (record) writeFileSync(record, JSON.stringify({ chain, reads }, null, 2) + "\n");
  const v = judge(chain, reads);
  for (const l of v.lines) console.log(l);
  console.log(`${v.verdict} ${KEY} ${chain}`);
  process.exit(EXIT[v.verdict]);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => (console.error(`${KEY}: ${e.message}`), process.exit(2)));
