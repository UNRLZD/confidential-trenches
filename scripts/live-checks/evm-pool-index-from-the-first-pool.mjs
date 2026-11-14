#!/usr/bin/env node
// Live check of card evm-pool-index-from-the-first-pool: the deployed helper serves each EVM chain's PoolManager pools
// from its first block, read to its head. The device scans the PoolManager's Initialize logs only the venue's depth back
// (Base 1,000,000 blocks, Robinhood 10,000,000), so a token whose only pool is older was never a candidate for its
// reference; the helper's index closes that, and this check holds it there after every helper deploy.
// It asks GET {helper}/v1/market/pools for the chain's named token, whose named pool was made long before the scan's
// depth, and reads the chain's head on two public providers. It passes only when:
//   - the answer is the chain's (chainId, PoolManager) and `complete: true`;
//   - `through` is within the device's scan depth of the lower head of the two providers (no block between the index
//     and the device's own scan is left unread) and not past the higher one;
//   - every served pool's key hashes to its id (keccak of the encoded key) and names the token;
//   - the named pool is served.
// Every answer is hostile: shapes, sizes and numbers are checked, and a provider or the helper that errors, times out
// (15 s) or answers something else is a BAD line naming it.
// After: helper --chain robinhood
// After: helper --chain base
//   node scripts/live-checks/evm-pool-index-from-the-first-pool.mjs --chain <robinhood|base> [--helper <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { keccak } from "./pool-evm-deploy.mjs";

const KEY = "evm-pool-index-from-the-first-pool";
export const HELPER = "https://ct-api.unrealized.trade";
/** Per chain: its id, PoolManager, the device's scan depth (kit trade/evm/buy-unpinned.ts), two public head providers, and
 *  the named token and pool. Robinhood's: native/0xb4c8b1f1…507b, fee 0, tick spacing 1, no hook, initialized at block
 *  100,150,105, its token's only pool at or after block 9,505 none newer (a whole backfill of the PoolManager from block 0
 *  on rpc.mainnet.chain.robinhood.com, 2026-11-14 08:12-08:26Z, head 114,027,190); Base's: native/0x36ede8f1…7584, fee 3000, tick spacing 60, no
 *  hook, initialized at block 27,500,318 (base.api.pocket.network, 2026-11-14 08:1xZ), 29.7M blocks before the head. */
export const CHAINS = {
  robinhood: {
    chainId: 4663,
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    depth: 10_000_000,
    heads: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"],
    token: "0xb4c8b1f18f67d4f25a51f5ead97dc95a79f2507b",
    pool: "0x7d527182d13d1bcdc4be889c2c52489a5fe94263cb427991dc80104dc1150e47",
  },
  base: {
    chainId: 8453,
    poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    depth: 1_000_000,
    heads: ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co"],
    token: "0x36ede8f188161423640ad60d6930587037cd7584",
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
const headOf = (url) => read(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });

/** The verdict of one run's reads: { ok, lines }. `reads`: { answer: {status, text}, heads: [{status, text}, ...] }. */
export function judge(chain, reads) {
  const c = CHAINS[chain];
  const bad = [];
  const heads = reads.heads.map((h, i) => {
    let n = null;
    try {
      const j = JSON.parse(h.text);
      if (h.status === 200 && QUANTITY.test(j?.result ?? "")) n = Number(j.result);
    } catch {}
    if (n === null || !Number.isSafeInteger(n)) bad.push(`BAD head ${c.heads[i]}: no block number`);
    return n;
  });
  let a = null;
  try {
    a = reads.answer.status === 200 ? JSON.parse(reads.answer.text) : null;
  } catch {}
  if (a === null || typeof a !== "object") return { ok: false, lines: [...bad, `BAD helper: status ${reads.answer.status}, no JSON answer`] };
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
    if (k.currency0 !== c.token && k.currency1 !== c.token) bad.push(`BAD helper: pool ${p.id} does not pair ${c.token}`);
    ids.add(p.id);
  }
  if (!ids.has(c.pool)) bad.push(`BAD helper: the named pool ${c.pool}, made before the scan's depth, is not served`);
  const lines = bad.length ? bad : [`OK ${chain}: complete, through ${a.through} (heads ${heads.join(", ")}), ${ids.size} pool(s) of ${c.token}, the named pool ${c.pool} among them`];
  return { ok: bad.length === 0, lines };
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
  const [answer, ...heads] = await Promise.all([read(`${helper}/v1/market/pools?chain=${chain}&token=${c.token}`).catch(failed), ...c.heads.map((u) => headOf(u).catch(failed))]);
  const reads = { answer, heads };
  const record = opt("--record");
  if (record) writeFileSync(record, JSON.stringify({ chain, reads }, null, 2) + "\n");
  const v = judge(chain, reads);
  for (const l of v.lines) console.log(l);
  console.log(v.ok ? `PASS ${KEY} ${chain}` : `FAIL ${KEY} ${chain}`);
  process.exit(v.ok ? 0 : 1);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => (console.error(`${KEY}: ${e.message}`), process.exit(2)));
