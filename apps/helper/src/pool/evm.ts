// POST /v1/pool/evm/send (card helper-pool-senders; v2 M3; card helper-evm-sender-2): the helper's EVM sender carries a
// pool withdraw or buy the device built and W signed, byte for byte as its calldata, or refuses it. The sender is an operating key holding only gas, read from the
// host's environment; it signs one EIP-1559 transaction to the pool with value 0 and exactly the calldata received, and
// takes only the fee the proof's context caps, paid to the release's fee recipient.
//
// The body: { "pool": "0x<the pool>", "data": "0x<calldata>", "epoch": <the start, ms, of the epoch whose fee the
// proof binds> }. Checks, each a refusal before any send (422 unless named):
//   bad_shape        not withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes),
//                    PrivacyPool.withdraw(Withdrawal, WithdrawProof, fee, W's signature), nor buy((address,bytes),
//                    (uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes),
//                    PrivacyPoolSimple.buy(Withdrawal, WithdrawProof, fee, Buy, W's signature), as the pool compiles
//                    them (contracts/pool-evm/abi.json, card helper-evm-abi-tie), in its one canonical ABI encoding
//                    (every offset, length and padding as the encoder writes them, a 65-byte signature, nothing after),
//                    or over EVM_BODY_DATA_MAX (400);
//   not_pool         the withdrawal's processooor is not the pool the body names, which this helper carries;
//   fee_recipient    the request pays the fee to anyone but this release's fee recipient;
//   not_configured (503) the kit pins no chain id for the network (evmPoolVenues): every release, nothing read;
//   bad_signature    W's signature does not recover to the request's recipient over the pool's own EIP-712 digest of
//                    exactly this release (evmReleaseDigest: domain Blindfill, 1, the network's pinned chain id, the
//                    pool; Withdraw(uint256 nullifier,uint256 context,uint256 value), or Buy(address adapter,bytes data,
//                    uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value) with the proof's
//                    pubSignals 1, 7 and 2; M354, M357), or its v is not 27 or 28, r or s is 0 or not under n, or s is
//                    over n / 2 (the pool's HALF_N); checked before any RPC call, so a forged or replayed release, or
//                    one W signed for another value, nullifier, context, chain, pool or method, costs no read;
//   bad_route        a buy's adapter is not one of the kit's pinned adapters for the network, or its data is not the
//                    bytes the kit's builder makes for the route it reads as (the kit's evmBuyRouteOf, the one
//                    definition, as a sale's evmSellRouteOf: decoded, encoded again as the device builds every buy,
//                    byte for byte, buying the Buy's token); before any RPC call (the adapter runs whatever code it
//                    holds, at the sender's gas);
//   epoch_off        the epoch is not inside the proof's life (deadlineMs - POOL_LIFE_MAX_MS up to the deadline), is
//                    outside [now - POOL_LIFE_MAX_MS, now], or the chain has no block in it yet;
//   deadline_near    the deadline is under now + EVM_POOL_SEND_MARGIN_MS (these first checks make no RPC call);
//   reverted         this nullifier's send by this method in this epoch reverted on chain: it is never sent again by
//                    that method in this epoch (M356 (1)); the same proof by the other method (a withdraw after its buy
//                    missed minOut) and a new proof in a later epoch are each their own send;
//   fee_off          the fee is not the fee this helper publishes for that epoch: the kit's evmPoolFee (trade/evm/
//                    pool-fee.ts, the device's own rule) at the epoch's first block, with G at the pool's tree depth
//                    there and the chain fee there, each read at that block's hash on both providers;
//   fee_over_cap     the fee is over the request's feeCap (the pool refuses it too: FeeOverCap);
//   recipient_code   the recipient holds code on either provider at pending or latest (an EIP-7702 delegation,
//                    0xef0100..., too): a contract could revert the pool's push after the simulation;
//   simulation_failed eth_estimateGas or eth_call of the exact transaction at "pending", from the sender with the gas,
//                    maxFeePerGas and maxPriorityFeePerGas the send then signs, fails in execution, or its gas is over
//                    EVM_GAS_MAX; or, for a buy, its eth_call answers anything but true (its swap would fail, and the
//                    pool would take the fee and pay W ETH: card pool-evm-buy-pays-revert);
//   fee_stale        the fee's cap per gas (fee / gas limit) is under the current base fee: it could not be mined, so
//                    the device re-proves at a newer epoch's fee (M356 (2));
//   rate_limited (429) EVM_QUEUE_MAX sends are already waiting (Retry-After EVM_BUSY_RETRY_S; card helper-abuse-limits:
//                    the helper's own budget is a wait, never a 503); or a provider throttled a read or the send (its
//                    HTTP 429, a rate-limit error, EIP-1474's -32005; Retry-After 1, limits.ts throttleOf);
//   rate_limited (429) for a buy: the unpaid gas held against its W, the client, its token (each
//                    EVM_SELL_UNPAID_CAP_WEI, shared with the sales) or the withdraw sender's whole buy budget
//                    (EVM_SELL_UNPAID_BUDGET_WEI) in EVM_SELL_UNPAID_WINDOW_MS would pass its cap, before any read and
//                    again with this buy's worst cost, Retry-After until the oldest leaves it (a key holding nothing
//                    takes one buy whatever its worst); a repeat of a release already sent gets its first hash, never
//                    this; or the sender's lower pending balance on the two providers, less the buys in flight at
//                    their worst and this one's, would fall under the withdraws' reserve (EVM_WITHDRAW_RESERVE_SENDS x
//                    EVM_GAS_MAX x (2 x base + tip)), Retry-After EVM_LANE_RETRY_S; withdraws are never held by these;
//   in_flight (429)  this client already holds EVM_IN_FLIGHT_MAX requests open (M374 (5) on this route too: one client
//                    cannot fill the shared queue); Retry-After EVM_BUSY_RETRY_S;
//   upstream (503)   a read could not be made (a transport error, an HTTP status but 429, another JSON-RPC error),
//                    or the two providers name different chains, or a chain other than the network's pinned one
//                    (M356 (6)): the send is signed only for the chain W signed for.
// A nullifier is sent once (./once.ts): a repeat gets the first hash and sends nothing; a repeat after that send
// reverted by the same method is refused as reverted. Each send's maxFeePerGas is at most fee / gas limit, so the
// sender never pays more gas than the fee. A withdraw the helper accepts lands or fails in the simulation (the recipient
// holds no code); a buy can still revert on chain after its simulation passed (its adapter's swap misses minOut once
// the price moves), and then the sender pays its gas and gets no fee: so a buy's worst cost (gas x maxFeePerGas) is held
// against its caps from the send, and its receipts, read in the background on both providers, release it only when both
// read status 1 and each carries the pool's Bought log of this buy (from the pool, recipient W, this fee recipient,
// fee, nullifier and token), to its cost less the fee, at least 0; any other receipt pair is charged its whole cost
// (evmBuyUnpaid), and a proven buy marks its W and client as a paid sale does.
// Answer: 200 { hash }. A buy runs every rule a withdraw does, on the same lane and once key (one proof serves either
// method, and W's signature picks which; one send in flight per nullifier).
//
// POST /v1/pool/evm/sell (card helper-evm-sender): W's sell of its token back into the pool. W holds no ETH and sends
// nothing: the device sends W's EIP-712 Sell inside SellDelegate.sell's calldata and W's EIP-7702 authorization of the
// kit's pinned SellDelegate, and the sender sends ONE type-4 transaction to W carrying both, as the device's reference
// sell that landed on both testnets does (contracts/pool-evm/script/testnet-run.mjs sellOf, testnet-run-lib.mjs
// signTx7702). SellDelegate pays `fee` (at most Sell.feeCap) to Sell.feeRecipient, never to msg.sender (pool review
// round 3, L-1), and deposits the rest; the sender sends only a Sell whose feeRecipient is this network's fee collector
// (card helper-sender-fee-proof: POOL_EVM_FEE_COLLECTOR_<NETWORK>, card evm-fee-collector's keyless FeeCollector,
// whose receive() emits Paid(from, value) and forwards it to the sell sender), so a sale's fee is proven by a log only a
// real payment makes, and the sender's gas comes back through it.
// The body: { "pool", "w", "data", "authorization": { chainId, address, nonce, yParity, r, s } }, hex strings as
// testnet-run-lib.mjs authJson writes them. Checks, each a refusal before any send (422 unless named), every static one
// before any RPC call:
//   bad_shape        a body of any other key or shape, or data not sell((address,uint256,address,bytes,uint256,address,
//                    uint256,uint256,address,uint256,uint256),uint256,bytes) in its one canonical ABI encoding (every offset,
//                    length and padding as the encoder writes them, a 65-byte signature, nothing after), or over
//                    EVM_SELL_DATA_MAX (2,048 bytes);
//   not_pool         the Sell's pool is not this sender's;
//   fee_recipient    the Sell pays its fee to anyone but this network's fee collector;
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
//   not_configured (503) no sell key is set for the network (POOL_EVM_SELL_KEY_<NETWORK>), or no fee collector
//                    (POOL_EVM_FEE_COLLECTOR_<NETWORK>): every sell, nothing read;
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
//                    leaves it (a cap holding nothing takes one sale whatever its worst, which a gas spike can lift past
//                    the cap: one such sale per empty key); a caller (W or client) whose own sale landed and paid in the
//                    window is held by its own W and client caps and the budget, never by the token's, so unpaid gas
//                    never passes the budget by more than one sale.
//                    Withdraws are never held by these; buys are, by the same W, client and token caps and their own
//                    budget (above);
//   in_flight (429)  as the withdraw: one held limit per client across both routes.
// The send: from the sell sender's own key (never the withdraw sender's) on its own queue and nonce lane; gas exactly
// EVM_POOL_SELL_GAS and maxPriorityFeePerGas exactly the kit's evmPoolSellTip (pins the device's sim copies, never
// eth_estimateGas or eth_maxPriorityFeePerGas), maxFeePerGas min(2 x base + tip, (fee - the chain fee) / gas), so the
// sender's worst cost, gas x maxFeePerGas + the chain fee, is within the fee. That worst cost is held against
// the caps from the send; the sale's receipt, read in the background on both providers, turns it into what went
// unpaid (card helper-sender-fee-proof): a sale is proven only when both providers return its receipt with status 1
// and each carries the fee collector's Paid log, from the collector, `from` W and `value` at least the Sell's fee (the
// call to W runs whatever code W holds then: a status 1 alone proves nothing, and any log W's own code can emit, the
// pool's public Deposited among them, proves nothing either); a proven sale's unpaid is its cost (the higher of the
// two receipts' gasUsed x effectiveGasPrice + l1Fee) less the fee, at least 0; any other receipt pair is charged its whole cost; one provider's receipt alone changes
// nothing, so the worst stays held.
// Once per (W, Sell nonce): a repeat gets the first hash and sends nothing, unless that sale ended without landing on
// the providers' own reads (a receipt with status 0 on either, or once now is past its deadline plus
// EVM_SELL_DROP_MARGIN_MS no transaction on either): then (W, nonce) is free for a new send, as often as W's unpaid cap
// allows. A refused sell frees it at once.
// The nonce lanes (withdraw and sell alike): neither leaves a nonce no transaction holds, and no one provider moves a
// lane. Each send reads its sender's pending count on both providers: it goes at the lower count when that is at or past
// the lane's next nonce; it fills a hole, the higher count when that is below the lane's next nonce, only once the
// lane's send there (if any) is older than EVM_SELL_DROP_MARGIN_MS and neither provider returns it by hash; else at the
// next nonce. A nonce is mined once both latest counts pass it or either provider returns a receipt for any send the lane
// made at it (each record keeps its nonce's earlier hashes, a replaced send included).
// Each send's receipt is read in the background, from EVM_SELL_RECEIPT_POLL_MS doubling to 30 s, on both
// providers: every send still unmined past its deadline plus the margin is replaced once at its own nonce, lowest first,
// whatever its price, by a 0-value transfer to the sender itself (gas EVM_SELF_TRANSFER_GAS, with the L1 poster's gas
// on Robinhood), its fee fields raised a tenth over the send's and to at least 2 x base + tip, never over
// EVM_SELL_MAX_FEE_PER_GAS; a replacement is raised again only once 2 x base + tip passes its maxFeePerGas or the tip
// passes its own, and one neither provider returns is broadcast again as it was; a hole is filled the same way. Each
// nonce's watch ends at its bound (EVM_LANE_WATCH_MS) with one log line; while the lane's lowest unmined send is past
// it, new sends answer 503 with Retry-After, and each such answer, at most once per EVM_LANE_RETRY_S, tends the lane and
// reads again, so the lane goes on once the chain does: Retry-After is a second (EVM_LANE_SENT_RETRY_S) when that tend
// sent something, else a second within EVM_LANE_SENT_WINDOW_MS of that send, or the seconds to the next allowed
// tend; held answers share one hold read per block, a failed one included. A tend reads each stuck send's receipts and tx at most once per
// EVM_SELL_DROP_MARGIN_MS. A provider whose latest count stays below a nonce the lane sent for EVM_LANE_WATCH_MS is
// logged once, naming the provider and the nonce; one whose latest count is past the lane's next nonce, once as ahead.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  EVM_7702_AUTH_GAS,
  EVM_POOL_FEE_FLOOR,
  EVM_POOL_FEE_STEP,
  EVM_POOL_SELL_DEADLINE_MAX_S,
  EVM_POOL_SELL_GAS,
  EVM_POOL_TX_BYTES,
  evmPoolChainFee,
  evmPoolChainFeeReads,
  evmPoolFee,
  evmPoolGas,
  evmPoolSellTip,
  evmBuyRouteOf,
  evmPoolVenues,
  evmRpcOperator,
  evmSellRouteOf,
  solanaJsonRpc,
  type EvmPoolChain,
  type EvmPoolVenue,
} from "@blindfill/kit";
import { epochStartOf, POOL_EPOCH_MS } from "./fee.ts";
import { oncePerNullifier, POOL_SEND_MEMORY } from "./once.ts";
import { heldPerClient, RETRY_AFTER_MAX_S, throttleOf, type ProviderHolds } from "../limits/limits.ts";

/** POST /v1/pool/evm/send's body limit, and the calldata's: a withdraw is 4 + 32 x 32 = 1,028 bytes (WITHDRAW_LEN), a buy
 *  1,220 bytes plus its swap data padded; the most a release's calldata can be is the most whose signed transaction, at
 *  every field's longest, fits the kit's EVM_POOL_TX_BYTES (2,600), the bytes the epoch fee pays the chain fee for (a
 *  larger one would be sent at the sender's cost): 2,404 bytes (evm.test.ts holds it), which takes the kit's longest
 *  route with no hook data, 4 v4 hops, at 2,212. */
export const POOL_EVM_BODY_MAX = 8_192;
export const EVM_BODY_DATA_MAX = 2_404;
/** The most gas the helper pays for one withdraw: the measured Privacy Pools withdrawal is 611,391 (M349), so 2.5x [design]. */
export const EVM_GAS_MAX = 1_500_000n;

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const selectorOf = (sig: string): string => hex(keccak_256(new TextEncoder().encode(sig)).subarray(0, 4));
/** The pool's withdraw as it compiles (contracts/pool-evm/abi.json; contracts/pool-evm/test/abi-tie.test.mjs ties it). */
export const WITHDRAW_SIGNATURE = "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)";
export const WITHDRAW_SELECTOR = selectorOf(WITHDRAW_SIGNATURE);
/** The pool's buy as it compiles (PrivacyPoolSimple.buy: Withdrawal, WithdrawProof, fee, Buy, W's signature). */
export const BUY_SIGNATURE = "buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)";
export const BUY_SELECTOR = selectorOf(BUY_SIGNATURE);

const word = (d: Uint8Array, i: number): bigint => BigInt(`0x${hex(d.subarray(4 + 32 * i, 4 + 32 * (i + 1))) || "0"}`);
const HEAD_WORDS = 19; // the Withdrawal's offset, the proof's 16 words, the fee, the signature's offset
const BUY_HEAD_WORDS = 20; // the Withdrawal's offset, the proof's 16 words, the fee, the Buy's offset, the signature's offset
const RELAY_WORDS = 6; // recipient, feeRecipient, feeCap, deadlineMs, refundPrecommitment, salt
const W_WORDS = 3 + RELAY_WORDS; // processooor, the data's offset (64), its length (192), the data
const SIG_WORDS = 4; // its length (65), r, s, v and 31 zero bytes
const BUY_WORDS = 5; // adapter, the data's offset (128), minOut, token, the data's length; then the data, padded
const WITHDRAW_LEN = 4 + 32 * (HEAD_WORDS + W_WORDS + SIG_WORDS);
const BUY_LEN_MIN = 4 + 32 * (BUY_HEAD_WORDS + W_WORDS + BUY_WORDS + SIG_WORDS);
const isAddressWord = (w: bigint) => w >> 160n === 0n;
const addr = (w: bigint) => `0x${w.toString(16).padStart(40, "0")}`;

/** A release's calldata read back: the request, the fee, the proof's nullifier (hex, the send's once key), value and
 *  context (pubSignals 1, 2 and 7: ProofLib.sol), W's 65 signature bytes, and for a buy its Buy. */
export type EvmRelease = {
  method: "withdraw" | "buy";
  processooor: string; recipient: string; feeRecipient: string; feeCap: bigint; deadlineMs: bigint; fee: bigint;
  nullifier: string; value: bigint; context: bigint; signature: Uint8Array;
  buy?: { adapter: string; data: Uint8Array; minOut: bigint; token: string };
};
export type EvmWithdraw = EvmRelease;

/** The words a withdraw and a buy share, read from a head of `head` words: the Withdrawal's offset and its tail (exactly
 *  abi.encode(RelayData), as the pool's _relayData takes only 192 bytes), the fee, the proof's public values. */
function readRelease(d: Uint8Array, head: number, method: EvmRelease["method"], sigAt: number): EvmRelease {
  if (word(d, 0) !== BigInt(32 * head)) throw new Error("the withdrawal's offset");
  const processooor = word(d, head);
  if (!isAddressWord(processooor) || word(d, head + 1) !== 64n || word(d, head + 2) !== BigInt(32 * RELAY_WORDS)) throw new Error("the withdrawal's layout");
  const r = (i: number) => word(d, head + 3 + i);
  if (!isAddressWord(r(0)) || !isAddressWord(r(1)) || r(3) >> 64n !== 0n || (r(5) & ((1n << 128n) - 1n)) !== 0n) throw new Error("the relay data's padding");
  // the signature: 65 bytes, as the pool's _signer takes only 65; the rest of its last word zero
  if (word(d, sigAt) !== 65n || (word(d, sigAt + 3) & ((1n << 248n) - 1n)) !== 0n) throw new Error("the signature's layout");
  const at = 4 + 32 * (sigAt + 1);
  // the proof's pubSignals start at head word 9 (after pA 2, pB 4, pC 2): [1] the nullifier, [2] the value, [7] the context
  return {
    method, processooor: addr(processooor), recipient: addr(r(0)), feeRecipient: addr(r(1)), feeCap: r(2), deadlineMs: r(3), fee: word(d, 17),
    nullifier: word(d, 10).toString(16).padStart(64, "0"), value: word(d, 11), context: word(d, 16), signature: d.slice(at, at + 65),
  };
}

/** A withdraw's calldata read back; throws unless it is exactly the one canonical encoding. */
export function evmReadWithdraw(d: Uint8Array): EvmRelease {
  if (d.length !== WITHDRAW_LEN || hex(d.subarray(0, 4)) !== WITHDRAW_SELECTOR) throw new Error("not withdraw's calldata");
  if (word(d, 18) !== BigInt(32 * (HEAD_WORDS + W_WORDS))) throw new Error("the signature's offset");
  return readRelease(d, HEAD_WORDS, "withdraw", HEAD_WORDS + W_WORDS);
}

/** A buy's calldata read back; throws unless it is exactly the one canonical encoding, nothing after the signature. */
export function evmReadBuy(d: Uint8Array): EvmRelease {
  if (d.length < BUY_LEN_MIN || d.length > EVM_BODY_DATA_MAX || (d.length - 4) % 32 !== 0 || hex(d.subarray(0, 4)) !== BUY_SELECTOR) throw new Error("not buy's calldata");
  const at = BUY_HEAD_WORDS + W_WORDS; // the Buy's tail, after the Withdrawal's
  if (word(d, 18) !== BigInt(32 * at)) throw new Error("the buy's offset");
  const b = (i: number) => word(d, at + i);
  if (!isAddressWord(b(0)) || !isAddressWord(b(3))) throw new Error("an address's padding");
  if (b(1) !== BigInt(32 * 4)) throw new Error("the buy data's offset");
  const len = b(4);
  if (len > BigInt(d.length)) throw new Error("the buy data's length");
  const padded = Math.ceil(Number(len) / 32);
  const sigAt = at + BUY_WORDS + padded;
  if ((d.length - 4) / 32 !== sigAt + SIG_WORDS) throw new Error("the buy's length");
  if (word(d, 19) !== BigInt(32 * sigAt)) throw new Error("the signature's offset");
  const dataAt = 4 + 32 * (at + BUY_WORDS);
  if (d.subarray(dataAt + Number(len), dataAt + 32 * padded).some((x) => x !== 0)) throw new Error("the buy data's padding");
  return { ...readRelease(d, BUY_HEAD_WORDS, "buy", sigAt), buy: { adapter: addr(b(0)), data: d.slice(dataAt, dataAt + Number(len)), minOut: b(2), token: addr(b(3)) } };
}

/** A withdraw's or a buy's calldata, by its selector; throws on any other. */
export function evmReadRelease(d: Uint8Array): EvmRelease {
  return hex(d.subarray(0, 4)) === BUY_SELECTOR ? evmReadBuy(d) : evmReadWithdraw(d);
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

export const SELL_SIGNATURE = "sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)";
export const SELL_SELECTOR = selectorOf(SELL_SIGNATURE);
/**
 * The sell's calldata limit, bytes, and POST /v1/pool/evm/sell's body limit: the calldata is 612 bytes plus the swap
 * data padded; the longest route the kit builds (EVM_POOL_MAX_HOPS 4 v4 hops with empty hook data, abi.encode(PathKey[]))
 * is 960 bytes of swap data, so 1,572 bytes [design: about 1.3x that].
 */
export const EVM_SELL_DATA_MAX = 2_048;
export const POOL_EVM_SELL_BODY_MAX = 8_192;
const SELL_HEAD = 3; // the tuple's offset, the fee, the signature's offset
const SELL_TUPLE = 11; // token, amount, target, the data's offset, minOut, pool, precommitment, feeCap, feeRecipient, deadline, nonce

export type EvmSell = { token: string; amount: bigint; target: string; data: string; minOut: bigint; pool: string; precommitment: bigint; feeCap: bigint; feeRecipient: string; deadline: bigint; nonce: bigint; fee: bigint; signature: Uint8Array };

/** A sell's calldata read back; throws unless it is exactly the one canonical encoding. */
export function evmReadSell(d: Uint8Array): EvmSell {
  const least = 4 + 32 * (SELL_HEAD + SELL_TUPLE + 1 + 1 + 3);
  if (d.length > EVM_SELL_DATA_MAX || d.length < least || (d.length - 4) % 32 !== 0 || hex(d.subarray(0, 4)) !== SELL_SELECTOR) throw new Error("not sell's calldata");
  if (word(d, 0) !== BigInt(32 * SELL_HEAD)) throw new Error("the sell's offset");
  const t = (i: number) => word(d, SELL_HEAD + i);
  if (t(3) !== BigInt(32 * SELL_TUPLE)) throw new Error("the swap data's offset");
  if (![t(0), t(2), t(5), t(8)].every(isAddressWord)) throw new Error("an address's padding");
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
    precommitment: t(6), feeCap: t(7), feeRecipient: addr(t(8)), deadline: t(9), nonce: t(10), fee: word(d, 1), signature: d.slice(sigBytes, sigBytes + 65),
  };
}

const utf8 = (t: string) => new TextEncoder().encode(t);
const w32 = (n: bigint) => unhex(n.toString(16).padStart(64, "0"));
const DOMAIN_TYPE = keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
/** SellDelegate.sol's SELL_TYPEHASH, its string held to the contract's own text by contracts/pool-evm/test/sell-type-helper.test.mjs.
 *  The string sits in this one declaration, the one the signing page's signer guard lets the helper hold it in. */
const SELL_TYPE = keccak_256(utf8("Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)"));
/** SellDelegate._sellDigest (contracts/pool-evm/src/SellDelegate.sol) of `s` under W's own address on chain `chainId`. */
export function evmSellDigest(chainId: bigint, w: string, s: EvmSell): Uint8Array {
  const domain = keccak_256(Uint8Array.from([...DOMAIN_TYPE, ...keccak_256(utf8("Blindfill")), ...keccak_256(utf8("1")), ...w32(chainId), ...w32(BigInt(w))]));
  const fields = [BigInt(s.token), s.amount, BigInt(s.target)].map(w32);
  const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, BigInt(s.feeRecipient), s.deadline, s.nonce].map(w32);
  const struct = keccak_256(Uint8Array.from([...SELL_TYPE, ...fields.flatMap((x) => [...x]), ...keccak_256(unhex(s.data.slice(2))), ...rest.flatMap((x) => [...x])]));
  return keccak_256(Uint8Array.from([0x19, 0x01, ...domain, ...struct]));
}

/** The pool's release types (PrivacyPool.sol WITHDRAW_TYPEHASH, PrivacyPoolSimple.sol BUY_TYPEHASH; M354, M357 (2)). */
const WITHDRAW_TYPE = keccak_256(utf8("Withdraw(uint256 nullifier,uint256 context,uint256 value)"));
const BUY_TYPE = keccak_256(utf8("Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)"));
/** The EIP-712 digest W signs to take a proof as `r`'s method, as the pool's _typedDigest makes it: domain Blindfill,
 *  1, `chainId`, verifyingContract the pool; the struct the method's type with the Buy's fields (a buy) and the proof's
 *  nullifier, context and value. */
export function evmReleaseDigest(chainId: bigint, pool: string, r: EvmRelease): Uint8Array {
  const domain = keccak_256(Uint8Array.from([...DOMAIN_TYPE, ...keccak_256(utf8("Blindfill")), ...keccak_256(utf8("1")), ...w32(chainId), ...w32(BigInt(pool))]));
  const proof = [BigInt(`0x${r.nullifier}`), r.context, r.value].map(w32).flatMap((x) => [...x]);
  const b = r.buy;
  if ((r.method === "buy") !== (b !== undefined)) throw new Error("a buy is exactly a release with its Buy");
  const struct = b !== undefined
    ? keccak_256(Uint8Array.from([...BUY_TYPE, ...w32(BigInt(b.adapter)), ...keccak_256(b.data), ...w32(b.minOut), ...w32(BigInt(b.token)), ...proof]))
    : keccak_256(Uint8Array.from([...WITHDRAW_TYPE, ...proof]));
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

/** The address whose signature `r` carries over its digest on `pool` and chain `chainId`, as the pool's _signer reads
 *  it (r ‖ s ‖ v), or null unless it is in its one form: v 27 or 28, r and s in 1..n-1, s at most n / 2 (EIP-2), as the
 *  pool's HALF_N; a signature with s high is refused even where its low twin is W's (the pool reverts it). */
export function evmReleaseSigner(chainId: bigint, pool: string, r: EvmRelease): string | null {
  const sig = r.signature;
  if (sig.length !== 65) return null;
  const [sr, ss, sv] = [BigInt(`0x${hex(sig.subarray(0, 32))}`), BigInt(`0x${hex(sig.subarray(32, 64))}`), sig[64]!];
  if ((sv !== 27 && sv !== 28) || sr === 0n || sr >= N || ss === 0n || ss > N / 2n) return null;
  return recoverAddress(evmReleaseDigest(chainId, pool, r), sv - 27, sr, ss);
}

// ---- The epoch fee (M352 (2)) ----

/** The step every EVM fee is rounded up to, in wei: the kit's EVM_POOL_FEE_STEP, 0.00001 ETH, named in each answer. */
export const EVM_FEE_STEP = EVM_POOL_FEE_STEP;
/** The pool's tree depth view (State.sol currentTreeDepth), the depth G is priced at. */
const TREE_DEPTH_DATA = `0x${selectorOf("currentTreeDepth()")}`;
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
 * The withdraws whose gas the withdraw sender always keeps for them, at their worst (EVM_GAS_MAX x (2 x base + tip)):
 * a buy is refused (429) when the lower of the two providers' pending balances, less every buy still in flight at its
 * worst and this buy's worst, would fall under it (review of 7d210cb5, M1). A buy whose coin or hook reverts on
 * chain after its simulation passed costs its sender gas and pays no fee, so buys could spend the float the withdraws
 * need; with this reserve they stop first and every withdraw still goes. N = EVM_QUEUE_MAX: every withdraw the lane can
 * hold at once, so a full lane of withdraws is paid at the worst price any of them can be sent at; the fees those
 * withdraws pay go to the fee recipient (the sender itself unless POOL_EVM_FEE_RECIPIENT_<NETWORK> names another), and
 * the operator refills the sender from that.
 */
export const EVM_WITHDRAW_RESERVE_SENDS = EVM_QUEUE_MAX;
/**
 * How long past a Sell's deadline, on our clock, a sale with no receipt and no transaction on either provider still
 * holds its (W, Sell nonce): SellDelegate checks the deadline against the block's time, so a helper whose clock runs up
 * to this far ahead of the chain's would otherwise free the nonce, and send a second tx at it, while the first can still
 * land [design: the same 60 s as EVM_POOL_SEND_MARGIN_MS].
 */
export const EVM_SELL_DROP_MARGIN_MS = 60_000;
/**
 * The sell sender pays gas for each call W signs; SellDelegate pays the fee, out of the proceeds and only when the sale
 * lands, to the Sell's feeRecipient, this network's fee collector, which forwards it to the sell sender. The ledger counts what the
 * release does not get back, not the sell key's balance, which falls by every sale's cost. Each sale's worst cost (gas x maxFeePerGas + the L1 data fee bound) is held against W, the client,
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
/**
 * The most maxFeePerGas a lane's replacement (its 0-value transfer to itself, at a stuck send's or a hole's nonce) is
 * ever sent at, on every chain: EVM_SELL_UNPAID_CAP_WEI / EVM_POOL_SELL_GAS, 1 gwei, the price at which one sale's worst
 * gas is a whole W's unpaid cap, so the caps above (about 30 reverts at a 0.01 gwei base) hold no sale at it. The sale's
 * own cost check has no fixed price of its own (its maxFeePerGas is min(2 x base + tip, (fee - the chain fee) / gas),
 * bounded by the fee W signed); a replacement is paid by no one, so it gets this one. Over it nothing is replaced and
 * the lane logs it once, until a replacement goes again [design: Base and Robinhood both price sales on the kit's one
 * EVM_POOL_SELL_GAS, so one value serves both].
 */
export const EVM_SELL_MAX_FEE_PER_GAS = EVM_SELL_UNPAID_CAP_WEI / EVM_POOL_SELL_GAS;
/**
 * How long a lane's send is watched past its deadline plus the send margin; a watch that reaches it ends with one log
 * line, and while the lane's lowest unmined send is past it the lane answers every new send 503 upstream with
 * Retry-After EVM_LANE_RETRY_S, since a send behind it could not be mined [design: a proof's life, 10 minutes, past the
 * one replacement and its raises].
 */
export const EVM_LANE_WATCH_MS = 600_000;
export const EVM_LANE_RETRY_S = 60;
/** The Retry-After of a held answer whose tend sent something: the least a Retry-After says (whole seconds, RFC 9110
 *  10.2.3), so the next try reads its receipt; it holds five of Base's 200 ms blocks (since block 53556127, 2026-11-05
 *  18:00:01Z; one 2 s block before) and about ten of Robinhood's 101 ms ones (both read 2026-11-05 20:38Z) [design: the
 *  chain's own pace, never an artificial wait]. Also how often a held lane's hold is read again. */
export const EVM_LANE_SENT_RETRY_S = 1;
/** How long after a held answer's tend sent something the other held answers retry each EVM_LANE_SENT_RETRY_S: a
 *  receipt can land a block or more late, and a late read or a slow provider adds more, so the wait for it is never a
 *  whole tend cycle [design: 10 s, five of Base's 2 s blocks when it was set]. */
export const EVM_LANE_SENT_WINDOW_MS = 10_000;
/** The most earlier hashes a nonce's record keeps (each send the lane made at it before the one it holds now). */
const EVM_LANE_PRIOR_MAX = 8;
/** A 0-value transfer's gas: 21,000 (OP Stack, Base); on Arbitrum (Robinhood) the L1 poster's gas is added to it. */
export const EVM_SELF_TRANSFER_GAS = 21_000n;
/** FeeCollector's Paid(address indexed from, uint256 value) (card evm-fee-collector), its topic 0. */
export const PAID_TOPIC = `0x${hex(keccak_256(new TextEncoder().encode("Paid(address,uint256)")))}`;
/**
 * Whether the receipt `r` (a provider's answer, read as hostile) carries the fee collector's Paid log of this sale: from
 * `collector`, not removed, its two topics Paid's and W's address, its data one word, at least `fee`. The collector emits
 * it only in receive(), for ETH it was sent, so no code W runs can make one without paying.
 */
export function evmSalePaid(r: unknown, collector: string, w: string, fee: bigint): boolean {
  const logs = (r as { logs?: unknown } | null)?.logs;
  if (!Array.isArray(logs)) return false;
  const from = `0x${w.slice(2).toLowerCase().padStart(64, "0")}`;
  return logs.some((l) => {
    if (typeof l !== "object" || l === null) return false;
    const { address, topics, data, removed } = l as { address?: unknown; topics?: unknown; data?: unknown; removed?: unknown };
    if (removed === true || evmRpcHex(address) !== collector || !Array.isArray(topics) || topics.length !== 2) return false;
    if (evmRpcHex(topics[0]) !== PAID_TOPIC || evmRpcHex(topics[1]) !== from) return false;
    const d = evmRpcHex(data);
    return d !== null && d.length === 2 + 64 && BigInt(d) >= fee;
  });
}
/**
 * What a landed sale left unpaid, from its two receipts, one per provider, read as hostile (card
 * helper-sender-fee-proof): proven only when both read status 1 and each carries the fee collector's Paid log of the
 * sale (evmSalePaid: the call to W runs whatever code W holds then, so a status 1 alone proves nothing). A proven sale's
 * unpaid is its cost less the fee, at least 0, and it paid when its cost is at most the fee; any other pair is charged its
 * whole cost and paid nothing. The cost is the higher of the two receipts' gasUsed x effectiveGasPrice + l1Fee, each part
 * held to what the sale can cost (one provider's answer is hostile, and the higher one counts): gasUsed at most the gas
 * the sale is sent with (EVM_POOL_SELL_GAS), effectiveGasPrice at most its maxFeePerGas, and l1Fee at most `worst`, the
 * whole worst cost held at its send (so a lying provider charges one sale under twice its worst, never an hour of
 * sells); a receipt whose cost cannot be read counts `worst`.
 */
export function evmSaleUnpaid(ra: Record<string, unknown>, rb: Record<string, unknown>, sale: { collector: string; w: string; fee: bigint; maxFeePerGas: bigint }, worst: bigint): { proven: boolean; paid: boolean; unpaid: bigint } {
  const most = (v: bigint, cap: bigint) => (v < cap ? v : cap);
  const costOf = (r: Record<string, unknown>): bigint => {
    try {
      return most(qty(r.gasUsed), EVM_POOL_SELL_GAS) * most(qty(r.effectiveGasPrice), sale.maxFeePerGas) + (r.l1Fee === undefined || r.l1Fee === null ? 0n : most(qty(r.l1Fee), worst));
    } catch {
      return worst;
    }
  };
  const [ca, cb] = [costOf(ra), costOf(rb)];
  const cost = ca > cb ? ca : cb;
  const ok = [ra, rb].every((r) => evmRpcHex(r.status) === "0x1" && evmSalePaid(r, sale.collector, sale.w, sale.fee));
  return { proven: ok, paid: ok && cost <= sale.fee, unpaid: ok ? (cost > sale.fee ? cost - sale.fee : 0n) : cost };
}
export const BOUGHT_TOPIC = `0x${hex(keccak_256(new TextEncoder().encode("Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)")))}`;
/** buy's return as eth_call answers it where the swap lands: abi.encode(true) (card pool-evm-buy-pays-revert). */
const BUY_TRUE = `0x${"0".repeat(63)}1`;
export const WITHDRAWN_TOPIC = `0x${hex(keccak_256(new TextEncoder().encode("Withdrawn(address,address,uint256,uint256,uint256,uint256)")))}`;
/** Whether receipt `r` carries the pool's log of this buy landing: from the pool, `_recipient` W (its one indexed
 *  field), and in its data the fee recipient, the fee and the spent nullifier. Either Bought (IPrivacyPool.sol), with
 *  the token the buy signed, which the pool emits only after the adapter ran and W's balance rose by minOut; or
 *  Withdrawn, which a buy emits when its swap failed (card pool-evm-buy-pays-revert, NOTICE change 18: the note is
 *  spent, the fee paid and W paid the rest in ETH, as withdraw does), so a swap that fails after its simulation still
 *  pays the fee. Only the pool emits either, and in the sender's own buy transaction only that buy can (the pool's
 *  reentrancy guard): the adapter's own logs, whatever code it runs, prove nothing. */
export function evmBuyLanded(r: unknown, buy: { pool: string; w: string; feeRecipient: string; fee: bigint; nullifier: string; token: string }): boolean {
  const logs = (r as { logs?: unknown } | null)?.logs;
  if (!Array.isArray(logs)) return false;
  const pad = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
  return logs.some((l) => {
    if (typeof l !== "object" || l === null) return false;
    const { address, topics, data, removed } = l as { address?: unknown; topics?: unknown; data?: unknown; removed?: unknown };
    if (removed === true || evmRpcHex(address) !== buy.pool || !Array.isArray(topics) || topics.length !== 2) return false;
    const bought = evmRpcHex(topics[0]) === BOUGHT_TOPIC;
    if ((!bought && evmRpcHex(topics[0]) !== WITHDRAWN_TOPIC) || evmRpcHex(topics[1]) !== `0x${pad(buy.w)}`) return false;
    const d = evmRpcHex(data);
    if (d === null || d.length !== 2 + (bought ? 7 : 5) * 64) return false;
    const at = (i: number) => d.slice(2 + 64 * i, 2 + 64 * (i + 1));
    return at(0) === pad(buy.feeRecipient) && BigInt(`0x${at(2)}`) === buy.fee && at(3) === buy.nullifier && (!bought || at(5) === pad(buy.token));
  });
}
/**
 * What a sent buy left unpaid, from its two receipts, one per provider, read as hostile (card helper-evm-sender-2, review
 * a2ff5521 H1): the adapter runs code the sender cannot vet, so a buy can revert on chain after its simulation passed.
 * Proven only when both read status 1 and each carries the pool's Bought log of this buy (evmBuyLanded): then the fee
 * was paid and what is held is the cost less the fee, at least 0 (the fee caps the gas, maxFeePerGas at most fee / gas,
 * but not the receipt's l1Fee), as evmSaleUnpaid holds a sale. Any other pair is charged its whole cost: the higher of the two receipts' gasUsed x effectiveGasPrice + l1Fee, each part held to what the buy can cost
 * (gasUsed at most the gas it was sent with, effectiveGasPrice at most its maxFeePerGas, l1Fee at most `worst`); a
 * receipt whose cost cannot be read counts `worst`.
 */
export function evmBuyUnpaid(ra: Record<string, unknown>, rb: Record<string, unknown>, buy: { pool: string; w: string; feeRecipient: string; fee: bigint; nullifier: string; token: string; gas: bigint; maxFeePerGas: bigint }, worst: bigint): { proven: boolean; unpaid: bigint } {
  const most = (v: bigint, cap: bigint) => (v < cap ? v : cap);
  const costOf = (r: Record<string, unknown>): bigint => {
    try {
      return most(qty(r.gasUsed), buy.gas) * most(qty(r.effectiveGasPrice), buy.maxFeePerGas) + (r.l1Fee === undefined || r.l1Fee === null ? 0n : most(qty(r.l1Fee), worst));
    } catch {
      return worst;
    }
  };
  const [ca, cb] = [costOf(ra), costOf(rb)];
  const cost = ca > cb ? ca : cb;
  const ok = [ra, rb].every((r) => evmRpcHex(r.status) === "0x1" && evmBuyLanded(r, buy));
  return { proven: ok, unpaid: ok ? (cost > buy.fee ? cost - buy.fee : 0n) : cost };
}
/** The first wait before a sent transaction's receipt is read, doubling each read up to EVM_RECEIPT_POLL_BACKOFF times
 *  it (400 ms to 30 s), until its deadline plus the send margin [design: two of Base's 200 ms blocks (2 s, one block,
 *  before block 53556127), then a few reads a minute up to the same 30 s]. */
export const EVM_SELL_RECEIPT_POLL_MS = 400;
export const EVM_RECEIPT_POLL_BACKOFF = 75;

export type EvmBlock = { number: bigint; timestamp: bigint; hash: string; baseFeePerGas: bigint };
const blockOf = (v: unknown): EvmBlock => {
  const b = v as { number?: unknown; timestamp?: unknown; hash?: unknown; baseFeePerGas?: unknown } | null;
  const hash = evmRpcHex(b?.hash);
  if (hash === null || !/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("not a block");
  return { number: qty(b!.number), timestamp: qty(b!.timestamp), hash, baseFeePerGas: qty(b!.baseFeePerGas) };
};
const tag = (n: bigint) => `0x${n.toString(16)}`;

/**
 * The first block at or after `seconds`, read on `rpc`: null when the newest block is still before it. Searches by the
 * chain's own block time (card robinhood-mainnet-rpcs, review M-3), never a second as a block: the first step back is
 * one block a second, at most as far as the time on a chain of a block a second or slower; each later step is the
 * time still to go at the block time the two newest reads show, a tenth more, at least twice the step before (so a chain
 * whose blocks stopped is still passed). Inside the bracket each probe lands where the block times put `seconds` less
 * half a second (the gap between the blocks before it and the blocks at it, where the run of blocks with one timestamp
 * makes the first at it), and halves the gap instead when the probe before took less than half of it.
 * 8 to 10 reads at Robinhood's 0.1 s blocks, 1 to 600 s back, where a second as a block took 11 to 14 a minute back.
 */
export async function evmFirstBlockAtOrAfter(rpc: EvmRpc, seconds: bigint): Promise<EvmBlock | null> {
  const at = async (n: bigint | "latest") => blockOf(await rpc("eth_getBlockByNumber", [n === "latest" ? n : tag(n), false]));
  let hi = await at("latest");
  if (hi.timestamp < seconds) return null;
  // blocks per second over two reads, as a fraction (blocks, seconds); null when they share a timestamp
  const rate = (a: EvmBlock, b: EvmBlock): [bigint, bigint] | null => (b.timestamp > a.timestamp ? [b.number - a.number, b.timestamp - a.timestamp] : null);
  let step = hi.timestamp - seconds + 1n;
  let newer: EvmBlock | null = null;
  let lo: EvmBlock | null = null;
  for (;;) {
    if (hi.number === 0n) return hi;
    const n = hi.number > step ? hi.number - step : 0n;
    const b = await at(n);
    if (b.timestamp < seconds) {
      lo = b;
      break;
    }
    newer = hi;
    hi = b;
    const r = rate(hi, newer);
    const want = r === null ? 0n : ((hi.timestamp - seconds + 1n) * r[0] * 11n) / (r[1] * 10n) + 1n;
    step = want > step * 2n ? want : step * 2n;
  }
  let halve = false;
  while (hi.number - lo.number > 1n) {
    const gap = hi.number - lo.number;
    let n = (lo.number + hi.number) / 2n;
    if (!halve) {
      // where seconds - 1/2 falls between lo and hi, in half seconds so the arithmetic stays whole
      const guess = lo.number + ((2n * (seconds - lo.timestamp) - 1n) * gap) / (2n * (hi.timestamp - lo.timestamp));
      n = guess <= lo.number ? lo.number + 1n : guess >= hi.number ? hi.number - 1n : guess;
    }
    const mid = await at(n);
    if (mid.timestamp >= seconds) hi = mid;
    else lo = mid;
    halve = !halve && (hi.number - lo.number) * 2n > gap;
  }
  return hi;
}


// ---- The sender ----

export type EvmRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type PoolEvmCode =
  | "bad_shape" | "not_pool" | "fee_recipient" | "fee_off" | "fee_over_cap" | "epoch_off" | "deadline_near" | "reverted" | "recipient_code" | "simulation_failed" | "fee_stale" | "rate_limited" | "in_flight" | "upstream"
  | "bad_authorization" | "bad_signature" | "deadline_far" | "auth_nonce" | "fee_low" | "bad_route" | "not_configured";
/** `retryAfterS` on a 429, and on the 503 of a lane held behind an unmined send: the whole seconds the route names in
 *  Retry-After. */
export type PoolEvmAnswer = { status: number; body: { hash: string } | { error: { code: PoolEvmCode; detail?: string } }; retryAfterS?: number };
/** `sell_sender`: the sell sender's address, which every sale is sent from and the device's sim runs from (the kit pins
 *  it), or null where no sell key is set (every sell refused not_configured). `fee_collector`: the address every Sell
 *  must pay its fee to (SellDelegate.sol, pool review round 3, L-1), the network's FeeCollector, whose Paid log proves a
 *  sale's fee (card helper-sender-fee-proof), or null where none is set (every sell refused not_configured); never the
 *  withdraw's `fee_recipient`. A device takes it from its own pin, never from this answer. */
export type EvmFeeAnswer = { chain: "evm"; network: string; pool: string; fee_recipient: string; sell_sender: string | null; fee_collector: string | null; epoch_ms: number; epoch_start_ms: number; block: string; fee: string; step: string };

export type EvmPoolSender = {
  readonly network: string;
  readonly pool: string;
  readonly sender: string;
  /** The sell sender's address (its own key, nonce lane and queue, never the withdraw sender's), or null: no sell key. */
  readonly sellSender: string | null;
  /** GET /v1/pool/fee: the epoch's fee (the epoch holding `atMs`), in wei; null while the chain has no block in it yet. */
  fee(atMs: number): Promise<EvmFeeAnswer | null>;
  /**
   * The start's check (card evm-buy-hookdata-fee, review fold 2 MEDIUM-A): each provider answers every state read the
   * fee makes (the pool's tree depth, the chain fee) at the block POOL_LIFE_MAX_MS old, the oldest epoch a proof's fee
   * is read at, so a pruning provider (robinhood-sepolia-rpc.publicnode.com keeps about 15 s) is refused at the start,
   * never at a user's send. Rejects naming the provider (rpc 1 or 2) and its answer; server.ts exits 2 on it. A call
   * answered with a throttle or a timeout is asked again, EVM_READY_TRIES times at most, EVM_READY_WAIT_MS then twice
   * that apart (`sleep` is the wait, a test's own); any other answer, a missing state among them, refuses at once.
   */
  ready(sleep?: (ms: number) => Promise<void>): Promise<void>;
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
 * One pool's sender; its least fee is the kit's EVM_POOL_FEE_FLOOR, which evmPoolFee applies (wei: the pool's asset is
 * the chain's native coin, PrivacyPoolSimple). `feeRecipient` is where the release takes it. Sends one at a time, so
 * each takes the next nonce; one per nullifier.
 */
export function evmPoolSender(
  cfg: { network: string; pool: string; senderKey: Uint8Array; sellKey?: Uint8Array; feeRecipient?: string; feeCollector?: string; memory?: number; venues?: Readonly<Partial<Record<string, EvmPoolVenue>>>; receiptPollMs?: number; log?: (line: string) => void },
  providers: readonly [EvmRpc, EvmRpc],
  now: () => number = Date.now,
): EvmPoolSender {
  const pool = cfg.pool.toLowerCase();
  if (!ADDRESS.test(pool)) throw new Error("the pool must be an address");
  // the fee rule reads the network's chain fee: a network the kit has no chain fee rule for starts no sender
  evmPoolChainFeeReads(cfg.network, 1n);
  const sender = evmAddressOf(cfg.senderKey);
  const feeRecipient = (cfg.feeRecipient ?? sender).toLowerCase();
  if (!ADDRESS.test(feeRecipient)) throw new Error("the fee recipient must be an address");
  // the sell sender: its own key, so a sale's unpaid gas never drains the withdraw sender, and its own nonce lane
  const sellSender = cfg.sellKey === undefined ? null : evmAddressOf(cfg.sellKey);
  if (sellSender === sender) throw new Error("the sell key must not be the withdraw sender's key");
  // the fee collector a Sell must pay (card helper-sender-fee-proof): none set, every sell is refused
  const feeCollector = cfg.feeCollector === undefined ? undefined : cfg.feeCollector.toLowerCase();
  if (feeCollector !== undefined && (!ADDRESS.test(feeCollector) || feeCollector === pool || feeCollector === sender || feeCollector === sellSender || feeCollector === feeRecipient)) throw new Error("the fee collector must be an address, not the pool's, a sender's or the fee recipient's");
  const [a, b] = providers;
  let chainId: Promise<bigint> | null = null;
  // one lane per key: its queue (each send waits for the one before it), its next nonce, and each of its own sends not
  // yet seen mined, by nonce: when it was sent, the time past which it is stuck, its fee fields
  // (`bound`: the end of its nonce's watch, kept by each replacement at that nonce; `replacement`: one of the lane's own
  // 0-value transfers, `raw` its signed bytes; `prior`: the lane's earlier sends at the nonce, any of which may be the one
  // mined; `checkedAt`: when a tend last read its receipts and its tx)
  type Sent = { at: number; stuckAfter: number; bound: number; maxFee: bigint; tip: bigint; hash: string; replacement: boolean; raw?: string; prior: string[]; checkedAt: number };
  // (`ceilingSaid`, `failSaid`: the lane has logged a replacement held over EVM_SELL_MAX_FEE_PER_GAS, or a tend that
  // failed, since its last replacement went or its last tend ran through; `heldTendAt`: when a held answer last tended it;
  // `heldSentAt`: when a held answer's tend last sent something; `heldRead`: the last hold read (heldLow), shared by every
  // held answer within EVM_LANE_SENT_RETRY_S of it; `behind`: per provider, the nonce its latest count has stayed below
  // since `since`, and whether that was logged; `ahead`: per provider, whether a latest count past the lane's next nonce
  // was logged)
  type Behind = { nonce: bigint; since: number; said: boolean } | null;
  type HeldRead = { at: number; low: Promise<[bigint, Sent] | undefined> };
  type Lane = { queue: Promise<unknown>; waiting: number; nextNonce: bigint; from: string; key: Uint8Array | undefined; sent: Map<bigint, Sent>; tending: boolean; ceilingSaid: boolean; failSaid: boolean; heldTendAt: number; heldSentAt: number; heldRead: HeldRead | null; behind: [Behind, Behind]; ahead: [boolean, boolean] };
  const laneOf = (from: string, key: Uint8Array | undefined): Lane => ({ queue: Promise.resolve(), waiting: 0, nextNonce: -1n, from, key, sent: new Map(), tending: false, ceilingSaid: false, failSaid: false, heldTendAt: -Infinity, heldSentAt: -Infinity, heldRead: null, behind: [null, null], ahead: [false, false] });
  /** The hashes of the lanes' sends a replacement took the nonce of, the oldest dropped first: each is ended. */
  const superseded = new Set<string>();
  const log = cfg.log ?? ((line: string) => console.log(`helper: ${line}`));
  const withdrawLane = laneOf(sender, cfg.senderKey);
  const sellLane = laneOf(sellSender ?? sender, cfg.sellKey);
  const once = oncePerNullifier<PoolEvmAnswer>(cfg.memory);
  /** Each remembered send's epoch, so a revert is held against the epoch whose proof reverted. */
  const sentIn = new WeakMap<Promise<PoolEvmAnswer>, number>();
  /** Each remembered send's deadline (ms), so a repeat can tell a dropped withdraw from a waiting one. */
  const sentDeadline = new WeakMap<Promise<PoolEvmAnswer>, number>();
  /** Each remembered send's method, so a revert is held against the method that reverted. */
  const sentMethod = new WeakMap<Promise<PoolEvmAnswer>, EvmRelease["method"]>();
  /** `${epoch}:${method}:${nullifier}` of every send that reverted on chain, the oldest dropped first (M356 (1)): a buy
   *  that reverted (its minOut not met) leaves the same proof free to withdraw in its epoch, and the reverse. */
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
  // the chain id a withdraw's or a buy's W signature is checked under and its send signed for: the kit's pin for the
  // network (M356 (6)); a network the kit does not list refuses every release
  const releaseChainId = sellVenue === undefined ? undefined : BigInt(sellVenue.chainId);
  const sells = oncePerNullifier<PoolEvmAnswer>(cfg.memory);
  /** Each remembered sale's Sell deadline (unix seconds), so a repeat can tell a dropped sale from a waiting one. */
  const sellDeadline = new WeakMap<Promise<PoolEvmAnswer>, bigint>();
  /** The last time each W ("w:") and client ("c:") had a sale land and pay its cost, held for the unpaid window. */
  const paid = new Map<string, number>();
  /** The unpaid-gas ledger: per key ("all", "w:", "c:", "t:"), the charges in the window; one charge object is shared by
   *  every key of its sale, so its receipt updates them all at once. */
  type Charge = { at: number; wei: bigint };
  const unpaid = new Map<string, Charge[]>();
  /** Each buy sent whose two receipts are not yet read, its worst held: the withdraws' reserve counts them as spent. */
  const buysInFlight = new Set<Charge>();
  /** Whether the last buy that read the reserve stopped at it: one log line per stop and per start again. */
  let reserveHeld = false;
  const live = (k: string, t: number): Charge[] => {
    const l = (unpaid.get(k) ?? []).filter((c) => c.at > t - EVM_SELL_UNPAID_WINDOW_MS);
    if (l.length === 0) unpaid.delete(k);
    else unpaid.set(k, l);
    return l;
  };
  /** The 429 a sale would get with `extra` wei more held against `keys`, or null when every key stays within its cap. */
  const overCap = (keys: readonly string[], extra: bigint): PoolEvmAnswer | null => {
    const t = now();
    // a caller whose own sale landed and paid in the window is not held by the token's cap (strangers' reverts on its
    // token never refuse it); its own W and client caps and the sender's whole budget hold it as they hold every sale
    const known = keys.some((k) => (k.startsWith("w:") || k.startsWith("c:")) && (paid.get(k) ?? -Infinity) > t - EVM_SELL_UNPAID_WINDOW_MS);
    for (const k of keys) {
      if (known && k.startsWith("t:")) continue;
      const l = live(k, t);
      const budget = k === "all" || k === "buys";
      const cap = budget ? EVM_SELL_UNPAID_BUDGET_WEI : EVM_SELL_UNPAID_CAP_WEI;
      const sum = l.reduce((x, c) => x + c.wei, 0n);
      // a key with nothing held takes one send whatever its worst (a buy's worst is at most its fee, which a gas spike
      // can lift past a cap: one buy is never refused for its own size). So a key holds at most its cap plus the one
      // send that found it empty: a W, client or token key, which buys and sales share, its cap plus one buy and one
      // sale (each may find it empty at once). A sale's worst, gas x min(2 x base + tip, (fee - the chain fee) / gas), has
      // no ceiling of its own (EVM_SELL_MAX_FEE_PER_GAS caps only the lane's replacements), so in a gas spike it too can
      // pass the cap: one such sale per empty key
      if (sum > 0n && sum + extra > cap) {
        const oldest = l.length > 0 ? l[0]!.at : t;
        return { ...no(429, "rate_limited", `unpaid ${keys[0] === "buys" ? "buy" : "sell"} gas ${sum} wei for ${budget ? "this sender" : k.slice(0, 1) === "w" ? "W" : k.slice(0, 1) === "c" ? "this client" : "this token"}, cap ${cap}`), retryAfterS: Math.max(1, Math.ceil((oldest + EVM_SELL_UNPAID_WINDOW_MS - t) / 1000)) };
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
  // a buy's keys (card helper-evm-sender-2, review a2ff5521 H1): the same W, client and token caps as a sale (one
  // caller's unpaid gas, either route), and the withdraw sender's own budget ("buys"), as the sell sender has "all"
  const buyKeys = (w: string, client: string | undefined, token: string) => ["buys", `w:${w}`, `t:${token}`, ...(client === undefined ? [] : [`c:${client}`])];
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
  /** One eth_call at block `hash` (EIP-1898) on both providers: its first word, the same on both, else a throw. */
  const viewAt = async (to: string, data: string, hash: string): Promise<bigint> => {
    const words = (await Promise.all([a, b].map((rpc) => rpc("eth_call", [{ to, data }, { blockHash: hash }])))).map((v) => {
      const h = firstWord(v);
      if (h === null) throw new Error(`not a word from ${to} at ${hash}`);
      return BigInt(h);
    });
    if (words[0] !== words[1]) throw new Error(`the providers differ on ${data.slice(0, 10)} at ${to}, block ${hash}`);
    return words[0]!;
  };
  /**
   * The epoch's first block, on provider A and the same hash on B, and its fee, cached once both agree: the kit's
   * evmPoolFee({ gas: evmPoolGas(the pool's tree depth there), gasPrice: its base fee, chainFee: the chain fee
   * there }), every input read at that block's hash on both providers, as the device reads them before it binds.
   */
  const feeOf = (epochStartMs: number): Promise<{ block: EvmBlock; fee: bigint } | null> => {
    const known = fees.get(epochStartMs);
    if (known) return known;
    const p = (async () => {
      const block = await evmFirstBlockAtOrAfter(a, BigInt(Math.ceil(epochStartMs / 1000)));
      if (block === null) return null;
      const same = blockOf(await b("eth_getBlockByNumber", [tag(block.number), false]));
      if (same.hash !== block.hash) throw new Error("the providers hold different blocks");
      const d = await viewAt(pool, TREE_DEPTH_DATA, block.hash);
      const gas = evmPoolGas(Number(d)); // a depth past the pool's 32 throws
      const answers = [];
      for (const r of evmPoolChainFeeReads(cfg.network, gas)) answers.push(await viewAt(r.to, r.data, block.hash));
      const chainFee = evmPoolChainFee(cfg.network, EVM_POOL_TX_BYTES, answers);
      return { block, fee: evmPoolFee({ gas, gasPrice: block.baseFeePerGas, chainFee }) };
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
  const carry = (body: unknown, client?: string): Promise<PoolEvmAnswer> => holding(client, () => carryHeld(body, client));
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
  const carryHeld = async (body: unknown, client: string | undefined): Promise<PoolEvmAnswer> => {
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 3) return no(400, "bad_shape");
    const { pool: p, data, epoch } = body as { pool?: unknown; data?: unknown; epoch?: unknown };
    if (p !== pool || typeof data !== "string" || data.length > 2 + 2 * EVM_BODY_DATA_MAX || !HEX.test(data)) return no(400, "bad_shape");
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 || epoch % POOL_EPOCH_MS !== 0) return no(400, "bad_shape");
    const bytes = unhex(data.slice(2));
    let w: EvmRelease;
    try {
      w = evmReadRelease(bytes);
    } catch (e) {
      return no(400, "bad_shape", (e as Error).message);
    }
    if (w.processooor !== pool) return no(422, "not_pool");
    if (w.feeRecipient !== feeRecipient) return no(422, "fee_recipient");
    // W picked this release (M354, M357): its signature of exactly this method, Buy, nullifier, context and value, on
    // this pool and the network's pinned chain id, in its one form (65 bytes, v 27 or 28, s low), by the recipient, as
    // the pool's _release checks it; no RPC call before it, so a forged or replayed release costs no read
    if (releaseChainId === undefined) return no(503, "not_configured", `the kit pins no chain id for ${cfg.network}`);
    const signer = evmReleaseSigner(releaseChainId, pool, w);
    if (signer !== w.recipient) return no(422, "bad_signature", signer === null ? "not one signature: v not 27 or 28, r or s out of range, s high, or no key" : `signed by ${signer}, not the recipient W`);
    // a buy's adapter runs whatever code it holds, at the sender's gas: only one of the kit's pinned adapters, along a
    // route the device's own builder makes for this Buy, byte for byte (the kit's evmBuyRouteOf, the one definition, as
    // a sale's evmSellRouteOf); no RPC call before it
    if (w.buy !== undefined) {
      try {
        evmBuyRouteOf(sellChain!, { adapter: w.buy.adapter, data: `0x${hex(w.buy.data)}`, minOut: w.buy.minOut, token: w.buy.token });
      } catch (e) {
        return no(422, "bad_route", String((e as Error).message).slice(0, 200));
      }
    }
    // the proof's epoch: inside its life (at most POOL_LIFE_MAX_MS before its deadline, before the deadline), never
    // later than the epoch now nor older than a proof's life; then a deadline at least the send margin away. No RPC
    // call before these, so an old or expired request costs no read (M356 (3)).
    const deadline = Number(w.deadlineMs);
    const t = now();
    if (epoch < deadline - POOL_LIFE_MAX_MS || epoch >= deadline || epoch > epochStartOf(t) || epoch < t - POOL_LIFE_MAX_MS) return no(422, "epoch_off");
    if (deadline < t + EVM_POOL_SEND_MARGIN_MS) return no(422, "deadline_near", `deadline ${deadline}, now ${t}`);
    if (reverted.has(`${epoch}:${w.method}:${w.nullifier}`)) return no(422, "reverted");
    // a buy's unpaid-gas caps, before any read: a W, client or token already at its cap, or the buys' budget spent, waits;
    // a repeat of a release already sent is not held here (its own held worst may fill the cap): it gets its first hash
    // below, and a repeat after that send ended is held just before its new send
    const keys = w.buy === undefined ? undefined : buyKeys(w.recipient, client, w.buy.token);
    if (keys !== undefined && once.get(w.nullifier) === undefined) {
      const capped = overCap(keys, 1n);
      if (capped !== null) return capped;
    }
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
    // refused, and its epoch is remembered so that release is never sent again (M356 (1)); a repeat after that send was
    // dropped (no receipt and no transaction on either provider past its deadline plus the margin) or replaced (the
    // lane's 0-value transfer took its nonce) frees the nullifier, as a dropped sale frees its (W, Sell nonce)
    const prior = once.get(w.nullifier);
    if (prior) {
      const first = await prior;
      const hash = (first.body as { hash?: string }).hash;
      if (hash === undefined) return first;
      const end = await sendEnded(hash, sentDeadline.get(prior) ?? 0);
      if (end === "waiting") return first;
      if (end === "reverted") {
        const was = sentIn.get(prior) ?? epoch;
        const how = sentMethod.get(prior) ?? w.method;
        reverted.add(`${was}:${how}:${w.nullifier}`);
        while (reverted.size > revertMemory) reverted.delete(reverted.values().next().value as string);
        once.forget(w.nullifier, prior);
        if (was === epoch && how === w.method) return no(422, "reverted");
      } else once.forget(w.nullifier, prior);
      if (keys !== undefined) {
        const capped = overCap(keys, 1n);
        if (capped !== null) return capped;
      }
    }
    const entry = once.run(w.nullifier, () => enqueue(withdrawLane, () => simulateSignSend(data, bytes, w, keys)));
    sentIn.set(entry, epoch);
    if (!sentMethod.has(entry)) sentMethod.set(entry, w.method);
    if (!sentDeadline.has(entry)) sentDeadline.set(entry, Number(w.deadlineMs));
    return entry;
  };
  async function simulateSignSend(data: string, bytes: Uint8Array, w: EvmRelease, keys: readonly string[] | undefined): Promise<PoolEvmAnswer> {
    // the deadline again after the queue's wait: a send that waited past the margin would pay for the pool's revert
    if (Number(w.deadlineMs) < now() + EVM_POOL_SEND_MARGIN_MS) return no(422, "deadline_near", `deadline ${w.deadlineMs}, now ${now()} after the queue`);
    const call = { from: sender, to: pool, data, value: "0x0" };
    let id: bigint, base: bigint, tip: bigint, pa: bigint, pb: bigint;
    let balA = 0n, balB = 0n;
    try {
      const stuck = await laneHeld(withdrawLane);
      if (stuck !== null) return stuck;
      id = await chain();
      // the chain W signed for (M356 (6)): the providers must name the network's pinned chain id, never another
      if (id !== releaseChainId) return no(503, "upstream", `the providers name chain ${id}, not ${releaseChainId}`);
      // a recipient with code could revert the pool's push after the simulation: refused on either provider, at
      // pending and at latest; any answer but "0x" (an EIP-7702 delegation is 0xef0100 + an address) is code
      const codes = await Promise.all([a, b].flatMap((r) => ["pending", "latest"].map((at) => r("eth_getCode", [w.recipient, at]))));
      if (codes.some((c) => c !== "0x")) return no(422, "recipient_code");
      // a buy reads the sender's pending balance on both providers too (the withdraws' reserve)
      const [block, t, n, m, ln, lm, ...bal] = await Promise.all([a("eth_getBlockByNumber", ["latest", false]), a("eth_maxPriorityFeePerGas", []), a("eth_getTransactionCount", [sender, "pending"]), b("eth_getTransactionCount", [sender, "pending"]), a("eth_getTransactionCount", [sender, "latest"]), b("eth_getTransactionCount", [sender, "latest"]), ...(keys === undefined ? [] : [a("eth_getBalance", [sender, "pending"]), b("eth_getBalance", [sender, "pending"])])]);
      base = qty((block as { baseFeePerGas?: unknown })?.baseFeePerGas);
      tip = qty(t);
      [pa, pb] = [qty(n), qty(m)];
      if (bal.length === 2) [balA, balB] = [qty(bal[0]), qty(bal[1])];
      behindOf(withdrawLane, qty(ln), qty(lm));
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
    // a buy's caps again with its worst cost held: the gas it can pay (the chain's L1 fee is read by the fee check,
    // card helper-evm-sender-3; a receipt's l1Fee is charged when the buy does not land)
    const worst = gas * maxFeePerGas;
    if (keys !== undefined) {
      const capped = overCap(keys, worst);
      if (capped !== null) return capped;
      // the withdraws' reserve: buys stop before the float the withdraws need is spent (EVM_WITHDRAW_RESERVE_SENDS)
      const t = now();
      for (const c of buysInFlight) if (c.at <= t - EVM_SELL_UNPAID_WINDOW_MS) buysInFlight.delete(c);
      const flying = [...buysInFlight].reduce((x, c) => x + c.wei, 0n);
      const reserve = BigInt(EVM_WITHDRAW_RESERVE_SENDS) * EVM_GAS_MAX * (2n * base + tip);
      const low = balA < balB ? balA : balB;
      // one log line when buys first stop at the reserve and one when they go again, so the operator learns of a refill
      // need from the log, not from users
      const said = `${sender}'s lower pending balance ${low} wei, reserve ${reserve} wei, buys in flight ${flying} wei`;
      if (low < reserve + flying + worst) {
        if (!reserveHeld) log(`evm ${cfg.network}: buys stop at the withdraws' reserve: ${said}; refill the sender`);
        reserveHeld = true;
        return { ...no(429, "rate_limited", `the sender keeps ${reserve} wei for withdraws: balance ${low}, buys in flight ${flying}, this buy ${worst}`), retryAfterS: EVM_LANE_RETRY_S };
      }
      if (reserveHeld) log(`evm ${cfg.network}: buys go again over the withdraws' reserve: ${said}`);
      reserveHeld = false;
    }
    // the simulation is the transaction as it will be signed: at pending, from the sender, with its gas and fee fields
    // (a call that reverts only at a real gas price is caught here, not paid for on chain)
    let sim: unknown;
    try {
      sim = await a("eth_call", [{ ...call, gas: tag(gas), maxFeePerGas: tag(maxFeePerGas), maxPriorityFeePerGas: tag(maxPriorityFeePerGas) }, "pending"]);
    } catch (e) {
      return failedInExecution(e) ? no(422, "simulation_failed", String((e as Error).message).slice(0, 200)) : unread(e);
    }
    // a buy whose swap fails no longer reverts: the pool takes the fee and pays W the rest in ETH, and buy returns false
    // (card pool-evm-buy-pays-revert). So a buy goes out only where its simulation, at this very gas limit, answers
    // exactly true: one that would land as a withdraw is refused before the note is spent (review of 68b0930a, M1)
    if (w.buy !== undefined && sim !== BUY_TRUE) return no(422, "simulation_failed", `the buy's simulation answers ${String(sim).slice(0, 80)}, not true: its swap would fail and the pool would pay W ETH`);
    const nonce = await nonceFor(withdrawLane, pa, pb);
    const { raw, hash } = signEvmTx({ chainId: id, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to: pool, data: bytes }, cfg.senderKey);
    const sent = await Promise.allSettled([a("eth_sendRawTransaction", [`0x${hex(raw)}`]), b("eth_sendRawTransaction", [`0x${hex(raw)}`])]);
    const why = sent.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
    if (why.length === sent.length) return unread(why.find((e) => throttleOf(e, true) > 0) ?? why[0]);
    const until = Number(w.deadlineMs) + EVM_POOL_SEND_MARGIN_MS;
    sentAt(withdrawLane, nonce, until, maxFeePerGas, maxPriorityFeePerGas, hash, false);
    let landed: ((ra: Record<string, unknown>, rb: Record<string, unknown>) => void) | undefined;
    if (keys !== undefined && w.buy !== undefined) {
      const held = charge(keys, worst);
      buysInFlight.add(held);
      landed = landedBuy(held, w, gas, maxFeePerGas, keys);
    }
    watch(withdrawLane, nonce, hash, until, landed);
    return { status: 200, body: { hash } };
  }
  /** POST /v1/pool/evm/sell: the static checks, none of which reads a provider, then one send per (W, Sell nonce). */
  const sellHeld = async (body: unknown, client: string | undefined): Promise<PoolEvmAnswer> => {
    if (cfg.sellKey === undefined || sellSender === null) return no(503, "not_configured", `no sell key is set for ${cfg.network}`);
    if (feeCollector === undefined) return no(503, "not_configured", `no fee collector is set for ${cfg.network}`);
    const sellKey = cfg.sellKey;
    const collector = feeCollector;
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
    // the fee goes only to the Sell's feeRecipient (SellDelegate.sol, L-1): this network's fee collector, whose Paid log
    // is the one proof of the fee (card helper-sender-fee-proof)
    if (s.feeRecipient !== collector) return no(422, "fee_recipient", `the Sell pays ${s.feeRecipient}, not the fee collector ${collector}`);
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
      if (hash === undefined || (await sendEnded(hash, Number(sellDeadline.get(prior) ?? 0n) * 1000)) === "waiting") return first;
      if (sells.get(key) === prior) sells.forget(key, prior);
    }
    const entry = sells.run(key, () => enqueue(sellLane, () => sellSend(w, data, bytes, s, auth, sellChain, sellVenue, sellDelegate, sellKey, sellSender, keys)));
    if (!sellDeadline.has(entry)) sellDeadline.set(entry, s.deadline);
    return entry;
  };
  /** How the send `hash` (a sale or a withdraw, its deadline `deadlineMs`) ended: "reverted", a receipt with status 0
   *  on either provider; "dropped", the lane's replacement took its nonce, or no receipt and no transaction on either
   *  once now is past the deadline plus EVM_SELL_DROP_MARGIN_MS; else "waiting" (a read that fails, a success, a send
   *  still pending). */
  async function sendEnded(hash: string, deadlineMs: number): Promise<"reverted" | "dropped" | "waiting"> {
    const rc = await Promise.allSettled([a("eth_getTransactionReceipt", [hash]), b("eth_getTransactionReceipt", [hash])]);
    const status = rc.map((x) => (x.status === "fulfilled" && x.value !== null && typeof x.value === "object" ? evmRpcHex((x.value as { status?: unknown }).status) : undefined));
    if (status.includes("0x1")) return "waiting";
    if (status.includes("0x0")) return "reverted";
    if (superseded.has(hash)) return "dropped";
    if (rc.some((x) => x.status === "rejected" || x.value !== null)) return "waiting";
    if (Math.floor(now()) <= deadlineMs + EVM_SELL_DROP_MARGIN_MS) return "waiting";
    const tx = await Promise.allSettled([a("eth_getTransactionByHash", [hash]), b("eth_getTransactionByHash", [hash])]);
    return tx.every((x) => x.status === "fulfilled" && x.value === null) ? "dropped" : "waiting";
  }
  const higher = (x: bigint, y: bigint) => (x > y ? x : y);
  const lower = (x: bigint, y: bigint) => (x < y ? x : y);
  /** The lane's sender's pending and latest counts on both providers. */
  const countsOf = async (lane: Lane) => {
    const [pa, la, pb, lb] = await Promise.all([a, b].flatMap((r) => ["pending", "latest"].map(async (at) => qty(await r("eth_getTransactionCount", [lane.from, at])))));
    behindOf(lane, la!, lb!);
    return { pa: pa!, pb: pb!, la: la!, lb: lb! };
  };
  /** Each provider's latest count against the nonces the lane sent: one that stays below the same sent nonce for
   *  EVM_LANE_WATCH_MS is logged once, naming the provider and the nonce (a provider that lies about receipts or counts
   *  is never silent). A count that passes it starts the watch again at the lane's next nonce. A count past the lane's next
   *  nonce (more sends than this key made) is logged once as ahead, naming the provider. */
  const behindOf = (lane: Lane, la: bigint, lb: bigint): void => {
    [la, lb].forEach((l, i) => {
      if (lane.nextNonce >= 0n && l > lane.nextNonce && !lane.ahead[i]) {
        log(`evm ${cfg.network}: provider ${i === 0 ? "a" : "b"}'s latest count for ${lane.from} is ${l}, ahead of the lane's next nonce ${lane.nextNonce}: it counts sends this key never made`);
        lane.ahead[i] = true;
      }
      let x: Behind = lane.behind[i] ?? null;
      if (x !== null && l > x.nonce) x = null;
      if (x === null && l < lane.nextNonce) x = { nonce: l, since: now(), said: false };
      if (x !== null && !x.said && now() - x.since >= EVM_LANE_WATCH_MS) {
        log(`evm ${cfg.network}: provider ${i === 0 ? "a" : "b"}'s latest count for ${lane.from} has stayed at ${x.nonce} for ${EVM_LANE_WATCH_MS / 60_000} min: the lane's send at nonce ${x.nonce} is unmined there`);
        x.said = true;
      }
      lane.behind[i] = x;
    });
  };
  /** Drops the lane's records below `mined`, the lower latest count: a nonce is mined only once both providers pass it. */
  const prune = (lane: Lane, mined: bigint): void => {
    for (const n of [...lane.sent.keys()]) if (n < mined) lane.sent.delete(n);
  };
  /** The lane's lowest record, its lowest unmined send once pruned. */
  const lowestOf = (lane: Lane): [bigint, Sent] | undefined => {
    let low: [bigint, Sent] | undefined;
    for (const e of lane.sent) if (low === undefined || e[0] < low[0]) low = e;
    return low;
  };
  /**
   * The lane's lowest nonce no tx holds, or null (card helper-evm-sender fold 4): the higher of the two pending counts,
   * when it is below the lane's next nonce (both providers count no tx there), and the lane's send there, if any, is older
   * than EVM_SELL_DROP_MARGIN_MS and neither provider returns it by hash (as a dropped sale is read).
   */
  async function holeOf(lane: Lane, pa: bigint, pb: bigint): Promise<bigint | null> {
    const n = higher(pa, pb);
    if (n >= lane.nextNonce) return null;
    const x = lane.sent.get(n);
    if (x === undefined) return n;
    if (now() - x.at <= EVM_SELL_DROP_MARGIN_MS) return null;
    const seen = await Promise.allSettled([a("eth_getTransactionByHash", [x.hash]), b("eth_getTransactionByHash", [x.hash])]);
    return seen.every((y) => y.status === "fulfilled" && y.value === null) ? n : null;
  }
  /**
   * The nonce a lane's next send takes, from its sender's pending counts on both providers (no nonce is left that no tx
   * holds, and no one provider moves the lane): the lower count when it is at or past the lane's next nonce; else the
   * lane's hole (holeOf); else the next nonce.
   */
  async function nonceFor(lane: Lane, pa: bigint, pb: bigint): Promise<bigint> {
    const lo = lower(pa, pb);
    if (lo >= lane.nextNonce) return lo;
    return (await holeOf(lane, pa, pb)) ?? lane.nextNonce;
  }
  /** A send at `nonce` that a provider took: the lane's next nonce past it, and its record (a replacement keeps the
   *  bound of the send it replaced, so sending again never reopens a lane held behind that nonce). */
  const sentAt = (lane: Lane, nonce: bigint, stuckAfter: number, maxFee: bigint, tip: bigint, hash: string, replacement: boolean, bound?: number, raw?: string): void => {
    if (nonce + 1n > lane.nextNonce) lane.nextNonce = nonce + 1n;
    const old = lane.sent.get(nonce);
    // the earlier sends at this nonce, any of which may yet be the one mined (a send the chain dropped keeps none)
    const prior = old === undefined ? [] : [...old.prior, ...(old.hash === hash ? [] : [old.hash])].slice(-EVM_LANE_PRIOR_MAX);
    lane.sent.set(nonce, { at: now(), stuckAfter, bound: bound ?? stuckAfter + EVM_LANE_WATCH_MS, maxFee, tip, hash, replacement, ...(raw === undefined ? {} : { raw }), prior, checkedAt: -Infinity });
    while (lane.sent.size > revertMemory) lane.sent.delete(lane.sent.keys().next().value as bigint);
  };
  /** Whether either provider returns a receipt for any send the lane made at the record's nonce (its own and each it
   *  replaced): the nonce is used, whatever the counts say. */
  const usedAt = async (x: Sent): Promise<boolean> => {
    const rc = await Promise.allSettled([x.hash, ...x.prior].flatMap((h) => [a("eth_getTransactionReceipt", [h]), b("eth_getTransactionReceipt", [h])]));
    return rc.some((y) => y.status === "fulfilled" && y.value !== null && typeof y.value === "object");
  };
  /** The lane's lowest unmined send when it is past its bound, else undefined: a send is unmined until both providers'
   *  latest counts pass it or either returns its receipt (a record with one is dropped here). */
  async function heldLow(lane: Lane): Promise<[bigint, Sent] | undefined> {
    const c = await countsOf(lane);
    prune(lane, lower(c.la, c.lb));
    for (;;) {
      const low = lowestOf(lane);
      if (low === undefined || now() <= low[1].bound) return undefined;
      if (!(await usedAt(low[1]))) return low;
      lane.sent.delete(low[0]);
    }
  }
  /** 503 upstream while the lane's lowest unmined send is past its bound (heldLow, read only once a record is past its
   *  bound, and at most once per block: a held answer within EVM_LANE_SENT_RETRY_S of the last read answers from it);
   *  else null. A held answer first tends the lane, at most once per EVM_LANE_RETRY_S (a send neither provider holds goes
   *  again, so the lane recovers once the chain does), and reads again after it. Its Retry-After is EVM_LANE_SENT_RETRY_S
   *  when that tend sent something, else one block while the lane's last held send is within
   *  EVM_LANE_SENT_WINDOW_MS, or the seconds to the next allowed tend if sooner, at least 1. A read that fails
   *  answers every held answer in its block alike, Retry-After at least the rest of the block. */
  async function laneHeld(lane: Lane): Promise<PoolEvmAnswer | null> {
    if (![...lane.sent.values()].some((x) => now() > x.bound)) return null;
    const block = EVM_LANE_SENT_RETRY_S * 1000;
    const read = (): HeldRead => {
      const r: HeldRead = { at: now(), low: heldLow(lane) };
      lane.heldRead = r;
      r.low.catch(() => {}); // a failed read is shared too: its whole block answers from it
      return r;
    };
    // a failed read: the provider's refusal, Retry-After at least the rest of its block
    const failed = (r: HeldRead, e: unknown): PoolEvmAnswer => {
      const u = unread(e);
      return { ...u, retryAfterS: Math.max(u.retryAfterS ?? 0, Math.max(1, Math.ceil((r.at + block - now()) / 1000))) };
    };
    // one hold read per block, shared by every held answer in it
    let r = lane.heldRead !== null && now() - lane.heldRead.at < block ? lane.heldRead : read();
    let low: [bigint, Sent] | undefined;
    try {
      low = await r.low;
    } catch (e) {
      return failed(r, e);
    }
    let sent = 0;
    if (low !== undefined && lane.key !== undefined && now() - lane.heldTendAt >= EVM_LANE_RETRY_S * 1000) {
      lane.heldTendAt = now();
      sent = await tendOnce(lane);
      if (sent > 0) lane.heldSentAt = now();
      r = read();
      try {
        low = await r.low;
      } catch (e) {
        return failed(r, e);
      }
    }
    if (low === undefined) return null;
    // a tend that sent something: try again in a block, when its receipt can be read; else, while the lane's last held
    // send is within EVM_LANE_SENT_WINDOW_MS, in a block too (its receipt may land late), and otherwise at the
    // next allowed tend
    const nextTend = lane.heldTendAt + EVM_LANE_RETRY_S * 1000;
    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS > now() ? now() + block : Infinity;
    const wait = sent > 0 ? EVM_LANE_SENT_RETRY_S : Math.max(1, Math.ceil((Math.min(nextTend, mined) - now()) / 1000));
    return { ...no(503, "upstream", `the sender's nonce ${low[0]} is unmined past its watch`), retryAfterS: wait };
  }
  /** One tend of the lane, run now (on the lane's queue), to how many sends it made; a tend that fails logs once until
   *  one runs through. */
  const tendOnce = (lane: Lane): Promise<number> => {
    const made = { n: 0 };
    return tendNow(lane, made).then(
      () => {
        lane.failSaid = false;
        return made.n;
      },
      (e: unknown) => {
        if (!lane.failSaid) log(`evm ${cfg.network}: ${lane.from}'s tend failed: ${String((e as Error | undefined)?.message ?? e).slice(0, 200)}`);
        lane.failSaid = true;
        return made.n;
      },
    );
  };
  /** One tend of the lane, queued behind its sends; a tend already queued answers every ask until it runs. */
  const tend = (lane: Lane): void => {
    if (lane.tending || lane.key === undefined) return;
    lane.tending = true;
    lane.queue = lane.queue
      .then(() => tendOnce(lane))
      .finally(() => {
        lane.tending = false;
      });
  };
  /**
   * The lane's nonces sent again, lowest first, each as a 0-value transfer to the sender itself: every unmined send (on
   * both providers' latest counts) past its deadline plus the margin or its nonce's bound, then its hole (holeOf). A stuck
   * send's reads run at most once per EVM_SELL_DROP_MARGIN_MS; one with a receipt on either provider, for it or any send it
   * replaced (usedAt), is dropped, its nonce used. One neither provider returns by hash (dropped from both) goes
   * again whatever its price (a replacement whose price covers, below, as the same tx). A send of the lane's own still
   * held is replaced once whatever its price; a replacement still held is raised again only while stuck on price: its
   * maxFeePerGas under 2 x the base fee (the providers' higher) + the tip (their higher eth_maxPriorityFeePerGas), or its
   * tip under that tip. The new tip is max(the old x 11/10 + 1, that tip), the new maxFeePerGas max(the old x 11/10 + 1, 2 x base + the new tip) (a node replaces a pending
   * tx only for more than a tenth over), never over EVM_SELL_MAX_FEE_PER_GAS (over it nothing more is sent and the lane
   * logs once). Its gas is EVM_SELF_TRANSFER_GAS, and on Arbitrum (Robinhood) the L1 poster's gas too: the kit's chain
   * fee read (ArbGasInfo) on both providers, the higher, over the lower base fee, plus a fifth (the estimate moves
   * between the read and the block). A replacement both providers refuse fails the tend.
   */
  async function tendNow(lane: Lane, made: { n: number } = { n: 0 }): Promise<void> {
    const key = lane.key!;
    const { pa, pb, la, lb } = await countsOf(lane);
    prune(lane, lower(la, lb));
    // stuck: past its deadline plus the margin, or past its nonce's bound (a held lane's send, however recent)
    const todo: [bigint, Sent | undefined, boolean][] = [...lane.sent].filter(([, x]) => now() > x.stuckAfter || now() > x.bound).map(([n, x]) => [n, x, true]);
    const hole = await holeOf(lane, pa, pb);
    if (hole !== null && !todo.some(([n]) => n === hole)) todo.push([hole, lane.sent.get(hole), false]);
    if (todo.length === 0) return;
    todo.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    const [ba, bb, ta, tb] = await Promise.all([a("eth_getBlockByNumber", ["latest", false]), b("eth_getBlockByNumber", ["latest", false]), a("eth_maxPriorityFeePerGas", []), b("eth_maxPriorityFeePerGas", [])]);
    const [xa, xb] = [qty((ba as { baseFeePerGas?: unknown } | null)?.baseFeePerGas), qty((bb as { baseFeePerGas?: unknown } | null)?.baseFeePerGas)];
    const base = higher(xa, xb);
    const tipNow = higher(qty(ta), qty(tb));
    const raise = (v: bigint) => (v * 11n) / 10n + 1n;
    const id = await chain();
    for (const [n, old, stuck] of todo) {
      let again = false;
      if (stuck) {
        // its reads at most once per margin, however often the lane is tended
        if (now() - old!.checkedAt < EVM_SELL_DROP_MARGIN_MS) continue;
        old!.checkedAt = now();
        if (await usedAt(old!)) {
          lane.sent.delete(n);
          continue;
        }
        const seen = await Promise.allSettled([a("eth_getTransactionByHash", [old!.hash]), b("eth_getTransactionByHash", [old!.hash])]);
        const gone = seen.every((y) => y.status === "fulfilled" && y.value === null);
        // a replacement that covers 2 x base + tip, in its maxFeePerGas and its tip, is not stuck on price: left to be
        // mined while a provider holds it, else broadcast again as it was (the same tx, so a node holding it still takes it)
        const covers = old!.replacement && old!.maxFee >= 2n * base + tipNow && old!.tip >= tipNow;
        if (covers && !gone) continue;
        again = covers && old!.raw !== undefined;
      }
      if (again) {
        // the same signed bytes, broadcast again: its hash, fee fields and gas unchanged
        const raw = old!.raw!;
        const sent = await Promise.allSettled([a("eth_sendRawTransaction", [raw]), b("eth_sendRawTransaction", [raw])]);
        if (sent.every((x) => x.status === "rejected")) throw new Error(`both providers refused the replacement at nonce ${n} again: ${String((sent[0] as PromiseRejectedResult).reason).slice(0, 120)}`);
        made.n++;
        const until = now() + EVM_SELL_DROP_MARGIN_MS;
        sentAt(lane, n, until, old!.maxFee, old!.tip, old!.hash, true, old!.bound, raw);
        watch(lane, n, old!.hash, until);
        continue;
      }
      const tip = old === undefined ? tipNow : higher(tipNow, raise(old.tip));
      const maxFee = higher(2n * base + tip, old === undefined ? 0n : raise(old.maxFee));
      if (maxFee > EVM_SELL_MAX_FEE_PER_GAS) {
        if (!lane.ceilingSaid) log(`evm ${cfg.network}: ${lane.from}'s nonce ${n} is not replaced: its fee ${maxFee} wei per gas is over EVM_SELL_MAX_FEE_PER_GAS ${EVM_SELL_MAX_FEE_PER_GAS} (base fee ${base})`);
        lane.ceilingSaid = true;
        return;
      }
      let gas = EVM_SELF_TRANSFER_GAS;
      if (POSTER_GAS_CHAINS.has(cfg.network)) {
        const net = cfg.network as EvmPoolChain;
        const txBytes = BigInt(evmTx4MaxLength({ chainId: id, nonce: n, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gas: 1n << 32n, to: lane.from, data: new Uint8Array(), authorizations: [] }));
        const reads = evmPoolChainFeeReads(net, EVM_SELF_TRANSFER_GAS, txBytes);
        const fees = await Promise.all([a, b].map(async (r) => evmPoolChainFee(net, txBytes, await Promise.all(reads.map(async (at) => {
          const h = evmRpcHex(await r("eth_call", [at, "latest"]));
          if (h === null || !/^0x[0-9a-f]{64}$/.test(h)) throw new Error("not a word");
          return BigInt(h);
        })))));
        const l1 = higher(fees[0]!, fees[1]!);
        const baseLow = lower(xa, xb);
        if (l1 > 0n && baseLow === 0n) throw new Error("a base fee of 0 prices no poster gas");
        const poster = l1 === 0n ? 0n : (l1 + baseLow - 1n) / baseLow;
        gas += poster + (poster + 4n) / 5n;
      }
      const { raw, hash } = signEvmTx({ chainId: id, nonce: n, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gas, to: lane.from, data: new Uint8Array() }, key);
      const sent = await Promise.allSettled([a("eth_sendRawTransaction", [`0x${hex(raw)}`]), b("eth_sendRawTransaction", [`0x${hex(raw)}`])]);
      if (sent.every((x) => x.status === "rejected")) throw new Error(`both providers refused the replacement at nonce ${n}: ${String((sent[0] as PromiseRejectedResult).reason).slice(0, 120)}`);
      made.n++;
      lane.ceilingSaid = false;
      if (old !== undefined) {
        superseded.add(old.hash);
        while (superseded.size > revertMemory) superseded.delete(superseded.values().next().value as string);
      }
      const until = now() + EVM_SELL_DROP_MARGIN_MS;
      sentAt(lane, n, until, maxFee, tip, hash, true, old?.bound, `0x${hex(raw)}`);
      watch(lane, n, hash, until);
    }
  }
  /**
   * Reads a lane's send's receipt on both providers in the background, first after cfg.receiptPollMs
   * (EVM_SELL_RECEIPT_POLL_MS), the wait doubling to EVM_RECEIPT_POLL_BACKOFF times it. A receipt ends it (`landed` reads
   * it) and drops the send's record; a watch with `landed` (a sale's) reads on until both providers have returned the
   * receipt, each provider's latest kept, and only then calls `landed` with the two (card helper-sender-fee-proof: one
   * provider's receipt never clears a charge; past the bound with one only, `landed` is never called); another send
   * taking its nonce (a replacement) ends it; its record's bound (`until` +
   * EVM_LANE_WATCH_MS, or the bound a replacement kept from the send it replaced) ends it, with one log line from the
   * watch that saw the bound come (one started past it, a held answer's tend, ends without). A send unmined past the
   * margin has its lane tended at each read (a hole behind it is filled, it is replaced past `until`).
   */
  function watch(lane: Lane, nonce: bigint, hash: string, until: number, landed?: (ra: Record<string, unknown>, rb: Record<string, unknown>) => void): void {
    const first = cfg.receiptPollMs ?? EVM_SELL_RECEIPT_POLL_MS;
    const sent = now();
    const mine = lane.sent.get(nonce);
    const bound = mine?.bound ?? until + EVM_LANE_WATCH_MS;
    let every = first;
    // each provider's receipt, its latest answer: a sale's watch reads on until both have one
    const seen: [Record<string, unknown> | null, Record<string, unknown> | null] = [null, null];
    let used = false;
    const tick = async (): Promise<void> => {
      const rc = await Promise.allSettled([a("eth_getTransactionReceipt", [hash]), b("eth_getTransactionReceipt", [hash])]);
      rc.forEach((x, i) => {
        if (x.status === "fulfilled" && x.value !== null && typeof x.value === "object") seen[i] = x.value as Record<string, unknown>;
      });
      if (seen[0] !== null || seen[1] !== null) {
        if (!used) lane.sent.delete(nonce); // a receipt for any send at the nonce: it is used
        used = true;
        if (landed === undefined) return;
        if (seen[0] !== null && seen[1] !== null) return landed(seen[0], seen[1]);
        // one provider's receipt only: read on until the other returns it, never past the bound
        if (now() > bound) return;
      } else {
        if (mine === undefined || lane.sent.get(nonce) !== mine) return;
        if (now() > bound) {
          if (sent <= bound) log(`evm ${cfg.network}: ${lane.from}'s nonce ${nonce} (${hash}) is unmined past its watch; new sends wait for it`);
          return;
        }
        if (now() - sent > EVM_SELL_DROP_MARGIN_MS) tend(lane);
      }
      every = Math.min(every * 2, first * EVM_RECEIPT_POLL_BACKOFF);
      setTimeout(() => void tick(), every).unref?.();
    };
    setTimeout(() => void tick(), every).unref?.();
  }
  /** A sale's two receipts, one per provider, turn its held worst cost into what went unpaid (evmSaleUnpaid), and a
   *  sale proven paid marks its W and client; any other marks nothing. A sale whose receipt both providers never return
   *  keeps its worst cost held for the window. */
  const landedSale = (held: Charge, s: EvmSell, w: string, maxFeePerGas: bigint, keys: readonly string[]) => (ra: Record<string, unknown>, rb: Record<string, unknown>): void => {
    const r = evmSaleUnpaid(ra, rb, { collector: feeCollector!, w, fee: s.fee, maxFeePerGas }, held.wei);
    held.wei = r.unpaid;
    if (!r.paid) return;
    for (const k of keys) {
      if (!k.startsWith("w:") && !k.startsWith("c:")) continue;
      paid.delete(k);
      paid.set(k, now());
    }
    while (paid.size > revertMemory) paid.delete(paid.keys().next().value as string);
  };
  /** A buy's two receipts, one per provider, turn its held worst cost into what went unpaid (evmBuyUnpaid): 0 once both
   *  read status 1 and the pool's Bought log of this buy, which marks its W and client as a paid sale does; else its whole
   *  cost. A buy whose receipt both providers never return keeps its worst cost held for the window. */
  const landedBuy = (held: Charge, w: EvmRelease, gas: bigint, maxFeePerGas: bigint, keys: readonly string[]) => (ra: Record<string, unknown>, rb: Record<string, unknown>): void => {
    buysInFlight.delete(held);
    const r = evmBuyUnpaid(ra, rb, { pool, w: w.recipient, feeRecipient: w.feeRecipient, fee: w.fee, nullifier: w.nullifier, token: w.buy!.token, gas, maxFeePerGas }, held.wei);
    held.wei = r.unpaid;
    if (!r.proven) return;
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
    let id: bigint, base: bigint, baseLow: bigint, pa: bigint, pb: bigint;
    try {
      const stuck = await laneHeld(sellLane);
      if (stuck !== null) return stuck;
      id = await chain();
      if (id !== BigInt(venue.chainId)) return no(503, "upstream", `the providers name chain ${id}, not ${venue.chainId}`);
      const [ba, bb, wa, wb, n, m, ln, lm] = await Promise.all([a("eth_getBlockByNumber", ["latest", false]), b("eth_getBlockByNumber", ["latest", false]), a("eth_getTransactionCount", [w, "pending"]), b("eth_getTransactionCount", [w, "pending"]), a("eth_getTransactionCount", [from, "pending"]), b("eth_getTransactionCount", [from, "pending"]), a("eth_getTransactionCount", [from, "latest"]), b("eth_getTransactionCount", [from, "latest"])]);
      const [x, y] = [qty((ba as { baseFeePerGas?: unknown } | null)?.baseFeePerGas), qty((bb as { baseFeePerGas?: unknown } | null)?.baseFeePerGas)];
      base = x > y ? x : y;
      baseLow = x < y ? x : y;
      const [na, nb] = [qty(wa), qty(wb)];
      if (na !== auth.nonce || nb !== auth.nonce) return no(422, "auth_nonce", `W's pending nonce ${na} and ${nb}, the authorization's ${auth.nonce}`);
      [pa, pb] = [qty(n), qty(m)];
      behindOf(sellLane, qty(ln), qty(lm));
    } catch (e) {
      return unread(e);
    }
    const nonce = await nonceFor(sellLane, pa, pb);
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
    sentAt(sellLane, nonce, until, maxFeePerGas, tip, hash, false);
    watch(sellLane, nonce, hash, until, landedSale(charge(keys, worst), s, w, maxFeePerGas, keys));
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
      return { chain: "evm", network: cfg.network, pool, fee_recipient: feeRecipient, sell_sender: sellSender, fee_collector: feeCollector ?? null, epoch_ms: POOL_EPOCH_MS, epoch_start_ms: epoch, block: tag(f.block.number), fee: f.fee.toString(), step: EVM_FEE_STEP.toString() };
    },
    carry,
    sell,
    async ready(sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
      // each call asked again only on a throttle or a timeout, at most EVM_READY_TRIES times
      const patient = (rpc: EvmRpc): EvmRpc => async (method, params) => {
        for (let t = 1; ; t++) {
          try {
            return await rpc(method, params);
          } catch (e) {
            if (t >= EVM_READY_TRIES || !askAgain(e)) throw e;
            await sleep(EVM_READY_WAIT_MS * 2 ** (t - 1));
          }
        }
      };
      const [pa, pb] = [patient(a), patient(b)];
      const on = <T>(k: 1 | 2, p: Promise<T>): Promise<T> => p.catch((e: Error) => Promise.reject(new Error(`rpc ${k}: ${e.message}`)));
      const block = await on(1, evmFirstBlockAtOrAfter(pa, BigInt(Math.ceil((now() - POOL_LIFE_MAX_MS) / 1000))));
      if (block === null) throw new Error(`rpc 1: no block in the last ${POOL_LIFE_MAX_MS / 1000} s`);
      const same = await on(2, pb("eth_getBlockByNumber", [tag(block.number), false]).then(blockOf));
      if (same.hash !== block.hash) throw new Error(`rpc 2: another block at ${block.number}`);
      // the reads feeOf makes, each on each provider alone, so the refusal names the one that cannot answer
      const reads = [{ to: pool, data: TREE_DEPTH_DATA }, ...evmPoolChainFeeReads(cfg.network, evmPoolGas(0))];
      for (const [k, rpc] of [pa, pb].entries()) {
        for (const r of reads) {
          try {
            if (firstWord(await rpc("eth_call", [{ to: r.to, data: r.data }, { blockHash: block.hash }])) === null) throw new Error("not a word");
          } catch (e) {
            throw new Error(`rpc ${k + 1}: no answer to ${r.data.slice(0, 10)} at ${r.to} at block ${block.number}, ${Math.round(now() / 1000) - Number(block.timestamp)} s old (a proof's fee is read up to ${POOL_LIFE_MAX_MS / 1000} s back): ${(e as Error).message}`);
          }
        }
      }
    },
  };
}

/** An eth_call answer's first 32-byte word (0x and 64 hex), or null: feeOf's viewAt and ready() take the same answers. */
const firstWord = (v: unknown): string | null => {
  const h = evmRpcHex(v);
  return h === null || h.length < 66 ? null : h.slice(0, 66);
};
/** How many times ready() asks one call that a provider throttled or let time out, and the first wait between: a 429 at
 *  a deploy's start is a moment's limit, not a refusal. A refusal exits 2 before the helper is ready (server.ts
 *  poolsChecked), so redeploy.sh keeps the old helper serving and the deploy needs a rerun. */
const EVM_READY_TRIES = 3;
const EVM_READY_WAIT_MS = 1_000;
/** A throttle (limits.ts throttleOf: HTTP 429, a rate-limit message, EIP-1474's -32005; the kit client's other
 *  throttle codes) or a timeout: the provider's moment, which ready() asks again. A missing state is neither. */
const askAgain = (e: unknown): boolean => {
  const m = String((e as Error | undefined)?.message ?? e);
  return throttleOf(e, true) > 0 || /^RPC error (-32029|-32429|-429|15):/.test(m) || (e as Error | undefined)?.name === "TimeoutError" || /no answer in \d+ ms|aborted due to timeout|timed? ?out/i.test(m);
};

/** Per network: the pool, the sender's key (0x + 64 hex, gas only), the fee's floor (unset, or the kit's
 *  EVM_POOL_FEE_FLOOR), its recipient, two RPC URLs. */
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
 * Per network: the fee collector every Sell must pay (card helper-sender-fee-proof; card evm-fee-collector's keyless
 * FeeCollector, its Paid log the proof of a sale's fee). Unset: that network's sells answer 503 not_configured.
 */
export const POOL_EVM_COLLECTOR_ENV = {
  base: "POOL_EVM_FEE_COLLECTOR_BASE",
  robinhood: "POOL_EVM_FEE_COLLECTOR_ROBINHOOD",
  "base-sepolia": "POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA",
  "robinhood-testnet": "POOL_EVM_FEE_COLLECTOR_ROBINHOOD_TESTNET",
} as const;

/**
 * One spelling for an RPC URL (card robinhood-mainnet-rpcs, review L-3): what the URL parser writes, the bare origin
 * when there is no path, query, fragment or userinfo, so `https://robinhood.drpc.org/` is the pace's and the holds' key
 * `https://robinhood.drpc.org` (PROVIDER_PACE, the /v1/rpc proxy's pinned URLs), never a second provider with no pace.
 * A URL that does not parse is left as written; its operator is none and the start refuses it.
 */
export function evmRpcUrlOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" && u.search === "" && u.hash === "" && u.username === "" && u.password === "" ? u.origin : u.href;
  } catch {
    return url;
  }
}

/**
 * `rpc` (provider `url`'s client) drawn from the helper's one pace and hold for that provider (card
 * robinhood-mainnet-rpcs; helper-evm-sender review 4 Nov 22:38Z, L1): each call waits while the provider is held, then
 * takes its post from the sender's reserve (limits.ts take with `sender`: down to empty, where callers' reads stop at
 * SENDER_ROOM and background at CALLER_ROOM, fold A), so no crowd of /v1/rpc callers holds a withdraw past one post's
 * refill, and it never spends the provider's limit outside the pace, however often a halted chain's reads are asked
 * again; a throttle it is answered holds the provider for every path (its Retry-After, else 1 s). A provider with no
 * pace (an env URL of the host's own) is only held.
 */
export function pacedEvmRpc(url: string, rpc: EvmRpc, holds: ProviderHolds, sleep: (ms: number) => Promise<void> = (ms) => new Promise((go) => setTimeout(go, ms))): EvmRpc {
  holds.reserve(url);
  return async (method, params) => {
    for (;;) {
      const h = holds.heldMs(url);
      const w = h > 0 ? h : holds.take(url, 1, false, true);
      if (w === 0) break;
      await sleep(w);
    }
    try {
      return await rpc(method, params);
    } catch (e) {
      if (throttleOf(e, true) > 0) {
        const after = (e as { afterMs?: unknown }).afterMs;
        holds.hold(url, typeof after === "number" && after > 0 ? Math.min(Math.ceil(after / 1000), RETRY_AFTER_MAX_S) : 1);
      }
      throw e;
    }
  };
}

/**
 * The EVM pool senders the host's environment sets, by pool address; a network with none of its names set is off (a
 * sell key set alone is refused). A network whose venue in the kit (`venues`, the kit's own list) pins a sell sender
 * starts only with that sell key: the device sims each sale as sent from the pin (the kit's checks/evm/quote.ts
 * simmedSells), so a sale from any other key would run where the sim did not. With no sell key, or on a chain whose venue
 * pins no sell sender (the sell key is then not used), the network starts and refuses every sell (503 not_configured).
 * `holds`: the helper's one pace and hold per provider (limits.ts providerHolds), which each sender's reads draw on
 * (pacedEvmRpc); the server passes its own, shared with the swap, maker and /v1/rpc reads.
 */
export function evmPoolSendersFromEnv(env: Record<string, string | undefined>, venues: Readonly<Partial<Record<string, EvmPoolVenue>>> = evmPoolVenues(), holds?: ProviderHolds): Map<string, EvmPoolSender> {
  const out = new Map<string, EvmPoolSender>();
  for (const [network, names] of Object.entries(POOL_EVM_ENV)) {
    const [pool, key, fee, feeTo, rpcs] = names.map((n) => env[n] ?? "");
    const sellName = POOL_EVM_SELL_ENV[network as keyof typeof POOL_EVM_SELL_ENV];
    const sellKey = env[sellName] ?? "";
    const collectorName = POOL_EVM_COLLECTOR_ENV[network as keyof typeof POOL_EVM_COLLECTOR_ENV];
    const collector = env[collectorName] ?? "";
    if (pool === "" && key === "" && fee === "" && feeTo === "" && rpcs === "") {
      if (sellKey !== "") throw new Error(`${sellName} is set but ${network}'s pool is not`);
      if (collector !== "") throw new Error(`${collectorName} is set but ${network}'s pool is not`);
      continue;
    }
    if (collector !== "" && !/^0x[0-9a-fA-F]{40}$/.test(collector)) throw new Error(`${collectorName} must be an address`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool!)) throw new Error(`${names[0]} must be an address`);
    if (!/^0x[0-9a-f]{64}$/.test(key!)) throw new Error(`${names[1]} must be 0x and 64 lowercase hex`);
    if (sellKey !== "" && !/^0x[0-9a-f]{64}$/.test(sellKey)) throw new Error(`${sellName} must be 0x and 64 lowercase hex`);
    if (sellKey !== "" && sellKey === key) throw new Error(`${sellName} must not be ${names[1]}: sells have their own key`);
    // one floor (card evm-buy-hookdata-fee, review fold 2 LOW-A): the kit's, which the device's rule applies too; an env
    // value that differs would refuse every bind whose fee is under it, or do nothing, so it is refused
    if (fee !== "" && fee !== EVM_POOL_FEE_FLOOR.toString()) throw new Error(`${names[2]} must be unset or the kit's floor, ${EVM_POOL_FEE_FLOOR} wei (EVM_POOL_FEE_FLOOR)`);
    // every read the sender makes is at a past block (feeOf, viewAt and ready() at an epoch's first block, up to
    // POOL_LIFE_MAX_MS back): unset, the kit's fee pair for the network (evmPoolVenues feeProviders, card
    // evm-quote-warm-round fold 8), never the quote's providers, some of which keep no state that far back; set, two
    // URLs of the host's own, which ready() holds to the same 600 s before the sender serves
    const v = Object.hasOwn(venues, network) ? venues[network] : undefined;
    const pair = v !== undefined && Object.hasOwn(v, "feeProviders") ? v.feeProviders : undefined;
    if (rpcs === "" && pair === undefined) throw new Error(`${names[4]} must be set: the kit lists no fee providers for ${network}`);
    const urls = (rpcs === "" ? [...pair!] : rpcs!.split(",")).map(evmRpcUrlOf);
    if (urls.length !== 2 || urls[0] === urls[1]) throw new Error(`${names[4]} must be two different RPC URLs`);
    // fold B: two operators, by the kit's one rule (evmRpcOperator, card robinhood-mainnet-rpcs review L-2): two URLs of
    // one operator are one word
    const ops = urls.map(evmRpcOperator);
    if (ops.includes(null)) throw new Error(`${names[4]} must be two http or https URLs`);
    if (ops[0] === ops[1]) throw new Error(`${names[4]} must be two RPC URLs of two operators: both are ${ops[0]}`);
    // a plain JSON-RPC client, drawn from the helper's pace for its provider when the server gives one
    const providers = urls.map((u) => {
      const r = solanaJsonRpc(u) as unknown as EvmRpc;
      return holds === undefined ? r : pacedEvmRpc(u, r, holds);
    }) as [EvmRpc, EvmRpc];
    const pin = v !== undefined && Object.hasOwn(v, "sellSender") ? v.sellSender : undefined;
    // sales go only from the pin: a chain with none starts with sales off, never with an unpinned key
    const sells = sellKey !== "" && pin !== undefined;
    const s0 = evmPoolSender({ network, pool: pool!, senderKey: unhex(key!.slice(2)), ...(sells ? { sellKey: unhex(sellKey.slice(2)) } : {}), ...(feeTo === "" ? {} : { feeRecipient: feeTo! }), ...(collector === "" ? {} : { feeCollector: collector }), venues }, providers);
    // the start's refusal names the variable and the host whose provider cannot answer the fee's reads: the host only,
    // since a provider's URL may carry its key in the path or the query (Alchemy's /v2/<key>, Infura's /v3/<key>)
    const s: EvmPoolSender = { ...s0, ready: (sleep) => s0.ready(sleep).catch((e: Error) => Promise.reject(new Error(`${names[4]}: ${e.message.replace(/^rpc ([12]):/, (_, k: string) => `${new URL(urls[Number(k) - 1]!).host}:`)}`))) };
    if (pin !== undefined && s.sellSender !== null && pin.toLowerCase() !== s.sellSender) throw new Error(`${sellName} is not the key of the kit's pinned sell sender for ${network} (${pin})`);
    // the collector is the kit's pin or unset (card helper-sender-fee-proof, review M1): a sale is counted paid by the
    // Paid log of the collector set here, so any other address would let every sale read as paid while the sell sender
    // pays its gas; a chain whose venue pins none (the mainnets until their collectors deploy) takes no collector
    const collectorPin = v !== undefined && Object.hasOwn(v, "feeCollector") ? v.feeCollector : undefined;
    if (collector !== "" && (collectorPin === undefined || collector.toLowerCase() !== collectorPin.toLowerCase())) throw new Error(`${collectorName} is not the kit's pinned fee collector for ${network} (${collectorPin ?? "none pinned"})`);
    out.set(s.pool, s);
  }
  return out;
}
