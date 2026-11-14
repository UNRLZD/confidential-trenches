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
//   W signs (the note goes back UNSPENT). The notes under the epoch root are planned first, but never in more parts than
//   the plan over every note (the Solana withdraw's rested preference: the screen drew its Max fee on that one).
// - The roots (the Solana withdraw's, card fresh-money-spendable-at-once): the epoch root when the note is in it; a note
//   that landed this epoch, of any kind, proves at once on the newest root both RPCs agree on, its epoch, deadline and
//   binding the current epoch's; only a newest cut that does not hold its leaf yet is read again on the pool's time, a
//   second apart, out of one budget (one epoch and EVM_WITHDRAW_BOUNDARY_LAG_MS).
// - To, before any note moves: never under 0x10000 (the zero address and every precompile), the pool, the fee recipient
//   or a W of the plan; its code read on both RPCs. With no code a plain send takes 21,000 gas and cannot revert (the
//   estimate on Robinhood, both RPCs); with code (a smart wallet, a forwarder, an EIP-7702 delegation) W's exact send is
//   estimated and run (eth_call) on both RPCs, W's balance set by a state override, and its gas is the agreed estimate
//   and a fifth, at most 100,000. A To whose code changes after it leaves the part owed on W, as a crash does.
// - The op (the kit's kind "withdraw", WithdrawStage): proving, submitted (a release out), in_transit (the part on W, its
//   send owed), sent (every part's onward read back on both RPCs), stopped. The owed send (EvmPendingOnward: the
//   attempt, its context, To, the part, the release's nullifier, first block and deadline) is written to the wallet
//   store's meta before the release leaves; the note is RESERVED before it leaves and settled by the EVM settle pass
//   (evmSettleReserved). A restore from the 12 words does not find a part on W today: the page restores the EVM notes
//   with `wallets: false` (src/pool-restore.ts:678) and keeps only spends with a token (:682), so only this device's
//   owed record finishes the send; card evm-restore-finds-w-part closes that.
// - A W send that reverts (a To with code whose call fails, status 0 on both RPCs at a safe block) used W's nonce while
//   the part stays on W: the op stays in_transit, its owed send kept, and `held` (what W holds and W's index,
//   EvmHeldOnW) is written in the same op write as that stage. The state reads' finish then sends what W holds, less
//   its gas, to the same To at W's nonce 1 (resendHeld), only once that very send ran on both RPCs with its fee fields,
//   kept before it leaves: one resend at most. When it reverts too, the op stays in_transit with `held` and nothing
//   more is signed, so W's fees stop at two sends' bounds.
// - A send ends (sent, or reverted) only once its receipt's block is at or under the safe block both RPCs read: an
//   unsafe block can be rebuilt without it.
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
import { checkBinding, PoolNoLeafError, type Pool, type PoolTrees } from "../../wallet/src/pool/pool.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { EVM_BUY_HEAD_SPREAD, EVM_BUY_LAG_BLOCKS, EVM_BUY_LAG_MS } from "./pool-buy-evm.ts";
import { EvmSendBusy, EvmSendRefused, evmBuyVerdict, evmHeadNumber, evmReleaseRead, evmWithdrawCalldata, type EvmReleaseRead } from "./evm-send.ts";
import { legCause } from "./pool-sell.ts";
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
/** The one nonce a send after a revert takes (resendHeld): W's nonce-0 send and one resend at most, so a To that runs
 *  in eth_call but reverts on chain costs W two sends' gas bounds, never a resend each pass. */
export const EVM_RESEND_NONCE = 1n;

/** A public key no note is bound to (secp256k1's generator, the key of scalar 1): the epoch fee is read by a bind for
 *  it, which names it to no one (the helper's GET /v1/pool/fee names the pool and the epoch only). */
const PROBE_PUBLIC = /* @__PURE__ */ Uint8Array.from("0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8".match(/../g)!, (x) => parseInt(x, 16));

/** What a part costs on this chain: the epoch fee, W's fee bound and the smallest part; `gas` and `maxFee` W's send's. */
export type EvmWithdrawCosts = WithdrawCosts & { gas: bigint; maxFee: bigint; tip: bigint; l1: bigint; toHasCode: boolean };

/** One owed onward send on an EVM pool: the Solana record's fields, the chain, the part (wei, a decimal), and the
 *  release's nullifier, the block its read-back starts at, its deadline, chunk and fee (decimals); `release` the
 *  release's transaction once both RPCs read it, `onward` W's newest signed send's hash and `onwards` every one signed
 *  for this part (a reload's, another tab's), each written before its bytes leave. */
export type EvmPendingOnward = PendingOnward & { chain: Chain; part: string; nullifier: string; from: string; deadlineMs: string; chunk: string; fee: string; onward?: string; onwards?: string[]; resends?: EvmResend[] };
/** One of W's sends after its nonce-0 send reverted (resendHeld): its nonce (a decimal) and hash, kept before it leaves. */
export type EvmResend = { nonce: string; hash: string };

/** Every W send kept for an owed part: `onwards` and `onward`, once each. */
export const evmKeptOnwards = (p: Pick<EvmPendingOnward, "onward" | "onwards">): string[] => [...new Set([...(p.onwards ?? []), ...(p.onward !== undefined ? [p.onward] : [])])];

/** A part held on W after W's send reverted: W (its index: the note's label `l` and `j`), and what W holds, wei, a
 *  decimal, as both RPCs read it. The op's record keeps it, for a send at W's next nonce. */
export type EvmHeldOnW = { chain: Chain; noteId: string; w: string; l: string; j: number; amount: string };

/** One op's finish state across its passes: each RPC's read stop, and when its release first read "none". */
export type EvmFinishState = { stops: [bigint | null, bigint | null]; noneAt: bigint | null };

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
  /** The run's planned notes kept out of every proof queue (any tab's) and every other plan for `spanMs` from now on the
   *  device's clock (the longest a part can take to bind), written before any part and again before each part's wait for
   *  its boundary; [] clears them, at every end (the Solana withdraw's keepOut, src/pool-withdraw.ts). */
  keepOut?(noteIds: readonly string[], spanMs: bigint): Promise<void>;
  /** The op's stage; `held` (a part left on W by a send that reverted) in the same call, so one write holds both. */
  stage?(stage: WithdrawStage, txs: TxRef[], pending: EvmPendingOnward | null, arrived: Arrivals, held?: EvmHeldOnW): void;
  now?(): bigint;
  wait?(ms: number): Promise<void>;
  /** A payout to another chain: the Solana run's exit (src/pool-withdraw.ts PoolWithdrawHost exit). */
  exit?(refundTo: string): Promise<string>;
  /** A Move's claim, as the Solana run's (src/pool-withdraw.ts PoolWithdrawHost claim). */
  claim?(): Promise<void>;
};

/** `cause`: why a run or one of its parts ended on a throw, in public words only (pool-sell.ts legCause), for the op's
 *  record and the page's console, never a screen (the Solana run's PoolWithdrawAnswer cause). */
export type EvmWithdrawAnswer = { stage: WithdrawStage; txs: TxRef[]; pending: EvmPendingOnward | null; arrived: Arrivals; feeNeeded?: string; held?: EvmHeldOnW; cause?: string };

/** A run's own refusal, its word in `code` (an op's cause names it, legCause). */
class Stop extends Error {
  readonly code: string;
  constructor(why: string) {
    super(why);
    this.code = why;
  }
}
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
 *  `tag` on both RPCs, the same; 0 on Robinhood, whose L1 cost is in the gas. `bytes`: the send's size bound (W's own
 *  buy, pool-buy-evm-rest.ts, carries its call's bytes). */
export async function l1Of(h: Pick<EvmWithdrawHost, "chain" | "pin" | "rpcs">, gas: bigint, tag: string, bytes: bigint = EVM_ONWARD_L1_BYTES): Promise<[bigint, bigint]> {
  if (nitro(h.chain)) return [0n, 0n];
  const net = h.pin.network;
  const answers: [bigint[], bigint[]] = [[], []];
  for (const c of evmPoolChainFeeReads(net, gas, bytes)) {
    const [a, b] = await both(h.rpcs, async (rpc) => {
      const x = await rpc("eth_call", [{ to: c.to, data: c.data }, tag]);
      return typeof x === "string" && /^0x[0-9a-fA-F]{64,}$/.test(x) ? BigInt(`0x${x.slice(2, 66)}`) : stop("read");
    });
    answers[0].push(a);
    answers[1].push(b);
  }
  const fees: [bigint, bigint] = [evmPoolChainFee(net, bytes, answers[0]), evmPoolChainFee(net, bytes, answers[1])];
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

/** W's send to `to` with `value` and `gas`, estimated and run (eth_call) on both RPCs at `tag`, the run with the send's
 *  fee fields (`fees`: its max fee and tip); `balance`: W's set by a state override (before the release, W holds
 *  nothing). The estimate (both must agree) and whether each run returned. */
async function simulate(rpcs: readonly [EvmRpc, EvmRpc], from: string, to: string, value: bigint, tag: string, fees: { maxFee: bigint; tip: bigint }, balance?: bigint): Promise<{ estimate: [bigint, bigint]; ran: [boolean, boolean] }> {
  const over = balance === undefined ? [] : [{ [from]: { balance: qty(balance) } }];
  const call = { from, to, value: qty(value) };
  const estimate = await both(rpcs, async (rpc) => quantity(await rpc("eth_estimateGas", [call, tag, ...over])));
  const gas = evmOnwardCodeGas(agree(estimate));
  const run = { ...call, gas: qty(gas), maxFeePerGas: qty(fees.maxFee), maxPriorityFeePerGas: qty(fees.tip) };
  const ran = await both(rpcs, (rpc) => Promise.resolve().then(() => rpc("eth_call", [run, tag, ...over])).then(() => true, () => false));
  return { estimate, ran };
}

/** This chain's costs for a part, read now: the epoch fee, W's gas (21,000, Robinhood's agreed estimate, or a To with
 *  code's estimate and margin, its run on both RPCs), its max fee and tip, the L1 bound, W's fee bound and the smallest
 *  part. `to` and `from`: To and the first part's W when known (the screen before To is typed reads a plain send);
 *  `known`: the epoch fee this run already read (one helper read less; a bind under another fee stops the part). */
export async function evmWithdrawCosts(h: Pick<EvmWithdrawHost, "chain" | "pin" | "rpcs" | "pool">, to?: { to: string; from: string; value: bigint }, known?: bigint): Promise<EvmWithdrawCosts> {
  const fee = known ?? (await evmEpochFeeNow(h.pool)).fee;
  const blk = await latest(h.rpcs);
  const tag = qty(blk.number);
  const baseFee = blk.baseFeePerGas ?? stop("read");
  let toHasCode = false;
  let gas = EVM_ONWARD_GAS;
  const tip = nitro(h.chain) ? 0n : EVM_ONWARD_TIP;
  const maxFee = nitro(h.chain) ? baseFee : 2n * baseFee + tip;
  if (to !== undefined) {
    toHasCode = agree(await codeOf(h.rpcs, to.to, tag));
    if (toHasCode) {
      const sim = await simulate(h.rpcs, to.from, to.to, to.value, tag, { maxFee, tip }, 2n * to.value + 10n ** 18n);
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

/** A release's verdict for an owed part: "mine" (both RPCs read the same one Withdrawn of the pinned pool for the
 *  nullifier, paying W the chunk to the pinned fee recipient at a fee up to the cap), "other" (another release of the
 *  nullifier: it spent the note elsewhere), "none" (no release, both reads past the deadline at a final block), or null
 *  (read again). The transaction that carried it is not read: a release sent through any contract (a wrapper that calls
 *  the pool) changes nothing W receives. The event is the pool's own (its log address the pin's; PrivacyPool.sol
 *  _release emits it in the call that pays W the chunk less the fee, W's signed relay data holding the fee cap), only
 *  W's key moves what W then holds, and each send of W's moves at most min(part, balance - bound), at most one landing. */
export type EvmReleaseVerdict = { end: "mine"; tx: string; block: bigint } | { end: "other" } | { end: "none" } | null;
export async function evmReleaseOf(h: Pick<EvmWithdrawHost, "rpcs" | "pin">, p: Pick<EvmPendingOnward, "nullifier" | "from" | "deadlineMs" | "chunk" | "fee">, w: string, stops: [bigint | null, bigint | null]): Promise<EvmReleaseVerdict> {
  const reads = (await Promise.all(h.rpcs.map((rpc, k) => evmReleaseRead(rpc, h.pin.pool, BigInt(p.from), BigInt(p.deadlineMs), stops[k]!)))) as [EvmReleaseRead, EvmReleaseRead];
  stops[0] = reads[0].stop;
  stops[1] = reads[1].stop;
  // a buy's verdict with no token: a Withdrawn paying W is "withdrawn", anything else of the nullifier not_landed
  const v = evmBuyVerdict(reads, { nullifier: BigInt(p.nullifier), w, feeRecipient: h.pin.feeRecipient, token: "", minOut: 1n << 255n, value: BigInt(p.chunk), feeCap: BigInt(p.fee), deadlineMs: BigInt(p.deadlineMs) });
  if (v === null) return null;
  if (v.end === "not_landed") return v.release === null ? { end: "none" } : { end: "other" };
  if (v.end !== "withdrawn") return { end: "other" };
  return { end: "mine", tx: v.release.tx, block: v.release.block };
}

type OnwardEnd = { state: "ok"; hash: string; value: bigint } | { state: "fee"; need: bigint } | { state: "empty" } | { state: "reverted"; hash: string; held: bigint } | { state: "failed" } | { state: "unknown"; hash: string };

/** W's kept sends read back on both RPCs: "ok" (one landed, status 1), "reverted" (one landed with status 0: every
 *  kept send is W's nonce-0 send of this part, so the others can never land), else null. */
async function keptEnd(rpcs: readonly [EvmRpc, EvmRpc], p: EvmPendingOnward, w: string): Promise<{ state: "ok" | "reverted"; hash: string } | null> {
  let reverted: string | null = null;
  for (const hash of evmKeptOnwards(p)) {
    const r = await onwardReceipt(rpcs, hash, w, p.to);
    if (r === "ok") return { state: "ok", hash };
    if (r === "failed") reverted = hash;
  }
  return reverted !== null ? { state: "reverted", hash: reverted } : null;
}

/** W's address for the note's label `l` and `j`, its key wiped. */
const wOf = (h: Pick<EvmWithdrawHost, "seed64">, l: bigint, j: number): Promise<string> =>
  seedUse(h, (seed) => {
    const x = freshWallet(seed, "evm", l, j);
    x.secretKey.fill(0);
    return x.address;
  });

/** What W holds, as both RPCs read it at `tag` (they must agree). */
const heldOf = async (rpcs: readonly [EvmRpc, EvmRpc], w: string, tag: string): Promise<bigint> => agree(await both(rpcs, async (rpc) => quantity(await rpc("eth_getBalance", [w, tag]))));

/** W's onward send: exactly the part to To (W's balance less its bound when the bound rose past what W holds beyond it),
 *  built from the device's reads on both RPCs, checked by the rule, signed by W, its hash kept before it leaves, sent to
 *  both RPCs and read back as a receipt of status 1 on both. W's nonce: two RPCs that differ read again ("unknown");
 *  past 0 on both, W's one send was made (this tab's or another's): a kept one read back ("ok", or "reverted" with what
 *  W holds, for resendHeld), else "empty" (still owed: read again, never dropped). */
async function sendOnward(h: EvmWithdrawHost, ask: PoolAsk, p: EvmPendingOnward, l: bigint, j: number, keep: (p: EvmPendingOnward) => Promise<void>): Promise<OnwardEnd> {
  const w = await wOf(h, l, j);
  const part = BigInt(p.part);
  const feeCap = BigInt(p.feeCap);
  const blk = await latest(h.rpcs);
  const tag = qty(blk.number);
  const baseFee = blk.baseFeePerGas ?? stop("read");
  const nonce = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_getTransactionCount", [w, tag])));
  if (nonce[0] !== nonce[1]) return { state: "unknown", hash: "" };
  if (nonce[0] > 0n) {
    const k = await keptEnd(h.rpcs, p, w);
    if (k?.state === "ok") return { state: "ok", hash: k.hash, value: BigInt(await sentValue(h.rpcs, k.hash)) };
    if (k?.state === "reverted") return { state: "reverted", hash: k.hash, held: await heldOf(h.rpcs, w, tag) };
    return { state: "empty" };
  }
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
  if (code) {
    // the very send run on both RPCs, its value, gas and fee fields (a run with none prices the gas at 0)
    const call = { from: w, to: p.to, value: qty(value), gas: qty(gas), maxFeePerGas: qty(maxFee), maxPriorityFeePerGas: qty(prio) };
    simulated = await both(h.rpcs, (rpc) => Promise.resolve().then(() => rpc("eth_call", [call, tag])).then(() => true, () => false));
  }
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
  return broadcast(h, raw, hash, w, p.to, value);
}

/** W's signed send to both RPCs, again every fifth round, and its receipt read between them: "ok", "reverted" (with
 *  what W holds then, both RPCs' word), else "unknown" once the tap's rounds are spent (the state reads go on). */
async function broadcast(h: EvmWithdrawHost, raw: Uint8Array, hash: string, w: string, to: string, value: bigint): Promise<OnwardEnd> {
  const wait = waitOf(h);
  for (let round = 0; round < EVM_ONWARD_ROUNDS; round++) {
    if (round % 5 === 0) await Promise.allSettled(h.rpcs.map((rpc) => rpc("eth_sendRawTransaction", [hexOf(raw)])));
    const got = await onwardReceipt(h.rpcs, hash, w, to);
    if (got === "ok") return { state: "ok", hash, value };
    if (got === "failed") return { state: "reverted", hash, held: await heldOf(h.rpcs, w, qty((await latest(h.rpcs)).number)) };
    await wait(EVM_WITHDRAW_WAIT_MS);
  }
  return { state: "unknown", hash };
}

/** W's send after its nonce-0 send reverted (`held`): what W holds less its gas bound (never more than the part) to the
 *  same To, at W's nonce 1 only (EVM_RESEND_NONCE). A kept resend read back ends it ("ok"); W's nonce 0, or the two
 *  RPCs apart on it, reads again (never a second nonce-0 send); W's nonce 2 with the kept nonce-1 resend reverted
 *  answers "reverted" with what W holds and signs nothing (the part stays on W, in_transit); any other nonce reads
 *  again. The send is estimated and run (eth_call) on both RPCs at the block read, with its value, gas and fee fields,
 *  and signed only when both returned; the rule (checkEvmOnwardSend) holds it as W's first send; its hash and nonce
 *  kept before it leaves. */
async function resendHeld(h: EvmWithdrawHost, ask: PoolAsk, p: EvmPendingOnward, l: bigint, j: number, keep: (p: EvmPendingOnward) => Promise<void>): Promise<OnwardEnd> {
  const w = await wOf(h, l, j);
  const kept = p.resends ?? [];
  const read = new Map<string, "ok" | "failed" | null>();
  for (const r of kept) {
    const got = await onwardReceipt(h.rpcs, r.hash, w, p.to);
    if (got === "ok") return { state: "ok", hash: r.hash, value: BigInt(await sentValue(h.rpcs, r.hash)) };
    read.set(r.hash, got);
  }
  const part = BigInt(p.part);
  const feeCap = BigInt(p.feeCap);
  const blk = await latest(h.rpcs);
  const tag = qty(blk.number);
  const baseFee = blk.baseFeePerGas ?? stop("read");
  const nonce = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_getTransactionCount", [w, tag])));
  if (nonce[0] !== nonce[1] || nonce[0] === 0n) return { state: "unknown", hash: "" };
  if (nonce[0] > EVM_RESEND_NONCE) {
    // the one resend's nonce used: a kept resend there that reverted leaves the part on W (in_transit, `held` what W
    // holds now), and nothing more is signed, so W's fees stop at its two sends' bounds; any other: read again
    const r = kept.find((x) => BigInt(x.nonce) === EVM_RESEND_NONCE && read.get(x.hash) === "failed");
    return r !== undefined && nonce[0] === EVM_RESEND_NONCE + 1n ? { state: "reverted", hash: r.hash, held: await heldOf(h.rpcs, w, tag) } : { state: "unknown", hash: "" };
  }
  const balance = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_getBalance", [w, tag])));
  const bal = agree(balance);
  const toHasCode = await codeOf(h.rpcs, p.to, tag);
  const code = agree(toHasCode);
  const tip = nitro(h.chain) ? 0n : EVM_ONWARD_TIP;
  const maxFee = nitro(h.chain) ? baseFee : 2n * baseFee + tip;
  // the gas: 21,000 to no code on Base; else the estimate both RPCs agree on (a To with code: and its margin), for the
  // most W could send (its balance less the largest bound)
  const most = bal - EVM_ONWARD_GAS_MAX * maxFee - (await l1Of(h, EVM_ONWARD_GAS_MAX, tag))[0];
  if (most <= 0n) return { state: "failed" };
  const estimate = await both(h.rpcs, async (rpc) => quantity(await rpc("eth_estimateGas", [{ from: w, to: p.to, value: qty(most < part ? most : part) }, tag])));
  const gas = code ? evmOnwardCodeGas(agree(estimate)) : nitro(h.chain) ? agree(estimate) : EVM_ONWARD_GAS;
  const l1 = await l1Of(h, gas, tag);
  const bound = gas * maxFee + l1[0];
  if (bound > feeCap) return { state: "fee", need: bound };
  const value = bal - bound < part ? bal - bound : part;
  if (value <= 0n) return { state: "failed" };
  // the very send, run on both RPCs with its gas and fee fields (a run with none prices the gas at 0): a To that
  // reverts it is never sent to until it returns
  const call = { from: w, to: p.to, value: qty(value), gas: qty(gas), maxFeePerGas: qty(maxFee), maxPriorityFeePerGas: qty(tip) };
  const simulated = await both(h.rpcs, (rpc) => Promise.resolve().then(() => rpc("eth_call", [call, tag])).then(() => true, () => false));
  if (!simulated[0] || !simulated[1]) return { state: "unknown", hash: "" };
  const tx: EvmOnwardSend = { type: 2, chainId: EVM_CHAIN_IDS[h.pin.network], nonce: nonce[0], maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit: gas, to: p.to, value, data: "0x", accessList: [] };
  const ctx = { nowMs: clockOf(h)(), wallet: w, feeCap, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
  try {
    checkEvmOnwardSend(tx, ask, ctx, p.to, { nonce, balance, toHasCode, estimate: code || nitro(h.chain) ? estimate : null, simulated, baseFee: [baseFee, baseFee], l1Fee: l1, priorityCap: tip, part }, h.testnet);
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
  await keep({ ...p, resends: [...kept, { nonce: nonce[0].toString(), hash }] });
  return broadcast(h, raw, hash, w, p.to, value);
}

/** W's send's receipt on both RPCs: "ok" (status 1 on both, from W to To, the same block hash and number), "failed"
 *  (status 0 on both), each only once that block is at or under the safe block both RPCs read (an unsafe block can be
 *  rebuilt without the send, which would put its nonce, and the part, back in play); else null. */
export async function onwardReceipt(rpcs: readonly [EvmRpc, EvmRpc], hash: string, w: string, to: string): Promise<"ok" | "failed" | null> {
  type Receipt = { status?: unknown; from?: unknown; to?: unknown; blockHash?: unknown; blockNumber?: unknown };
  const rs = await Promise.all(rpcs.map((rpc) => Promise.resolve().then(() => rpc("eth_getTransactionReceipt", [hash])).catch(() => null))) as (Receipt | null)[];
  if (rs.some((r) => r === null || typeof r !== "object")) return null;
  const [a, b] = rs as Receipt[];
  if (a!.blockHash !== b!.blockHash || typeof a!.from !== "string" || typeof a!.to !== "string" || lower(a!.from) !== lower(w) || lower(a!.to) !== lower(to) || lower(String(b!.from)) !== lower(w) || lower(String(b!.to)) !== lower(to)) return null;
  if (typeof a!.blockNumber !== "string" || a!.blockNumber !== b!.blockNumber || !/^0x[0-9a-fA-F]{1,16}$/.test(a!.blockNumber)) return null;
  const end = a!.status === "0x1" && b!.status === "0x1" ? "ok" : a!.status === "0x0" && b!.status === "0x0" ? "failed" : null;
  if (end === null) return null;
  const block = BigInt(a!.blockNumber);
  const safe = await Promise.all(rpcs.map((rpc) => Promise.resolve().then(() => rpc("eth_getBlockByNumber", ["safe", false])).then((x) => (x as { number?: unknown } | null)?.number, () => null)));
  return safe.every((n) => typeof n === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(n) && BigInt(n) >= block) ? end : null;
}

/** One withdraw of `amount` (wei arriving at `to`), `maxFee` the Max fee the screen drew. */
export async function runEvmPoolWithdraw(h: EvmWithdrawHost, ask: PoolAsk, to: string, amount: bigint, maxFee: bigint): Promise<EvmWithdrawAnswer> {
  const txs: TxRef[] = [];
  const arrived: Arrivals = {};
  let pending: EvmPendingOnward | null = null;
  let feeNeeded: bigint | null = null;
  let held: EvmHeldOnW | null = null;
  const say = (s: WithdrawStage): void => h.stage?.(s, txs.slice(), pending, { ...arrived }, held ?? undefined);
  const end = (s: WithdrawStage): EvmWithdrawAnswer => (say(s), { stage: s, txs: txs.slice(), pending, arrived: { ...arrived }, ...(feeNeeded !== null ? { feeNeeded: feeNeeded.toString() } : {}), ...(held !== null ? { held } : {}) });
  try {
    if (ask.kind !== "pool.withdraw" || ask.chain !== h.chain) stop("kind");
    // the pin alone decides: this page's network's pin for the chain, or no withdraw
    const network = h.testnet ? (h.chain === "base" ? "base-sepolia" : "robinhood-testnet") : h.chain;
    if (h.pin.network !== network) stop("pin");
    if (typeof maxFee !== "bigint" || maxFee < 0n) stop("max_fee");
    const notes = await h.notes();
    const owed = (await h.owedNotes?.()) ?? new Set<string>();
    // UNSPENT and HELD notes (a HELD one any tab's proof queue holds lets go: free()), less the owed and kept-out ones
    const list = await notes.list();
    const sources = withdrawSources(list, h.pool.scope).filter((n) => !owed.has(n.id));
    // the notes under the epoch root first, but never in more parts than the plan over every note: the screen drew its
    // Max fee on that one (withdraw/pool-form.ts over withdrawSources), so the rested preference never costs more
    const rested = await evmRestedNotes(h.pool, list);
    const planOf = (c: WithdrawCosts): WithdrawPart[] | null => {
      const all = planPoolWithdraw(sources, amount, c);
      const quiet = rested === null ? null : planPoolWithdraw(sources.filter((n) => rested.has(n.id)), amount, c);
      return quiet !== null && all !== null && quiet.length <= all.length ? quiet : all;
    };
    // the first plan at a plain send's cost names the notes, and so the first W the To check runs from
    const first = await evmWithdrawCosts(h);
    const plan0 = planOf(first);
    if (plan0 === null) stop("plan");
    const wsOf = (ps: readonly WithdrawPart[]): Promise<string[]> => seedUse(h, async (seed) => {
      const out: string[] = [];
      for (const p of ps) out.push(spendOf(seed, (await notes.get(p.noteId))!).w);
      return out;
    });
    const ws = await wsOf(plan0!);
    // another chain (card pool-withdraws-to-any-chain): To is the checked quote's deposit address on this chain, its
    // refund the first W, which must stay the run's first W (no re-plan below)
    if (h.exit) to = await h.exit(ws[0]!);
    if (evmToRefused(to, h.pin, ws)) stop("to");
    // To read on both RPCs before any note moves: a To with code is run from the first part's W, or refused
    const costs = await evmWithdrawCosts(h, { to, from: ws[0]!, value: plan0![0]!.part }, first.fee);
    const plan = costs.wFee === first.wFee && costs.fee === first.fee ? plan0! : planOf(costs);
    if (plan === null) stop("plan");
    // a re-plan (W's send priced higher to a To with code) spends other notes: their Ws are checked against To, and a To
    // with code is run again from the first W and part of the plan that runs; a send that needs more gas from there than
    // the plan was priced at stops before any note moves (review of cb287f4f5 P3-2)
    if (plan !== plan0) {
      if (h.exit) stop("plan");
      const ws1 = await wsOf(plan!);
      if (evmToRefused(to, h.pin, ws1)) stop("to");
      if (costs.toHasCode && (await evmWithdrawCosts(h, { to, from: ws1[0]!, value: plan![0]!.part }, first.fee)).gas > costs.gas) stop("gas");
    }
    if (BigInt(plan!.length) * (costs.fee + costs.wFee) > maxFee) stop("max_fee");
    const wCap = maxFee / BigInt(plan!.length) - costs.fee;
    // from here to the run's end no proof queue (any tab's) takes a planned note; each part moves the deadline on
    const keepOut = async (): Promise<void> => h.keepOut?.(plan!.map((x) => x.noteId), evmKeepSpan(h.pool));
    await keepOut();
    for (const [i, p] of plan!.entries()) {
      say("proving");
      const got = await onePart(h, ask, notes, p, costs, { to, last: i === plan!.length - 1, feeCap: wCap.toString() }, (o) => void (pending = o), keepOut);
      if (got.tx !== "") txs.push({ chain: h.chain, hash: got.tx });
      if (got.end === "stopped") {
        pending = null;
        return { ...end("stopped"), ...(got.cause !== undefined ? { cause: got.cause } : {}) };
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
      } else if (on.state === "reverted") {
        // W's send reverted: the part stays on W and still owed (in_transit), `held` written with that stage; the state
        // reads' finish sends it at W's next nonce (resendHeld)
        txs.push({ chain: h.chain, hash: on.hash });
        held = { chain: h.chain, noteId: pending!.noteId, w: await wOf(h, got.l, got.j), l: got.l.toString(), j: got.j, amount: on.held.toString() };
        return end("in_transit");
      } else return end("in_transit"); // "empty", "unknown", "failed": the part still owed, for the state reads
      pending = null;
      if (i < plan!.length - 1) say("submitted");
    }
    return end("sent");
  } catch (e) {
    return { ...end(pending ? "in_transit" : "stopped"), cause: legCause(e) };
  } finally {
    // the planned notes back to every queue; a failed write lets them back at the record's own deadline
    await h.keepOut?.([], 0n).catch(() => {});
  }
}

/** A part's one budget for its waits on chain time is one epoch and this (the Solana withdraw's
 *  WITHDRAW_BOUNDARY_LAG_MS): the pool's time is the newest block both RPCs agree on; past it one lags. A part waits
 *  only while the newest cut does not hold its note's leaf yet. */
export const EVM_WITHDRAW_BOUNDARY_LAG_MS = 30_000n;
/** How long a part waits for a note the page's proof queue is still proving to come back UNSPENT once dropped (the
 *  queue frees it when that proof ends, queue.ts drop); past it the part stops. */
export const EVM_WITHDRAW_FREE_MS = 30_000;
/** A part's tree read, bounded in wall-clock time (the pool's trees() takes the signal). */
export const EVM_WITHDRAW_TREES_MS = 30_000;

/** The longest a part can take to bind from its start: its waits on chain time (they may cross a boundary) and a proof's life. */
const evmKeepSpan = (P: Pick<Pool<EvmPoolRequest>, "epochMs" | "lifeMs">): bigint => P.epochMs + EVM_WITHDRAW_BOUNDARY_LAG_MS + P.lifeMs;

/** The landed notes under the pool's epoch root now (leaf index below the epoch tree's size); null when the read fails,
 *  so the plan draws on every note and each part reads its own roots (the Solana withdraw's restedNotes). */
async function evmRestedNotes(P: Pool<EvmPoolRequest>, list: readonly NoteRecord[]): Promise<ReadonlySet<string> | null> {
  try {
    const nowMs = await P.now();
    const size = BigInt((await P.trees(nowMs - (nowMs % P.epochMs), AbortSignal.timeout(EVM_WITHDRAW_TREES_MS))).stateTree.size);
    return new Set(list.filter((n) => n.leaf !== undefined && n.leaf.leafIndex < size).map((n) => n.id));
  } catch (e) {
    // an epoch root that holds no leaf (PoolNoLeafError): none rested
    return e instanceof PoolNoLeafError ? new Set() : null;
  }
}

/** One part's release to W: hold the note, bind and prove part + fee + W's fee to W, check, sign as W, RESERVED, the
 *  owed send written, then the helper's send and the read-back on both RPCs. "stopped": nothing left the device, or
 *  the chain says it never lands; "sent": no end in the tap's bound (owed, for the state reads). */
async function onePart(h: EvmWithdrawHost, ask: PoolAsk, notes: NoteStore, p: WithdrawPart, c: EvmWithdrawCosts, base: Pick<PendingOnward, "to" | "last" | "feeCap">, owing: (o: EvmPendingOnward) => void, keepOut: () => Promise<void>): Promise<{ end: "mine" | "stopped" | "sent"; tx: string; l: bigint; j: number; cause?: string }> {
  const P = h.pool;
  let attempt: string | null = null;
  let reserved = false;
  let key: Uint8Array | null = null;
  const clock = clockOf(h);
  const wait = waitOf(h);
  try {
    // the note, dropped first when this page's proof queue holds it for the next buy; one it is still proving, or
    // another tab's queue holds, comes back UNSPENT when that proof ends or at that queue's next pass (the keep-out
    // record's write wakes it: queue.ts skip), waited for at most EVM_WITHDRAW_FREE_MS
    const free = async (): Promise<NoteRecord> => {
      let n = await notes.get(p.noteId);
      if (n?.state === "HELD") {
        await h.drop?.(p.noteId);
        for (let waited = 0; (n = await notes.get(p.noteId))?.state === "HELD" && waited < EVM_WITHDRAW_FREE_MS; waited += 500) await wait(500);
      }
      if (n === undefined || n.state !== "UNSPENT" || n.leaf === undefined) stop("note");
      return n!;
    };
    // the run's notes out of every queue's pass (any tab's) for this part's whole span, before its note is freed (a
    // part before it may have outrun the last write's span), and again below before its tree read and any wait
    await keepOut();
    let n = await free();
    const leaf = n.leaf!;
    if (leaf.value < p.chunk || p.chunk !== p.part + c.fee + c.wFee) stop("value");
    // the epoch root when the note is in it; else the newest both RPCs agree on, which holds every leaf up to now (card
    // fresh-money-spendable-at-once: no part waits for a boundary)
    let nowMs = await P.now();
    // again from here: past the latest deadline this part can bind, so no queue takes this note during a wait
    await keepOut();
    // one budget for every wait of this part on chain time
    const left = { ms: P.epochMs + EVM_WITHDRAW_BOUNDARY_LAG_MS };
    // a cut that holds no leaf (an empty pool's first leaf landing this epoch: PoolNoLeafError) is a cut that does not
    // hold the note: null, so the newest root is taken at once
    const read = (cut: bigint, opts?: { newest?: boolean }): Promise<PoolTrees | null> =>
      P.trees(cut, AbortSignal.timeout(EVM_WITHDRAW_TREES_MS), opts).catch((e: unknown) => {
        if (e instanceof PoolNoLeafError) return null;
        throw e;
      });
    const holds = (t: PoolTrees | null): t is PoolTrees => t !== null && leaf.leafIndex < BigInt(t.stateTree.size);
    let epochStartMs = nowMs - (nowMs % P.epochMs);
    let trees = await read(epochStartMs);
    for (let waited = false; !holds(trees); ) {
      // a note that landed this epoch: the newest root, at once
      const newest = await read(nowMs + 1n, { newest: true });
      if (holds(newest)) {
        trees = newest;
        // a queue that took it before the keep-out was written, during a wait: dropped and waited for, as at the start
        if (waited) n = await free();
        break;
      }
      // its leaf past the pool's time (its landing read ahead of both RPCs' agreed block): the pool's time read again a
      // second later, out of the one budget; a new epoch's root may hold it by then
      if (left.ms <= 0n) stop("leaf");
      const ms = left.ms < 1_000n ? left.ms : 1_000n;
      await wait(Number(ms));
      left.ms -= ms;
      waited = true;
      const at = await P.now();
      if (at > nowMs) nowMs = at;
      if (nowMs - (nowMs % P.epochMs) !== epochStartMs) {
        epochStartMs = nowMs - (nowMs % P.epochMs);
        trees = await read(epochStartMs);
        if (holds(trees)) n = await free();
      }
    }
    const deadlineMs = epochStartMs + P.lifeMs;
    const j = jOf(n.ref);
    const keys = await seedUse(h, (seed) => {
      const w = freshWallet(seed, "evm", leaf.label, j);
      w.secretKey.fill(0);
      return { w, refund: noteSecrets(seed, { kind: "refund", l: leaf.label, j }).precommitment, spent: noteSecrets(seed, n.ref), next: noteSecrets(seed, { kind: "change", l: leaf.label, j }) };
    });
    const binding = await P.bind({ chunk: p.chunk, wallet: { address: keys.w.address, publicKey: keys.w.publicKey }, refundPrecommitment: keys.refund, epochStartMs, deadlineMs });
    checkBinding(P as Pool, binding, p.chunk);
    // the plan's fee or no part: a fee that moved since the plan stops before W signs
    if (binding.feeCap !== c.fee || binding.request.relay.feeCap !== c.fee) stop("fee");
    attempt = (await notes.move(p.noteId, "UNSPENT", "HELD", { deadlineMs, context: binding.context.toString() })).attempt!;
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
    // where the read-back starts: under the lower of both RPCs' newest blocks, read before W signs; two heads further
    // apart than the buy's and the sell's bound (EVM_BUY_HEAD_SPREAD) stop the part, so one RPC's low head never starts
    // the read further under the chain than the read's span (EVM_BUY_LOG_SPAN) covers
    const heads = await Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc)));
    const [lo, hi] = heads[0]! < heads[1]! ? [heads[0]!, heads[1]!] : [heads[1]!, heads[0]!];
    if (hi - lo > EVM_BUY_HEAD_SPREAD) stop("heads");
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
    // a Move past its send-by (or ended) sends nothing (card move-sends-or-says-why); then RESERVED and the owed send,
    // both before anything leaves the device
    await h.claim?.();
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
    return { end: "stopped", tx: "", l: 0n, j: 0, cause: legCause(e) };
  } finally {
    (key as Uint8Array | null)?.fill(0);
    if (attempt !== null && !reserved) await notes.move(p.noteId, "HELD", "UNSPENT", { attempt }).catch(() => {});
  }
}

/** The state reads' pass for an owed EVM part (a reload, a crash, a lost send): its note still this attempt's
 *  (RESERVED by it, or SPENT with its context), its release read on both RPCs (none past the deadline on two passes
 *  the lag margin apart, as the run's own rule, or another's: stopped, nothing sent), then W's send: every hash kept
 *  read back first, then W's send onward, its hash kept before it leaves. W's nonce past 0 on both RPCs: a kept send
 *  landed or will, read again until both hold its receipt; a kept send that reverted (status 0 on both) answers
 *  in_transit with what W holds (`held`), nothing signed in that pass, so the op's record holds `held` before any
 *  resend leaves. With `held` (the op's record's, this note's), W's next-nonce send of what it holds to the same To
 *  (resendHeld), never W's nonce-0 send again. null: read again later (the money may be on W). */
export async function finishEvmOnward(h: EvmWithdrawHost, pending: EvmPendingOnward, state: EvmFinishState = { stops: [null, null], noneAt: null }, heldWas?: EvmHeldOnW): Promise<{ stage: WithdrawStage; txs: TxRef[]; arrived: Arrivals; feeNeeded?: string; held?: EvmHeldOnW } | null> {
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
    // every send of W's kept: read back first
    const k = await keptEnd(h.rpcs, pending, w);
    if (k?.state === "ok") return done(pending.last ? "sent" : "stopped", [{ chain: h.chain, hash: k.hash }], { [k.hash]: await sentValue(h.rpcs, k.hash) });
    const v = await evmReleaseOf(h, pending, w, state.stops);
    if (v === null) return null;
    if (v.end === "none") {
      // two passes of "none" at least the lag margin apart (the run's rule): then it never lands
      const at = clockOf(h)();
      state.noneAt ??= at;
      if (at - state.noneAt < BigInt(EVM_BUY_LAG_MS)) return null;
      h.settle();
      return done("stopped");
    }
    state.noneAt = null;
    h.settle();
    if (v.end !== "mine") return done("stopped");
    const keep = async (q: EvmPendingOnward): Promise<void> => {
      await h.keep?.(q);
    };
    // `held` only as this note's own W: any other record is no word of the chain's
    const held = heldWas !== undefined && heldWas.noteId === pending.noteId && heldWas.chain === h.chain && lower(heldWas.w) === lower(w) && heldWas.l === l.toString() && heldWas.j === j;
    const on = held ? await resendHeld(h, ask, pending, l, j, keep) : await sendOnward(h, ask, pending, l, j, keep);
    const rel: TxRef = { chain: h.chain, hash: v.tx };
    if (on.state === "ok") return done(pending.last ? "sent" : "stopped", [rel, { chain: h.chain, hash: on.hash }], { [on.hash]: on.value.toString() });
    if (on.state === "reverted") return { ...done("in_transit", [rel, { chain: h.chain, hash: on.hash }]), held: { chain: h.chain, noteId: pending.noteId, w, l: l.toString(), j, amount: on.held.toString() } };
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
export async function evmWithdrawFunds(h: Pick<EvmWithdrawHost, "chain" | "pin" | "rpcs" | "pool" | "notes" | "seed64" | "owedNotes">, to?: string): Promise<{ notes: ReturnType<typeof withdrawSources>; fee: bigint; wFee: bigint; minPart: bigint }> {
  const notes = await h.notes();
  const owed = (await h.owedNotes?.()) ?? new Set<string>();
  const list = withdrawSources(await notes.list(), h.pool.scope).filter((n) => !owed.has(n.id));
  let c = await evmWithdrawCosts(h);
  if (to !== undefined && !evmToRefused(to, h.pin, []) && list.length > 0) {
    const plan = planPoolWithdraw(list, list.reduce((a, n) => (n.value > a ? n.value : a), 0n) - c.fee - c.wFee, c) ?? [];
    const first = plan[0];
    if (first !== undefined) {
      const w = await seedUse(h, async (seed) => spendOf(seed, (await notes.get(first.noteId))!).w);
      c = await evmWithdrawCosts(h, { to, from: w, value: first.part }, c.fee);
    }
  }
  return { notes: list, fee: c.fee, wFee: c.wFee, minPart: c.minPart };
}
