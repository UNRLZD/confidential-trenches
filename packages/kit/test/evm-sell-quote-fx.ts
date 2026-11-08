// The modelled chain the sell quote's tests run on (moved out of test/evm-sell-quote.test.ts so the signing page's
// tests quote on it too, card evm-buy-hookdata-fee): a provider decodes each aggregate3 call and answers each quote from
// a price model, the factory and getPool reads, the L1 fee oracle and the fee-on-transfer probe run as W's code.
import assert from "node:assert/strict";
import * as kit from "../src/index.ts";
import * as quoteMod from "../src/checks/evm/quote.ts";
import type { EvmRpc, EvmRpcCall } from "../src/checks/evm/quote.ts";
import type { EvmPoolChain } from "../src/trade/evm/buy-unpinned.ts";

export const W = (v: bigint) => v.toString(16).padStart(64, "0");
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const TOKEN = "0x1111111111111111111111111111111111111111";
export const WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // Hardhat account 0, a published test key
export const FACTORY = "0x00000000000000000000000000000000000fac70";
export const V3_POOL = "0x0000000000000000000000000000000000000b01";
export const HASH = "0x" + "bb".repeat(32);
export const AMOUNT = 10n ** 18n;
// the quote module as a namespace: the red run before card evm-sell-device-quote read it where evmPoolSellQuoteWith was not there yet
export const sellQuoteWith = (quoteMod as unknown as { evmPoolSellQuoteWith: (...a: unknown[]) => Promise<kit.EvmPoolSellQuote> }).evmPoolSellQuoteWith;

export type Pool = { venue: "v3" | "v4"; hops: number; from: string; to: string[]; fees: number[]; spacings: number[]; hooks: string[]; amount: bigint };
// one quoter call's shape, from its calldata (as test/evm-quote-attacks.test.ts reads a buy's)
export function poolOf(h: string): Pool {
  const sel = h.slice(0, 8);
  const d = h.slice(8);
  const w = (i: number) => BigInt("0x" + d.slice(64 * i, 64 * i + 64));
  const addr = (i: number) => "0x" + d.slice(64 * i + 24, 64 * i + 64);
  if (sel === "cdca1753") {
    const len = Number(w(2));
    const path = d.slice(64 * 3, 64 * 3 + 2 * len);
    const hops = (len - 20) / 23;
    const fees = Array.from({ length: hops }, (_, i) => parseInt(path.slice(40 + 46 * i, 46 + 46 * i), 16));
    const to = Array.from({ length: hops }, (_, i) => "0x" + path.slice(46 + 46 * i, 86 + 46 * i));
    return { venue: "v3", hops, from: "0x" + path.slice(0, 40), to, fees, spacings: [], hooks: [], amount: w(1) };
  }
  assert.equal(sel, "ca253dc9");
  const n = Number(w(4));
  const p: Pool = { venue: "v4", hops: n, from: addr(1), to: [], fees: [], spacings: [], hooks: [], amount: w(3) };
  for (let i = 0; i < n; i++) {
    const at = 5 + Number(w(5 + i)) / 32;
    p.to.push(addr(at));
    p.fees.push(Number(w(at + 1)));
    p.spacings.push(Number(w(at + 2)));
    p.hooks.push(addr(at + 3));
    assert.equal(w(at + 4), 0xa0n);
    assert.equal(w(at + 5), 0n, "every hop's hook data is empty"); // the device's own, never a route's
  }
  return p;
}
export function decodeAggregate(data: string): string[] {
  const h = data.slice(10);
  const w = (o: number) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
  return Array.from({ length: w(32) }, (_, i) => {
    const e = 64 + w(64 + 32 * i);
    const dl = w(e + 96);
    return h.slice(2 * (e + 128), 2 * (e + 128 + dl));
  });
}
export function encodeAggregate(outs: (bigint | null)[]): string {
  const body = outs.map((x) => (x === null ? W(0n) + W(0x40n) + W(0n) : W(1n) + W(0x40n) + W(64n) + W(x) + W(0n)));
  let at = 32 * outs.length;
  const offs = body.map((b) => {
    const o = W(BigInt(at));
    at += b.length / 2;
    return o;
  });
  return "0x" + W(0x20n) + W(BigInt(outs.length)) + offs.join("") + body.join("");
}

export type Model = {
  price: (p: Pool) => bigint | null;
  /** what the probe answers for (token, to, amount); null: it reverts */
  probe?: (token: string, to: string, amount: bigint) => bigint | null;
  headSec?: number;
  /** the block's base fee (Base's 5,000,000 wei by default); null: the block names none */
  baseFee?: bigint | null;
  /** what the chain fee oracle answers, by selector (pool-fee.ts evmPoolChainFeeReads; 0 by default); null: it reverts */
  chainFee?: Record<string, bigint | null>;
  /** the finalized block (card evm-sell-no-release-in-flight): 0x100 - 0x20 by default, 900 s before the head */
  fin?: bigint;
  /** the pool's Withdrawn and Bought logs (to WALLET unless `to`), answered to an eth_getLogs of its range and topic */
  releases?: Release[];
  /** the newest block a getLogs range to "latest" reaches (every release by default) */
  seesTo?: bigint;
  /** the newest block the provider holds by number (asked each time; the head 0x100 by default): a block above the head
   *  has the hash releaseLog gives it */
  holds?: () => bigint;
  /** the head a "latest" read answers (asked each time; 0x100 by default) */
  latest?: () => bigint;
};
export type Release = { kind: "withdraw" | "buy"; block: bigint; nullifier: bigint; to?: string; token?: string };
/** A block's hash in the model: the head's is HASH, any other's its number padded with c */
export const hashOf = (b: bigint) => (b === 0x100n ? HASH : "0x" + b.toString(16).padStart(64, "c"));
export const TOPIC_WITHDRAWN = "0xfabb9e7afa4ef595f60e1ae9041b2b311b4acb27aeaed4b11b6f2abf689af10a";
export const TOPIC_BOUGHT = "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d";
/** A release log as an RPC answers it, from `pool`. */
export const releaseLog = (pool: string, r: Release, i = 0) => ({
  address: pool,
  topics: [r.kind === "withdraw" ? TOPIC_WITHDRAWN : TOPIC_BOUGHT, "0x" + W(BigInt(r.to ?? WALLET))],
  data: "0x" + W(0xfeen) + W(10n ** 15n) + W(0n) + W(r.nullifier) + W(7n) + (r.kind === "buy" ? W(BigInt(r.token ?? TOKEN)) + W(5n) : ""),
  blockNumber: "0x" + r.block.toString(16),
  blockHash: hashOf(r.block),
  logIndex: "0x" + i.toString(16),
  transactionHash: "0x" + "dd".repeat(32),
  removed: false,
});
export type Seen = { pools: Pool[]; probes: { w: string; token: string; to: string; amount: bigint; code: string }[] };
/** A provider on the modelled chain; every quote it is asked lands in `seen`. */
export function provider(m: Model, seen: Seen = { pools: [], probes: [] }): EvmRpc {
  const fee = m.baseFee === undefined ? 5_000_000n : m.baseFee;
  const head = { number: "0x100", hash: HASH, timestamp: "0x" + (m.headSec ?? Math.floor(Date.now() / 1000) - 2).toString(16), ...(fee === null ? {} : { baseFeePerGas: "0x" + fee.toString(16) }) };
  const one = (data: string): bigint | null => {
    const sel = data.slice(0, 8);
    if (sel === "c45a0155") return BigInt(FACTORY);
    if (sel === "1698ee82") return BigInt(V3_POOL);
    // the chain fee oracle: GasPriceOracle getL1FeeUpperBound, getOperatorFee; ArbGasInfo getL1BaseFeeEstimate
    if (sel === "f1c7a58b" || sel === "275aedd2" || sel === "f5d6ded7") return m.chainFee?.[sel] === undefined ? 0n : m.chainFee[sel]!;
    const p = poolOf(data);
    seen.pools.push(p);
    return m.price(p);
  };
  return async (calls: readonly EvmRpcCall[]) =>
    calls.map((c, id) => {
      if (c.method === "eth_getBlockByNumber" && c.params[0] === "finalized") {
        const f = m.fin ?? 0x100n - 0x20n;
        return { jsonrpc: "2.0", id, result: { ...head, number: "0x" + f.toString(16), hash: "0x" + f.toString(16).padStart(64, "f"), timestamp: "0x" + (BigInt(head.timestamp) - 900n).toString(16) } };
      }
      if (c.method === "eth_getBlockByNumber" && c.params[0] !== "latest" && BigInt(c.params[0] as string) !== 0x100n) {
        const k = BigInt(c.params[0] as string);
        return { jsonrpc: "2.0", id, result: k <= (m.holds?.() ?? 0x100n) ? { ...head, number: "0x" + k.toString(16), hash: hashOf(k) } : null };
      }
      if (c.method === "eth_getBlockByNumber") {
        const n = m.latest?.() ?? 0x100n;
        return { jsonrpc: "2.0", id, result: n === 0x100n ? { ...head } : { ...head, number: "0x" + n.toString(16), hash: hashOf(n) } };
      }
      if (c.method === "eth_getLogs") {
        const f = c.params[0] as { address: string; fromBlock?: string; toBlock?: string; blockHash?: string; topics: [string[], string] };
        assert.deepEqual(f.topics[0], [TOPIC_WITHDRAWN, TOPIC_BOUGHT]);
        const all = (m.releases ?? []).map((r, i) => releaseLog(f.address, r, i)).filter((l) => l.topics[1] === f.topics[1].toLowerCase());
        if (f.blockHash !== undefined) return { jsonrpc: "2.0", id, result: all.filter((l) => l.blockHash === f.blockHash && BigInt(l.blockNumber) <= (m.holds?.() ?? 0x100n)) };
        const lo = BigInt(f.fromBlock!);
        const hi = f.toBlock === "latest" ? (m.seesTo ?? 1n << 64n) : BigInt(f.toBlock!);
        return { jsonrpc: "2.0", id, result: all.filter((l) => BigInt(l.blockNumber) >= lo && BigInt(l.blockNumber) <= hi) };
      }
      assert.equal(c.method, "eth_call");
      const { to, data } = c.params[0] as { to: string; data: string };
      assert.equal((c.params[1] as { blockHash: string }).blockHash, HASH);
      const override = c.params[2] as Record<string, { code: string }> | undefined;
      let out: bigint | null;
      if (to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
        assert.equal(override, undefined);
        return { jsonrpc: "2.0", id, result: encodeAggregate(decodeAggregate(data).map(one)) };
      }
      if (override !== undefined) {
        const d = data.slice(2);
        const probe = { w: to.toLowerCase(), token: "0x" + d.slice(24, 64), to: "0x" + d.slice(88, 128), amount: BigInt("0x" + d.slice(128, 192)), code: override[to]?.code ?? "" };
        seen.probes.push(probe);
        out = (m.probe ?? ((_t, _to, a) => a))(probe.token, probe.to, probe.amount);
      } else out = one(data.slice(2));
      return out === null ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } } : { jsonrpc: "2.0", id, result: "0x" + W(out) };
    });
}
export const verdict = async (p: Promise<kit.EvmPoolSellQuote>) => {
  try {
    const q = await p;
    return { accepted: true, venue: q.route.venue, amountOut: q.amountOut, minOut: q.minOut };
  } catch (e) {
    if (!(e instanceof kit.EvmQuoteError)) throw e;
    return { accepted: false, code: e.code };
  }
};
// the route the buy that paid W took (required, review of edb4dbb F3): the standard 0.3% native pool
export const BOUGHT = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] };
export const req = (chain: EvmPoolChain = "base", o: Record<string, unknown> = {}) => ({ chain, token: TOKEN, w: WALLET, amountIn: AMOUNT, slippageBps: 100, bought: BOUGHT, boughtBlock: 0x100n, sent: [], ...o });
export const sell = (m: Model, chain: EvmPoolChain = "base", o: Record<string, unknown> = {}, m2: Model = m) =>
  sellQuoteWith(req(chain, o), [provider(m), provider(m2)], Date.now());
/** v4 to the native asset, fee 3000: 2 ETH a token; every other pool 1 */
export const flat = (p: Pool) => (p.venue === "v4" && p.hops === 1 && p.to[0] === NATIVE && p.fees[0] === 3000 ? 2n * p.amount : p.amount);
