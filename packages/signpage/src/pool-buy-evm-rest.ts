// The rest of an EVM buy (card buy-any-amount-on-every-chain): the pool's buy swaps a whole note, so the part of the
// ask the whole notes do not make is bought by the plan's rest piece's own W (rules/pool.ts planEvmBuy).
//
// - Before anything leaves, under the seed's lock with the whole notes' legs (src/pool-buy-evm.ts): the device's quote
//   of the rest (no route: nothing is signed, the note stays HELD), the release checked (checkEvmRestRelease: the plan's
//   rest piece, the relay data paying W) and signed by W (signEvmWithdraw), W's holding written pending and the rest's
//   record (EVM_WBUY_KEY) written: a write that fails sends nothing.
// - The release, sent by the helper's sender with the whole notes' buys, read back on both pool RPCs (evm-send.ts
//   evmReleaseRead): mine, another release of the nullifier, or none by the deadline (the pool refuses it from then).
// - W's own buy, once its release is read back: under the seed's lock again, the device quotes the rest afresh, reads
//   W's nonce and balance, the estimate and a run of the very call on both RPCs at one block, checks it
//   (checkEvmWBuy: the pinned adapter, exactly the rest, paying W, its fee bound within what the plan kept) and W signs
//   it (signEvmWBuy). Its hash is kept in the rest's record before its bytes go to both RPCs; its receipt is read on both
//   at a safe block (pool-withdraw-evm.ts onwardReceipt).
// - W's change: the carry pass (src/pool-carry-evm.ts) puts it back into the pool as rungs (checkEvmChange) once the
//   rest's record has its end or its send window is past; what is under the least rung stays on W.
// Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import type { EvmPoolBuyQuote } from "../../kit/src/checks/evm/quote.ts";
import type { EvmPoolBuy } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { EVM_CHAIN_IDS, evmAgreedBlock, evmRetryLag, type EvmPoolRequest, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import { checkEvmRestRelease, checkEvmWBuy, evmAdapterBuyData, evmOnwardCodeGas, poolUnits, signEvmWBuy, signEvmWithdraw, type EvmBuyPlan, type EvmOnwardSend, type PoolAsk } from "./rules/pool.ts";
import { evmWithdrawCalldata } from "./evm-send.ts";
import { evmReleaseOf, EVM_ONWARD_TIP, l1Of, onwardReceipt } from "./pool-withdraw-evm.ts";
import type { EvmHolding, EvmPoolBuyHost } from "./pool-buy-evm.ts";

type Ready = ReadyProof<EvmPoolRequest>;
type Chain = "base" | "robinhood";

/** Each rest W's record, by W's address (lowercase): an owed/ key, the one meta keyspace the wallet store lets a caller
 *  write. Written before the release leaves; `hash` before W's buy leaves; `end` once that buy reads back or will never
 *  be sent. The carry pass carries a W of this record only (src/pool-carry-evm.ts), and only once it has its end or
 *  its `signBy` is EVM_WBUY_CARRY_AFTER_MS past. */
export const EVM_WBUY_KEY = "owed/wbuy-evm";
export type EvmWBuyRecord = { chain: Chain; l: string; j: number; nullifier: string; deadlineMs: string; signBy: string; spend: string; token: string; hash?: string; end?: "filled" | "reverted" | "unsent" };
/** How long past its release's deadline W's own buy may still be signed: past it the run signs nothing and the change
 *  is carried back whole as rungs. */
export const EVM_WBUY_SEND_MS = 120_000n;
/** How long past `signBy` the carry waits on a record with no end (a tab closed after W signed): by then W's one buy has
 *  landed or will never land. */
export const EVM_WBUY_CARRY_AFTER_MS = 300_000n;

const lower = (s: string): string => s.toLowerCase();
const qty = (v: bigint): string => `0x${v.toString(16)}`;
const hexOf = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
class RestStop extends Error {}
const stop = (why: string): never => {
  throw new RestStop(why);
};
const quantity = (x: unknown): bigint => (typeof x === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(x) ? BigInt(x) : stop("read"));
const both = <T>(rpcs: readonly [EvmRpc, EvmRpc], f: (rpc: EvmRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
const agree = <T>(p: readonly [T, T]): T => (p[0] === p[1] ? p[0] : stop("reads"));

/** The rest leg, ready to send: the release's calldata and what its read-back and W's buy need. */
export type RestLeg = {
  r: Ready;
  w: string;
  data: Uint8Array;
  from: bigint;
  token: string;
  decimals: number;
  signBy: bigint;
  holding: EvmHolding;
};

/** What the rest leg asks of the buy's run: its quote (the kit's buy tap) and build, the venue pins. */
export type RestQuote = (amountIn: bigint) => Promise<{ q: EvmPoolBuyQuote; adapter: string; built: EvmPoolBuy }>;

/** Merges `rec` into W's rest record (EVM_WBUY_KEY): the host's write, or none at all (a page with no store signs no
 *  rest). */
export const mergeRest = (v: unknown, w: string, rec: Partial<EvmWBuyRecord>): Record<string, unknown> => {
  const all = typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
  const was = (all[lower(w)] ?? {}) as Partial<EvmWBuyRecord>;
  return { ...all, [lower(w)]: { ...was, ...rec } };
};
const writeRest = (h: Pick<EvmPoolBuyHost, "rest">, w: string, rec: Partial<EvmWBuyRecord>): Promise<void> => (h.rest === undefined ? Promise.reject(new RestStop("record")) : h.rest(w, rec));

/** The rest leg up to its send (under the seed's lock): the quote, the release checked and signed by W (the seed and
 *  W's key zeroed once it has signed), W's holding and the rest's record written. */
export async function prepRest(
  h: EvmPoolBuyHost,
  ask: PoolAsk,
  plan: EvmBuyPlan,
  r: Ready,
  quoted: RestQuote,
  from: bigint,
  clock: () => bigint,
): Promise<RestLeg> {
  if (plan.rest === null || plan.rest.piece.noteId !== r.noteId) return stop("plan");
  const token = ask.token ?? stop("token");
  const relay = r.binding.request.relay;
  const fee = r.binding.feeCap;
  const signals = r.publicSignals.map((s) => BigInt(s));
  const binding = { nullifier: signals[1]!, context: signals[7]!, value: signals[2]! };
  if (binding.context !== r.binding.context || binding.value !== r.chunk) return stop("binding");
  // the rest has a route before the note is spent: a quote the kit refuses signs nothing
  const { q, adapter } = await quoted(plan.rest.spend);
  const ctx = { nowMs: clock(), wallet: r.wallet.address, feeCap: fee, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
  checkEvmRestRelease(h.pin.pool, binding, relay, ask, ctx, plan, h.testnet);
  const decimals = await h.decimals(token);
  const seed = await h.seed64();
  let sig: Uint8Array;
  try {
    const w = freshWallet(seed, "evm", r.wallet.l, r.wallet.j);
    seed.fill(0);
    try {
      if (lower(w.address) !== lower(r.wallet.address) || lower(relay.recipient) !== lower(w.address)) return stop("wallet");
      sig = signEvmWithdraw(w.secretKey, ctx, ask, h.pin.pool, binding, h.testnet);
    } finally {
      w.secretKey.fill(0);
    }
  } finally {
    seed.fill(0);
  }
  const data = evmWithdrawCalldata(h.pin.pool, relay, r.proof, r.publicSignals, fee, sig);
  const w = r.wallet.address;
  const signBy = relay.deadlineMs + EVM_WBUY_SEND_MS;
  // the rest's record, written before anything leaves (the carry finds W's change from it and the chain's release); W's
  // holding, pending with no pool buy of its own (the load's follow reads only a pool buy's), once the release paid W
  // and before W signs its buy
  const holding: EvmHolding = { mint: lower(token), decimals, chain: h.chain, state: "pending", route: { venue: q.route.venue, adapter: lower(adapter), path: q.route } };
  await writeRest(h, w, { chain: h.chain, l: r.wallet.l.toString(), j: r.wallet.j, nullifier: binding.nullifier.toString(), deadlineMs: relay.deadlineMs.toString(), signBy: signBy.toString(), spend: plan.rest.spend.toString(), token: lower(token) });
  return { r, w, data, from, token, decimals, signBy, holding };
}

/** The rest leg's read-back state, kept across the tap's reads and the follow's: each RPC's read stop, the release once
 *  read back, W's holding once written, W's signed buy once signed (never signed twice). */
export type RestState = { stops: [bigint | null, bigint | null]; release: { tx: string; block: bigint } | null; held: boolean; signed: { raw: Uint8Array; hash: string; adapter: string } | null | "none"; round: number };
export const restState = (): RestState => ({ stops: [null, null], release: null, held: false, signed: null, round: 0 });

/** The rest leg past its send: the release read back, then W's own buy and its receipt. `more` bounds the reads (the
 *  tap's, or the follow's); `hold` runs W's signature under the seed's lock; `st` carries the leg from the tap's reads to
 *  the follow's. The leg's end, or null when the reads ran out first. */
export async function finishRest(
  h: EvmPoolBuyHost,
  ask: PoolAsk,
  plan: EvmBuyPlan,
  leg: RestLeg,
  st: RestState,
  quoted: RestQuote,
  more: () => boolean,
  wait: (ms: number) => Promise<void>,
  clock: () => bigint,
  hold: <T>(f: () => Promise<T>) => Promise<T>,
): Promise<{ stage: TradeStage; txs: TxRef[] } | null> {
  const { r, w } = leg;
  const p = { nullifier: BigInt(r.publicSignals[1]!).toString(), from: leg.from.toString(), deadlineMs: r.binding.request.relay.deadlineMs.toString(), chunk: r.chunk.toString(), fee: r.binding.feeCap.toString() };
  for (let i = 0; st.release === null; i++) {
    if (i > 0) {
      if (!more()) return null;
      await wait(2_000);
    }
    let v: Awaited<ReturnType<typeof evmReleaseOf>>;
    try {
      v = await evmReleaseOf(h, p, w, st.stops);
    } catch {
      continue;
    }
    if (v === null) continue;
    if (v.end !== "mine") {
      // never released to W: nothing of the rest is W's
      await writeRest(h, w, { end: "unsent" }).catch(() => {});
      return { stage: "not_landed", txs: [] };
    }
    st.release = { tx: v.tx, block: v.block };
    h.landed?.(r.noteId, r.attempt, r.chunk, v.block);
  }
  const release = st.release;
  const txs: TxRef[] = [{ chain: h.chain, hash: release.tx }];
  const carry = (): void => {
    try {
      h.carry?.();
    } catch {
      /* the next state read runs it */
    }
  };
  const route = (tx: string) => ({ ...leg.holding.route, tx, block: release.block.toString() });
  // W's holding pending, then W's buy, signed under the seed's lock: a write that fails (another holding on W), or W's
  // window past, signs nothing and the change is carried back
  if (st.signed === null) {
    try {
      if (!st.held) {
        await h.record(w, leg.holding);
        st.held = true;
      }
      st.signed = (await hold(() => signRest(h, ask, plan, leg, quoted, clock))) ?? "none";
    } catch {
      st.signed = "none";
    }
  }
  if (st.signed === "none") {
    await writeRest(h, w, { end: "unsent" }).catch(() => {});
    if (st.held) await h.record(w, { ...leg.holding, state: "withdrawn", route: route(release.tx) }).catch(() => {});
    carry();
    return { stage: "refused", txs };
  }
  const s = st.signed;
  txs.push({ chain: h.chain, hash: s.hash });
  for (;; st.round++) {
    if (st.round % 5 === 0) await Promise.allSettled(h.rpcs.map((rpc) => rpc("eth_sendRawTransaction", [hexOf(s.raw)])));
    const got = await onwardReceipt(h.rpcs, s.hash, w, s.adapter).catch(() => null);
    if (got === "ok") {
      const received = await tokenHeld(h.rpcs, leg.token, w).catch(() => null);
      await h.record(w, { ...leg.holding, state: "filled", ...(received === null ? {} : { received: poolUnits(received, leg.decimals) }), route: route(s.hash) }).catch(() => {});
      await writeRest(h, w, { end: "filled" }).catch(() => {});
      carry();
      return { stage: "filled", txs };
    }
    if (got === "failed") {
      await h.record(w, { ...leg.holding, state: "withdrawn", route: route(s.hash) }).catch(() => {});
      await writeRest(h, w, { end: "reverted" }).catch(() => {});
      carry();
      return { stage: "refused", txs };
    }
    if (!more()) {
      st.round++;
      return null;
    }
    await wait(2_000);
  }
}

/** W's token balance, the same on both RPCs at their agreed newest block. */
async function tokenHeld(rpcs: readonly [EvmRpc, EvmRpc], token: string, w: string): Promise<bigint> {
  const blk = await evmRetryLag(() => evmAgreedBlock(rpcs, "latest"));
  const data = "0x70a08231" + BigInt(w).toString(16).padStart(64, "0");
  return agree(await both(rpcs, async (rpc) => quantity(await rpc("eth_call", [{ to: token, data }, qty(blk.number)]))));
}

/** W's own buy of the rest, checked and signed (null past its window): the fresh quote and build, W's reads on both
 *  RPCs at one block, the rule, W's key; its hash kept in the rest's record before the bytes leave. */
async function signRest(h: EvmPoolBuyHost, ask: PoolAsk, plan: EvmBuyPlan, leg: RestLeg, quoted: RestQuote, clock: () => bigint): Promise<{ raw: Uint8Array; hash: string; adapter: string } | null> {
  const gone = (): boolean => h.stopped?.() === true || h.signal?.aborted === true || clock() >= leg.signBy;
  if (plan.rest === null || gone()) return null;
  const spend = plan.rest.spend;
  const w = leg.w;
  const { q, built } = await quoted(spend);
  const blk = await evmRetryLag(() => evmAgreedBlock(h.rpcs, "latest"));
  const tag = qty(blk.number);
  const baseFee = blk.baseFeePerGas ?? stop("read");
  const nitro = h.chain === "robinhood";
  const tip = nitro ? 0n : EVM_ONWARD_TIP;
  const maxFee = nitro ? baseFee : 2n * baseFee + tip;
  const nonce = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_getTransactionCount", [w, tag])));
  const balance = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_getBalance", [w, tag])));
  const data = evmAdapterBuyData(built.token, w, built.minOut, built.data);
  const call = { from: w, to: built.adapter, value: qty(spend), data };
  const estimate = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_estimateGas", [call, tag])));
  const gasLimit = evmOnwardCodeGas(agree(estimate));
  const l1Fee = await l1Of(h, gasLimit, tag, 128n + BigInt((data.length - 2) / 2));
  const run = { ...call, gas: qty(gasLimit), maxFeePerGas: qty(maxFee), maxPriorityFeePerGas: qty(tip) };
  const simulated = await both(h.rpcs, (rpc) => Promise.resolve().then(() => rpc("eth_call", [run, tag])).then(() => true, () => false));
  const tx: EvmOnwardSend = { type: 2, chainId: EVM_CHAIN_IDS[h.pin.network], nonce: agree(nonce), maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit, to: built.adapter, value: spend, data, accessList: [] };
  const ctx = { nowMs: clock(), wallet: w, feeCap: plan.bound, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
  checkEvmWBuy(tx, built, ask, ctx, { nonce, balance, estimate, simulated, baseFee: [baseFee, baseFee], l1Fee, priorityCap: tip }, { token: q.token, amountIn: q.amountIn, amountOut: q.amountOut }, plan, h.testnet);
  // a sign out since the reads: nothing signed
  if (gone()) return null;
  const seed = await h.seed64();
  let raw: Uint8Array;
  try {
    const k = freshWallet(seed, "evm", leg.r.wallet.l, leg.r.wallet.j);
    seed.fill(0);
    try {
      if (lower(k.address) !== lower(w)) return stop("wallet");
      raw = signEvmWBuy(k.secretKey, tx);
    } finally {
      k.secretKey.fill(0);
    }
  } finally {
    seed.fill(0);
  }
  const hash = hexOf(keccak_256(raw));
  // its hash kept before the bytes leave: a reload reads this very send back
  await writeRest(h, w, { hash });
  return { raw, hash, adapter: built.adapter };
}
