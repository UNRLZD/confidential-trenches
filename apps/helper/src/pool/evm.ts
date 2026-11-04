// POST /v1/pool/evm/send (card helper-pool-senders; v2 M3): the helper's EVM sender carries a pool withdraw the device
// built, byte for byte as its calldata, or refuses it. The sender is an operating key holding only gas, read from the
// host's environment; it signs one EIP-1559 transaction to the pool with value 0 and exactly the calldata received, and
// takes only the fee the proof's context caps, paid to the release's fee recipient.
//
// The body: { "pool": "0x<the pool>", "data": "0x<calldata>", "epoch": <the start, ms, of the epoch whose fee the
// proof binds> }. Checks, each a refusal before any send (422 unless named):
//   bad_shape        not withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256) in its one
//                    canonical ABI encoding (every offset, length and padding as the encoder writes them, nothing
//                    after), or over EVM_BODY_DATA_MAX (400);
//   not_pool         the withdrawal's processooor is not the pool the body names, which this helper carries;
//   fee_recipient    the request pays the fee to anyone but this release's fee recipient;
//   epoch_off        the epoch is not inside the proof's life (deadlineMs - POOL_LIFE_MAX_MS up to the deadline), is
//                    outside [now - POOL_LIFE_MAX_MS, now], or the chain has no block in it yet;
//   deadline_near    the deadline is under now + EVM_POOL_SEND_MARGIN_MS (these first checks make no RPC call);
//   reverted         this nullifier's send in this epoch reverted on chain: it is never sent again in this epoch
//                    (M356 (1)); a new proof in a later epoch is its own send;
//   fee_off          the fee is not the fee this helper publishes for that epoch (M352 (2): max(the floor,
//                    2 x EVM_WITHDRAW_GAS x the base fee of the epoch's first block), on its step);
//   fee_over_cap     the fee is over the request's feeCap (the pool refuses it too: FeeOverCap);
//   recipient_code   the recipient holds code on either provider at pending or latest (an EIP-7702 delegation,
//                    0xef0100..., too): a contract could revert the pool's push after the simulation;
//   simulation_failed eth_estimateGas or eth_call of the exact transaction at "pending", from the sender with the gas,
//                    maxFeePerGas and maxPriorityFeePerGas the send then signs, fails in execution, or its gas is over
//                    EVM_GAS_MAX;
//   fee_stale        the fee's cap per gas (fee / gas limit) is under the current base fee: it could not be mined, so
//                    the device re-proves at a newer epoch's fee (M356 (2));
//   rate_limited (429) EVM_QUEUE_MAX sends are already waiting (Retry-After EVM_BUSY_RETRY_S; card helper-abuse-limits:
//                    the helper's own budget is a wait, never a 503); or a provider throttled a read or the send (its
//                    HTTP 429, a rate-limit error, EIP-1474's -32005; Retry-After 1, limits.ts throttleOf);
//   in_flight (429)  this client already holds EVM_IN_FLIGHT_MAX requests open (M374 (5) on this route too: one client
//                    cannot fill the shared queue); Retry-After EVM_BUSY_RETRY_S;
//   upstream (503)   a read could not be made (a transport error, an HTTP status but 429, another JSON-RPC error),
//                    or the two providers name different chains.
// A nullifier is sent once (./once.ts): a repeat gets the first hash and sends nothing; a repeat after that send
// reverted is refused as reverted. Each send's maxFeePerGas is at most fee / gas limit, so the sender never pays more
// gas than the fee, and a send the helper accepts either lands and spends or fails in the simulation.
// Answer: 200 { hash }. pool-evm-buy adds buy() with W's EIP-712 signature: its selector goes in SELECTORS with its own
// decoder, and the same fee, recipient, simulation and send rules apply.
//
// POST /v1/pool/evm/sell (card helper-evm-sender): W's sell of its token back into the pool. W holds no ETH and sends
// nothing: the device sends W's EIP-712 Sell inside SellDelegate.sell's calldata and W's EIP-7702 authorization of the
// kit's pinned SellDelegate, and the sender sends ONE type-4 transaction to W carrying both, as the device's reference
// sell that landed on both testnets does (contracts/pool-evm/script/testnet-run.mjs sellOf, testnet-run-lib.mjs
// signTx7702). SellDelegate pays `fee` (at most Sell.feeCap) to msg.sender, the sender, and deposits the rest.
// The body: { "pool", "w", "data", "authorization": { chainId, address, nonce, yParity, r, s } }, hex strings as
// testnet-run-lib.mjs authJson writes them. Checks, each a refusal before any send (422 unless named), every static one
// before any RPC call:
//   bad_shape        a body of any other key or shape, or data not sell((address,uint256,address,bytes,uint256,address,
//                    uint256,uint256,uint256,uint256),uint256,bytes) in its one canonical ABI encoding (every offset,
//                    length and padding as the encoder writes them, a 65-byte signature, nothing after), or over
//                    EVM_SELL_DATA_MAX (2,048 bytes);
//   not_pool         the Sell's pool is not this sender's;
//   fee_over_cap     the fee is over the Sell's feeCap, or the feeCap is not under minOut (the deposit holds nothing);
//   bad_authorization the authorization's chainId is not the venue's (the kit's evmPoolVenues(), never 0), its address
//                    not the kit's pinned sell delegate for this network (none pinned: every sell refused), yParity not
//                    0 or 1, r or s 0 or out of range, s high (EIP-2), nonce 2^64 - 1 or more (EIP-7702), or its signer
//                    not W; one code, the detail names which;
//   bad_signature    W's Sell signature does not recover to W over SellDelegate's own digest (evmSellDigest: domain
//                    Blindfill, 1, the venue's chain id, verifyingContract W, as SellDelegate._sellDigest and the kit's
//                    sell-unpinned.ts sellDigest make it; the kit exports no digest), or its v is not 27 or 28, or its
//                    s is high;
//   bad_route        the Sell's target and swap data are not a call the kit's sell builder makes for that Sell: the
//                    kit's evmSellRouteOf (the one definition, sell-unpinned.ts) reads them back as a route (v4 through
//                    the venue's pinned PoolManager, v3 through a listed router), encodes that route again with the
//                    builder's own encoder and requires the same bytes, then evmSellRouteCheck; any other target,
//                    token, hook, hook data, recipient, amount or minOut is refused (the sell sender pays the gas of
//                    whatever W signs);
//   deadline_near    the deadline (unix seconds) is under now + EVM_POOL_SEND_MARGIN_MS, checked again after the
//                    queue's wait (a withdraw's deadlineMs too);
//   deadline_far     it is over now + the kit's EVM_POOL_SELL_DEADLINE_MAX_S (a deadline written in ms lands here);
//   not_configured (503) no sell key is set for the network (POOL_EVM_SELL_KEY_<NETWORK>): every sell, nothing read;
//   auth_nonce       W's account nonce at pending, on either provider, is not the authorization's: the chain would skip
//                    the authorization and the sender would pay for a call to W with no code;
//   fee_low          the fee is under EVM_POOL_SELL_GAS x (the higher latest base fee of the two providers + the kit's
//                    tip) + the chain fee: the kit's one definition (pool-fee.ts evmPoolChainFeeReads and
//                    evmPoolChainFee, the device's own rule), read on both providers, the higher, for the longest the
//                    transaction can be (its signature's r and s at 32 bytes each, evmTx4MaxLength, and maxFeePerGas at
//                    fee / gas, the most it can be). On Base and Base Sepolia the GasPriceOracle's L1 fee bound and its
//                    operator fee; on Robinhood the L1 poster fee, 16 x those bytes x ArbGasInfo's L1 base fee estimate;
//   simulation_failed eth_call at "pending" of the transaction as signed (from the sell sender, to W, its fee fields, its
//                    gas less EVM_7702_AUTH_GAS, which an eth_call does not charge, and on Robinhood less the poster's
//                    gas too: Arbitrum charges the poster fee as gas inside the limit, the poster fee over the lower
//                    of the two base fees, rounded up), W's code overridden with the delegation designator, fails in
//                    execution (as the device's sim does: the kit's checks/evm/quote.ts simmedSells); or the poster's
//                    gas leaves no gas to run the sale;
//   upstream (503)   a read could not be made, or the providers name another chain than each other or the venue's;
//   rate_limited (429) the sell lane's queue is full; or the unpaid gas held against W, the client, the token (each
//                    EVM_SELL_UNPAID_CAP_WEI) or the sender's whole sell budget (EVM_SELL_UNPAID_BUDGET_WEI) in the
//                    window would pass its cap with this sale's worst cost, each with Retry-After until the oldest
//                    leaves it; a caller (W or client) whose own sale landed and paid in the window is held only by
//                    its own W and client caps, never by the token's or the budget. Withdraws are never held by these;
//   in_flight (429)  as the withdraw: one held limit per client across both routes.
// The send: from the sell sender's own key (never the withdraw sender's) on its own queue and nonce lane; gas exactly
// EVM_POOL_SELL_GAS and maxPriorityFeePerGas exactly the kit's evmPoolSellTip (pins the device's sim copies, never
// eth_estimateGas or eth_maxPriorityFeePerGas), maxFeePerGas min(2 x base + tip, (fee - the chain fee) / gas), so the
// sender's worst cost, gas x maxFeePerGas + the chain fee, is within the fee. That worst cost is held against
// the caps from the send; the sale's receipt, read in the background on both providers, turns it into what went
// unpaid: all of gasUsed x effectiveGasPrice + l1Fee on a revert, that less the fee on a sale that paid less, else 0.
// Once per (W, Sell nonce): a repeat gets the first hash and sends nothing, unless that sale ended without landing on
// the providers' own reads (a receipt with status 0 on either, or once now is past its deadline plus
// EVM_SELL_DROP_MARGIN_MS no transaction on either): then (W, nonce) is free for a new send, as often as W's unpaid cap
// allows. A refused sell frees it at once.
// The nonce lanes (withdraw and sell alike): neither leaves a nonce no transaction holds. Each send reads its sender's
// pending count on both providers, the higher; while that count stays below the lane's next nonce for longer than
// EVM_SELL_DROP_MARGIN_MS since the lane's send at it, no provider holds a tx there, so the send takes that nonce. Each
// send's receipt is read in the background, from EVM_SELL_RECEIPT_POLL_MS doubling to 15 times it: a send still
// unmined past its deadline plus the margin is replaced at its own nonce by a 0-value transfer to the sender itself,
// its fee fields raised a tenth over the send's, and a hole with no send waiting to fill it is filled the same way.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  EVM_7702_AUTH_GAS,
  EVM_POOL_SELL_DEADLINE_MAX_S,
  EVM_POOL_SELL_GAS,
  evmPoolChainFee,
  evmPoolChainFeeReads,
  evmPoolSellTip,
  evmPoolVenues,
  evmSellRouteOf,
  solanaJsonRpc,
  type EvmPoolChain,
  type EvmPoolVenue,
} from "@blindfill/kit";
import { epochStartOf, POOL_EPOCH_MS } from "./fee.ts";
import { oncePerNullifier, POOL_SEND_MEMORY } from "./once.ts";
import { heldPerClient, throttleOf } from "../limits/limits.ts";

/** POST /v1/pool/evm/send's body limit, and the calldata's (a withdraw is 4 + 32 x 27 = 868 bytes). */
export const POOL_EVM_BODY_MAX = 4_096;
export const EVM_BODY_DATA_MAX = 1_024;
/** The most gas the helper pays for one withdraw: the measured Privacy Pools withdrawal is 611,391 (M349), so 2.5x [design]. */
export const EVM_GAS_MAX = 1_500_000n;

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const selectorOf = (sig: string): string => hex(keccak_256(new TextEncoder().encode(sig)).subarray(0, 4));
export const WITHDRAW_SIGNATURE = "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)";
export const WITHDRAW_SELECTOR = selectorOf(WITHDRAW_SIGNATURE);

const word = (d: Uint8Array, i: number): bigint => BigInt(`0x${hex(d.subarray(4 + 32 * i, 4 + 32 * (i + 1))) || "0"}`);
const W_OFFSET = 18n * 32n; // the Withdrawal tuple's tail starts after 1 + 16 + 1 head words
const RELAY_WORDS = 6; // recipient, feeRecipient, feeCap, deadlineMs, refundPrecommitment, salt
const WITHDRAW_LEN = 4 + 32 * (18 + 3 + RELAY_WORDS);
const isAddressWord = (w: bigint) => w >> 160n === 0n;
const addr = (w: bigint) => `0x${w.toString(16).padStart(40, "0")}`;

export type EvmWithdraw = { processooor: string; recipient: string; feeRecipient: string; feeCap: bigint; deadlineMs: bigint; fee: bigint; nullifier: string };

/** A withdraw's calldata read back; throws unless it is exactly the one canonical encoding. */
export function evmReadWithdraw(d: Uint8Array): EvmWithdraw {
  if (d.length !== WITHDRAW_LEN || hex(d.subarray(0, 4)) !== WITHDRAW_SELECTOR) throw new Error("not withdraw's calldata");
  if (word(d, 0) !== W_OFFSET) throw new Error("the withdrawal's offset");
  const fee = word(d, 17);
  const processooor = word(d, 18);
  if (!isAddressWord(processooor) || word(d, 19) !== 64n || word(d, 20) !== BigInt(32 * RELAY_WORDS)) throw new Error("the withdrawal's layout");
  const r = (i: number) => word(d, 21 + i);
  if (!isAddressWord(r(0)) || !isAddressWord(r(1)) || r(3) >> 64n !== 0n || (r(5) & ((1n << 128n) - 1n)) !== 0n) throw new Error("the relay data's padding");
  // pubSignals[1], existingNullifierHash: head word 1 + 2 (pA) + 4 (pB) + 2 (pC) + 1
  const nullifier = word(d, 10).toString(16).padStart(64, "0");
  return { processooor: addr(processooor), recipient: addr(r(0)), feeRecipient: addr(r(1)), feeCap: r(2), deadlineMs: r(3), fee, nullifier };
}

// ---- RLP and the EIP-1559 transaction ----

type Rlp = Uint8Array | Rlp[];
const big = (n: bigint): Uint8Array => (n === 0n ? new Uint8Array() : unhex(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0")));
function rlpLen(len: number, short: number): Uint8Array {
  if (len < 56) return Uint8Array.of(short + len);
  const l = big(BigInt(len));
  return Uint8Array.of(short + 55 + l.length, ...l);
}
export function rlp(x: Rlp): Uint8Array {
  if (x instanceof Uint8Array) return x.length === 1 && x[0]! < 0x80 ? x : Uint8Array.from([...rlpLen(x.length, 0x80), ...x]);
  const body = x.map(rlp);
  const n = body.reduce((s, b) => s + b.length, 0);
  return Uint8Array.from([...rlpLen(n, 0xc0), ...body.flatMap((b) => [...b])]);
}

export type EvmTx = { chainId: bigint; nonce: bigint; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; gas: bigint; to: string; data: Uint8Array };
/** One EIP-7702 authorization as a type-4 transaction's list carries it. */
export type EvmAuthorization = { chainId: bigint; address: string; nonce: bigint; yParity: bigint; r: bigint; s: bigint };
export type EvmTx4 = EvmTx & { authorizations: readonly EvmAuthorization[] };

/** The signed type-2 transaction (EIP-1559): value 0, no access list. */
export function signEvmTx(tx: EvmTx, key: Uint8Array): { raw: Uint8Array; hash: string } {
  const fields: Rlp[] = [big(tx.chainId), big(tx.nonce), big(tx.maxPriorityFeePerGas), big(tx.maxFeePerGas), big(tx.gas), unhex(tx.to.slice(2)), new Uint8Array(), tx.data, []];
  const digest = keccak_256(Uint8Array.from([2, ...rlp(fields)]));
  const sig = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const recovery = sig[0]!;
  const r = BigInt(`0x${hex(sig.subarray(1, 33))}`);
  const s = BigInt(`0x${hex(sig.subarray(33, 65))}`);
  const raw = Uint8Array.from([2, ...rlp([...fields, big(BigInt(recovery)), big(r), big(s)])]);
  return { raw, hash: `0x${hex(keccak_256(raw))}` };
}

/** A type-4 transaction's fields before its signature (EIP-7702): value 0, no access list. */
const tx4Fields = (tx: EvmTx4): Rlp[] => [
  big(tx.chainId), big(tx.nonce), big(tx.maxPriorityFeePerGas), big(tx.maxFeePerGas), big(tx.gas), unhex(tx.to.slice(2)), new Uint8Array(), tx.data, [],
  tx.authorizations.map((a) => [big(a.chainId), unhex(a.address.slice(2)), big(a.nonce), big(a.yParity), big(a.r), big(a.s)]),
];

/** The signed type-4 transaction (EIP-7702): 0x04 ‖ rlp([chainId, nonce, tip, maxFee, gas, to, 0, data, [], auths, y, r, s]). */
export function signEvmTx4(tx: EvmTx4, key: Uint8Array): { raw: Uint8Array; hash: string } {
  const fields = tx4Fields(tx);
  const digest = keccak_256(Uint8Array.from([4, ...rlp(fields)]));
  const sig = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const r = BigInt(`0x${hex(sig.subarray(1, 33))}`);
  const s = BigInt(`0x${hex(sig.subarray(33, 65))}`);
  const raw = Uint8Array.from([4, ...rlp([...fields, big(BigInt(sig[0]!)), big(r), big(s)])]);
  return { raw, hash: `0x${hex(keccak_256(raw))}` };
}

/** The most bytes `tx` signed can take: its signature's r and s at 32 bytes each, the longest they can be. */
const U256_MAX = (1n << 256n) - 1n;
export const evmTx4MaxLength = (tx: EvmTx4): number => 1 + rlp([...tx4Fields(tx), big(1n), big(U256_MAX), big(U256_MAX)]).length;

/** The address of a secp256k1 private key. */
export function evmAddressOf(key: Uint8Array): string {
  return `0x${hex(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12))}`;
}

// ---- The sell's calldata (card helper-evm-sender) ----

export const SELL_SIGNATURE = "sell((address,uint256,address,bytes,uint256,address,uint256,uint256,uint256,uint256),uint256,bytes)";
export const SELL_SELECTOR = selectorOf(SELL_SIGNATURE);
/**
 * The sell's calldata limit, bytes, and POST /v1/pool/evm/sell's body limit: the calldata is 580 bytes plus the swap
 * data padded; the longest route the kit builds (EVM_POOL_MAX_HOPS 4 v4 hops with empty hook data, abi.encode(PathKey[]))
 * is 960 bytes of swap data, so 1,540 bytes [design: about 1.3x that].
 */
export const EVM_SELL_DATA_MAX = 2_048;
export const POOL_EVM_SELL_BODY_MAX = 8_192;
const SELL_HEAD = 3; // the tuple's offset, the fee, the signature's offset
const SELL_TUPLE = 10; // token, amount, target, the data's offset, minOut, pool, precommitment, feeCap, deadline, nonce

export type EvmSell = { token: string; amount: bigint; target: string; data: string; minOut: bigint; pool: string; precommitment: bigint; feeCap: bigint; deadline: bigint; nonce: bigint; fee: bigint; signature: Uint8Array };

/** A sell's calldata read back; throws unless it is exactly the one canonical encoding. */
export function evmReadSell(d: Uint8Array): EvmSell {
  const least = 4 + 32 * (SELL_HEAD + SELL_TUPLE + 1 + 1 + 3);
  if (d.length > EVM_SELL_DATA_MAX || d.length < least || (d.length - 4) % 32 !== 0 || hex(d.subarray(0, 4)) !== SELL_SELECTOR) throw new Error("not sell's calldata");
  if (word(d, 0) !== BigInt(32 * SELL_HEAD)) throw new Error("the sell's offset");
  const t = (i: number) => word(d, SELL_HEAD + i);
  if (t(3) !== BigInt(32 * SELL_TUPLE)) throw new Error("the swap data's offset");
  if (![t(0), t(2), t(5)].every(isAddressWord)) throw new Error("an address's padding");
  const len = t(SELL_TUPLE);
  if (len > BigInt(d.length)) throw new Error("the swap data's length");
  const padded = Math.ceil(Number(len) / 32);
  const sigAt = SELL_HEAD + SELL_TUPLE + 1 + padded; // the signature's length word
  if ((d.length - 4) / 32 !== sigAt + 4) throw new Error("the sell's length");
  if (word(d, 2) !== BigInt(32 * sigAt)) throw new Error("the signature's offset");
  if (word(d, sigAt) !== 65n) throw new Error("the signature's length");
  const dataAt = 4 + 32 * (SELL_HEAD + SELL_TUPLE + 1);
  const sigBytes = 4 + 32 * (sigAt + 1);
  if (d.subarray(dataAt + Number(len), dataAt + 32 * padded).some((b) => b !== 0) || d.subarray(sigBytes + 65, sigBytes + 96).some((b) => b !== 0)) throw new Error("the padding");
  return {
    token: addr(t(0)), amount: t(1), target: addr(t(2)), data: `0x${hex(d.subarray(dataAt, dataAt + Number(len)))}`, minOut: t(4), pool: addr(t(5)),
    precommitment: t(6), feeCap: t(7), deadline: t(8), nonce: t(9), fee: word(d, 1), signature: d.slice(sigBytes, sigBytes + 65),
  };
}

const utf8 = (t: string) => new TextEncoder().encode(t);
const w32 = (n: bigint) => unhex(n.toString(16).padStart(64, "0"));
const DOMAIN_TYPE = keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const SELL_TYPE = keccak_256(utf8("Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,uint256 deadline,uint256 nonce)"));
/** SellDelegate._sellDigest (contracts/pool-evm/src/SellDelegate.sol) of `s` under W's own address on chain `chainId`. */
export function evmSellDigest(chainId: bigint, w: string, s: EvmSell): Uint8Array {
  const domain = keccak_256(Uint8Array.from([...DOMAIN_TYPE, ...keccak_256(utf8("Blindfill")), ...keccak_256(utf8("1")), ...w32(chainId), ...w32(BigInt(w))]));
  const fields = [BigInt(s.token), s.amount, BigInt(s.target)].map(w32);
  const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, s.deadline, s.nonce].map(w32);
  const struct = keccak_256(Uint8Array.from([...SELL_TYPE, ...fields.flatMap((x) => [...x]), ...keccak_256(unhex(s.data.slice(2))), ...rest.flatMap((x) => [...x])]));
  return keccak_256(Uint8Array.from([0x19, 0x01, ...domain, ...struct]));
}

const N = secp256k1.Point.CURVE().n;
/** The address that signed `digest` with (recovery, r, s), or null where none does. */
function recoverAddress(digest: Uint8Array, recovery: number, r: bigint, s: bigint): string | null {
  try {
    const sig = Uint8Array.from([recovery, ...unhex(r.toString(16).padStart(64, "0")), ...unhex(s.toString(16).padStart(64, "0"))]);
    const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(sig, digest, { prehash: false })).toBytes(false);
    return `0x${hex(keccak_256(pub.subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}

// ---- The epoch fee (M352 (2)) ----

/**
 * The withdraw's gas the fee is priced on: Privacy Pools' withdrawal, 611,391, measured twice (M349). A
 * constant, never a reading, so every caller and every restart prices an epoch the same.
 */
export const EVM_WITHDRAW_GAS = 611_391n;
/** The coarse step every EVM fee is rounded up to, in wei: 0.00001 ETH [design]. */
export const EVM_FEE_STEP = 10n ** 13n;
/** The longest a proof lives, ms: the device's cap on deadline_ms (wallet withdraw/request.ts WITHDRAW_DEADLINE_MAX_MS). */
export const POOL_LIFE_MAX_MS = 600_000;
/** How many epochs' fees each sender remembers [design: well past one proof life of 10 epochs]. */
const EPOCH_MEMORY = 64;
/**
 * The least time, ms, between now and a request's deadline for the helper to send it (M356 (1)): a send needs time to
 * be mined before the pool's deadline check, or the sender pays for a revert. It moves to the kit with the fee file.
 */
export const EVM_POOL_SEND_MARGIN_MS = 60_000;
/** The most sends waiting behind the one in flight; past it 503 busy (M356 (3)) [design: about a minute of sends]. */
export const EVM_QUEUE_MAX = 64;
/** The requests one client holds open on this route [design: a buy and a sell at once, as on Solana]. */
export const EVM_IN_FLIGHT_MAX = 2;
/** The wait a full queue or a client's held limit names [design: a send's reads and send take about a second]. */
export const EVM_BUSY_RETRY_S = 2;
/**
 * How long past a Sell's deadline, on our clock, a sale with no receipt and no transaction on either provider still
 * holds its (W, Sell nonce): SellDelegate checks the deadline against the block's time, so a helper whose clock runs up
 * to this far ahead of the chain's would otherwise free the nonce, and send a second tx at it, while the first can still
 * land [design: the same 60 s as EVM_POOL_SEND_MARGIN_MS].
 */
export const EVM_SELL_DROP_MARGIN_MS = 60_000;
/**
 * The sell sender pays gas for each call W signs and is paid only when the sale lands (SellDelegate pays the fee out of
 * the proceeds). Each sale's worst cost (gas x maxFeePerGas + the L1 data fee bound) is held against W, the client,
 * the token and the sender's whole sell budget from its send; its receipt, read in the background, turns that into what
 * went unpaid (all of the cost on a revert, cost - fee when a landed sale paid less). In any EVM_SELL_UNPAID_WINDOW_MS
 * the unpaid and held wei stay under EVM_SELL_UNPAID_CAP_WEI per W, client or token and EVM_SELL_UNPAID_BUDGET_WEI in
 * all, or sells answer 429 rate_limited; withdraws are never held by it [design: a sale's worst cost on Base is about
 * 3 x 10^13 wei (gas 1,000,000 x 2 x base + tip at a 0.01 gwei base, plus the L1 fee), so a cap of 10^15 is about 30
 * reverts from one W, client or token, and the budget 10^16 about 300 an hour from all, about 0.01 ETH].
 */
export const EVM_SELL_UNPAID_WINDOW_MS = 3_600_000;
export const EVM_SELL_UNPAID_CAP_WEI = 10n ** 15n;
export const EVM_SELL_UNPAID_BUDGET_WEI = 10n ** 16n;
/** The first wait before a sent transaction's receipt is read, doubling each read up to EVM_RECEIPT_POLL_BACKOFF times
 *  it (2 s to 30 s), until its deadline plus the send margin [design: about a block on Base, then a few reads a minute]. */
export const EVM_SELL_RECEIPT_POLL_MS = 2_000;
export const EVM_RECEIPT_POLL_BACKOFF = 15;

export type EvmBlock = { number: bigint; timestamp: bigint; hash: string; baseFeePerGas: bigint };
const blockOf = (v: unknown): EvmBlock => {
  const b = v as { number?: unknown; timestamp?: unknown; hash?: unknown; baseFeePerGas?: unknown } | null;
  const hash = evmRpcHex(b?.hash);
  if (hash === null || !/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("not a block");
  return { number: qty(b!.number), timestamp: qty(b!.timestamp), hash, baseFeePerGas: qty(b!.baseFeePerGas) };
};
const tag = (n: bigint) => `0x${n.toString(16)}`;

/**
 * The first block at or after `seconds`, read on `rpc`: null when the newest block is still before it. Steps back from
 * the newest block, doubling, until a block is before it, then halves the gap.
 */
export async function evmFirstBlockAtOrAfter(rpc: EvmRpc, seconds: bigint): Promise<EvmBlock | null> {
  const at = async (n: bigint | "latest") => blockOf(await rpc("eth_getBlockByNumber", [n === "latest" ? n : tag(n), false]));
  let hi = await at("latest");
  if (hi.timestamp < seconds) return null;
  let step = hi.timestamp - seconds + 1n;
  let lo: EvmBlock | null = null;
  for (;;) {
    if (hi.number === 0n) return hi;
    const n = hi.number > step ? hi.number - step : 0n;
    const b = await at(n);
    if (b.timestamp < seconds) {
      lo = b;
      break;
    }
    hi = b;
    step *= 2n;
  }
  while (hi.number - lo.number > 1n) {
    const mid = await at((lo.number + hi.number) / 2n);
    if (mid.timestamp >= seconds) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The epoch's fee: max(floor, 2 x EVM_WITHDRAW_GAS x the base fee of the epoch's first block), rounded up to the step. */
export function evmEpochFee(floor: bigint, baseFeePerGas: bigint): bigint {
  const gas = 2n * EVM_WITHDRAW_GAS * baseFeePerGas;
  const stepped = ((gas + EVM_FEE_STEP - 1n) / EVM_FEE_STEP) * EVM_FEE_STEP;
  return stepped > floor ? stepped : floor;
}

// ---- The sender ----

export type EvmRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type PoolEvmCode =
  | "bad_shape" | "not_pool" | "fee_recipient" | "fee_off" | "fee_over_cap" | "epoch_off" | "deadline_near" | "reverted" | "recipient_code" | "simulation_failed" | "fee_stale" | "rate_limited" | "in_flight" | "upstream"
  | "bad_authorization" | "bad_signature" | "deadline_far" | "auth_nonce" | "fee_low" | "bad_route" | "not_configured";
/** `retryAfterS` on a 429 only: the whole seconds the route names in Retry-After. */
export type PoolEvmAnswer = { status: number; body: { hash: string } | { error: { code: PoolEvmCode; detail?: string } }; retryAfterS?: number };
/** `sell_sender`: the sell sender's address, which a sale's fee is paid to and the device's sim runs from (the kit pins
 *  it), or null where no sell key is set (every sell refused not_configured). */
export type EvmFeeAnswer = { chain: "evm"; network: string; pool: string; fee_recipient: string; sell_sender: string | null; epoch_ms: number; epoch_start_ms: number; block: string; fee: string; step: string };

export type EvmPoolSender = {
  readonly network: string;
  readonly pool: string;
  readonly sender: string;
  /** The sell sender's address (its own key, nonce lane and queue, never the withdraw sender's), or null: no sell key. */
  readonly sellSender: string | null;
  /** GET /v1/pool/fee: the epoch's fee (the epoch holding `atMs`), in wei; null while the chain has no block in it yet. */
  fee(atMs: number): Promise<EvmFeeAnswer | null>;
  /** POST /v1/pool/evm/send for a parsed body, from `client` (server.ts's clientOf: the caller's address). */
  carry(body: unknown, client?: string): Promise<PoolEvmAnswer>;
  /** POST /v1/pool/evm/sell for a parsed body, from `client`, held and queued with the withdraws. */
  sell(body: unknown, client?: string): Promise<PoolEvmAnswer>;
};

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX = /^0x([0-9a-f]{2})+$/;
/** The sell body's hex strings, as authJson writes them: an address in either case, a 32-byte word, a quantity. */
const ANY_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD32 = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]{0,63})$/;
const SELL_KEYS = ["authorization", "data", "pool", "w"];
const AUTH_KEYS = ["address", "chainId", "nonce", "r", "s", "yParity"];
const sameKeys = (o: object, keys: readonly string[]) => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
};
/** The chains whose L1 poster fee is charged as gas inside the transaction's limit (Arbitrum: Robinhood Chain). */
const POSTER_GAS_CHAINS: ReadonlySet<string> = new Set(["robinhood", "robinhood-testnet"]);
/**
 * An RPC's hex string as viem and ethers read one, and as the device does (packages/wallet/src/pool/evm.ts evmRpcHex,
 * card wallet-rpc-hex-case): "0x", then hex digits in either case, lower-cased; null for anything else.
 * robinhood-testnet.drpc.org answers eth_chainId "0xB626" where Robinhood's own RPC and publicnode answer "0xb626"
 * (read 3 Nov 23:07Z). Every hex a provider gives is read through this before it is checked or compared, so two
 * providers' answers that differ only in case are one answer, and any other difference is still one.
 */
export const evmRpcHex = (v: unknown): string | null => (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : null);
/** A JSON-RPC quantity, canonical (no leading zero), as the spec writes it, in either case. */
const qty = (v: unknown): bigint => {
  const h = evmRpcHex(v);
  if (h === null || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(h)) throw new Error("not a quantity");
  return BigInt(h);
};
/**
 * The node ran the call and it failed in execution: a JSON-RPC error (the kit's client words it "RPC error <code>:
 * <message>") with code 3 (execution reverted), -32000 (geth: insufficient funds, a fee under the base fee, an invalid
 * opcode) or -32003 (EIP-1474 transaction rejected; anvil 1.8.6 answers an INVALID halt "EVM error InvalidFEOpcode"
 * and insufficient funds with it, read on an anvil fork, 3 Nov), unless its message names a rate limit. Anything else (a transport error, an HTTP status, a timeout, another
 * code) is the provider's, so it answers 503 upstream (429 rate_limited for a throttle) and never blames the request.
 */
const failedInExecution = (e: unknown): boolean => {
  const m = String((e as Error | undefined)?.message ?? e);
  return /^RPC error (3|-32000|-32003): /.test(m) && !/rate|limit exceeded|too many|capacity/i.test(m);
};

/**
 * One pool's sender. `floor` is the least fee, in wei (the pool's asset is the chain's native coin, PrivacyPoolSimple);
 * `feeRecipient` is where the release takes it. Sends one at a time, so each takes the next nonce; one per nullifier.
 */
export function evmPoolSender(
  cfg: { network: string; pool: string; senderKey: Uint8Array; sellKey?: Uint8Array; floor: bigint; feeRecipient?: string; memory?: number; venues?: Readonly<Partial<Record<string, EvmPoolVenue>>>; receiptPollMs?: number },
  providers: readonly [EvmRpc, EvmRpc],
  now: () => number = Date.now,
): EvmPoolSender {
  const pool = cfg.pool.toLowerCase();
  if (!ADDRESS.test(pool)) throw new Error("the pool must be an address");
  const sender = evmAddressOf(cfg.senderKey);
  const feeRecipient = (cfg.feeRecipient ?? sender).toLowerCase();
  if (!ADDRESS.test(feeRecipient)) throw new Error("the fee recipient must be an address");
  // the sell sender: its own key, so a sale's unpaid gas never drains the withdraw sender, and its own nonce lane
  const sellSender = cfg.sellKey === undefined ? null : evmAddressOf(cfg.sellKey);
  if (sellSender === sender) throw new Error("the sell key must not be the withdraw sender's key");
  const [a, b] = providers;
  let chainId: Promise<bigint> | null = null;
  // one lane per key: its queue (each send waits for the one before it), its next nonce, and each of its own sends not
  // yet seen mined, by nonce: when it was sent, the time past which it is stuck, its fee fields
  type Sent = { at: number; stuckAfter: number; maxFee: bigint; tip: bigint };
  type Lane = { queue: Promise<unknown>; waiting: number; nextNonce: bigint; from: string; key: Uint8Array | undefined; sent: Map<bigint, Sent>; tending: boolean };
  const laneOf = (from: string, key: Uint8Array | undefined): Lane => ({ queue: Promise.resolve(), waiting: 0, nextNonce: -1n, from, key, sent: new Map(), tending: false });
  const withdrawLane = laneOf(sender, cfg.senderKey);
  const sellLane = laneOf(sellSender ?? sender, cfg.sellKey);
  const once = oncePerNullifier<PoolEvmAnswer>(cfg.memory);
  /** Each remembered send's epoch, so a revert is held against the epoch whose proof reverted. */
  const sentIn = new WeakMap<Promise<PoolEvmAnswer>, number>();
  /** `${epoch}:${nullifier}` of every send that reverted on chain, the oldest dropped first (M356 (1)). */
  const reverted = new Set<string>();
  const revertMemory = cfg.memory ?? POOL_SEND_MEMORY;
  const fees = new Map<number, Promise<{ block: EvmBlock; fee: bigint } | null>>();
  // the sell's chain: the network's kit chain (the helper's network names are the kit's), its venue and its pinned
  // sell delegate; a network the kit does not list, or one with no pinned delegate, refuses every sell
  const venues: Readonly<Partial<Record<string, EvmPoolVenue>>> = cfg.venues ?? evmPoolVenues();
  const sellVenue = Object.hasOwn(venues, cfg.network) ? venues[cfg.network] : undefined;
  const sellChain = sellVenue === undefined ? undefined : (cfg.network as EvmPoolChain);
  const pinned = sellVenue !== undefined && Object.hasOwn(sellVenue, "sellDelegate") && typeof sellVenue.sellDelegate === "string" ? sellVenue.sellDelegate.toLowerCase() : undefined;
  const sellDelegate = pinned !== undefined && ADDRESS.test(pinned) ? pinned : undefined;
  const sells = oncePerNullifier<PoolEvmAnswer>(cfg.memory);
  /** Each remembered sale's Sell deadline (unix seconds), so a repeat can tell a dropped sale from a waiting one. */
  const sellDeadline = new WeakMap<Promise<PoolEvmAnswer>, bigint>();
  /** The last time each W ("w:") and client ("c:") had a sale land and pay its cost, held for the unpaid window. */
  const paid = new Map<string, number>();
  /** The unpaid-gas ledger: per key ("all", "w:", "c:", "t:"), the charges in the window; one charge object is shared by
   *  every key of its sale, so its receipt updates them all at once. */
  type Charge = { at: number; wei: bigint };
  const unpaid = new Map<string, Charge[]>();
  const live = (k: string, t: number): Charge[] => {
    const l = (unpaid.get(k) ?? []).filter((c) => c.at > t - EVM_SELL_UNPAID_WINDOW_MS);
    if (l.length === 0) unpaid.delete(k);
    else unpaid.set(k, l);
    return l;
  };
  /** The 429 a sale would get with `extra` wei more held against `keys`, or null when every key stays within its cap. */
  const overCap = (keys: readonly string[], extra: bigint): PoolEvmAnswer | null => {
    const t = now();
    // a caller whose own sale landed and paid in the window is held by its own W and client caps only: strangers'
    // reverts spending the token's cap or the sender's budget never refuse it
    const known = keys.some((k) => (k.startsWith("w:") || k.startsWith("c:")) && (paid.get(k) ?? -Infinity) > t - EVM_SELL_UNPAID_WINDOW_MS);
    for (const k of keys) {
      if (known && (k === "all" || k.startsWith("t:"))) continue;
      const l = live(k, t);
      const cap = k === "all" ? EVM_SELL_UNPAID_BUDGET_WEI : EVM_SELL_UNPAID_CAP_WEI;
      const sum = l.reduce((x, c) => x + c.wei, 0n);
      if (sum + extra > cap) {
        const oldest = l.length > 0 ? l[0]!.at : t;
        return { ...no(429, "rate_limited", `unpaid sell gas ${sum} wei for ${k === "all" ? "this sender" : k.slice(0, 1) === "w" ? "W" : k.slice(0, 1) === "c" ? "this client" : "this token"}, cap ${cap}`), retryAfterS: Math.max(1, Math.ceil((oldest + EVM_SELL_UNPAID_WINDOW_MS - t) / 1000)) };
      }
    }
    return null;
  };
  const charge = (keys: readonly string[], wei: bigint): Charge => {
    const c = { at: now(), wei };
    for (const k of keys) unpaid.set(k, [...live(k, c.at), c]);
    return c;
  };
  const sellKeys = (w: string, client: string | undefined, token: string) => ["all", `w:${w}`, `t:${token}`, ...(client === undefined ? [] : [`c:${client}`])];
  const no = (status: number, code: PoolEvmCode, detail?: string): PoolEvmAnswer => ({ status, body: { error: { code, ...(detail ? { detail } : {}) } } });
  // a provider call that failed: a throttle (its 429, a rate-limit error) is 429 rate_limited with its wait, else 503
  // upstream (card helper-abuse-limits: a 503 never means "wait")
  const unread = (e: unknown): PoolEvmAnswer => {
    const wait = throttleOf(e, true);
    return wait > 0 ? { ...no(429, "rate_limited"), retryAfterS: wait } : no(503, "upstream");
  };
  const chain = (): Promise<bigint> => {
    chainId ??= Promise.all([a("eth_chainId", []), b("eth_chainId", [])]).then(([x, y]) => {
      if (qty(x) !== qty(y)) throw new Error("the providers name different chains");
      return qty(x);
    });
    return chainId.catch((e) => {
      chainId = null;
      throw e;
    });
  };
  /** The epoch's first block, on provider A and the same hash on B, and its fee; cached once both agree. */
  const feeOf = (epochStartMs: number): Promise<{ block: EvmBlock; fee: bigint } | null> => {
    const known = fees.get(epochStartMs);
    if (known) return known;
    const p = (async () => {
      const block = await evmFirstBlockAtOrAfter(a, BigInt(Math.ceil(epochStartMs / 1000)));
      if (block === null) return null;
      const same = blockOf(await b("eth_getBlockByNumber", [tag(block.number), false]));
      if (same.hash !== block.hash) throw new Error("the providers hold different blocks");
      return { block, fee: evmEpochFee(cfg.floor, block.baseFeePerGas) };
    })();
    fees.set(epochStartMs, p);
    p.then((v) => v === null && fees.delete(epochStartMs), () => fees.delete(epochStartMs));
    while (fees.size > EPOCH_MEMORY) fees.delete(fees.keys().next().value as number);
    return p;
  };
  // M374 (5): the requests each client holds open, the queue's wait included
  const held = heldPerClient(EVM_IN_FLIGHT_MAX);
  // (a caller with no address, a test or the helper itself, is not counted); a withdraw and a sell count alike
  const holding = (client: string | undefined, run: () => Promise<PoolEvmAnswer>): Promise<PoolEvmAnswer> => {
    if (client === undefined) return run();
    if (!held.enter(client)) return Promise.resolve({ ...no(429, "in_flight"), retryAfterS: EVM_BUSY_RETRY_S });
    const p = run();
    const leave = () => held.leave(client);
    p.then(leave, leave);
    return p;
  };
  const carry = (body: unknown, client?: string): Promise<PoolEvmAnswer> => holding(client, () => carryHeld(body));
  const sell = (body: unknown, client?: string): Promise<PoolEvmAnswer> => holding(client, () => sellHeld(body, client));
  // one queue and one nonce lane per key: each send waits for the one before it on its lane
  const enqueue = (lane: Lane, job: () => Promise<PoolEvmAnswer>): Promise<PoolEvmAnswer> => {
    if (lane.waiting >= EVM_QUEUE_MAX) return Promise.resolve({ ...no(429, "rate_limited"), retryAfterS: EVM_BUSY_RETRY_S });
    lane.waiting++;
    const run = lane.queue.then(() => {
      lane.waiting--;
      return job();
    });
    lane.queue = run.catch(() => {});
    return run;
  };
  const carryHeld = async (body: unknown): Promise<PoolEvmAnswer> => {
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 3) return no(400, "bad_shape");
    const { pool: p, data, epoch } = body as { pool?: unknown; data?: unknown; epoch?: unknown };
    if (p !== pool || typeof data !== "string" || data.length > 2 + 2 * EVM_BODY_DATA_MAX || !HEX.test(data)) return no(400, "bad_shape");
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 || epoch % POOL_EPOCH_MS !== 0) return no(400, "bad_shape");
    const bytes = unhex(data.slice(2));
    let w: EvmWithdraw;
    try {
      w = evmReadWithdraw(bytes);
    } catch (e) {
      return no(400, "bad_shape", (e as Error).message);
    }
    if (w.processooor !== pool) return no(422, "not_pool");
    if (w.feeRecipient !== feeRecipient) return no(422, "fee_recipient");
    // the proof's epoch: inside its life (at most POOL_LIFE_MAX_MS before its deadline, before the deadline), never
    // later than the epoch now nor older than a proof's life; then a deadline at least the send margin away. No RPC
    // call before these, so an old or expired request costs no read (M356 (3)).
    const deadline = Number(w.deadlineMs);
    const t = now();
    if (epoch < deadline - POOL_LIFE_MAX_MS || epoch >= deadline || epoch > epochStartOf(t) || epoch < t - POOL_LIFE_MAX_MS) return no(422, "epoch_off");
    if (deadline < t + EVM_POOL_SEND_MARGIN_MS) return no(422, "deadline_near", `deadline ${deadline}, now ${t}`);
    if (reverted.has(`${epoch}:${w.nullifier}`)) return no(422, "reverted");
    let epochFee: { block: EvmBlock; fee: bigint } | null;
    try {
      epochFee = await feeOf(epoch);
    } catch (e) {
      return unread(e);
    }
    if (epochFee === null) return no(422, "epoch_off", "no block in the epoch yet");
    if (w.fee !== epochFee.fee) return no(422, "fee_off", `fee ${w.fee}, published ${epochFee.fee} for epoch ${epoch}`);
    if (w.fee > w.feeCap) return no(422, "fee_over_cap", `fee ${w.fee}, cap ${w.feeCap}`);
    // one send per nullifier (./once.ts): a repeat gets the first hash; a repeat after that send reverted on chain is
    // refused, and its epoch is remembered so that release is never sent again (M356 (1))
    const prior = once.get(w.nullifier);
    if (prior) {
      const first = await prior;
      const hash = (first.body as { hash?: string }).hash;
      const rc = hash ? await a("eth_getTransactionReceipt", [hash]).catch(() => null) : null;
      if ((rc as { status?: unknown } | null)?.status !== "0x0") return first;
      const was = sentIn.get(prior) ?? epoch;
      reverted.add(`${was}:${w.nullifier}`);
      while (reverted.size > revertMemory) reverted.delete(reverted.values().next().value as string);
      once.forget(w.nullifier, prior);
      if (was === epoch) return no(422, "reverted");
    }
    const entry = once.run(w.nullifier, () => enqueue(withdrawLane, () => simulateSignSend(data, bytes, w)));
    sentIn.set(entry, epoch);
    return entry;
  };
  async function simulateSignSend(data: string, bytes: Uint8Array, w: EvmWithdraw): Promise<PoolEvmAnswer> {
    // the deadline again after the queue's wait: a send that waited past the margin would pay for the pool's revert
    if (Number(w.deadlineMs) < now() + EVM_POOL_SEND_MARGIN_MS) return no(422, "deadline_near", `deadline ${w.deadlineMs}, now ${now()} after the queue`);
    const call = { from: sender, to: pool, data, value: "0x0" };
    let id: bigint, base: bigint, tip: bigint, pending: bigint;
    try {
      id = await chain();
      // a recipient with code could revert the pool's push after the simulation: refused on either provider, at
      // pending and at latest; any answer but "0x" (an EIP-7702 delegation is 0xef0100 + an address) is code
      const codes = await Promise.all([a, b].flatMap((r) => ["pending", "latest"].map((at) => r("eth_getCode", [w.recipient, at]))));
      if (codes.some((c) => c !== "0x")) return no(422, "recipient_code");
      const [block, t, n, m] = await Promise.all([a("eth_getBlockByNumber", ["latest", false]), a("eth_maxPriorityFeePerGas", []), a("eth_getTransactionCount", [sender, "pending"]), b("eth_getTransactionCount", [sender, "pending"])]);
      base = qty((block as { baseFeePerGas?: unknown })?.baseFeePerGas);
      tip = qty(t);
      pending = higher(qty(n), qty(m));
    } catch (e) {
      return unread(e);
    }
    let gas: bigint;
    try {
      gas = qty(await a("eth_estimateGas", [call, "pending"]));
    } catch (e) {
      return failedInExecution(e) ? no(422, "simulation_failed", String((e as Error).message).slice(0, 200)) : unread(e);
    }
    gas = (gas * 12n) / 10n;
    if (gas > EVM_GAS_MAX) return no(422, "simulation_failed", `gas ${gas} over ${EVM_GAS_MAX}`);
    // the sender never pays more gas than the fee: maxFeePerGas at most fee / gas limit; a cap under the base fee now
    // could not be mined and would hold every later nonce behind it, so it is refused and the device re-proves
    const cap = w.fee / gas;
    if (cap < base) return no(422, "fee_stale", `fee ${w.fee} / gas ${gas} = ${cap} under the base fee ${base}`);
    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;
    const maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas;
    // the simulation is the transaction as it will be signed: at pending, from the sender, with its gas and fee fields
    // (a call that reverts only at a real gas price is caught here, not paid for on chain)
    try {
      await a("eth_call", [{ ...call, gas: tag(gas), maxFeePerGas: tag(maxFeePerGas), maxPriorityFeePerGas: tag(maxPriorityFeePerGas) }, "pending"]);
    } catch (e) {
      return failedInExecution(e) ? no(422, "simulation_failed", String((e as Error).message).slice(0, 200)) : unread(e);
    }
    const nonce = nonceFor(withdrawLane, pending);
    const { raw, hash } = signEvmTx({ chainId: id, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to: pool, data: bytes }, cfg.senderKey);
    const sent = await Promise.allSettled([a("eth_sendRawTransaction", [`0x${hex(raw)}`]), b("eth_sendRawTransaction", [`0x${hex(raw)}`])]);
    const why = sent.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
    if (why.length === sent.length) return unread(why.find((e) => throttleOf(e, true) > 0) ?? why[0]);
    const until = Number(w.deadlineMs) + EVM_POOL_SEND_MARGIN_MS;
    sentAt(withdrawLane, nonce, until, maxFeePerGas, maxPriorityFeePerGas);
    watch(withdrawLane, nonce, hash, until);
    return { status: 200, body: { hash } };
  }
  /** POST /v1/pool/evm/sell: the static checks, none of which reads a provider, then one send per (W, Sell nonce). */
  const sellHeld = async (body: unknown, client: string | undefined): Promise<PoolEvmAnswer> => {
    if (cfg.sellKey === undefined || sellSender === null) return no(503, "not_configured", `no sell key is set for ${cfg.network}`);
    const sellKey = cfg.sellKey;
    if (typeof body !== "object" || body === null || Array.isArray(body) || !sameKeys(body, SELL_KEYS)) return no(400, "bad_shape");
    const { pool: p, w: wIn, data, authorization: au } = body as Record<string, unknown>;
    if (p !== pool || typeof wIn !== "string" || !ANY_ADDRESS.test(wIn) || typeof data !== "string" || data.length > 2 + 2 * EVM_SELL_DATA_MAX || !HEX.test(data)) return no(400, "bad_shape");
    if (typeof au !== "object" || au === null || Array.isArray(au) || !sameKeys(au, AUTH_KEYS)) return no(400, "bad_shape");
    const { chainId: ac, address: aa, nonce: an, yParity: ay, r: ar, s: as } = au as Record<string, unknown>;
    if (![ac, an, ay].every((x) => typeof x === "string" && QUANTITY.test(x)) || typeof aa !== "string" || !ANY_ADDRESS.test(aa) || ![ar, as].every((x) => typeof x === "string" && WORD32.test(x))) return no(400, "bad_shape");
    const auth: EvmAuthorization = { chainId: BigInt(ac as string), address: aa.toLowerCase(), nonce: BigInt(an as string), yParity: BigInt(ay as string), r: BigInt(ar as string), s: BigInt(as as string) };
    const w = wIn.toLowerCase();
    const bytes = unhex(data.slice(2));
    let s: EvmSell;
    try {
      s = evmReadSell(bytes);
    } catch (e) {
      return no(400, "bad_shape", (e as Error).message);
    }
    if (s.pool !== pool) return no(422, "not_pool");
    if (s.fee > s.feeCap) return no(422, "fee_over_cap", `fee ${s.fee}, cap ${s.feeCap}`);
    if (s.feeCap >= s.minOut) return no(422, "fee_over_cap", `feeCap ${s.feeCap} is not under minOut ${s.minOut}`);
    // W's authorization: of the kit's pinned delegate, on this chain's own id, in its one low-s form, signed by W
    const bad = (d: string) => no(422, "bad_authorization", d);
    if (sellChain === undefined || sellVenue === undefined || sellDelegate === undefined) return bad(`no sell delegate is pinned for ${cfg.network}`);
    if (auth.chainId === 0n || auth.chainId !== BigInt(sellVenue.chainId)) return bad(`chainId ${auth.chainId}, not ${sellVenue.chainId}`);
    if (auth.address !== sellDelegate) return bad(`address ${auth.address}, not the pinned delegate ${sellDelegate}`);
    if (auth.yParity > 1n) return bad(`yParity ${auth.yParity}`);
    if (auth.r === 0n || auth.r >= N || auth.s === 0n || auth.s > N / 2n) return bad("r or s out of range, or s high");
    if (auth.nonce >= (1n << 64n) - 1n) return bad(`nonce ${auth.nonce} is not under 2^64 - 1`);
    const authDigest = keccak_256(Uint8Array.from([5, ...rlp([big(auth.chainId), unhex(auth.address.slice(2)), big(auth.nonce)])]));
    const authority = recoverAddress(authDigest, Number(auth.yParity), auth.r, auth.s);
    if (authority !== w) return bad(`signed by ${authority ?? "no key"}, not W`);
    // W's Sell signature over SellDelegate's own digest, as its _signer reads it: r ‖ s ‖ v, s low, v 27 or 28
    const sig = s.signature;
    const [r, sv, v] = [BigInt(`0x${hex(sig.subarray(0, 32))}`), BigInt(`0x${hex(sig.subarray(32, 64))}`), sig[64]!];
    if ((v !== 27 && v !== 28) || r === 0n || r >= N || sv === 0n || sv > N / 2n) return no(422, "bad_signature", "v not 27 or 28, or r or s out of range, or s high");
    const signer = recoverAddress(evmSellDigest(BigInt(sellVenue.chainId), w, s), v - 27, r, sv);
    if (signer !== w) return no(422, "bad_signature", `signed by ${signer ?? "no key"}, not W`);
    // the sale's call: only the PoolManager or a listed router, along a route the kit's sell builder makes for this
    // Sell, byte for byte (the kit's evmSellRouteOf, the one definition): the sell sender pays the gas of whatever W signs
    try {
      evmSellRouteOf(sellChain, { w, token: s.token, amount: s.amount, minOut: s.minOut, target: s.target, data: s.data });
    } catch (e) {
      return no(422, "bad_route", String((e as Error).message).slice(0, 200));
    }
    // the deadline is unix seconds: at least the send margin away, at most the kit's longest sell
    const t = BigInt(Math.floor(now()));
    if (s.deadline * 1000n < t + BigInt(EVM_POOL_SEND_MARGIN_MS)) return no(422, "deadline_near", `deadline ${s.deadline} s, now ${t} ms`);
    if (s.deadline * 1000n > t + BigInt(EVM_POOL_SELL_DEADLINE_MAX_S) * 1000n) return no(422, "deadline_far", `deadline ${s.deadline} s, now ${t} ms`);
    // the unpaid-gas caps, before any read: a W, client or token already at its cap, or the budget spent, waits
    const keys = sellKeys(w, client, s.token);
    const capped = overCap(keys, 1n);
    if (capped !== null) return capped;
    // once per (W, Sell nonce): a repeat gets the first hash, unless that sale reverted, or was dropped past its
    // deadline, on the providers' own reads: then (W, nonce) is free for a new send, held only by the unpaid caps above
    const key = `${w}:${s.nonce}`;
    const prior = sells.get(key);
    if (prior) {
      const first = await prior;
      const hash = (first.body as { hash?: string }).hash;
      if (hash === undefined || !(await sellEnded(hash, sellDeadline.get(prior) ?? 0n))) return first;
      if (sells.get(key) === prior) sells.forget(key, prior);
    }
    const entry = sells.run(key, () => enqueue(sellLane, () => sellSend(w, data, bytes, s, auth, sellChain, sellVenue, sellDelegate, sellKey, sellSender, keys)));
    if (!sellDeadline.has(entry)) sellDeadline.set(entry, s.deadline);
    return entry;
  };
  /** True when the sale `hash` ended without landing: a receipt with status 0 on either provider, or no transaction on
   *  either once now is past the Sell's deadline plus EVM_SELL_DROP_MARGIN_MS. A read that fails, a success or a sale
   *  still waiting: false. */
  async function sellEnded(hash: string, deadlineS: bigint): Promise<boolean> {
    const rc = await Promise.allSettled([a("eth_getTransactionReceipt", [hash]), b("eth_getTransactionReceipt", [hash])]);
    const status = rc.map((x) => (x.status === "fulfilled" && x.value !== null && typeof x.value === "object" ? evmRpcHex((x.value as { status?: unknown }).status) : undefined));
    if (status.includes("0x1")) return false;
    if (status.includes("0x0")) return true;
    if (rc.some((x) => x.status === "rejected" || x.value !== null)) return false;
    if (BigInt(Math.floor(now())) <= deadlineS * 1000n + BigInt(EVM_SELL_DROP_MARGIN_MS)) return false;
    const tx = await Promise.allSettled([a("eth_getTransactionByHash", [hash]), b("eth_getTransactionByHash", [hash])]);
    return tx.every((x) => x.status === "fulfilled" && x.value === null);
  }
  const higher = (x: bigint, y: bigint) => (x > y ? x : y);
  /**
   * The nonce a lane's next send takes, from its sender's pending count on both providers, the higher (card
   * helper-evm-sender fold 2: no nonce is left that no tx holds): the count when it is at or past the lane's next nonce;
   * below it, the count's own nonce once the lane's send there is older than EVM_SELL_DROP_MARGIN_MS (no provider holds a
   * tx at it: it was dropped), else the next nonce (a send that young may not have reached the providers yet).
   */
  const nonceFor = (lane: Lane, pending: bigint): bigint => {
    if (pending >= lane.nextNonce) return pending;
    const at = lane.sent.get(pending)?.at;
    return at === undefined || now() - at > EVM_SELL_DROP_MARGIN_MS ? pending : lane.nextNonce;
  };
  /** A send at `nonce` that a provider took: the lane's next nonce past it, and its record. */
  const sentAt = (lane: Lane, nonce: bigint, stuckAfter: number, maxFee: bigint, tip: bigint): void => {
    if (nonce + 1n > lane.nextNonce) lane.nextNonce = nonce + 1n;
    lane.sent.set(nonce, { at: now(), stuckAfter, maxFee, tip });
    while (lane.sent.size > revertMemory) lane.sent.delete(lane.sent.keys().next().value as bigint);
  };
  /** One tend of the lane, queued behind its sends; a tend already queued answers every ask until it runs. */
  const tend = (lane: Lane): void => {
    if (lane.tending || lane.key === undefined) return;
    lane.tending = true;
    lane.queue = lane.queue
      .then(() => tendNow(lane))
      .catch(() => {})
      .finally(() => {
        lane.tending = false;
      });
  };
  /**
   * The lane's stuck sends and its hole, on both providers' counts, the higher of each: every one of its sends not mined
   * (the latest count at or below its nonce) past its deadline plus the margin, and the lowest nonce no tx holds (the
   * pending count below the lane's next nonce, the lane's send there older than the margin, no send waiting to take it),
   * is sent again as a 0-value transfer to the sender itself: its tip and maxFeePerGas each over the send's at that nonce
   * by more than a tenth (a node replaces a pending tx only so), maxFeePerGas at least 2 x the base fee + the tip, its gas
   * the providers' higher estimate + a fifth (on Robinhood the estimate holds the L1 poster's gas).
   */
  async function tendNow(lane: Lane): Promise<void> {
    const key = lane.key!;
    const [pa, la, pb, lb] = await Promise.all([a, b].flatMap((r) => ["pending", "latest"].map(async (at) => qty(await r("eth_getTransactionCount", [lane.from, at])))));
    const pending = higher(pa!, pb!);
    const mined = higher(la!, lb!);
    for (const n of [...lane.sent.keys()]) if (n < mined) lane.sent.delete(n);
    const t = now();
    const at = new Set<bigint>();
    const hole = lane.sent.get(pending);
    if (pending < lane.nextNonce && lane.waiting === 0 && (hole === undefined || t - hole.at > EVM_SELL_DROP_MARGIN_MS)) at.add(pending);
    for (const [n, x] of lane.sent) if (t > x.stuckAfter) at.add(n);
    if (at.size === 0) return;
    const id = await chain();
    const self = { from: lane.from, to: lane.from, value: "0x0" };
    const [ba, bb, ta, tb, ga, gb] = await Promise.all([a("eth_getBlockByNumber", ["latest", false]), b("eth_getBlockByNumber", ["latest", false]), a("eth_maxPriorityFeePerGas", []), b("eth_maxPriorityFeePerGas", []), a("eth_estimateGas", [self, "pending"]), b("eth_estimateGas", [self, "pending"])]);
    const base = higher(qty((ba as { baseFeePerGas?: unknown } | null)?.baseFeePerGas), qty((bb as { baseFeePerGas?: unknown } | null)?.baseFeePerGas));
    const tipNow = higher(qty(ta), qty(tb));
    const gas = (higher(qty(ga), qty(gb)) * 12n) / 10n;
    const raise = (v: bigint) => (v * 11n) / 10n + 1n;
    for (const n of [...at].sort((x, y) => (x < y ? -1 : 1))) {
      const old = lane.sent.get(n);
      const tip = old === undefined ? tipNow : higher(tipNow, raise(old.tip));
      const maxFee = higher(2n * base + tip, old === undefined ? 0n : raise(old.maxFee));
      const { raw, hash } = signEvmTx({ chainId: id, nonce: n, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gas, to: lane.from, data: new Uint8Array() }, key);
      const sent = await Promise.allSettled([a("eth_sendRawTransaction", [`0x${hex(raw)}`]), b("eth_sendRawTransaction", [`0x${hex(raw)}`])]);
      if (sent.every((x) => x.status === "rejected")) continue;
      const until = now() + EVM_SELL_DROP_MARGIN_MS;
      sentAt(lane, n, until, maxFee, tip);
      watch(lane, n, hash, until);
    }
  }
  /**
   * Reads a lane's send's receipt on both providers in the background, first after cfg.receiptPollMs
   * (EVM_SELL_RECEIPT_POLL_MS), the wait doubling to EVM_RECEIPT_POLL_BACKOFF times it, until `until`. A receipt ends it
   * (`landed` reads it) and drops the send's record; a send unmined past the margin has its lane tended at each read
   * (a hole behind it is filled), and one still unmined at `until` once more (it is replaced).
   */
  function watch(lane: Lane, nonce: bigint, hash: string, until: number, landed?: (r: Record<string, unknown>) => void): void {
    const first = cfg.receiptPollMs ?? EVM_SELL_RECEIPT_POLL_MS;
    const sent = now();
    let every = first;
    const tick = async (): Promise<void> => {
      const rc = await Promise.allSettled([a("eth_getTransactionReceipt", [hash]), b("eth_getTransactionReceipt", [hash])]);
      const got = rc.flatMap((x) => (x.status === "fulfilled" && x.value !== null && typeof x.value === "object" ? [x.value as Record<string, unknown>] : []));
      if (got.length > 0) {
        lane.sent.delete(nonce);
        landed?.(got.find((x) => evmRpcHex(x.status) === "0x0") ?? got[0]!);
        return;
      }
      if (now() > until) return tend(lane);
      if (now() - sent > EVM_SELL_DROP_MARGIN_MS) tend(lane);
      every = Math.min(every * 2, first * EVM_RECEIPT_POLL_BACKOFF);
      setTimeout(() => void tick(), every).unref?.();
    };
    setTimeout(() => void tick(), every).unref?.();
  }
  /** A sale's receipt turns its held worst cost into what went unpaid: all of its cost on a revert, its cost less the fee
   *  on a sale that paid less, else 0, and a sale that landed and paid marks its W and client. A sale never seen landed
   *  keeps its worst cost held for the window. */
  const landedSale = (held: Charge, fee: bigint, keys: readonly string[]) => (r: Record<string, unknown>): void => {
    let cost: bigint;
    try {
      cost = qty(r.gasUsed) * qty(r.effectiveGasPrice) + (r.l1Fee === undefined || r.l1Fee === null ? 0n : qty(r.l1Fee));
    } catch {
      cost = held.wei; // a receipt whose cost cannot be read: the worst stays held
    }
    const ok = evmRpcHex(r.status) === "0x1";
    held.wei = ok ? (cost > fee ? cost - fee : 0n) : cost;
    if (!ok || cost > fee) return;
    for (const k of keys) {
      if (!k.startsWith("w:") && !k.startsWith("c:")) continue;
      paid.delete(k);
      paid.set(k, now());
    }
    while (paid.size > revertMemory) paid.delete(paid.keys().next().value as string);
  };
  async function sellSend(w: string, data: string, bytes: Uint8Array, s: EvmSell, auth: EvmAuthorization, kitChain: EvmPoolChain, venue: EvmPoolVenue, delegate: string, key: Uint8Array, from: string, keys: readonly string[]): Promise<PoolEvmAnswer> {
    // the deadline again after the queue's wait
    if (s.deadline * 1000n < BigInt(Math.floor(now())) + BigInt(EVM_POOL_SEND_MARGIN_MS)) return no(422, "deadline_near", `deadline ${s.deadline} s, now ${now()} ms after the queue`);
    const gas = EVM_POOL_SELL_GAS;
    const tip = evmPoolSellTip(kitChain);
    let id: bigint, base: bigint, baseLow: bigint, pending: bigint;
    try {
      id = await chain();
      if (id !== BigInt(venue.chainId)) return no(503, "upstream", `the providers name chain ${id}, not ${venue.chainId}`);
      const [ba, bb, wa, wb, n, m] = await Promise.all([a("eth_getBlockByNumber", ["latest", false]), b("eth_getBlockByNumber", ["latest", false]), a("eth_getTransactionCount", [w, "pending"]), b("eth_getTransactionCount", [w, "pending"]), a("eth_getTransactionCount", [from, "pending"]), b("eth_getTransactionCount", [from, "pending"])]);
      const [x, y] = [qty((ba as { baseFeePerGas?: unknown } | null)?.baseFeePerGas), qty((bb as { baseFeePerGas?: unknown } | null)?.baseFeePerGas)];
      base = x > y ? x : y;
      baseLow = x < y ? x : y;
      const [na, nb] = [qty(wa), qty(wb)];
      if (na !== auth.nonce || nb !== auth.nonce) return no(422, "auth_nonce", `W's pending nonce ${na} and ${nb}, the authorization's ${auth.nonce}`);
      pending = higher(qty(n), qty(m));
    } catch (e) {
      return unread(e);
    }
    const nonce = nonceFor(sellLane, pending);
    const txAt = (maxFeePerGas: bigint): EvmTx4 => ({ chainId: id, nonce, maxPriorityFeePerGas: tip, maxFeePerGas, gas, to: w, data: bytes, authorizations: [auth] });
    // the chain fee (the kit's one definition, pool-fee.ts), for the longest this transaction can be (maxFeePerGas at
    // most fee / gas), on each provider, the higher of the two
    let l1: bigint;
    const txBytes = BigInt(evmTx4MaxLength(txAt(s.fee / gas)));
    try {
      const reads = evmPoolChainFeeReads(kitChain, gas, txBytes);
      const fees = await Promise.all([a, b].map(async (r) => {
        const words = await Promise.all(reads.map(async (at) => {
          const h = evmRpcHex(await r("eth_call", [at, "latest"]));
          if (h === null || !/^0x[0-9a-f]{64}$/.test(h)) throw new Error("not a word");
          return BigInt(h);
        }));
        return evmPoolChainFee(kitChain, txBytes, words);
      }));
      l1 = fees[0]! > fees[1]! ? fees[0]! : fees[1]!;
    } catch (e) {
      return unread(e);
    }
    // Arbitrum charges the poster fee as gas inside the limit, at the block's base fee: the lower of the two providers'
    // gives the most gas it can take; what is left after it and the authorization's intrinsic gas runs the sale
    const posterGas = POSTER_GAS_CHAINS.has(kitChain) && l1 > 0n ? (baseLow > 0n ? (l1 + baseLow - 1n) / baseLow : gas) : 0n;
    if (posterGas >= gas - EVM_7702_AUTH_GAS) return no(422, "simulation_failed", `the L1 poster fee ${l1} takes ${posterGas} gas of the ${gas - EVM_7702_AUTH_GAS} the sale has`);
    const need = gas * (base + tip) + l1;
    if (s.fee < need) return no(422, "fee_low", `fee ${s.fee}, need ${gas} x (${base} + ${tip}) + ${l1} = ${need}`);
    const cap = (s.fee - l1) / gas;
    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;
    if (maxFeePerGas < base + tip) return no(422, "fee_low", `maxFeePerGas ${maxFeePerGas} under ${base} + ${tip}`);
    // the caps again with this sale's worst cost held
    const worst = gas * maxFeePerGas + l1;
    const capped = overCap(keys, worst);
    if (capped !== null) return capped;
    // the simulation: the transaction as it will be signed, W's code its delegation designator (the authorization's
    // effect), its gas less the authorization's intrinsic gas, which an eth_call does not charge, and the poster's gas
    try {
      await a("eth_call", [{ from, to: w, data, gas: tag(gas - EVM_7702_AUTH_GAS - posterGas), maxFeePerGas: tag(maxFeePerGas), maxPriorityFeePerGas: tag(tip) }, "pending", { [w]: { code: `0xef0100${delegate.slice(2)}` } }]);
    } catch (e) {
      return failedInExecution(e) ? no(422, "simulation_failed", String((e as Error).message).slice(0, 200)) : unread(e);
    }
    const { raw, hash } = signEvmTx4(txAt(maxFeePerGas), key);
    const sent = await Promise.allSettled([a("eth_sendRawTransaction", [`0x${hex(raw)}`]), b("eth_sendRawTransaction", [`0x${hex(raw)}`])]);
    const why = sent.flatMap((x) => (x.status === "rejected" ? [x.reason as unknown] : []));
    if (why.length === sent.length) return unread(why.find((e) => throttleOf(e, true) > 0) ?? why[0]);
    const until = Number(s.deadline) * 1000 + EVM_POOL_SEND_MARGIN_MS;
    sentAt(sellLane, nonce, until, maxFeePerGas, tip);
    watch(sellLane, nonce, hash, until, landedSale(charge(keys, worst), s.fee, keys));
    return { status: 200, body: { hash } };
  }
  return {
    network: cfg.network,
    pool,
    sender,
    sellSender,
    async fee(atMs) {
      const epoch = epochStartOf(atMs);
      // an epoch no carry would take (older than a proof's life or later than now) is read nowhere (M356 (3))
      const t = now();
      if (epoch > t || epoch < t - POOL_LIFE_MAX_MS) return null;
      const f = await feeOf(epoch);
      if (f === null) return null;
      return { chain: "evm", network: cfg.network, pool, fee_recipient: feeRecipient, sell_sender: sellSender, epoch_ms: POOL_EPOCH_MS, epoch_start_ms: epoch, block: tag(f.block.number), fee: f.fee.toString(), step: EVM_FEE_STEP.toString() };
    },
    carry,
    sell,
  };
}

/** Per network: the pool, the sender's key (0x + 64 hex, gas only), the fee's floor (wei), its recipient, two RPC URLs. */
export const POOL_EVM_ENV = {
  base: ["POOL_EVM_ADDRESS_BASE", "POOL_EVM_SENDER_KEY_BASE", "POOL_EVM_FEE_BASE", "POOL_EVM_FEE_RECIPIENT_BASE", "POOL_EVM_RPCS_BASE"],
  robinhood: ["POOL_EVM_ADDRESS_ROBINHOOD", "POOL_EVM_SENDER_KEY_ROBINHOOD", "POOL_EVM_FEE_ROBINHOOD", "POOL_EVM_FEE_RECIPIENT_ROBINHOOD", "POOL_EVM_RPCS_ROBINHOOD"],
  "base-sepolia": ["POOL_EVM_ADDRESS_BASE_SEPOLIA", "POOL_EVM_SENDER_KEY_BASE_SEPOLIA", "POOL_EVM_FEE_BASE_SEPOLIA", "POOL_EVM_FEE_RECIPIENT_BASE_SEPOLIA", "POOL_EVM_RPCS_BASE_SEPOLIA"],
  "robinhood-testnet": ["POOL_EVM_ADDRESS_ROBINHOOD_TESTNET", "POOL_EVM_SENDER_KEY_ROBINHOOD_TESTNET", "POOL_EVM_FEE_ROBINHOOD_TESTNET", "POOL_EVM_FEE_RECIPIENT_ROBINHOOD_TESTNET", "POOL_EVM_RPCS_ROBINHOOD_TESTNET"],
} as const;

/**
 * Per network: the sell sender's key (0x + 64 hex, gas only), apart from the withdraw sender's so a sale's unpaid gas
 * never drains the key that carries withdraws. Unset: that network's sells answer 503 not_configured.
 */
export const POOL_EVM_SELL_ENV = {
  base: "POOL_EVM_SELL_KEY_BASE",
  robinhood: "POOL_EVM_SELL_KEY_ROBINHOOD",
  "base-sepolia": "POOL_EVM_SELL_KEY_BASE_SEPOLIA",
  "robinhood-testnet": "POOL_EVM_SELL_KEY_ROBINHOOD_TESTNET",
} as const;

/**
 * The EVM pool senders the host's environment sets, by pool address; a network with none of its names set is off (a
 * sell key set alone is refused). A network whose venue in the kit (`venues`, the kit's own list) pins a sell sender
 * starts only with that sell key: the device sims each sale as sent from the pin (the kit's checks/evm/quote.ts
 * simmedSells), so a sale from any other key would run where the sim did not. With no sell key, or on a chain whose venue
 * pins no sell sender (the sell key is then not used), the network starts and refuses every sell (503 not_configured).
 */
export function evmPoolSendersFromEnv(env: Record<string, string | undefined>, venues: Readonly<Partial<Record<string, EvmPoolVenue>>> = evmPoolVenues()): Map<string, EvmPoolSender> {
  const out = new Map<string, EvmPoolSender>();
  for (const [network, names] of Object.entries(POOL_EVM_ENV)) {
    const [pool, key, fee, feeTo, rpcs] = names.map((n) => env[n] ?? "");
    const sellName = POOL_EVM_SELL_ENV[network as keyof typeof POOL_EVM_SELL_ENV];
    const sellKey = env[sellName] ?? "";
    if (pool === "" && key === "" && fee === "" && feeTo === "" && rpcs === "") {
      if (sellKey !== "") throw new Error(`${sellName} is set but ${network}'s pool is not`);
      continue;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool!)) throw new Error(`${names[0]} must be an address`);
    if (!/^0x[0-9a-f]{64}$/.test(key!)) throw new Error(`${names[1]} must be 0x and 64 lowercase hex`);
    if (sellKey !== "" && !/^0x[0-9a-f]{64}$/.test(sellKey)) throw new Error(`${sellName} must be 0x and 64 lowercase hex`);
    if (sellKey !== "" && sellKey === key) throw new Error(`${sellName} must not be ${names[1]}: sells have their own key`);
    if (!/^[1-9][0-9]{0,37}$/.test(fee!)) throw new Error(`${names[2]} must be a whole number of wei`);
    const urls = rpcs!.split(",");
    if (urls.length !== 2 || urls[0] === urls[1]) throw new Error(`${names[4]} must be two different RPC URLs`);
    const providers = urls.map((u) => solanaJsonRpc(u)) as unknown as [EvmRpc, EvmRpc]; // a plain JSON-RPC client
    const v = Object.hasOwn(venues, network) ? venues[network] : undefined;
    const pin = v !== undefined && Object.hasOwn(v, "sellSender") ? v.sellSender : undefined;
    // sales go only from the pin: a chain with none starts with sales off, never with an unpinned key
    const sells = sellKey !== "" && pin !== undefined;
    const s = evmPoolSender({ network, pool: pool!, senderKey: unhex(key!.slice(2)), ...(sells ? { sellKey: unhex(sellKey.slice(2)) } : {}), floor: BigInt(fee!), ...(feeTo === "" ? {} : { feeRecipient: feeTo! }), venues }, providers);
    if (pin !== undefined && s.sellSender !== null && pin.toLowerCase() !== s.sellSender) throw new Error(`${sellName} is not the key of the kit's pinned sell sender for ${network} (${pin})`);
    out.set(s.pool, s);
  }
  return out;
}
