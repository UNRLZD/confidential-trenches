// pool.withdraw on a Base or Robinhood pool: the user types To and the Amount on SIGN_HOST's own screen
// (src/withdraw/pool-form.ts, the Solana withdraw's screen and words), and each part leaves the pinned pool in two
// transactions, as on Solana (src/pool-withdraw.ts):
//
// - The release (PrivacyPool.withdraw): the pool pays only a recipient that signed the release (PrivacyPool.sol:181,
//   InvalidSignature; the helper refuses a recipient with code), and the device has no key for To, so the recipient is
//   the note's fresh W_{evm, label, j}. The proof is made here on demand, bound like a buy's (the wallet's evmPool bind:
//   W, the pinned fee recipient, the device's own epoch fee as the fee cap, the epoch's deadline), checked by the rule
//   (rules/pool.ts checkEvmWithdraw: the relay data W's and the pin's, the context recomputed on the pinned pool and
//   chain id), signed by W (signEvmWithdraw, the pool's Withdraw digest) and carried by the helper's sender
//   (evm-send.ts evmPoolSend), whose fee is the one the calldata names: the device's own epoch fee (the helper refuses
//   any other, fee_off). So W holds exactly the chunk less that fee once the release lands.
// - The onward send: W's one EIP-1559 transfer of exactly the part to To (rules/pool.ts checkEvmOnwardSend), W its only
//   signer, sent and read back on the pool's two RPCs. Its gas comes out of the part's chunk: chunk = part + fee + W's
//   fee bound (gas x max fee per gas + Base's L1 data fee bound), so exactly the amount typed arrives. On Base the max
//   fee is twice the base fee and the tip cap, and what the gas leaves unused stays on W (at most W's share of the Max
//   fee drawn); on Robinhood (Arbitrum Nitro: the gas is paid at the base fee, the tip is not paid, and the L1 cost is in
//   the gas, 0 there) the max fee is the base fee itself, so W pays exactly its bound and ends at 0 while the base fee
//   holds (it sits at its floor: 0.01 gwei on every block read 2026-11-12 17:4xZ). A bound that rose past what W holds
//   beyond the part sends W's balance less the bound, within the part's ceiling; over the ceiling the send stays owed
//   with the fee it needs (the screen's "fee rose" line and its button).
// - The plan: the Solana withdraw's planPoolWithdraw over the pool's landed notes, with this chain's costs: the epoch
//   fee (a bind's own fee cap for the epoch: the device's reads, the helper's answer held to them), W's fee bound, and
//   the smallest part max(1 wei, fee - W's fee) (the pool's backstop: the fee at most half the chunk, PrivacyPool.sol:186).
//   Each note's change is 0 or at least the note floor. A part whose bind gives another fee than the plan's stops before
//   W signs (the note goes back UNSPENT).
// - To, before any note moves: never under 0x10000 (the zero address and every precompile), the pool, the fee recipient
//   or a W of the plan; its code read on both RPCs. With no code a plain send takes 21,000 gas and cannot revert (the
//   estimate on Robinhood, both RPCs); with code (a smart wallet, a forwarder, an EIP-7702 delegation) W's exact send is
//   estimated and run (eth_call) on both RPCs, W's balance set by a state override, and its gas is the agreed estimate
//   and a fifth, at most 100,000. A To whose code changes after it leaves the part owed on W, as a crash does.
// - The op (the kit's kind "withdraw", WithdrawStage): proving, submitted (a release out), in_transit (the part on W, its
//   send owed), sent (every part's onward read back on both RPCs), stopped. The owed send (EvmPendingOnward: the
//   attempt, its context, To, the part, the release's nullifier, first block and deadline) is written to the wallet
//   store's meta before the release leaves; the note is RESERVED before it leaves and settled by the EVM settle pass
//   (evmSettleReserved). A restore from the 12 words finds W.
// - Every read names the pool, a block, To or W (W only once its release landed: it is public then); no read carries a
//   key or which note is whose. Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poolProveWithdraw, type VaultProver } from "../../kit/src/prover/prove.ts";
import { evmPoolChainFee, evmPoolChainFeeReads } from "../../kit/src/trade/evm/pool-fee.ts";
import type { EvmPoolVenueList } from "../../kit/src/trade/evm/buy-unpinned.ts";
import type { TxRef, WithdrawStage } from "../../kit/src/signpage/messages.ts";
import { evmAddress, freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
import { EVM_CHAIN_IDS, EVM_SEND_MARGIN_MS, evmAgreedBlock, evmRetryLag, type EvmPoolPin, type EvmPoolRequest, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { checkBinding, type Pool } from "../../wallet/src/pool/pool.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { EVM_BUY_LAG_BLOCKS, EVM_BUY_LAG_MS } from "./pool-buy-evm.ts";
import { EvmSendBusy, EvmSendRefused, evmBuyVerdict, evmHeadNumber, evmReleaseRead, evmWithdrawCalldata, type EvmReleaseRead } from "./evm-send.ts";
import { planPoolWithdraw, withdrawSources, type Arrivals, type PendingOnward, type WithdrawPart } from "./pool-withdraw.ts";
import {
  checkEvmOnwardSend, checkEvmWithdraw, EVM_ONWARD_GAS, EVM_ONWARD_GAS_MAX, EVM_PRECOMPILE_TOP, evmOnwardCodeGas, PoolRuleRefused, signEvmOnwardSend, signEvmWithdraw,
  type EvmOnwardSend, type PoolAsk, type WithdrawCosts,
} from "./rules/pool.ts";

type Chain = "base" | "robinhood";

/** Base's tip cap, wei per gas (the deposit's own, src/pool-deposit-evm.ts EVM_DEPOSIT_PRIORITY_CAP). */
export const EVM_ONWARD_TIP = 10_000_000n;
/** The size the L1 data fee is bounded for: above any unsigned type 2 transfer (about 60 bytes). */
export const EVM_ONWARD_L1_BYTES = 128n;
/** The tap's read-back of a release, from its send: then the run answers its last true stage and the state reads'
 *  finish goes on (the buy's EVM_BUY_SETTLE_MS). */
export const EVM_WITHDRAW_SETTLE_MS = 120_000;
export const EVM_WITHDRAW_WAIT_MS = 2_000;
/** W's onward send: resends of the same bytes, and the rounds of receipts read between them. */
export const EVM_ONWARD_ROUNDS = 30;

/** A public key no note is bound to (secp256k1's generator, the key of scalar 1): the epoch fee is read by a bind for
 *  it, which names it to no one (the helper's GET /v1/pool/fee names the pool and the epoch only). */
const PROBE_PUBLIC = /* @__PURE__ */ Uint8Array.from("0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8".match(/../g)!, (x) => parseInt(x, 16));

/** What a part costs on this chain: the epoch fee, W's fee bound and the smallest part; `gas` and `maxFee` W's send's. */
export type EvmWithdrawCosts = WithdrawCosts & { gas: bigint; maxFee: bigint; tip: bigint; l1: bigint; toHasCode: boolean };

/** One owed onward send on an EVM pool: the Solana record's fields, the chain, the part (wei, a decimal), and the
 *  release's nullifier, the block its read-back starts at, its deadline, chunk and fee (decimals); `release` the
 *  release's transaction once both RPCs read it, `onward` W's signed send's hash, written before it leaves. */
export type EvmPendingOnward = PendingOnward & { chain: Chain; part: string; nullifier: string; from: string; deadlineMs: string; chunk: string; fee: string; onward?: string };

export type EvmWithdrawHost = {
  chain: Chain;
  testnet: boolean;
  pin: EvmPoolPin;
  venues: EvmPoolVenueList;
  /** The pool's two RPCs, of two operators. */
  rpcs: readonly [EvmRpc, EvmRpc];
  /** The wallet's evmPool for the pin: now, trees, bind (the device's epoch fee, the helper's answer held to it). */
  pool: Pool<EvmPoolRequest>;
  prover: VaultProver;
  notes(): Promise<NoteStore>;
  drop?(noteId: string): Promise<void>;
  seed64(): Promise<Uint8Array>;
  /** POST /v1/pool/evm/send (evm-send.ts evmPoolSend). */
  send(body: { pool: string; data: Uint8Array; epoch: bigint }): Promise<string>;
  /** Starts the chain's settle pass (evmSettleReserved); never awaited. */
  settle(): void;
  /** The owed send, written once the note is RESERVED and before the release leaves (awaited). */
  owe?(p: EvmPendingOnward): Promise<void>;
  /** The owed send's record updated (its release read back, W's send's hash before it leaves), awaited. */
  keep?(p: EvmPendingOnward): Promise<void>;
  owedNotes?(): Promise<ReadonlySet<string>>;
  stage?(stage: WithdrawStage, txs: TxRef[], pending: EvmPendingOnward | null, arrived: Arrivals): void;
  now?(): bigint;
  wait?(ms: number): Promise<void>;
};

export type EvmWithdrawAnswer = { stage: WithdrawStage; txs: TxRef[]; pending: EvmPendingOnward | null; arrived: Arrivals; feeNeeded?: string };

class Stop extends Error {}
const stop = (why: string): never => {
  throw new Stop(why);
};
const lower = (s: string): string => s.toLowerCase();
const qty = (v: bigint): string => `0x${v.toString(16)}`;
const hexOf = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const quantity = (x: unknown): bigint => (typeof x === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(x) ? BigInt(x) : stop("read"));
const both = <T>(rpcs: readonly [EvmRpc, EvmRpc], f: (rpc: EvmRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
const agree = <T>(p: readonly [T, T]): T => (p[0] === p[1] ? p[0] : stop("reads"));
const nitro = (c: Chain): boolean => c === "robinhood";
const waitOf = (h: Pick<EvmWithdrawHost, "wait">) => h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
const clockOf = (h: Pick<EvmWithdrawHost, "now">) => (): bigint => h.now?.() ?? BigInt(Date.now());

/** The smallest part: the pool's backstop holds the fee to half the chunk (part + fee + W's fee), and a part is above 0. */
export const evmWithdrawMinPart = (fee: bigint, wFee: bigint): bigint => (fee - wFee > 1n ? fee - wFee : 1n);

/** The epoch fee now: the fee cap the pool's bind gives for this epoch (the device's own reads; the helper's GET
 *  /v1/pool/fee must be exactly it), for a key bound to no note. */
export async function evmEpochFeeNow(pool: Pool<EvmPoolRequest>): Promise<{ fee: bigint; epochStartMs: bigint }> {
  const now = await pool.now();
  const epochStartMs = now - (now % pool.epochMs);
  const b = await pool.bind({ chunk: (1n << 127n) - 1n, wallet: { address: evmAddress(PROBE_PUBLIC), publicKey: PROBE_PUBLIC }, refundPrecommitment: 0n, epochStartMs, deadlineMs: epochStartMs + pool.lifeMs });
  return { fee: b.feeCap, epochStartMs };
}

/** The newest block both RPCs hold, by its number (its base fee in it). */
const latest = (rpcs: readonly [EvmRpc, EvmRpc]) => evmRetryLag(() => evmAgreedBlock(rpcs, "latest"));

/** Base's L1 data fee bound for W's send (GasPriceOracle getL1FeeUpperBound and getOperatorFee, the kit's reads) at
 *  `tag` on both RPCs, the same; 0 on Robinhood, whose L1 cost is in the gas. */
async function l1Of(h: Pick<EvmWithdrawHost, "chain" | "pin" | "rpcs">, gas: bigint, tag: string): Promise<[bigint, bigint]> {
  if (nitro(h.chain)) return [0n, 0n];
  const net = h.pin.network;
  const answers: [bigint[], bigint[]] = [[], []];
  for (const c of evmPoolChainFeeReads(net, gas, EVM_ONWARD_L1_BYTES)) {
    const [a, b] = await both(h.rpcs, async (rpc) => {
      const x = await rpc("eth_call", [{ to: c.to, data: c.data }, tag]);
      return typeof x === "string" && /^0x[0-9a-fA-F]{64,}$/.test(x) ? BigInt(`0x${x.slice(2, 66)}`) : stop("read");
    });
    answers[0].push(a);
    answers[1].push(b);
  }
  const fees: [bigint, bigint] = [evmPoolChainFee(net, EVM_ONWARD_L1_BYTES, answers[0]), evmPoolChainFee(net, EVM_ONWARD_L1_BYTES, answers[1])];
  agree(fees);
  return fees;
}

/** Whether `to` holds code, on both RPCs at `tag` (they must agree): an EIP-7702 delegation is code. */
async function codeOf(rpcs: readonly [EvmRpc, EvmRpc], to: string, tag: string): Promise<[boolean, boolean]> {
  return both(rpcs, async (rpc) => {
    const c = await rpc("eth_getCode", [to, tag]);
    if (typeof c !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(c)) return stop("read");
    return c !== "0x";
  });
}

/** W's send to `to` with `value` and `gas`, estimated and run (eth_call) on both RPCs at `tag`; `balance`: W's set by a
 *  state override (before the release, W holds nothing). The estimate (both must agree) and whether each run returned. */
async function simulate(rpcs: readonly [EvmRpc, EvmRpc], from: string, to: string, value: bigint, tag: string, balance?: bigint): Promise<{ estimate: [bigint, bigint]; ran: [boolean, boolean] }> {
  const over = balance === undefined ? [] : [{ [from]: { balance: qty(balance) } }];
  const call = { from, to, value: qty(value) };
  const estimate = await both(rpcs, async (rpc) => quantity(await rpc("eth_estimateGas", [call, tag, ...over])));
  const gas = evmOnwardCodeGas(agree(estimate));
  const ran = await both(rpcs, (rpc) => Promise.resolve().then(() => rpc("eth_call", [{ ...call, gas: qty(gas) }, tag, ...over])).then(() => true, () => false));
  return { estimate, ran };
}

/** This chain's costs for a part, read now: the epoch fee, W's gas (21,000, Robinhood's agreed estimate, or a To with
 *  code's estimate and margin, its run on both RPCs), its max fee and tip, the L1 bound, W's fee bound and the smallest
 *  part. `to` and `from`: To and the first part's W when known (the screen before To is typed reads a plain send). */
export async function evmWithdrawCosts(h: Pick<EvmWithdrawHost, "chain" | "pin" | "rpcs" | "pool">, to?: { to: string; from: string; value: bigint }): Promise<EvmWithdrawCosts> {
  const { fee } = await evmEpochFeeNow(h.pool);
  const blk = await latest(h.rpcs);
  const tag = qty(blk.number);
  const baseFee = blk.baseFeePerGas ?? stop("read");
  let toHasCode = false;
  let gas = EVM_ONWARD_GAS;
  if (to !== undefined) {
    toHasCode = agree(await codeOf(h.rpcs, to.to, tag));
    if (toHasCode) {
      const sim = await simulate(h.rpcs, to.from, to.to, to.value, tag, 2n * to.value + 10n ** 18n);
      if (!sim.ran[0] || !sim.ran[1]) stop("to");
      gas = evmOnwardCodeGas(sim.estimate[0]);
      if (gas > EVM_ONWARD_GAS_MAX) stop("to");
    }
  }
  if (!toHasCode && nitro(h.chain)) {
    // a plain send's gas on Nitro, from the fee recipient's own address (an account with no code), with no value
    const est = agree(await both(h.rpcs, async (rpc) => quantity(await rpc("eth_estimateGas", [{ from: h.pin.feeRecipient, to: to?.to ?? h.pin.feeRecipient, value: "0x0" }, tag]))));
    if (est > EVM_ONWARD_GAS_MAX) stop("gas");
    gas = est;
  }
  const tip = nitro(h.chain) ? 0n : EVM_ONWARD_TIP;
  const maxFee = nitro(h.chain) ? baseFee : 2n * baseFee + tip;
  const l1 = (await l1Of(h, gas, tag))[0];
  const wFee = gas * maxFee + l1;
  return { fee, wFee, minPart: evmWithdrawMinPart(fee, wFee), gas, maxFee, tip, l1, toHasCode };
}

/** A note's W and its nullifier hash. */
const spendOf = (seed: Uint8Array, n: NoteRecord): { w: string; nullifierHash: bigint } => {
  const w = freshWallet(seed, "evm", n.leaf!.label, jOf(n.ref));
  w.secretKey.fill(0);
  return { w: w.address, nullifierHash: noteSecrets(seed, n.ref).nullifierHash };
};
const seedUse = async <T>(h: Pick<EvmWithdrawHost, "seed64">, f: (seed: Uint8Array) => T | Promise<T>): Promise<T> => {
  const s = await h.seed64();
  try {
    return await f(s);
  } finally {
    s.fill(0);
  }
};

/** To on the pool's terms: never under 0x10000 (the zero address, a precompile), the pool, the fee recipient, nor a W
 *  of the plan. */
export const evmToRefused = (to: string, pin: EvmPoolPin, ws: readonly string[]): boolean =>
  !/^0x[0-9a-fA-F]{40}$/.test(to) || BigInt(to) < EVM_PRECOMPILE_TOP || [pin.pool, pin.feeRecipient, ...ws].some((x) => lower(x) === lower(to));

/** The context a release's calldata carries (its proof's eighth public signal: the head's word 16), or null when it is
 *  not a withdraw or buy of this layout. */
export function releaseContextOf(input: unknown): bigint | null {
  if (typeof input !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(input) || input.length < 2 + 2 * (4 + 32 * 17)) return null;
  const sel = lower(input.slice(2, 10));
  if (sel !== WITHDRAW_SEL && sel !== BUY_SEL) return null;
  return BigInt(`0x${input.slice(2 + 8 + 64 * 16, 2 + 8 + 64 * 17)}`);
}
const selOf = (s: string): string => Array.from(keccak_256(new TextEncoder().encode(s)).subarray(0, 4), (x) => x.toString(16).padStart(2, "0")).join("");
const WITHDRAW_SEL = /* @__PURE__ */ selOf("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)");
const BUY_SEL = /* @__PURE__ */ selOf("buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)");

/** A release's verdict for an owed part: "mine" (both RPCs read one Withdrawn of the nullifier paying W the chunk at a
 *  fee up to the cap, and its transaction's calldata, on both, carries this attempt's context), "other" (another
 *  release of the nullifier: another attempt's or device's), "none" (no release, both reads past the deadline at a
 *  safe block), or null (read again). */
export type EvmReleaseVerdict = { end: "mine"; tx: string; block: bigint } | { end: "other" } | { end: "none" } | null;
export async function evmReleaseOf(h: Pick<EvmWithdrawHost, "rpcs" | "pin">, p: Pick<EvmPendingOnward, "nullifier" | "from" | "deadlineMs" | "chunk" | "fee" | "context">, w: string, stops: [bigint | null, bigint | null]): Promise<EvmReleaseVerdict> {
  const reads = (await Promise.all(h.rpcs.map((rpc, k) => evmReleaseRead(rpc, h.pin.pool, BigInt(p.from), BigInt(p.deadlineMs), stops[k]!)))) as [EvmReleaseRead, EvmReleaseRead];
  stops[0] = reads[0].stop;
  stops[1] = reads[1].stop;
  // a buy's verdict with no token: a Withdrawn paying W is "withdrawn", anything else of the nullifier not_landed
  const v = evmBuyVerdict(reads, { nullifier: BigInt(p.nullifier), w, feeRecipient: h.pin.feeRecipient, token: "", minOut: 1n << 255n, value: BigInt(p.chunk), feeCap: BigInt(p.fee), deadlineMs: BigInt(p.deadlineMs) });
  if (v === null) return null;
  if (v.end === "not_landed") return v.release === null ? { end: "none" } : { end: "other" };
  if (v.end !== "withdrawn") return { end: "other" };
  // whose release: the transaction's own calldata on both RPCs names this attempt's context
  const txs = await both(h.rpcs, async (rpc) => (await rpc("eth_getTransactionByHash", [v.release.tx])) as { input?: unknown; to?: unknown } | null);
  const ctx = txs.map((t) => (typeof t?.to === "string" && lower(t.to) === lower(h.pin.pool) ? releaseContextOf(t.input) : null));
  if (ctx[0] === null || ctx[1] === null) return null;
  if (ctx[0] !== ctx[1]) return null;
  return ctx[0] === BigInt(p.context) ? { end: "mine", tx: v.release.tx, block: v.release.block } : { end: "other" };
}

type OnwardEnd = { state: "ok"; hash: string; value: bigint } | { state: "fee"; need: bigint } | { state: "empty" } | { state: "failed" } | { state: "unknown"; hash: string };

/** W's onward send: exactly the part to To (W's balance less its bound when the bound rose past what W holds beyond it),
 *  built from the device's reads on both RPCs, checked by the rule, signed by W, its hash kept before it leaves, sent to
 *  both RPCs and read back as a receipt of status 1 on both. W's nonce read past 0: W's one send was made (this tab's or
 *  another's): "empty". */
async function sendOnward(h: EvmWithdrawHost, ask: PoolAsk, p: EvmPendingOnward, l: bigint, j: number, keep: (p: EvmPendingOnward) => Promise<void>): Promise<OnwardEnd> {
  const wait = waitOf(h);
  const w = await seedUse(h, (seed) => {
    const x = freshWallet(seed, "evm", l, j);
    x.secretKey.fill(0);
    return x.address;
  });
  const part = BigInt(p.part);
  const feeCap = BigInt(p.feeCap);
  const blk = await latest(h.rpcs);
  const tag = qty(blk.number);
  const baseFee = blk.baseFeePerGas ?? stop("read");
  const nonce = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_getTransactionCount", [w, tag])));
  if (nonce[0] > 0n || nonce[1] > 0n) return { state: "empty" };
  const balance = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_getBalance", [w, tag])));
  const bal = agree(balance);
  if (bal === 0n) return { state: "unknown", hash: "" };
  const toHasCode = await codeOf(h.rpcs, p.to, tag);
  const tip = nitro(h.chain) ? 0n : EVM_ONWARD_TIP;
  const hi = nitro(h.chain) ? baseFee : 2n * baseFee + tip;
  // the gas: 21,000 to no code on Base; else the estimate both RPCs agree on (a To with code: and its margin)
  let gas = EVM_ONWARD_GAS;
  let estimate: [bigint, bigint] | null = null;
  let simulated: [boolean, boolean] | null = null;
  const code = agree(toHasCode);
  if (code || nitro(h.chain)) {
    estimate = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_estimateGas", [{ from: w, to: p.to, value: qty(part < bal ? part : bal) }, tag])));
    gas = code ? evmOnwardCodeGas(agree(estimate)) : agree(estimate);
    if (code) {
      const call = { from: w, to: p.to, value: qty(part < bal ? part : bal), gas: qty(gas) };
      simulated = await both(h.rpcs, (rpc) => Promise.resolve().then(() => rpc("eth_call", [call, tag])).then(() => true, () => false));
    }
  }
  const l1 = await l1Of(h, gas, tag);
  // the max fee: the chain's own bound; lower, down to the base fee, when W holds the part and a lower bound only
  let maxFee = hi;
  let prio = tip;
  if (part + gas * hi + l1[0] > bal && bal > part + l1[0]) {
    const m = (bal - part - l1[0]) / gas;
    if (m >= baseFee) {
      maxFee = m;
      prio = m - baseFee < tip ? m - baseFee : tip;
    }
  }
  const bound = gas * maxFee + l1[0];
  if (bound > feeCap) return { state: "fee", need: bound };
  const value = bal - bound < part ? bal - bound : part;
  if (value <= 0n) return { state: "failed" };
  const tx: EvmOnwardSend = { type: 2, chainId: EVM_CHAIN_IDS[h.pin.network], nonce: nonce[0], maxPriorityFeePerGas: prio, maxFeePerGas: maxFee, gasLimit: gas, to: p.to, value, data: "0x", accessList: [] };
  const ctx = { nowMs: clockOf(h)(), wallet: w, feeCap, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
  try {
    checkEvmOnwardSend(tx, ask, ctx, p.to, { nonce, balance, toHasCode, estimate, simulated, baseFee: [baseFee, baseFee], l1Fee: l1, priorityCap: tip, part }, h.testnet);
  } catch (e) {
    if (e instanceof PoolRuleRefused) return { state: "failed" };
    throw e;
  }
  const raw = await seedUse(h, (seed) => {
    const signer = freshWallet(seed, "evm", l, j);
    try {
      if (signer.address !== w) stop("wallet");
      return signEvmOnwardSend(signer.secretKey, tx);
    } finally {
      signer.secretKey.fill(0);
    }
  });
  const hash = hexOf(keccak_256(raw));
  // its hash kept with the owed send before the bytes leave: a reload reads this very send back
  await keep({ ...p, onward: hash });
  for (let round = 0; round < EVM_ONWARD_ROUNDS; round++) {
    if (round % 5 === 0) await Promise.allSettled(h.rpcs.map((rpc) => rpc("eth_sendRawTransaction", [hexOf(raw)])));
    const got = await onwardReceipt(h.rpcs, hash, w, p.to);
    if (got === "ok") return { state: "ok", hash, value };
    if (got === "failed") return { state: "failed" };
    await wait(EVM_WITHDRAW_WAIT_MS);
  }
  return { state: "unknown", hash };
}

/** W's send's receipt on both RPCs: "ok" (status 1 on both, from W to To, the same block), "failed" (status 0 on
 *  both), else null. */
export async function onwardReceipt(rpcs: readonly [EvmRpc, EvmRpc], hash: string, w: string, to: string): Promise<"ok" | "failed" | null> {
  const rs = await Promise.all(rpcs.map((rpc) => Promise.resolve().then(() => rpc("eth_getTransactionReceipt", [hash])).catch(() => null))) as ({ status?: unknown; from?: unknown; to?: unknown; blockHash?: unknown } | null)[];
  if (rs.some((r) => r === null || typeof r !== "object")) return null;
  const [a, b] = rs as { status?: unknown; from?: unknown; to?: unknown; blockHash?: unknown }[];
  if (a!.blockHash !== b!.blockHash || typeof a!.from !== "string" || typeof a!.to !== "string" || lower(a!.from) !== lower(w) || lower(a!.to) !== lower(to) || lower(String(b!.from)) !== lower(w) || lower(String(b!.to)) !== lower(to)) return null;
  if (a!.status === "0x1" && b!.status === "0x1") return "ok";
  if (a!.status === "0x0" && b!.status === "0x0") return "failed";
  return null;
}

/** One withdraw of `amount` (wei arriving at `to`), `maxFee` the Max fee the screen drew. */
export async function runEvmPoolWithdraw(h: EvmWithdrawHost, ask: PoolAsk, to: string, amount: bigint, maxFee: bigint, mine: ReadonlySet<string> = new Set()): Promise<EvmWithdrawAnswer> {
  const txs: TxRef[] = [];
  const arrived: Arrivals = {};
  let pending: EvmPendingOnward | null = null;
  let feeNeeded: bigint | null = null;
  const say = (s: WithdrawStage): void => h.stage?.(s, txs.slice(), pending, { ...arrived });
  const end = (s: WithdrawStage): EvmWithdrawAnswer => (say(s), { stage: s, txs: txs.slice(), pending, arrived: { ...arrived }, ...(feeNeeded !== null ? { feeNeeded: feeNeeded.toString() } : {}) });
  try {
    if (ask.kind !== "pool.withdraw" || ask.chain !== h.chain) stop("kind");
    // the pin alone decides: this page's network's pin for the chain, or no withdraw
    const network = h.testnet ? (h.chain === "base" ? "base-sepolia" : "robinhood-testnet") : h.chain;
    if (h.pin.network !== network) stop("pin");
    if (typeof maxFee !== "bigint" || maxFee < 0n) stop("max_fee");
    const notes = await h.notes();
    const owed = (await h.owedNotes?.()) ?? new Set<string>();
    const sources = withdrawSources(await notes.list(), h.pool.scope, mine).filter((n) => !owed.has(n.id));
    // the first plan at a plain send's cost names the notes, and so the first W the To check runs from
    const first = await evmWithdrawCosts(h);
    const plan0 = planPoolWithdraw(sources, amount, first);
    if (plan0 === null) stop("plan");
    const ws = await seedUse(h, async (seed) => {
      const out: string[] = [];
      for (const p of plan0!) out.push(spendOf(seed, (await notes.get(p.noteId))!).w);
      return out;
    });
    if (evmToRefused(to, h.pin, ws)) stop("to");
    // To read on both RPCs before any note moves: a To with code is run from the first part's W, or refused
    const costs = await evmWithdrawCosts(h, { to, from: ws[0]!, value: plan0![0]!.part });
    const plan = costs.wFee === first.wFee && costs.fee === first.fee ? plan0! : planPoolWithdraw(sources, amount, costs);
    if (plan === null) stop("plan");
    if (BigInt(plan!.length) * (costs.fee + costs.wFee) > maxFee) stop("max_fee");
    const wCap = maxFee / BigInt(plan!.length) - costs.fee;
    for (const [i, p] of plan!.entries()) {
      say("proving");
      const got = await onePart(h, ask, notes, p, costs, { to, last: i === plan!.length - 1, feeCap: wCap.toString() }, (o) => void (pending = o));
      if (got.tx !== "") txs.push({ chain: h.chain, hash: got.tx });
      if (got.end === "stopped") {
        pending = null;
        return end("stopped");
      }
      if (got.end !== "mine") return end(pending ? "in_transit" : "stopped");
      say("in_transit");
      const on = await sendOnward(h, ask, pending!, got.l, got.j, async (q) => {
        pending = q;
        await h.keep?.(q);
      });
      if (on.state === "ok") {
        txs.push({ chain: h.chain, hash: on.hash });
        arrived[on.hash] = on.value.toString();
      } else if (on.state === "fee") {
        feeNeeded = on.need;
        return end("in_transit");
      } else if (on.state !== "empty") return end("in_transit");
      pending = null;
      if (i < plan!.length - 1) say("submitted");
    }
    return end("sent");
  } catch {
    return end(pending ? "in_transit" : "stopped");
  }
}

/** One part's release to W: hold the note, bind and prove part + fee + W's fee to W, check, sign as W, RESERVED, the
 *  owed send written, then the helper's send and the read-back on both RPCs. "stopped": nothing left the device, or
 *  the chain says it never lands; "sent": no end in the tap's bound (owed, for the state reads). */
async function onePart(h: EvmWithdrawHost, ask: PoolAsk, notes: NoteStore, p: WithdrawPart, c: EvmWithdrawCosts, base: Pick<PendingOnward, "to" | "last" | "feeCap">, owing: (o: EvmPendingOnward) => void): Promise<{ end: "mine" | "stopped" | "sent"; tx: string; l: bigint; j: number }> {
  const P = h.pool;
  let attempt: string | null = null;
  let reserved = false;
  let key: Uint8Array | null = null;
  const clock = clockOf(h);
  const wait = waitOf(h);
  try {
    let n = await notes.get(p.noteId);
    if (n?.state === "HELD" && h.drop) {
      await h.drop(p.noteId);
      n = await notes.get(p.noteId);
    }
    if (n === undefined || n.state !== "UNSPENT" || n.leaf === undefined) stop("note");
    const leaf = n!.leaf!;
    if (leaf.value < p.chunk || p.chunk !== p.part + c.fee + c.wFee) stop("value");
    const nowMs = await P.now();
    const epochStartMs = nowMs - (nowMs % P.epochMs);
    const deadlineMs = epochStartMs + P.lifeMs;
    const j = jOf(n!.ref);
    const keys = await seedUse(h, (seed) => {
      const w = freshWallet(seed, "evm", leaf.label, j);
      w.secretKey.fill(0);
      return { w, refund: noteSecrets(seed, { kind: "refund", l: leaf.label, j }).precommitment, spent: noteSecrets(seed, n!.ref), next: noteSecrets(seed, { kind: "change", l: leaf.label, j }) };
    });
    const binding = await P.bind({ chunk: p.chunk, wallet: { address: keys.w.address, publicKey: keys.w.publicKey }, refundPrecommitment: keys.refund, epochStartMs, deadlineMs });
    checkBinding(P as Pool, binding, p.chunk);
    // the plan's fee or no part: a fee that moved since the plan stops before W signs
    if (binding.feeCap !== c.fee || binding.request.relay.feeCap !== c.fee) stop("fee");
    attempt = (await notes.move(p.noteId, "UNSPENT", "HELD", { deadlineMs, context: binding.context.toString() })).attempt!;
    let trees = await P.trees(epochStartMs);
    if (leaf.leafIndex >= BigInt(trees.stateTree.size)) trees = await P.trees(nowMs + 1n, undefined, { newest: true });
    const made = await poolProveWithdraw(h.prover, {
      stateTree: trees.stateTree, labelTree: trees.labelTree, newestStateRoot: trees.stateRoot, newestLabelRoot: trees.labelRoot,
      note: { value: leaf.value, label: leaf.label, nullifier: keys.spent.nullifier, secret: keys.spent.secret },
      newNullifier: keys.next.nullifier, newSecret: keys.next.secret, withdrawn: p.chunk, context: binding.context,
    });
    const signals = made.publicSignals.map((s) => BigInt(s));
    const proof = { nullifier: signals[1]!, context: signals[7]!, value: signals[2]! };
    if (proof.context !== binding.context || proof.value !== p.chunk) stop("proof");
    const relay = binding.request.relay;
    const ctx = { nowMs: clock(), wallet: keys.w.address, feeCap: c.fee, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
    checkEvmWithdraw(h.pin.pool, proof, relay, ask, ctx, h.testnet);
    // where the read-back starts: under the lower of both RPCs' newest blocks, read before W signs
    const heads = await Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc)));
    const lo = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;
    const from = lo > EVM_BUY_LAG_BLOCKS ? lo - EVM_BUY_LAG_BLOCKS : 0n;
    const sig = await seedUse(h, (seed) => {
      const signer = freshWallet(seed, "evm", leaf.label, j);
      key = signer.secretKey;
      if (lower(signer.address) !== lower(keys.w.address) || lower(relay.recipient) !== lower(signer.address)) stop("wallet");
      const s = signEvmWithdraw(key, ctx, ask, h.pin.pool, proof, h.testnet);
      key.fill(0);
      key = null;
      return s;
    });
    const data = evmWithdrawCalldata(h.pin.pool, relay, made.proof, made.publicSignals, c.fee, sig);
    // RESERVED, then the owed send, both before anything leaves the device
    await notes.move(p.noteId, "HELD", "RESERVED", { attempt: attempt! });
    reserved = true;
    const owed: EvmPendingOnward = {
      noteId: p.noteId, attempt: attempt!, context: binding.context.toString(), ...base, chain: h.chain, part: p.part.toString(),
      nullifier: proof.nullifier.toString(), from: from.toString(), deadlineMs: deadlineMs.toString(), chunk: p.chunk.toString(), fee: c.fee.toString(),
    };
    owing(owed);
    await h.owe?.(owed);
    // the send: a busy helper waited out while the proof has more than the send margin left
    let busied = false;
    for (;;) {
      try {
        await h.send({ pool: h.pin.pool, data, epoch: epochStartMs });
        break;
      } catch (e) {
        if (e instanceof EvmSendRefused && !busied) break; // the helper's word only: the chain decides below
        if (e instanceof EvmSendBusy && clock() + BigInt(e.retryAfterMs) < deadlineMs - EVM_SEND_MARGIN_MS) {
          busied = true;
          await wait(Math.max(e.retryAfterMs, 1_000));
          continue;
        }
        break;
      }
    }
    // the read-back: this release, on both RPCs, until an end or the tap's bound
    const sentAt = clock();
    const stops: [bigint | null, bigint | null] = [null, null];
    let noneAt: bigint | null = null;
    for (let i = 0; i === 0 || clock() - sentAt < BigInt(EVM_WITHDRAW_SETTLE_MS); i++) {
      if (i > 0) await wait(EVM_WITHDRAW_WAIT_MS);
      let v: EvmReleaseVerdict;
      try {
        v = await evmReleaseOf(h, owed, keys.w.address, stops);
      } catch {
        continue;
      }
      if (v?.end === "none") {
        // two rounds of "none" at least the lag margin apart (the buy's rule): then it never lands
        const at = clock();
        noneAt ??= at;
        if (at - noneAt < BigInt(EVM_BUY_LAG_MS)) continue;
        h.settle();
        return { end: "stopped", tx: "", l: leaf.label, j };
      }
      noneAt = null;
      if (v === null) continue;
      h.settle();
      if (v.end === "other") return { end: "stopped", tx: "", l: leaf.label, j };
      const kept = { ...owed, release: v.tx };
      owing(kept);
      await h.keep?.(kept).catch(() => {});
      return { end: "mine", tx: v.tx, l: leaf.label, j };
    }
    return { end: "sent", tx: "", l: leaf.label, j };
  } catch (e) {
    if (reserved) throw e;
    return { end: "stopped", tx: "", l: 0n, j: 0 };
  } finally {
    (key as Uint8Array | null)?.fill(0);
    if (attempt !== null && !reserved) await notes.move(p.noteId, "HELD", "UNSPENT", { attempt }).catch(() => {});
  }
}

/** The state reads' pass for an owed EVM part (a reload, a crash, a lost send): its note still this attempt's
 *  (RESERVED by it, or SPENT with its context), its release read on both RPCs (none past the deadline, or another's:
 *  stopped, nothing sent), then W's send: a hash kept read back first, W's nonce past 0 (sent: this tab's or
 *  another's), else W's send onward. null: read again later (the money may be on W). */
export async function finishEvmOnward(h: EvmWithdrawHost, pending: EvmPendingOnward, stops: [bigint | null, bigint | null] = [null, null]): Promise<{ stage: WithdrawStage; txs: TxRef[]; arrived: Arrivals; feeNeeded?: string } | null> {
  const done = (stage: WithdrawStage, txs: TxRef[] = [], arrived: Arrivals = {}) => ({ stage, txs, arrived });
  try {
    const ask: PoolAsk = { kind: "pool.withdraw", chain: h.chain, token: null, amount: 0n, slippageBps: 0, decimals: 18 };
    const notes = await h.notes();
    const n = await notes.get(pending.noteId);
    if (n?.leaf === undefined || pending.chain !== h.chain) return done("stopped");
    const mine = (x: NoteRecord): boolean => (x.state === "RESERVED" && x.attempt === pending.attempt) || (x.state === "SPENT" && x.contexts?.at(-1)?.context === pending.context);
    if (!mine(n)) return done("stopped");
    const l = n.leaf.label;
    const j = jOf(n.ref);
    const { w } = await seedUse(h, (seed) => spendOf(seed, n));
    // a send of W's kept: read back first
    if (pending.onward !== undefined) {
      const r = await onwardReceipt(h.rpcs, pending.onward, w, pending.to);
      if (r === "ok") return done(pending.last ? "sent" : "stopped", [{ chain: h.chain, hash: pending.onward }], { [pending.onward]: await sentValue(h.rpcs, pending.onward) });
    }
    const v = await evmReleaseOf(h, pending, w, stops);
    if (v === null) return null;
    if (v.end !== "mine") return done("stopped");
    h.settle();
    const on = await sendOnward(h, ask, pending, l, j, async (q) => {
      await h.keep?.(q);
    });
    const rel: TxRef = { chain: h.chain, hash: v.tx };
    if (on.state === "ok") return done(pending.last ? "sent" : "stopped", [rel, { chain: h.chain, hash: on.hash }], { [on.hash]: on.value.toString() });
    if (on.state === "empty") return done(pending.last ? "sent" : "stopped", [rel]);
    if (on.state === "fee") return { stage: "in_transit", txs: [], arrived: {}, feeNeeded: on.need.toString() };
    return null;
  } catch {
    return null;
  }
}

/** What a send moved, read from the transaction itself on both RPCs (a decimal); "0" when they differ. */
async function sentValue(rpcs: readonly [EvmRpc, EvmRpc], hash: string): Promise<string> {
  const t = await both(rpcs, async (rpc) => quantity(((await rpc("eth_getTransactionByHash", [hash])) as { value?: unknown } | null)?.value));
  return t[0] === t[1] ? t[0].toString() : "0";
}

/** The screen's funds on an EVM pool: the landed notes of the pool's scope this page may spend, and this chain's
 *  costs (a plain send's, or To's when typed). */
export async function evmWithdrawFunds(h: Pick<EvmWithdrawHost, "chain" | "pin" | "rpcs" | "pool" | "notes" | "seed64" | "owedNotes">, mine: ReadonlySet<string>, to?: string): Promise<{ notes: ReturnType<typeof withdrawSources>; fee: bigint; wFee: bigint; minPart: bigint }> {
  const notes = await h.notes();
  const owed = (await h.owedNotes?.()) ?? new Set<string>();
  const list = withdrawSources(await notes.list(), h.pool.scope, mine).filter((n) => !owed.has(n.id));
  let c = await evmWithdrawCosts(h);
  if (to !== undefined && !evmToRefused(to, h.pin, []) && list.length > 0) {
    const plan = planPoolWithdraw(list, list.reduce((a, n) => (n.value > a ? n.value : a), 0n) - c.fee - c.wFee, c) ?? [];
    const first = plan[0];
    if (first !== undefined) {
      const w = await seedUse(h, async (seed) => spendOf(seed, (await notes.get(first.noteId))!).w);
      c = await evmWithdrawCosts(h, { to, from: w, value: first.part });
    }
  }
  return { notes: list, fee: c.fee, wFee: c.wFee, minPart: c.minPart };
}
