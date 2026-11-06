// The EVM pool as a pool of the proof queue (card notes-per-pool-evm; architecture v2, M349-M357). It implements
// ./pool.ts with the rules of contracts/pool-evm (PrivacyPoolSimple on Base and Robinhood, native ETH), read from its
// source:
//
// - scope: keccak256(abi.encodePacked(address(this), block.chainid, _asset)) mod p (src/State.sol:105), the asset the
//   native one (src/lib/Constants.sol:8, src/PrivacyPoolSimple.sol:46). The sync also reads SCOPE() on both RPCs and
//   refuses a pool whose SCOPE is not that (a pin of another chain or asset).
// - W: W_{evm, l, j}, EIP-55 of its secp256k1 public key (derive/keys.ts evmAddress); bind refuses an address that is not
//   that, the zero address and the pool (src/PrivacyPool.sol:176-177).
// - The tree sync reads the pool's own events, in log order: Deposited (src/interfaces/IPrivacyPool.sol:65-67: data
//   _commitment, _label, _value, _precommitmentHash) adds one state leaf and one label (src/PrivacyPool.sol:101-108);
//   Withdrawn (IPrivacyPool.sol:78-85) and Bought (IPrivacyPool.sol:253-262) each add one state leaf, _newCommitment
//   (src/PrivacyPool.sol:263 via _spendChecked, src/PrivacyPool.sol:130-137, src/PrivacyPoolSimple.sol:68-77). Each
//   method inserts before it emits and is nonReentrant (src/State.sol:83-88), so the events' order is the inserts'
//   order. The topics are keccak256 of the event signatures, computed here.
// - Two tags (M371 (1)): the cache only ever holds leaves of blocks up to EVM_POOL_TAG (finalized), which never move;
//   every read past it (the tail, finalized + 1 to the newest block both RPCs agree on) is read again on every round
//   and never kept. A finalized block lags its head by ~155 s to ~1,376 s on Base Sepolia and Robinhood testnet (read
//   3 Nov 04:46Z), past an epoch's 210 s life, so the roots, the time and the epoch's first block are read at the
//   newest agreed block: the lower of the two RPCs' EVM_NEWEST_TAG (latest) blocks, read by number on both, the same
//   hash on both (two blocks at that height on the two RPCs is a retry). A root of a tail a reorg later drops makes the
//   pool refuse the transaction (UnknownStateRoot: the root was never recorded on the chain that stays) and moves no
//   money; the next round reads the new tail, so a reorged leaf never enters the cache.
// - Each sync round reads at two anchors, each read by number on both RPCs with one hash on both: the finalized one
//   (the lower of the two RPCs' EVM_POOL_TAG blocks; two hashes there are refused) and the newest one above.
//   eth_getLogs takes a block range, not a hash (EIP-234's blockHash filter is one block a call, so a pool of N blocks
//   would need N calls), so every page is a range that ends at or below the newest anchor; a log in either anchor's
//   block must carry that anchor's hash, and both RPCs' lists must agree byte for byte (every field
//   the device reads). Each RPC pages on its own: any refusal of a page over one block but a head lag halves that
//   RPC's page (or takes it to the span the refusal names, CAP_SPANS) and tries again, down to one block, and a full page read doubles it again, so no provider's cap, in any
//   words (200 blocks on sepolia.base.org, 50,000 on publicnode, read 3 Nov 05:35Z; Tenderly's 1,000 as "invalid
//   params", 5 Nov), is a limit on the pool. A page of one block refused is that provider's true failure. A log in the
//   finalized anchor's block must carry its hash; one in the newest anchor's block that names another hash goes to the
//   reorg-or-lie test below.
// - The pool's state at the newest anchor, read with eth_call at its hash (EIP-1898) on both RPCs, first, before the
//   logs (a pruning node keeps recent state only: Robinhood's publicnode about 30 s, so never at the finalized block):
//   currentRoot, currentTreeSize, currentLabelRoot and
//   currentLabelTreeSize (src/State.sol:115-142) must agree on both, and the trees the device builds from every leaf up
//   to the anchor must have exactly that size and root, so a log dropped or changed on both RPCs is refused too. Only then does the
//   cache take the leaves up to the finalized anchor. A mismatch (between the two RPCs' logs, or with the views) while
//   the newest anchor's height holds another hash on either RPC is a reorg under the read: a retry, never an answer.
// - trees(beforeMs), duty 2 of pool.ts: refused (a retry) until the anchor's block time reached beforeMs, so every
//   leaf under the cut is in. The cut keeps the leaves whose block's timestamp * 1000 is below beforeMs (block times
//   read on both RPCs, by hash). The epoch root is the root the pool recorded with that block's time: the pool keeps
//   every root with the block time it was made at (src/State.sol:63-65, 172, 188), and the tap accepts a root only if
//   that time is set (src/State.sol:198-209), so stateRootTimes(root) and labelRootTimes(labelRoot) read at the
//   anchor on both RPCs must equal the cut's last leaf's block time. That is the pool's own record of the epoch root,
//   readable without the cut block's historical state.
// - A lagging RPC is a retry, never an answer: a tag block below beforeMs, an anchor block one RPC does not know yet, a
//   pool state call at a hash it does not know or no longer keeps (PRUNED), a log page past its own head (HEAD_LAG),
//   or one RPC's logs a strict prefix of the other's lacking only logs past the finalized anchor (its log index a
//   moment behind), waits EVM_LAG_WAIT_MS (ended at once by an abort) and reads again, at most EVM_LAG_TRIES times.
//   Two RPCs that answer differently at one hash are refused at once. A throttle or no answer in time on one read that
//   is not a page (a block, a view, a chain id, on the pool's pair or the fee pair) is the same read again, within
//   EVM_POOL_READ_BOUND_MS, a bound from the life; then the op fails by the read's name (EvmUnansweredError, card
//   evm-pool-reads-throttle). Each two-RPC read runs under one
//   AbortController: when one side fails the other stops, and both settle before the read fails.
// - Time (M373 (2)): now() is the newest block both RPCs agree on (evmAgreedBlock), never one RPC's word; bind's
//   send-margin check takes the higher of the two RPCs' latest times (evmLatestHigh), so a lie can only refuse. The
//   epoch's first block is searched below that agreed block, and bind reads the depth on that block's own chain.
// - bind: the pool's context (src/PrivacyPool.sol:236; src/interfaces/IPrivacyPool.sol:26-51):
//   keccak256(abi.encode(Withdrawal{processooor: the pool, data: abi.encode(RelayData)}, SCOPE)) mod p, RelayData
//   exactly 192 bytes (src/PrivacyPool.sol:150-153): recipient W, feeRecipient (the pinned one), feeCap (the epoch's
//   fee), deadlineMs uint64 (the epoch grid's), refundPrecommitment (bound, unused by withdraw), salt bytes16. One proof
//   serves withdraw and buy alike (the same context; src/PrivacyPoolSimple.sol:56-59), W's signature at the tap picks.
// - The epoch fee: the device computes it itself from its own reads, never the helper's word, and the helper's answer
//   must be exactly that number (M355 (2)). The reads: the epoch's first block (the first at or after its start, the
//   same hash on both RPCs) and the state tree's depth at that block, from the leaves both RPCs agree on (M356 (4),
//   M357 (3)). The formula is the kit's one definition (G(depth) and the rest of M356 (4)); see EvmEpochFeeRule.
// - Epochs of 60 s (M350 (1)) and a life of 2E + 60 s + 2 TAKE_SLACK_MS = 210 s: EVM's send margin is 60 s (M356 (1)).
// - Until card evm-pool-fee-kit (M371 (2)): the epoch fee formula is the caller's EvmEpochFeeRule and EVM_SEND_MARGIN_MS
//   is this file's; that card makes both kit constants (the full M356 (4) EVM fee and the send margin, which the helper
//   imports too), and this file then imports them and drops EvmEpochFeeRule.
// - Two RPCs are two providers: the kit's solanaSameProvider (one function, or one URL) refuses one passed twice.
// - A restore (./evm-restore.ts) reads the same agreed events (events()), then each W's Transfer logs (evmTokensSentTo)
//   through the same pager and the same two-RPC compare (evmAgreedLogs): one rule for every log the device reads.
// Nothing here holds a secret, and no read names a note of the user's: only the pool's own logs and views. The one read
// that names a wallet is evmTokensSentTo, one W a call, for the restore.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_POOL_TX_BYTES, evmPoolChainFee, evmPoolChainFeeReads, evmPoolGas, SOLANA_RPC_RETRY, solanaSameProvider, VAULT_FIELD_P, VaultTree, type SolanaRpc } from "@blindfill/kit";
import { evmAddress } from "../derive/index.ts";
import type { Ladder } from "./ladder.ts";
import { TAKE_SLACK_MS, type Pool, type PoolTrees } from "./pool.ts";

/** One JSON-RPC call on one EVM provider (the kit's JSON-RPC client shape, solanaJsonRpc, which speaks any JSON-RPC). */
export type EvmRpc = SolanaRpc;

/** ETH's ladder: one = the pool's MIN_DEPOSIT, 0.0001 ETH (src/PrivacyPool.sol:53), from 0.001 ETH = 10 x one, as
 * SOL_LADDER's smallest chunk is 0.01 SOL = 10 x the Solana program's MIN_DEPOSIT (./solana.ts SOL_LADDER) [design:
 * the owner's $2 floor, OD:268, in kind]. Against the gas a release costs: the dearest release, a buy through
 * SwapRouter02 at depth 32, is 1,332,356 gas (contracts/pool-evm/NOTICE, the gas table); at the base fees read on
 * 3 Nov 05:00Z on two RPCs each (Base 0.005 gwei, Robinhood 0.0201 gwei) that is 6.7e12 and 2.7e13 wei, so M356 (4)'s
 * 2 x (G x basefee), before the L1 fee, is 1.3% and 5.4% of 0.001 ETH, far under the pool's 50% backstop. */
export const EVM_LADDER: Ladder = Object.freeze({ one: 100_000_000_000_000n, min: 1_000_000_000_000_000n });
export const EVM_EPOCH_MS = 60_000n;
/** EVM's send margin (M356 (1)): 60 s, the helper's EVM_POOL_SEND_MARGIN_MS; this file's until card evm-pool-fee-kit
 * makes it the kit's constant (M371 (2)). */
export const EVM_SEND_MARGIN_MS = 60_000n;
export const EVM_LIFE_MS = 2n * EVM_EPOCH_MS + EVM_SEND_MARGIN_MS + 2n * TAKE_SLACK_MS;
/** The pool's backstop: fee x 10,000 at most withdrawnValue x 5,000 (src/PrivacyPool.sol:55, 186). */
const MAX_RELAY_FEE_BPS = 5_000n;
/** Constants.NATIVE_ASSET (src/lib/Constants.sol:8): the asset PrivacyPoolSimple's scope hashes. */
export const EVM_NATIVE_ASSET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** The tag the cache stops at: the sync keeps only leaves of blocks up to it (M371 (1)). */
export const EVM_POOL_TAG = "finalized";
/** The tag every root, time and epoch block is read at (the newest block both RPCs agree on); never kept. */
export const EVM_NEWEST_TAG = "latest";
/** A W's Transfer read's first and widest eth_getLogs page, in blocks; a range-cap error halves it for that RPC. */
export const EVM_LOG_PAGE_BLOCKS = 10_000n;
/** The pool sync's first eth_getLogs page on each provider, in blocks (card evm-pool-sync-wide-pages). Base makes a block
 * every 200 ms, so a month-old pool is about 13M blocks: about 1,300 pages a provider at EVM_LOG_PAGE_BLOCKS, 130 at
 * this. The pool's filter (its address, its three topics in one position) read live on every provider of the EVM
 * venues' lists, at the head over 100,000 to 10,000,000 blocks and again from the testnet pool's deploy block or 13M
 * blocks back (6 Nov 07:31Z from this Mac): the widest each answered, with its words past it.
 * - base: base.api.pocket.network 100,000 at the head and 13M back (1.8 s), "query exceeds max block range 100000"
 *   (13M back at 07:44Z, 4 of 4: "block range exceeds maximum 500": its backends differ);
 *   base-rpc.publicnode.com 50,000 ("-32701: exceed maximum block range: 50000"), and 13M back HTTP 403 "Archive
 *   requests require a personal token"; base.public.blockpi.network 5,000; base.gateway.tenderly.co "-32602: invalid
 *   params" (1,000, 5 Nov); rpc.sentio.xyz HTTP 429 code 8 "public eth_getLogs is limited to 1000 blocks" (a 429: a
 *   throttle to the pager, so never a pool provider); base-mainnet.public.blastapi.io 10 blocks; mainnet.base.org HTTP
 *   429 -32011 "request limit reached" on the first call.
 * - robinhood: rpc.mainnet.chain.robinhood.com 100,000 at the head and 13M back, "query spans 200000 blocks ..., but
 *   only 100000 are allowed for this request; ... or send one value per position"; robinhood.api.pocket.network 100,000
 *   at the head, then "block range exceeds maximum 50000" at 200,000 and "max 10001 blocks" 13M back (its backends
 *   differ); rpc-robinhood.globalstake.io 5,000,000 (10.1 s for its first page, 0.6-3.8 s after), no answer in 15 s at
 *   10,000,000 and 13M back; robinhood.drpc.org code 35 "ranges over 10000 blocks are not supported on free plan";
 *   robinhood.daybreak-rpc.network 2,000; robinhood-rpc.publicnode.com and robinhood.rpc.blxrbdn.com HTTP 403.
 * - base-sepolia: base-sepolia.gateway.tenderly.co 10,000,000 (54 logs, 0.5-4.2 s); base-testnet.api.pocket.network
 *   100,000 at the head, "max block range 10000" from the deploy block (again at 07:44Z on 3 of 6 pages of
 *   100,000 from there, the rest answered: its backends differ); base-sepolia-rpc.publicnode.com 50,000 at the
 *   head and from the deploy block (07:44Z);
 *   84532.rpc.thirdweb.com 1,000 (-32005 "Log response size exceeded"); sepolia.base.org 200.
 * - robinhood-testnet: rpc.testnet.chain.robinhood.com 100,000 (as mainnet's own), from the deploy block too;
 *   robinhood-sepolia-rpc.publicnode.com 50,000 at the head and from the deploy block (07:44Z); 46630.rpc.thirdweb.com 1,000; robinhood-testnet.drpc.org under 10,000.
 * A page the provider answers in full doubles, up to EVM_POOL_LOG_PAGE_MAX_BLOCKS. */
export const EVM_POOL_LOG_PAGE_BLOCKS = 100_000n;
/** The pool sync's widest page: 8 x its first. Tenderly's Base Sepolia gateway answered the pool's logs over 500,000
 * blocks in 1.3 s and 1,000,000 in 2.7 s (6 Nov 07:31Z), against the device's 3.5 s client (the kit's SOLANA_RPC_RETRY
 * deadlineMs), so no page grows to where an honest provider's answer outlasts the client. */
export const EVM_POOL_LOG_PAGE_MAX_BLOCKS = 800_000n;
/** A refusal of a page no wider than its provider already answered in full is not its cap but one of its backends': the
 * same page again at once, at most this many times in a row, then halved. Pocket's gateways answer one range from
 * backends of different caps: base-testnet.api.pocket.network refused 3 of 6 pages of 100,000 blocks from the Base
 * Sepolia pool's deploy block "query exceeds max block range 10000" and answered the rest (6 Nov 07:44Z), and the
 * restore's Base Sepolia sync there took 96 pages and 21 refusals where PublicNode took 31 and 3 (07:47Z). */
export const EVM_LOG_REFUSED_AGAIN = 2;
/** A log read's ceiling (the smallest page size refused in it) holds for this many full pages in a row, then the page
 * may double past it once more: a W's Transfer read (card restore-check-bounded; evmTokensSentTo, evmTokensSentToOne)
 * and the pool sync's (card notes-per-pool-evm-base-hang, evmTreeSync). The pager reads no cap's words but a span named (CAP_SPANS), so a refusal under a provider's
 * cap (no answer in time, a spare's own error behind the helper's route) sets a ceiling as a cap does; held for the
 * whole read, each one halved the rest of it: the helper's Base route, capped at 1,000 blocks, ended CI's W reads of
 * 50,000 blocks at 312, 78 and 624-block pages against the Mac's 625 (live runs 42125976095, 42143211092 and
 * 42152968842, 5-6 Nov), 641 pages at the holdings pace of 1.5 s a page, and over 20 min in run 42146750370. At a true
 * cap this costs one refused call per 9 pages; a refusal under it, at most 8 pages at half size. A read that names no
 * number keeps its ceiling to its end. */
export const EVM_LOG_CEILING_PAGES = 8;
/** A throttled page (EVM_LOG_THROTTLE): tried this many times in all at its own size, then the read's failure. Its waits
 * (1, 2, 4, 8, 16 and 30 s, 61 s in all) outlast a provider's one-minute window: rpc.mainnet.chain.robinhood.com
 * answered 189 eth_getLogs in 59 s, then HTTP 429 "Too Many Requests" with no Retry-After, and again 5 s later (read
 * 5 Nov 13:55Z); at 5 tries and 10 s (15 s of waits) a W one day old was left unread there (13:52Z). */
export const EVM_LOG_THROTTLE_TRIES = 7;
/** The wait before a throttled page's next try: the provider's Retry-After, else 1 s doubled per try; at most this. */
export const EVM_LOG_THROTTLE_WAIT_MAX_MS = 30_000;
/** The longest one try of a read takes: the device's client ends a call, its own retry inside, in this (the kit's
 * SOLANA_RPC_RETRY, the signing page's pageRpc). */
export const EVM_READ_TRY_MS = BigInt(SOLANA_RPC_RETRY.deadlineMs);
/** A pool read (card evm-pool-reads-throttle): one block, view or chain id of a buy's or a withdraw's reads, on the
 * pool's pair or the fee pair. A throttle or no answer in time is the same read again after evmAnswered's wait (the
 * provider's Retry-After, else 1 s doubled per try), at most EVM_POOL_READ_TRIES tries and EVM_POOL_READ_WAIT_MS of
 * waits in all (a wait that would pass it is not begun), then the op's failure by the read's name. The bound comes
 * from the life L: a pass that starts at its epoch's last moment (start + E) makes a proof that take() hands out only
 * until start + L - M - 2 TAKE_SLACK_MS (= start + 2E: past it the proof is from before the previous epoch; L - M - S
 * is later), so that pass's reads and its proof have L - M - 2S - E = 60 s. One read takes at most half of it,
 * EVM_POOL_READ_BOUND_MS = 30 s, so the pass's other reads and its proof keep the rest. Its tries: 4, each at most
 * EVM_READ_TRY_MS (14 s), with waits of 1, 2 and 4 s inside the 16 s left; a fifth try (17.5 s and 15 s of waits)
 * would pass 30 s. The restore's EVM_LOG_THROTTLE_TRIES (61 s of waits) outlasts a provider's one-minute window, which
 * no op of this life can wait out: there the op fails by name and the next pass reads again. */
export const EVM_POOL_READ_BOUND_MS = (EVM_LIFE_MS - EVM_SEND_MARGIN_MS - 2n * TAKE_SLACK_MS - EVM_EPOCH_MS) / 2n;
export const EVM_POOL_READ_TRIES = 4;
export const EVM_POOL_READ_WAIT_MS = EVM_POOL_READ_BOUND_MS - BigInt(EVM_POOL_READ_TRIES) * EVM_READ_TRY_MS;
export const EVM_LAG_TRIES = 5;
export const EVM_LAG_WAIT_MS = 2_000;

const enc = new TextEncoder();
const U64 = (1n << 64n) - 1n;
const U128 = 1n << 128n;
const U256 = 1n << 256n;

/** The pool's three events (src/interfaces/IPrivacyPool.sol:65, 78, 253) and their topics: keccak256 of the signature. */
export const EVM_POOL_EVENTS = Object.freeze({
  Deposited: "Deposited(address,uint256,uint256,uint256,uint256)",
  Withdrawn: "Withdrawn(address,address,uint256,uint256,uint256,uint256)",
  Bought: "Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)",
});
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const topicOf = (signature: string): string => `0x${hex(keccak_256(enc.encode(signature)))}`;
const TOPIC_DEPOSITED = topicOf(EVM_POOL_EVENTS.Deposited);
const TOPIC_WITHDRAWN = topicOf(EVM_POOL_EVENTS.Withdrawn);
const TOPIC_BOUGHT = topicOf(EVM_POOL_EVENTS.Bought);
/** Data words per event: the non-indexed fields (each indexes only its first address). */
const DATA_WORDS: Record<string, number> = { [TOPIC_DEPOSITED]: 4, [TOPIC_WITHDRAWN]: 5, [TOPIC_BOUGHT]: 7 };

const selector = (signature: string): string => hex(keccak_256(enc.encode(signature)).subarray(0, 4));

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};
const word = (x: bigint): Uint8Array => {
  if (typeof x !== "bigint" || x < 0n || x >= U256) throw new Error("not a uint256");
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const beInt = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
const fieldOf = (...parts: Uint8Array[]): bigint => beInt(keccak_256(cat(...parts))) % VAULT_FIELD_P;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** An address's 20 bytes; any case (a pin's case is not a checksum the device relies on). */
const addr20 = (a: unknown, what: string): Uint8Array => {
  if (typeof a !== "string" || !ADDRESS.test(a)) throw new Error(`${what}: not an address`);
  return Uint8Array.from(a.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
};
const lower = (a: string): string => a.toLowerCase();
const tag = (n: bigint): string => `0x${n.toString(16)}`;
/**
 * An RPC's hex string as viem and ethers read one: "0x", then hex digits in either case, lower-cased; null for anything
 * else. robinhood-testnet.drpc.org answers eth_chainId "0xB626" where rpc.testnet.chain.robinhood.com and
 * robinhood-sepolia-rpc.publicnode.com answer "0xb626" (read 3 Nov 23:07Z). Every hex an RPC gives is read through
 * this before it is checked or compared, so two RPCs' answers that differ only in case are one answer, and any other
 * difference is still one.
 */
export const evmRpcHex = (v: unknown): string | null => (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : null);
/** A JSON-RPC quantity, canonical (no leading zero), as the spec writes it, in either case. */
const qty = (v: unknown, what: string): bigint => {
  const h = evmRpcHex(v);
  if (h === null || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(h)) throw new Error(`${what}: not a quantity`);
  return BigInt(h);
};
const H32 = /^0x[0-9a-f]{64}$/;
/** A 32-byte hash or word, in either case: lower-cased. */
const hash32 = (v: unknown, what: string): string => {
  const h = evmRpcHex(v);
  if (h === null || !H32.test(h)) throw new Error(`${what}: not a 32-byte hash`);
  return h;
};

/** The pool's scope, as its constructor computes it (src/State.sol:105). */
export function evmPoolScopeOf(pool: string, chainId: bigint): bigint {
  return fieldOf(addr20(pool, "pool"), word(chainId), addr20(EVM_NATIVE_ASSET, "asset"));
}

/** RelayData (src/interfaces/IPrivacyPool.sol:44-51), as the device sends it at the tap. */
export type EvmRelayData = {
  /** W */
  recipient: string;
  feeRecipient: string;
  feeCap: bigint;
  deadlineMs: bigint;
  refundPrecommitment: bigint;
  /** bytes16: 0x and 32 lowercase hex */
  salt: string;
};
/** The withdrawal the proof's context binds (src/interfaces/IPrivacyPool.sol:30-33): processooor is the pool. */
export type EvmPoolRequest = { processooor: string; relay: EvmRelayData };

/** abi.encode(RelayData): six static words, 192 bytes (src/PrivacyPool.sol:151); bytes16 is left-aligned. */
export function evmRelayDataBytes(r: EvmRelayData): Uint8Array {
  if (typeof r.deadlineMs !== "bigint" || r.deadlineMs < 0n || r.deadlineMs > U64) throw new Error("deadlineMs: not a uint64");
  if (typeof r.salt !== "string" || !/^0x[0-9a-f]{32}$/.test(r.salt)) throw new Error("salt: not 16 bytes of lowercase hex");
  const salt = new Uint8Array(32);
  salt.set(r.salt.slice(2).match(/../g)!.map((h) => parseInt(h, 16)), 0);
  return cat(
    word(beInt(addr20(r.recipient, "recipient"))),
    word(beInt(addr20(r.feeRecipient, "feeRecipient"))),
    word(r.feeCap),
    word(r.deadlineMs),
    word(r.refundPrecommitment),
    salt,
  );
}

/** abi.encode(Withdrawal, SCOPE): the tuple's offset, SCOPE, then the tuple (processooor, its bytes' offset, their
 * length, the bytes). The preimage of the context (src/PrivacyPool.sol:236). */
export function evmContextPreimage(req: EvmPoolRequest, scope: bigint): Uint8Array {
  const data = evmRelayDataBytes(req.relay);
  return cat(word(0x40n), word(scope), word(beInt(addr20(req.processooor, "processooor"))), word(0x40n), word(BigInt(data.length)), data);
}

/** The pool's context of a request: keccak256(abi.encode(Withdrawal, SCOPE)) mod p (src/PrivacyPool.sol:236). */
export function evmPoolContextOf(req: EvmPoolRequest, scope: bigint): bigint {
  return beInt(keccak_256(evmContextPreimage(req, scope))) % VAULT_FIELD_P;
}

export type EvmNetwork = "base" | "robinhood" | "base-sepolia" | "robinhood-testnet";
/** Each network's chain id (eth_chainId), as the money gate pins them (scripts/ci/money-gate.mjs CHAIN_ID). */
export const EVM_CHAIN_IDS: Readonly<Record<EvmNetwork, bigint>> = Object.freeze({ base: 8453n, robinhood: 4663n, "base-sepolia": 84532n, "robinhood-testnet": 46630n });
/**
 * Each testnet's Transfer RPCs, the restore's walletRpcs there (./evm-restore.ts evmRestoreNotes): a pinned list of
 * keyless providers of three operators, read as a pair with spares (evmPair, card evm-transfer-rpc-spares): the first
 * two are the seats, the third takes the place of one that throttles or is out. On Base and Robinhood a W is read on the
 * helper's route only (decision M359: holdings are display, one reader, the helper's keyed provider and its fallbacks),
 * so no mainnet W is ever named to a provider the device reaches itself, and there is no mainnet list. The testnets have
 * no helper route. thirdweb is the last spare: its keyless quota runs out for the day on every chain at once (below),
 * and neither testnet has a fourth keyless operator that answers a W's read from the browser (below), so there a second
 * provider out leaves one.
 * Each answers a W's Transfer read (eth_getLogs, Transfer's topic, topic 2 = the W, no address) at the chain's head and
 * 2,000,000 blocks back, and a CORS preflight from https://sign.confidential.unrealized.trade (POST, content-type)
 * with 204 or 200 and that origin or *. testnet-run takes these too; evmRestoreNotes never names a W to a provider of
 * the pool's own list, so one that is (Robinhood testnet's own and Base Sepolia's Pocket, below) is dropped from the W
 * reads there, and thirdweb takes its seat. None is an operator of the kit's providers (evmPoolVenues) but two, each
 * named by the independence test: rpc.testnet.chain.robinhood.com, since no other keyless operator answers every read
 * on Robinhood testnet (below), and base-testnet.api.pocket.network (card notes-per-pool-evm-base-hang): the pool's
 * pair there must page its logs wide, and of Base Sepolia's keyless operators only PublicNode, Pocket and Tenderly do
 * (sepolia.base.org's 200-block pages were about 8,250 for the pool's life at 200 ms blocks, 6 Nov 04:27-04:35Z), and
 * PublicNode answers no W's read.
 * The reads, 5 Nov 17:29-17:33Z (W 0x809286a1…078e; 1,000 blocks at the head and 2,000,000 back, then 20 pages):
 * - base-sepolia: base-sepolia.gateway.tenderly.co 1,000 blocks 338 and 447 ms, CORS 204 *;
 *   base-testnet.api.pocket.network 1,000 blocks 190 and 288 ms, 20 x 1,000 p50 213 ms all answered, CORS 204 the origin.
 * - robinhood-testnet: robinhood-testnet.drpc.org code 35 at 1,000 blocks, 20 x 100 p50 311 ms all answered (101 is its
 *   page, 5 Nov 12:28Z), CORS 204 the origin; rpc.testnet.chain.robinhood.com 20 x 10,000 blocks, 8 answered and then
 *   HTTP 429 (a throttle, waited out or swapped), CORS 204 *.
 * - thirdweb, the spare (84532 and 46630.rpc.thirdweb.com): 1,000 blocks on 5 Nov 12:20-12:28Z (-32005 "Log response
 *   size exceeded" above, HTTP 429 after about 4 calls with Retry-After up to 9 s); at 16:28Z and again 17:29-17:30Z
 *   every chain answered eth_chainId HTTP 429 -32005 "Rate limit exceeded" (its keyless daily quota, Retry-After
 *   26,741,000 ms): a spare that rests, never a seat; CORS 204 *.
 * Not taken (17:29-17:31Z unless dated): on Robinhood testnet robinhood-sepolia-rpc.publicnode.com (-32701 "Please
 * specify an address"), robinhood-testnet.gateway.tenderly.co and robinhood-testnet.api.pocket.network (HTTP 404):
 * Robinhood testnet has no other keyless operator. On Base Sepolia base-sepolia-public.nodies.app (10 x 50 blocks p50
 * 336 ms, 17:48Z, but its CORS preflight answers no Access-Control-Allow-Origin, so no browser reads it),
 * base-sepolia.drpc.org (code 19 "Temporary internal error" at 10 to 101 blocks, 4 Nov), base-sepolia.api.onfinality.io
 * (-32029 at once), base-sepolia.public.blastapi.io (HTTP 403, closed), sepolia.base.org (the pool's, 200 blocks),
 * publicnode ("Please specify an address"), rpc.ankr.com (a key), and the kit's providers' operators.
 */
// The freezes are marked pure, so SIGN_HOST's build, which reads none of these yet, drops them whole
// (packages/signpage/scripts/build-network.test.mjs refuses a testnet provider in it).
export type EvmTestnet = "base-sepolia" | "robinhood-testnet";
export const EVM_TRANSFER_RPCS: Readonly<Record<EvmTestnet, readonly string[]>> = /* @__PURE__ */ Object.freeze({
  "base-sepolia": /* @__PURE__ */ Object.freeze(["https://base-sepolia.gateway.tenderly.co", "https://base-testnet.api.pocket.network", "https://84532.rpc.thirdweb.com"]),
  "robinhood-testnet": /* @__PURE__ */ Object.freeze(["https://robinhood-testnet.drpc.org", "https://rpc.testnet.chain.robinhood.com", "https://46630.rpc.thirdweb.com"]),
});

/** A network's pool, pinned on the device: the pool, the relayer's fee recipient every proof binds, and the pool's
 * deploy block (the sync's first block). */
export type EvmPoolPin = { readonly network: EvmNetwork; readonly pool: string; readonly feeRecipient: string; readonly fromBlock: bigint };
/** The pinned pools by network: pool-evm-deploy writes each one. */
export const EVM_POOLS: Readonly<Partial<Record<EvmNetwork, EvmPoolPin>>> = Object.freeze({});

/** A block as the sync reads it. */
export type EvmBlock = { number: bigint; hash: string; timestamp: bigint; baseFeePerGas: bigint | null };

/** An RPC behind the other: a retry, never an answer. */
export class EvmLagError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "EvmLagError";
  }
}
const lag = (m: string): never => {
  throw new EvmLagError(m);
};

type Rpcs = readonly [EvmRpc, EvmRpc];

/** Refuses two RPCs that are one provider (the kit's solanaSameProvider: one function, or one URL). */
export function checkEvmRpcs(rpcs: unknown): asserts rpcs is Rpcs {
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || typeof rpcs[0] !== "function" || typeof rpcs[1] !== "function") throw new Error("rpcs: two");
  if (solanaSameProvider(rpcs[0], rpcs[1])) throw new Error("rpcs: one provider twice is one read");
}

/** How long a provider rests after a throttle or no connection that names no longer Retry-After: Robinhood's own RPC's
 * one-minute window (HTTP 429 with no Retry-After after 189 eth_getLogs in 59 s, read 5 Nov 13:55Z). */
export const EVM_SPARE_REST_MS = 60_000;

/**
 * A pinned list of providers (two or more, no provider twice: the kit's solanaSameProvider) read as one pair of seats
 * (card evm-transfer-rpc-spares). Seat 0 starts on the list's first provider and seat 1 on its second; the rest are
 * spares. A seat's call that the provider throttles or cannot carry (`throttled`: HTTP 429, a throttle code, a
 * transport fault, and no answer in time on any call but an eth_getLogs page, whose pager halves it instead; and a provider
 * out, OUT_WORDS) rests that
 * provider for its Retry-After, at least EVM_SPARE_REST_MS, and is made again at once on the next spare: never a wait
 * while a spare is free. With none free the seat takes the provider whose rest ends first and the error goes up with
 * that provider's own Retry-After (none when it named none), so the read's own waits and bound apply as on a fixed
 * pair, never another provider's hours. The two seats never hold one provider, so the pair always reads
 * on two. thirdweb's keyless daily quota answered every chain HTTP 429 with Retry-After 26,741,000 ms (5 Nov 16:28Z):
 * the kit's client ends that call at once, and with no spare it was the pair's failure. A seat's `url` is its
 * provider's now.
 * A range cap walks too (card helper-evm-range-cap-walk, the helper's rule in rpc.ts callEvm): an eth_getLogs refused in
 * words that name a span (CAP_SPANS) under the span asked, and no smaller than the widest that provider answered (a
 * smaller one is one backend's, the pager's to ask again), moves the seat to the next provider in the list, not the
 * other seat's and not resting, whose cap is not known to be under the span asked, and the call is made there at once;
 * with none, to the provider of the largest cap named, whose own refusal goes up so the pager pages at that cap. The
 * capped provider is not rested: it still answers the seat's other reads when a later move seats it. Which two
 * providers sit changes, never that two read and agree. Read live: the kit's Base list seats blastapi second, which
 * caps a getLogs at 10 blocks (evm-transfer-rpc-spares), and sepolia.base.org answers HTTP 413 "eth_getLogs is limited
 * to a 200 range" (6 Nov 18:51Z), where publicnode takes 50,000 and Pocket 100,000.
 */
export function evmPair(list: readonly EvmRpc[], what = "rpcs"): Rpcs {
  if (!Array.isArray(list) || list.length < 2 || list.some((r) => typeof r !== "function")) throw new Error(`${what}: two or more`);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (solanaSameProvider(list[i]!, list[j]!)) throw new Error(`${what}: one provider twice is one read`);
  const restUntil = list.map(() => 0);
  // whether a provider's rest is its own Retry-After (else EVM_SPARE_REST_MS, a guess)
  const named = list.map(() => false);
  const at = [0, 1];
  // the provider seat k moves to: a resting-free one after its own in list order, else (`soonest`) the one whose rest
  // ends first; never the other seat's
  const next = (k: number, soonest: boolean): number | null => {
    let best: number | null = null;
    for (let s = 1; s < list.length; s++) {
      const i = (at[k]! + s) % list.length;
      if (i === at[1 - k]) continue;
      if (restUntil[i]! <= Date.now()) return i;
      if (soonest && (best === null || restUntil[i]! < restUntil[best]!)) best = i;
    }
    return best !== null && restUntil[best]! <= restUntil[at[k]!]! ? best : null;
  };
  // each provider's eth_getLogs cap as its words named it (null: none known), and the widest span it answered
  const capOf: (bigint | null)[] = list.map(() => null);
  const answered: (bigint | null)[] = list.map(() => null);
  // the provider a capped seat k moves to for a page of `span` blocks: the next one in list order, not the other seat's
  // and not resting, with no cap known under `span`; else the one (the seat's own too) with the largest cap named
  const wider = (k: number, span: bigint): number => {
    let best = at[k]!;
    for (let s = 1; s < list.length; s++) {
      const i = (at[k]! + s) % list.length;
      if (i === at[1 - k] || restUntil[i]! > Date.now()) continue;
      const c = capOf[i]!;
      if (c === null || c >= span) return i;
      if (c > (capOf[best] ?? 0n)) best = i;
    }
    return best;
  };
  const spanOf = (params: readonly unknown[]): bigint | null => {
    const f = params[0] as { fromBlock?: unknown; toBlock?: unknown } | null;
    if (typeof f?.fromBlock !== "string" || typeof f.toBlock !== "string") return null;
    try {
      return BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n;
    } catch {
      return null;
    }
  };
  const seat = (k: number): EvmRpc => {
    const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const span = method === "eth_getLogs" ? spanOf(params) : null;
      for (;;) {
        if (restUntil[at[k]!]! > Date.now()) at[k] = next(k, true) ?? at[k]!;
        const i = at[k]!;
        try {
          const r = await list[i]!(method, params);
          if (span !== null && (answered[i] === null || span > answered[i]!)) answered[i] = span;
          if (span !== null && capOf[i] !== null && span > capOf[i]!) capOf[i] = null;
          return r;
        } catch (e) {
          const t = throttled(e);
          const cap = span !== null && t === null ? capSpanOf(String((e as Error)?.message ?? e)) : null;
          if (span !== null && cap !== null && cap >= 1n && cap < span && (answered[i] === null || cap >= answered[i]!)) {
            if (capOf[i] === null || cap > capOf[i]!) capOf[i] = cap;
            if (at[k] !== i) continue; // another call on this seat moved it already
            const n = wider(k, span);
            if (n === i) throw e;
            at[k] = n;
            continue;
          }
          if (t === null || (t.kind === "slow" && method === "eth_getLogs")) throw e;
          restUntil[i] = Date.now() + Math.max(t.afterMs ?? 0, EVM_SPARE_REST_MS);
          named[i] = (t.afterMs ?? 0) > EVM_SPARE_REST_MS;
          if (at[k] !== i) continue; // another call on this seat moved it already
          const n = next(k, false);
          if (n === null) {
            at[k] = next(k, true) ?? i;
            // the read's wait is for the provider now seated: its own Retry-After, else the read's backoff
            const j = at[k]!;
            if (j === i) throw e;
            throw Object.assign(new Error(String((e as Error)?.message ?? e), { cause: e }), { name: (e as Error)?.name ?? "Error", fault: (e as { fault?: unknown })?.fault, afterMs: named[j] ? Math.max(0, restUntil[j]! - Date.now()) : null });
          }
          at[k] = n;
        }
      }
    };
    return Object.defineProperty(call, "url", { get: () => list[at[k]!]!.url, enumerable: true }) as EvmRpc;
  };
  return [seat(0), seat(1)];
}

/**
 * f on both RPCs at once, under one AbortController: when one side fails (or the caller aborts) the other is aborted
 * too, and both are settled before the first error is thrown, so a failed read leaves nothing running behind it.
 */
async function both<T>(rpcs: Rpcs, f: (rpc: EvmRpc, k: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<[T, T]> {
  signal?.throwIfAborted();
  const ac = new AbortController();
  const stop = () => ac.abort(signal!.reason);
  signal?.addEventListener("abort", stop, { once: true });
  let first: { e: unknown } | null = null;
  const side = (k: number) => f(rpcs[k]!, k, ac.signal).catch((e: unknown) => {
    first ??= { e };
    ac.abort(e);
    throw e;
  });
  try {
    const rs = await Promise.allSettled([side(0), side(1)]);
    if (first !== null) throw (first as { e: unknown }).e;
    signal?.throwIfAborted();
    return [(rs[0] as PromiseFulfilledResult<T>).value, (rs[1] as PromiseFulfilledResult<T>).value];
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

function blockOf(v: unknown, what: string): EvmBlock | null {
  if (v === null) return null;
  const b = v as { number?: unknown; hash?: unknown; timestamp?: unknown; baseFeePerGas?: unknown };
  if (typeof b !== "object") throw new Error(`${what}: not a block`);
  return {
    number: qty(b.number, `${what} number`),
    hash: hash32(b.hash, `${what} hash`),
    timestamp: qty(b.timestamp, `${what} timestamp`),
    baseFeePerGas: b.baseFeePerGas === undefined ? null : qty(b.baseFeePerGas, `${what} baseFeePerGas`),
  };
}
const getBlock = async (rpc: EvmRpc, at: string, what: string): Promise<EvmBlock | null> => blockOf(await rpc("eth_getBlockByNumber", [at, false]), what);

/** The wait after a throttled try `tries` (1 first): the provider's Retry-After, else 1 s doubled per try; at most
 * EVM_LOG_THROTTLE_WAIT_MAX_MS. */
const throttleWaitMs = (tries: number, afterMs: number | null): number => Math.min(EVM_LOG_THROTTLE_WAIT_MAX_MS, Math.max(afterMs ?? 0, 1_000 * 2 ** (tries - 1)));

/** A read a throttle or no answer in time left unanswered through its every try: named by the read, and never a
 * throttle to a read around it, so one bound is never tried again inside another. */
export class EvmUnansweredError extends Error {
  constructor(m: string, cause: unknown) {
    super(m, { cause });
    this.name = "EvmUnansweredError";
  }
}

/** A read's bound: its tries, the waits it may begin in all (ms), and its name for its failure. */
export type EvmReadBound = { tries: number; waitMs: bigint; what: string };

/** One read that is not a page (a chain id, a block, a view): a throttle or no answer in time (throttled) is the same
 * read again after the wait readLogs takes, at most EVM_LOG_THROTTLE_TRIES tries, then its failure. With `bound`, at
 * most its tries and its waits (a wait that would pass them is not begun), then an EvmUnansweredError naming the read.
 * Any other error at once. On 5 Nov 13:58Z one eth_getBlockByNumber with no answer in 3.5 s
 * (base-testnet.api.pocket.network, and robinhood.daybreak-rpc.network) was a whole pair's failure. */
export async function evmAnswered<T>(f: () => Promise<T>, signal?: AbortSignal, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = wait, bound?: EvmReadBound): Promise<T> {
  let waited = 0n;
  for (let n = 1; ; n++) {
    try {
      return await f();
    } catch (e) {
      signal?.throwIfAborted();
      const t = throttled(e);
      if (t === null) throw e;
      const ms = throttleWaitMs(n, t.afterMs);
      if (bound === undefined) {
        if (n >= EVM_LOG_THROTTLE_TRIES) throw e;
      } else if (n >= bound.tries || waited + BigInt(ms) > bound.waitMs) {
        throw new EvmUnansweredError(`${bound.what}: no answer in ${n} ${n === 1 ? "try" : "tries"} (${String((e as Error)?.message ?? e)})`, e);
      }
      waited += BigInt(ms);
      await sleep(ms, signal);
    }
  }
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/** A pool read (EVM_POOL_READ_TRIES, EVM_POOL_READ_WAIT_MS): f again after a throttle or no answer in time, then its
 * failure named `what`. */
const poolRead = <T>(what: string, f: () => Promise<T>, signal: AbortSignal | undefined, sleep: Sleep): Promise<T> => evmAnswered(f, signal, sleep, { tries: EVM_POOL_READ_TRIES, waitMs: EVM_POOL_READ_WAIT_MS, what });
/** A block of the pool's reads, by tag or number, as a pool read. */
const readBlock = (rpc: EvmRpc, at: string, what: string, signal: AbortSignal | undefined, sleep: Sleep): Promise<EvmBlock | null> => poolRead(what, () => getBlock(rpc, at, what), signal, sleep);

/** A JSON-RPC error that says the node does not know the block yet (a lag, not a lie). */
const UNKNOWN_BLOCK = /unknown block|header not found|block not found|no such block/i;
// A provider's cap on one eth_getLogs call (its range, its number of results or its answer's size) has no standard
// code or words, so the pager needs none of them: any refusal of a page over one block but a head lag (HEAD_LAG) halves
// that RPC's page (readLogs). The caps' words read live, each one a refusal the pager meets this way:
// - 3 Nov 04:21-07:05Z: sepolia.base.org "-32614: eth_getLogs is limited to a 200 range"; base-sepolia-rpc.publicnode.com
//   and robinhood-sepolia-rpc.publicnode.com "-32701: exceed maximum block range: 50000"; base.drpc.org code 35 "ranges
//   over 10000 blocks are not supported on free plan" for every range of 501 to 1,000,001 blocks (101 and 11 answer);
//   results caps from the team's data run of 2 Nov: Base "query exceeds max results 20000, retry with the range ...",
//   Robinhood "logs matched by query exceeds limit of 10000".
// - 5 Nov 12:20-12:28Z (card wallet-restore-transfer-rpcs; Transfer, topic 2 = a W, no address): base.gateway.tenderly.co
//   "-32602: invalid params" over 1,000 blocks, its cap only in the error's `data`, which the kit's client never reads;
//   rpc.mainnet.chain.robinhood.com and rpc.testnet.chain.robinhood.com "-32602: query spans 99993 blocks (...), but only
//   30000 are allowed"; base.api.pocket.network "invalid argument 0: block range exceeds maximum 500" (another backend
//   answered 10,000); rpc-robinhood.blockmachine.io "block range exceeds maximum allowed (max=10000, ...)"; 1rpc.io "is
//   limited to 0 - 50 blocks range"; base-mainnet.public.blastapi.io "up to a 10 block range"; thirdweb "-32005: Log
//   response size exceeded. Maximum allowed number of requested blocks is 1000"; base-sepolia.drpc.org HTTP 500 code 19
//   "Temporary internal error. Please retry" at 10 to 101 blocks, code 35 above.
/** What a refused page was. "throttle": a provider's rate limit, never its range cap: the page is tried again at its
 *  size. "slow": no answer in time: a page over one block is halved (a range too heavy for the provider's time: under
 *  the device's 3.5 s client base-testnet.api.pocket.network answered no 10,000-block page, 5 Nov 13:44Z, and the
 *  retry at that size never would), one block is tried again as a throttle. The rule: HTTP 429 and the kit's throttle
 *  codes (-32029, -32429, -429, dRPC's 15) in any client's words, -32005 unless its words name a cap (results, range,
 *  blocks, logs matched, response size), and the kit client's transport faults but a timeout (SolanaRpcTransportError:
 *  429, 5xx, a throttle code, no connection, after its own retry) are throttles; a timeout in any words, or the kit
 *  client's, is slow. -32005 is EIP-1474's "limit exceeded", which providers use for both. The reads behind it: the
 *  review of card wallet-restore-transfer-rpcs (5 Nov) read 8453.rpc.thirdweb.com answering HTTP 429 and -32005 "Rate
 *  limit exceeded" after about 4 calls, Retry-After up to 9 s, and daybreak timing out; this card's live check (5 Nov
 *  13:36Z) read thirdweb's own cap as -32005 "Log response size exceeded. Maximum allowed number of requested blocks
 *  is 1000" on Base and Robinhood testnet; the team's data run (2 Nov) read -32005 "query exceeds max results 20000". */
const THROTTLE_WORDS = /HTTP 429\b|(RPC error |"code":\s*)(-32029|-32429|-429|15)\b/i;
const SLOW_WORDS = /no answer in \d+ ms|\btimed? ?out\b|TimeoutError|ETIMEDOUT/i;
const LIMIT_32005 = /(RPC error |"code":\s*)-32005\b/;
const CAP_WORDS = /\b(results?|range|blocks?|logs? matched|response size)\b/i;
/** The span a cap's words name, in each provider's own form (card helper-evm-range-cap-walk; the reads above, and
 *  base-pokt.nodies.app's -32001 "maximum allowed is 50 blocks on your current plan", 6 Nov 15:19Z and 15:58Z), held to
 *  the helper's (apps/helper/src/rpc/rpc.ts CAP_SPANS) by their tests. Robinhood's names the asked span first, so each
 *  form is its own. A refusal that names a span under the page refused pages at it at once; one naming none, or one no
 *  smaller, halves the page as any refusal does. */
const CAP_SPANS: readonly RegExp[] = [
  /maximum allowed is (\d{1,12}) blocks/i,
  /limited to 0 ?- ?(\d{1,12}) blocks/i,
  /limited to a (\d{1,12}) range/i,
  /ranges over (\d{1,12}) blocks/i,
  /max(?:imum)? block range:? (\d{1,12})/i,
  /block range exceeds maximum (?:allowed \(max=)?(\d{1,12})/i,
  /maximum (\d{1,12}) blocks/i,
  /but only (\d{1,12}) are allowed/i,
  /up to a (\d{1,12}) block range/i,
  /requested blocks is (\d{1,12})/i,
  /\bmax (\d{1,12}) blocks/i,
];
/** The span a refusal's words name (CAP_SPANS, in its first 1,000 characters), or null. */
const capSpanOf = (m: string): bigint | null => {
  const w = m.slice(0, 1_000);
  for (const f of CAP_SPANS) {
    const x = f.exec(w);
    if (x !== null) return BigInt(x[1]!);
  }
  return null;
};
/** A provider out, never a word on the read (card evm-transfer-rpc-spares): an HTTP error with no JSON-RPC answer in it
 * (the kit's client: "HTTP 410", where a refusal reads "HTTP 400: RPC error 35: ..."), an answer to another request
 * (the client's "answer id null is not request id 6") and a standard method the provider says it lacks (-32601). Read
 * 5 Nov 18:00-18:05Z on a restore's W reads: 1rpc.io/base HTTP 410, then "answer id null" on 7 pages in a row;
 * robinhood-testnet.drpc.org -32601 "the method eth_getBlockByNumber does not exist/is not available" from one of its
 * backends; base.api.pocket.network -32602 "missing required field 'address' for log filter" to 2 of 30 W pages (17:59Z),
 * one backend's, as Robinhood's Pocket (5 Nov). And a provider that refuses a read for want of a key, HTTP 401 or 403
 * whatever its words: robinhood-rpc.publicnode.com, the kit's first Robinhood provider, answered a pool-shaped log read
 * 2,000 blocks back HTTP 403 -32602 "Archive requests require a personal token" (5 Nov 18:55Z); a cap is a 400, never
 * these. A throttle: the same read again, on a spare at once when the list has one free. */
const OUT_WORDS = /^HTTP \d{3}$|^HTTP 40[13]\b|^answer id \S+ is not request id |(RPC error |"code":\s*)-32601\b|missing required field 'address'/;
const throttled = (e: unknown): { kind: "throttle" | "slow"; afterMs: number | null } | null => {
  const t = e as { name?: unknown; afterMs?: unknown; message?: unknown; fault?: unknown } | null;
  if (t?.name === "EvmUnansweredError") return null;
  const afterMs = typeof t?.afterMs === "number" ? t.afterMs : null;
  if (t?.name === "SolanaRpcTransportError") return { kind: t.fault === "timeout" ? "slow" : "throttle", afterMs };
  const m = String(t?.message ?? e);
  if ((e as Error)?.name === "TimeoutError" || SLOW_WORDS.test(m)) return { kind: "slow", afterMs: null };
  if (THROTTLE_WORDS.test(m) || OUT_WORDS.test(m) || (LIMIT_32005.test(m) && !CAP_WORDS.test(m))) return { kind: "throttle", afterMs: null };
  return null;
};
/** A page past the provider's own head (its log index behind its block headers): a lag, never a smaller page. */
const HEAD_LAG = /beyond (the )?current head|invalid block range params|after last accepted block|is ahead of (the )?(head|latest)/i;
// Read live on 3 Nov 05:35Z, eth_call at a block 20,000 blocks back by hash: rpc.testnet.chain.robinhood.com and
// robinhood-sepolia-rpc.publicnode.com "-32000: historical state <root> is not available"; geth's own is "missing trie
// node". robinhood.drpc.org, from a backend that has not synced the block's state (2026-11-04, review fold 2 of card
// evm-buy-hookdata-fee): "Unknown state. First available state is 1"; another backend answers the retry.
/** A pruning node's answer for state it no longer keeps: a lag, so the retry reads at a newer anchor. */
const PRUNED = /missing trie node|historical state \S* ?is not available|state \S* ?is not available|state (has been|was) pruned|unknown state/i;

/** One pool view's 32-byte answer, by eth_call at a block hash (EIP-1898). */
async function view(rpc: EvmRpc, pool: string, data: string, blockHash: string, what: string, signal: AbortSignal | undefined, sleep: Sleep): Promise<bigint> {
  let r: unknown;
  try {
    r = await poolRead(what, () => rpc("eth_call", [{ to: pool, data: `0x${data}` }, { blockHash }]), signal, sleep);
  } catch (e) {
    if (UNKNOWN_BLOCK.test(String((e as Error)?.message ?? e))) lag(`${what}: the RPC does not know block ${blockHash} yet`);
    if (PRUNED.test(String((e as Error)?.message ?? e))) lag(`${what}: the RPC no longer keeps the state of block ${blockHash}`);
    throw e;
  }
  const h = evmRpcHex(r);
  if (h === null || !H32.test(h)) throw new Error(`${what}: not one 32-byte word`);
  return BigInt(h);
}

const VIEWS = {
  SCOPE: selector("SCOPE()"),
  currentRoot: selector("currentRoot()"),
  currentTreeSize: selector("currentTreeSize()"),
  currentLabelRoot: selector("currentLabelRoot()"),
  currentLabelTreeSize: selector("currentLabelTreeSize()"),
  stateRootTimes: selector("stateRootTimes(uint256)"),
  labelRootTimes: selector("labelRootTimes(uint256)"),
};

/** Where a log is, and `bytes`: every field the device reads, for the byte-for-byte compare of two RPCs' lists. */
export type EvmLogRow = { block: bigint; blockHash: string; logIndex: bigint; bytes: string };
/**
 * One of the pool's leaf events, as both RPCs gave it: its state leaf (Deposited's _commitment, Withdrawn's and Bought's
 * _newCommitment) and Deposited's label, then the fields a restore reads (./evm-restore.ts): a deposit's _value and
 * _precommitmentHash; a release's W (topic 1, _recipient), _value (withdrawnValue) and _spentNullifier, and a buy's
 * _token. Every one of them is in `bytes`.
 */
export type EvmPoolEvent = EvmLogRow & {
  kind: "deposit" | "withdraw" | "buy";
  state: bigint;
  label: bigint | null;
  value: bigint;
  /** Deposited's _precommitmentHash; null on a release */
  precommitment: bigint | null;
  /** a release's _spentNullifier; null on a deposit */
  nullifier: bigint | null;
  /** a release's W, lowercase; null on a deposit */
  recipient: string | null;
  /** Bought's _token, lowercase; null otherwise */
  token: string | null;
};
type Ev = EvmPoolEvent;

function decodeLog(raw: unknown, pool: string, from: bigint, to: bigint, what: string): Ev {
  const l = raw as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown; blockHash?: unknown; logIndex?: unknown; transactionHash?: unknown; transactionIndex?: unknown; removed?: unknown };
  if (typeof l !== "object" || l === null) throw new Error(`${what}: not a log`);
  if (typeof l.address !== "string" || lower(l.address) !== pool) throw new Error(`${what}: not the pool's log`);
  if (l.removed !== undefined && l.removed !== false) throw new Error(`${what}: a removed log`);
  const block = qty(l.blockNumber, `${what} blockNumber`);
  if (block < from || block > to) throw new Error(`${what}: block ${block} is outside ${from}..${to}`);
  const blockHash = hash32(l.blockHash, `${what} blockHash`);
  const logIndex = qty(l.logIndex, `${what} logIndex`);
  const tx = hash32(l.transactionHash, `${what} transactionHash`);
  const txIndex = qty(l.transactionIndex, `${what} transactionIndex`);
  const topics = l.topics;
  if (!Array.isArray(topics) || topics.length !== 2) throw new Error(`${what}: not two topics`);
  const t0 = hash32(topics[0], `${what} topic 0`);
  const t1 = hash32(topics[1], `${what} topic 1`);
  const words = DATA_WORDS[t0];
  if (words === undefined) throw new Error(`${what}: not Deposited, Withdrawn or Bought`);
  if (BigInt(t1) >> 160n !== 0n) throw new Error(`${what}: the indexed address is not an address`);
  const data = evmRpcHex(l.data);
  if (data === null || !new RegExp(`^0x[0-9a-f]{${64 * words}}$`).test(data)) throw new Error(`${what}: not ${words} data words`);
  const w = (i: number): bigint => BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
  // Deposited: _commitment, _label, _value, _precommitmentHash; Withdrawn and Bought: _feeRecipient, _value, _fee,
  // _spentNullifier, _newCommitment, then Bought's _token, _out
  const dep = t0 === TOPIC_DEPOSITED;
  const state = dep ? w(0) : w(4);
  const label = dep ? w(1) : null;
  for (const v of [state, label]) if (v !== null && (v === 0n || v >= VAULT_FIELD_P)) throw new Error(`${what}: a leaf is not a field element above 0`);
  const addrWord = (v: bigint, name: string): string => {
    if (v >> 160n !== 0n) throw new Error(`${what}: ${name} is not an address`);
    return `0x${v.toString(16).padStart(40, "0")}`;
  };
  const bytes = [tag(block), blockHash, tag(logIndex), tx, tag(txIndex), pool, t0, t1, data].join(" ");
  return {
    block, blockHash, logIndex, bytes, state, label,
    kind: dep ? "deposit" : t0 === TOPIC_WITHDRAWN ? "withdraw" : "buy",
    value: dep ? w(2) : w(1),
    precommitment: dep ? w(3) : null,
    nullifier: dep ? null : w(3),
    recipient: dep ? null : addrWord(BigInt(t1), "the recipient"),
    token: t0 === TOPIC_BOUGHT ? addrWord(w(5), "the token") : null,
  };
}

/** An eth_getLogs filter, less its block range: the address (absent: any) and the topics. */
export type EvmLogFilter = { address?: string; topics: readonly (string | readonly string[] | null)[] };
/** A log's decoder: refuses a log the filter would not give or a field not in its shape. */
export type EvmLogDecode<E extends EvmLogRow> = (raw: unknown, from: bigint, to: bigint, what: string) => E;

/** How one log read pages (readLogs): its widest page, how many full pages a refused size holds as the read's
 * ceiling before the page may grow past it once more (doubled each time its probe is refused at that same size again,
 * so a true cap costs a few refused calls in a read, never one per EVM_LOG_CEILING_PAGES pages; a refusal at any other
 * size, as one under the cap, holds it for ceilingPages again), and whether no answer in time on a
 * page over one block halves it (a W's Transfer read, whose filter names no address: base-testnet.api.pocket.network
 * answered no 10,000-block one in time, 5 Nov 13:44Z) or never does (the pool sync, card evm-pool-sync-wide-pages: its
 * filter names the pool, and the pool pairs answered its pages of 50,000 and 100,000 blocks in 0.1-0.9 s, 6 Nov
 * 07:31-07:44Z). */
export type EvmLogRules = { max: bigint; ceilingPages: number; slowHalves: boolean };
/** One provider's page: its size now and the widest it answered in full (null: none yet). */
export type EvmLogPage = { size: bigint; answered: bigint | null };
/** Where each read finds its page: by the RPC and its index, at each page (a seat's provider may change mid-read). */
export type EvmLogPager = { rules: EvmLogRules; of(rpc: EvmRpc, k: number): EvmLogPage };

/** A W's Transfer read's pager: one size per RPC index in `page`, kept across Ws (the restore's). */
const transferPager = (page: bigint[], ceilingPages = Infinity): EvmLogPager => ({
  rules: { max: EVM_LOG_PAGE_BLOCKS, ceilingPages, slowHalves: true },
  of: (_rpc, k) => ({ get size() { return page[k]!; }, set size(v: bigint) { page[k] = v; }, answered: null }),
});

/**
 * The pool sync's pager (card evm-pool-sync-wide-pages): one page for each provider, by its URL (a seat's provider now,
 * evmPair), so a spare that takes a seat pages at its own size and the provider it left keeps its own. Each starts at
 * EVM_POOL_LOG_PAGE_BLOCKS, doubles after each full page up to EVM_POOL_LOG_PAGE_MAX_BLOCKS, halves only on its own
 * refusal (a range cap, in any words), never on a 429 or no answer in time (the same page again), and keeps its size
 * and the widest it answered across the sync's rounds.
 */
export function evmPoolLogPager(): EvmLogPager {
  const pages = new Map<string, EvmLogPage>();
  return {
    rules: { max: EVM_POOL_LOG_PAGE_MAX_BLOCKS, ceilingPages: EVM_LOG_CEILING_PAGES, slowHalves: false },
    of(rpc, k) {
      const key = (rpc as { url?: unknown }).url;
      const id = typeof key === "string" ? key : `rpc ${k}`;
      let p = pages.get(id);
      if (p === undefined) pages.set(id, (p = { size: EVM_POOL_LOG_PAGE_BLOCKS, answered: null }));
      return p;
    },
  };
}

/**
 * One RPC's logs of a filter over from..to, in pages that end at or below `to`, each page's size its provider's
 * (`pager`). A throttle (`throttled`: a rate limit, or a one-block page with no answer in time) is no cap: the same
 * page again after the provider's Retry-After (else 1 s doubled per try, at most EVM_LOG_THROTTLE_WAIT_MAX_MS), at most
 * EVM_LOG_THROTTLE_TRIES tries, then the read's failure (unread, never an empty list). No answer in time on a page over
 * one block halves it where the rules say so (slowHalves); where not, it is a throttle too, but on a page wider than
 * the provider ever answered in full, which takes the page back to that width (the read's ceiling), never below it.
 * Any other refusal of a page over one block (a provider's cap, in whatever words) halves its page (or, naming a span
 * under it and no smaller than the provider answered in full, takes it to that span, CAP_SPANS), but one no wider
 * than the provider answered in full, asked again at once first (EVM_LOG_REFUSED_AGAIN); after a full page
 * reads, the page doubles again, up to the rules' max and below the smallest size refused in this read until the
 * rules' ceilingPages full pages in a row have read under it (doubled while its probe meets that same size), so a
 * cap lifted, a refusal under the cap or a page shrunk long ago comes back. A page past the provider's head (HEAD_LAG)
 * is a lag. A page of one block refused is the read's failure, with the provider's own error.
 */
async function readLogs<E extends EvmLogRow>(rpc: EvmRpc, k: number, filter: EvmLogFilter, decode: EvmLogDecode<E>, from: bigint, to: bigint, pager: EvmLogPager, signal?: AbortSignal, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = wait): Promise<E[]> {
  const { max, slowHalves } = pager.rules;
  const out: E[] = [];
  let refused: bigint | null = null;
  // full pages read in a row since the ceiling was set, and how many it holds for: doubled when the size refused is the
  // last ceiling's again (its probe met the same cap), else the rules' ceilingPages (a refusal under the cap)
  let held = 0;
  let hold = pager.rules.ceilingPages;
  let lastCeiling: bigint | null = null;
  let tries = 0;
  // refusals in a row of a page no wider than its provider answered (EVM_LOG_REFUSED_AGAIN)
  let again = 0;
  // the widest page this read answered in full: a named span under it is one backend's, never this provider's cap (a
  // W's Transfer pager keeps no `answered`, review fold 3)
  let widest: bigint | null = null;
  const ceiling = (size: bigint) => {
    hold = size === lastCeiling ? hold * 2 : pager.rules.ceilingPages;
    refused = lastCeiling = size;
    held = 0;
  };
  for (let at = from; at <= to; ) {
    signal?.throwIfAborted();
    const p = pager.of(rpc, k);
    const size = p.size;
    const end = at + size - 1n < to ? at + size - 1n : to;
    let got: unknown;
    try {
      got = await rpc("eth_getLogs", [{ ...filter, fromBlock: tag(at), toBlock: tag(end) }]);
    } catch (e) {
      // the other RPC failed and this read was stopped: never a smaller page for the next W
      signal?.throwIfAborted();
      const m = String((e as Error)?.message ?? e);
      if (HEAD_LAG.test(m)) lag(`rpc ${k}: its logs of ${at}..${end} are behind its head (${m})`);
      const t = throttled(e);
      if (t?.kind === "slow" && !slowHalves && end > at && p.answered !== null && end - at + 1n > p.answered) {
        // wider than this provider ever answered: back to the widest it did, held as the read's ceiling
        ceiling(end - at + 1n);
        p.size = p.answered;
        continue;
      }
      if (t !== null && (t.kind === "throttle" || end === at || !slowHalves)) {
        if (++tries >= EVM_LOG_THROTTLE_TRIES) throw e;
        await sleep(throttleWaitMs(tries, t.afterMs), signal);
        continue;
      }
      if (end > at && p.answered !== null && end - at + 1n <= p.answered && ++again <= EVM_LOG_REFUSED_AGAIN) continue;
      if (end > at) {
        again = 0;
        // a cap that names its span at most half this page: that span at once, held as the read's ceiling just past it
        // (card helper-evm-range-cap-walk: halving 10,000 to a named 50 took 8 refusals and paged at 39); a span named
        // nearer the page is halved past, so no words step the page down a block a call (review fold 2); never under a
        // page this provider or this read answered in full, where the words are one backend's, not its cap (Pocket's,
        // 6 Nov 07:44Z; review fold 3)
        const named = capSpanOf(m);
        const floor = p.answered !== null && (widest === null || p.answered > widest) ? p.answered : widest;
        if (named !== null && named >= 1n && named <= (end - at + 1n) / 2n && (floor === null || named >= floor)) {
          ceiling(named + 1n);
          p.size = named;
          continue;
        }
        ceiling(end - at + 1n);
        p.size = (end - at + 1n) / 2n;
        continue;
      }
      throw e;
    }
    tries = 0;
    again = 0;
    if (!Array.isArray(got)) throw new Error(`rpc ${k}: eth_getLogs ${at}..${end}: not a list`);
    out.push(...got.map((g, i) => decode(g, at, end, `rpc ${k}: log ${i} of ${at}..${end}`)));
    const full = end - at + 1n === size;
    if (full && (p.answered === null || size > p.answered)) p.answered = size;
    if (full && (widest === null || size > widest)) widest = size;
    if (full && refused !== null && ++held >= hold) refused = null;
    if (full && size * 2n <= max && (refused === null || size * 2n < refused)) p.size = size * 2n;
    at = end + 1n;
  }
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!, b = out[i]!;
    if (b.block < a.block || (b.block === a.block && (b.logIndex <= a.logIndex || b.blockHash !== a.blockHash))) throw new Error(`rpc ${k}: the logs are not in order at ${i}`);
  }
  return out;
}

/** The two anchors of one read: the finalized one and the newest agreed one (evmAgreedBlock at each tag). */
export type EvmAnchors = { fin: EvmBlock; anchor: EvmBlock };

/**
 * One filter's logs over from..anchor on both RPCs (each paging on its own `page`), the same on both, byte for byte.
 * A log in the finalized anchor's block must carry its hash. A log in the newest anchor's block naming another hash, or
 * the two lists differing, is refused unless the newest anchor's height holds another hash now (a reorg under the
 * read: a retry). One list a strict prefix of the other, every log it lacks past the finalized anchor, is one RPC's log
 * index a moment behind its headers: a retry. Whose logs they are never matters: any other difference is refused,
 * for every device alike. `at0` numbers the logs in the refusal (the pool's leaves held before `from`). `page` is a W's
 * Transfer read's one size per RPC (with `ceilingPages`, each RPC's readLogs') or the pool sync's pager
 * is each RPC's readLogs'.
 */
export async function evmAgreedLogs<E extends EvmLogRow>(rpcs: Rpcs, filter: EvmLogFilter, decode: EvmLogDecode<E>, from: bigint, { fin, anchor }: EvmAnchors, page: bigint[] | EvmLogPager, at0: number, signal?: AbortSignal, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, ceilingPages?: number): Promise<E[]> {
  const refuse = async (why: string): Promise<never> => {
    const now = await both(rpcs, (rpc, k, sig) => readBlock(rpc, tag(anchor.number), `rpc ${k} block ${anchor.number}`, sig, sleep ?? wait), signal);
    if (now.some((b) => b === null || b.hash !== anchor.hash)) return lag(`block ${anchor.number} moved under the read (a reorg)`);
    throw new Error(why);
  };
  const pager = Array.isArray(page) ? transferPager(page, ceilingPages) : page;
  const [x, y] = await both(rpcs, (rpc, k, sig) => readLogs(rpc, k, filter, decode, from, anchor.number, pager, sig, sleep), signal);
  for (const e of [...x, ...y]) {
    if (e.block === fin.number && e.blockHash !== fin.hash) throw new Error(`a log of block ${e.block} is not of the anchor ${fin.hash}`);
    if (e.block === anchor.number && e.blockHash !== anchor.hash) await refuse(`a log of block ${e.block} is not of the anchor ${anchor.hash}`);
  }
  const i = x.findIndex((e, j) => e.bytes !== y[j]?.bytes);
  const at = i >= 0 ? i : x.length < y.length ? x.length : -1;
  if (at >= 0) {
    const [short, long] = x.length < y.length ? [x, y] : [y, x];
    if (at === short.length && long.slice(at).every((e) => e.block > fin.number)) lag(`rpc ${short === x ? 0 : 1}'s logs past block ${fin.number} are behind the other's`);
    await refuse(`the two RPCs differ at log ${at0 + at} (blocks ${from}..${anchor.number})`);
  }
  return x;
}

/** ERC-20's Transfer(address indexed from, address indexed to, uint256 value) (EIP-20): its topic. ERC-721's Transfer
 * has the same signature and topic, with the token id indexed as a fourth topic. */
export const EVM_TRANSFER_TOPIC = topicOf("Transfer(address,address,uint256)");
/** One Transfer log to a W: the token's contract (the log's address, lowercase). */
export type EvmTransferLog = EvmLogRow & { token: string };

/** A Transfer log to `w` (topic 2), as the filter asks: any contract, Transfer's topic, three or four topics. */
function decodeTransfer(raw: unknown, w: string, from: bigint, to: bigint, what: string): EvmTransferLog {
  const l = raw as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown; blockHash?: unknown; logIndex?: unknown; transactionHash?: unknown; transactionIndex?: unknown; removed?: unknown };
  if (typeof l !== "object" || l === null) throw new Error(`${what}: not a log`);
  addr20(l.address, `${what}: the token`);
  const token = lower(l.address as string);
  if (l.removed !== undefined && l.removed !== false) throw new Error(`${what}: a removed log`);
  const block = qty(l.blockNumber, `${what} blockNumber`);
  if (block < from || block > to) throw new Error(`${what}: block ${block} is outside ${from}..${to}`);
  const blockHash = hash32(l.blockHash, `${what} blockHash`);
  const logIndex = qty(l.logIndex, `${what} logIndex`);
  const tx = hash32(l.transactionHash, `${what} transactionHash`);
  const txIndex = qty(l.transactionIndex, `${what} transactionIndex`);
  if (!Array.isArray(l.topics) || (l.topics.length !== 3 && l.topics.length !== 4)) throw new Error(`${what}: not a Transfer's three or four topics`);
  const topics = l.topics.map((t, i) => hash32(t, `${what} topic ${i}`));
  if (topics[0] !== EVM_TRANSFER_TOPIC) throw new Error(`${what}: not a Transfer`);
  if (topics[2] !== `0x${w.slice(2).padStart(64, "0")}`) throw new Error(`${what}: not a Transfer to the W asked`);
  const data = evmRpcHex(l.data);
  if (data === null || !/^0x([0-9a-f]{2})*$/.test(data)) throw new Error(`${what}: data not hex bytes`);
  const bytes = [tag(block), blockHash, tag(logIndex), tx, tag(txIndex), token, ...topics, data].join(" ");
  return { block, blockHash, logIndex, bytes, token };
}

/**
 * Every token a W was sent from block `from` up to the newest anchor: the contracts of the Transfer logs to W
 * (eth_getLogs, topic 2 = W, no address), read on both RPCs, paged under each provider's caps (one `page` pair, kept
 * across Ws), the same on both byte for byte (evmAgreedLogs). Each call names this one W and nothing else of the
 * user's. A token bought outside any list is found: the read names no token. Lowercase, sorted.
 */
export async function evmTokensSentTo(rpcs: readonly [EvmRpc, EvmRpc], w: string, from: bigint, anchors: EvmAnchors, page: bigint[], signal?: AbortSignal, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>): Promise<string[]> {
  checkEvmRpcs(rpcs);
  addr20(w, "W");
  const to = lower(w);
  if (typeof from !== "bigint" || from < 0n) throw new Error("from: a block number");
  const logs = from > anchors.anchor.number ? [] : await evmAgreedLogs(rpcs, { topics: [EVM_TRANSFER_TOPIC, null, `0x${to.slice(2).padStart(64, "0")}`] }, (raw, f, t, what) => decodeTransfer(raw, to, f, t, what), from, anchors, page, 0, signal, sleep, EVM_LOG_CEILING_PAGES);
  return [...new Set(logs.map((l) => l.token))].sort();
}

/**
 * Two RPCs that read on the pool's chain at the restore's anchor: eth_chainId must be `chainId` on both (another chain
 * is refused), and the anchor's height must hold the anchor's hash on both (another hash, or none yet, is a lag: a
 * retry). Run before a W's Transfer reads, so no Transfer log of another chain or another fork is ever taken.
 */
export async function evmHoldsAnchor(rpcs: readonly [EvmRpc, EvmRpc], chainId: bigint, anchor: EvmBlock, signal?: AbortSignal, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = wait): Promise<void> {
  checkEvmRpcs(rpcs);
  const ids = await both(rpcs, async (rpc, k, sig) => qty(await evmAnswered(() => rpc("eth_chainId", []), sig, sleep), `rpc ${k} eth_chainId`), signal);
  if (ids[0] !== chainId || ids[1] !== chainId) throw new Error(`rpcs: chain ${ids[0]} and ${ids[1]}, not ${chainId}`);
  const bs = await both(rpcs, (rpc, k, sig) => evmAnswered(() => getBlock(rpc, tag(anchor.number), `rpc ${k} block ${anchor.number}`), sig, sleep), signal);
  if (bs.some((b) => b === null || b.hash !== anchor.hash)) lag(`an RPC does not hold block ${anchor.number} as ${anchor.hash}`);
}

/**
 * Every token a W was sent from block `from` up to the newest anchor, on one reader: the helper's route on mainnet
 * (./evm-restore.ts, decision M359: a W's holdings are display, read on the helper's keyed provider, never named to a
 * provider the device reaches itself). The anchor's height must hold the anchor's hash on it first (another hash, or
 * none yet, is a lag: a retry), which also holds it to the pool's chain, since the route answers no eth_chainId; then
 * the Transfer logs to W (eth_getLogs, topic 2 = W, no address), paged under its cap (`page[0]`, kept across Ws), each
 * log in the finalized or the newest anchor's block of that block's hash (the newest's another hash is a lag). Each
 * call names this one W and nothing else of the user's. No second provider compares them: they gate no signature.
 */
export async function evmTokensSentToOne(rpc: EvmRpc, w: string, from: bigint, { fin, anchor }: EvmAnchors, page: bigint[], signal?: AbortSignal, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = wait): Promise<string[]> {
  addr20(w, "W");
  const to = lower(w);
  if (typeof from !== "bigint" || from < 0n) throw new Error("from: a block number");
  const b = await evmAnswered(() => getBlock(rpc, tag(anchor.number), `block ${anchor.number}`), signal, sleep);
  if (b === null || b.hash !== anchor.hash) lag(`the reader does not hold block ${anchor.number} as ${anchor.hash}`);
  if (from > anchor.number) return [];
  const logs = await readLogs(rpc, 0, { topics: [EVM_TRANSFER_TOPIC, null, `0x${to.slice(2).padStart(64, "0")}`] }, (raw, f, t, what) => decodeTransfer(raw, to, f, t, what), from, anchor.number, transferPager(page, EVM_LOG_CEILING_PAGES), signal, sleep);
  for (const e of logs) {
    if (e.block === fin.number && e.blockHash !== fin.hash) throw new Error(`a log of block ${e.block} is not of the anchor ${fin.hash}`);
    if (e.block === anchor.number && e.blockHash !== anchor.hash) lag(`a log of block ${e.block} is not of the anchor ${anchor.hash}`);
  }
  return [...new Set(logs.map((l) => l.token))].sort();
}

/** What a trees() call may ask beyond the cut: a deposit's own note's newest root, read like every other read. */
export type EvmTreesOpts = { newest?: boolean };

/** The sync's read at one anchor: every leaf event both RPCs agree on up to it, checked against the pool's views. */
type Round = EvmAnchors & { events: Ev[] };

export type EvmTreeSync = {
  trees(beforeMs: bigint, signal?: AbortSignal, opts?: EvmTreesOpts): Promise<PoolTrees>;
  /** Every leaf event of the pool up to the newest agreed block, the same on both RPCs and making the pool's trees at
   * that block (its views), with the round's two anchors: the whole set a restore reads (./evm-restore.ts). With
   * `once`, one round and its lag thrown, for a caller that retries itself (one retry budget, never one in another). */
  events(signal?: AbortSignal, once?: boolean): Promise<Round>;
  /** The state tree's depth after every leaf in blocks up to `block` (the pool's currentTreeDepth at that block). With
   * `hash`, `block` must still be that block on both RPCs after the round (the round's chain), else a lag; then the
   * caller retries (it re-reads the block), not depthAt. */
  depthAt(block: bigint, signal?: AbortSignal, hash?: string): Promise<number>;
};

export type EvmSyncArgs = {
  /** A pinned list of two or more providers on the pool's network, read as a pair with spares (evmPair). */
  rpcs: readonly EvmRpc[];
  pin: EvmPoolPin;
  /** Where the device holds this pool's sync between syncs (evmMemoryHold, or the device's store): none, the sync
   * starts from the pin's deploy block. */
  held?: EvmSyncHold;
  /** tests only: the wait between lag retries */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * A pool sync's held part, as the device keeps it between syncs (card evm-pool-sync-wide-pages): every leaf event of
 * the pool in blocks fromBlock..to, read on both RPCs, the same on both byte for byte, at or below a finalized anchor,
 * and with the tail of its round making the pool's trees at that round's newest anchor. Its events are the trees'
 * leaves, in log order, so the tree is rebuilt from them; `to` is the last block synced. The pool's public logs only: no
 * secret, and nothing that says which leaf is the user's.
 */
export type EvmSyncHeld = { network: EvmNetwork; pool: string; fromBlock: bigint; to: bigint; events: readonly EvmPoolEvent[] };
/** Where a sync's held part is kept: read once, at its first round (a record that is not this pin's, or not in shape,
 * is not taken); written each time the held part rises. A later sync then reads only the blocks after `to`, and its
 * first round holds the held leaves to the pool's views with the new ones: a held part they do not make is dropped and
 * the pool read again from its deploy block, once. A write that fails leaves the sync as it is. */
export type EvmSyncHold = { read(): Promise<EvmSyncHeld | null | undefined>; write(h: EvmSyncHeld): Promise<void> };

/** A hold in this page's memory: every sync given it (the pool's, a restore's) reads only past the last one's blocks. */
export function evmMemoryHold(): EvmSyncHold {
  let h: EvmSyncHeld | null = null;
  return { read: async () => h, write: async (v) => void (h = v) };
}

const KINDS = new Set(["deposit", "withdraw", "buy"]);
const nullOr = (v: unknown, t: string): boolean => v === null || typeof v === t;
/** A held record this pin's and in shape: its events in this pin's blocks up to `to`, in order, each of the shape the
 * sync and a restore read (the views check holds what they say). */
function heldOf(h: unknown, pin: EvmPoolPin, pool: string): EvmSyncHeld | null {
  const r = h as Partial<EvmSyncHeld> | null | undefined;
  if (r === null || typeof r !== "object" || r.network !== pin.network || typeof r.pool !== "string" || lower(r.pool) !== pool || r.fromBlock !== pin.fromBlock) return null;
  if (typeof r.to !== "bigint" || r.to < pin.fromBlock - 1n || !Array.isArray(r.events)) return null;
  let last: Ev | null = null;
  for (const e of r.events as Ev[]) {
    if (e === null || typeof e !== "object" || typeof e.block !== "bigint" || e.block < pin.fromBlock || e.block > r.to || typeof e.logIndex !== "bigint") return null;
    if (last !== null && (e.block < last.block || (e.block === last.block && e.logIndex <= last.logIndex))) return null;
    if (!KINDS.has(e.kind) || typeof e.state !== "bigint" || typeof e.value !== "bigint" || typeof e.blockHash !== "string" || typeof e.bytes !== "string") return null;
    if (!nullOr(e.label, "bigint") || !nullOr(e.precommitment, "bigint") || !nullOr(e.nullifier, "bigint") || !nullOr(e.recipient, "string") || !nullOr(e.token, "string")) return null;
    last = e;
  }
  return r as EvmSyncHeld;
}

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const t = setTimeout(() => (signal?.removeEventListener("abort", stop), resolve()), ms);
    const stop = () => (clearTimeout(t), reject(signal!.reason));
    signal?.addEventListener("abort", stop, { once: true });
  });

/** f, again after EVM_LAG_WAIT_MS while it throws EvmLagError, at most EVM_LAG_TRIES times in all. */
export async function evmRetryLag<T>(f: () => Promise<T>, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = wait, signal?: AbortSignal): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof EvmLagError) || n >= EVM_LAG_TRIES) throw e;
      await sleep(EVM_LAG_WAIT_MS, signal);
    }
  }
}

/**
 * The block both RPCs agree on at a tag: the lower of their `at` blocks, read by number on both, one hash, time and
 * number on both. Two blocks at that height are a retry at EVM_NEWEST_TAG (two honest RPCs may hold two blocks of one
 * height for a moment) and refused at a final tag (a final block never moves).
 */
export async function evmAgreedBlock(rpcs: readonly [EvmRpc, EvmRpc], at: string, signal?: AbortSignal, sleep: Sleep = wait): Promise<EvmBlock> {
  const tops = await both(rpcs, (rpc, k, sig) => readBlock(rpc, at, `rpc ${k} ${at} block`, sig, sleep), signal);
  if (tops[0] === null || tops[1] === null) return lag(`an RPC has no ${at} block`);
  const n = tops[0].number < tops[1].number ? tops[0].number : tops[1].number;
  const [x, y] = await both(rpcs, (rpc, k, sig) => readBlock(rpc, tag(n), `rpc ${k} block ${n}`, sig, sleep), signal);
  if (x === null || y === null) return lag(`rpc ${x === null ? 0 : 1} does not know block ${n} yet`);
  if (x.hash !== y.hash || x.timestamp !== y.timestamp || x.number !== n || y.number !== n) {
    if (at === EVM_NEWEST_TAG) return lag(`the two RPCs hold different blocks at ${n}`);
    throw new Error(`the two RPCs hold different blocks at ${n}`);
  }
  return x;
}

/** LeanIMT's depth for `size` leaves: ceil(log2(size)), 0 for 0 or 1 (lean-imt InternalLeanIMT _insert). */
const depthOf = (size: number): number => {
  let d = 0;
  while (2 ** d < size) d++;
  return d;
};

/**
 * The pool's tree sync on two RPCs. Every leaf event read at an EVM_POOL_TAG anchor on both RPCs, the same on both and
 * matching the pool's views at the anchor, is kept: it can never change. Each round reads only past what it holds. A
 * tail past the finalized block is read again on every round and never kept. Rounds run one at a time.
 */
export function evmTreeSync(a: EvmSyncArgs): EvmTreeSync {
  const rpcs = evmPair(a.rpcs);
  const pool = lower(a.pin.pool);
  addr20(pool, "pool");
  const chainId = EVM_CHAIN_IDS[a.pin.network];
  if (chainId === undefined) throw new Error(`network: unknown ${String(a.pin.network)}`);
  if (typeof a.pin.fromBlock !== "bigint" || a.pin.fromBlock < 0n) throw new Error("fromBlock: a block number");
  const scope = evmPoolScopeOf(pool, chainId);
  const sleep = a.sleep ?? wait;
  let held: Ev[] = [];
  let heldTo = a.pin.fromBlock - 1n;
  let checked = false;
  // the device's held part (a.held): read at the first round; `fromHold` until a round's views check has held it
  let read = a.held === undefined;
  let fromHold = false;
  let writtenTo = heldTo;
  const pager = evmPoolLogPager();
  const poolFilter: EvmLogFilter = { address: pool, topics: [[TOPIC_DEPOSITED, TOPIC_WITHDRAWN, TOPIC_BOUGHT]] };
  const poolDecode: EvmLogDecode<Ev> = (raw, from, to, what) => decodeLog(raw, pool, from, to, what);
  const times = new Map<string, bigint>();
  let turn: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const r = turn.then(f, f);
    turn = r.catch(() => {});
    return r;
  };

  const anchorAt = (at: string, signal?: AbortSignal): Promise<EvmBlock> => evmAgreedBlock(rpcs, at, signal, sleep);

  /** One view on both RPCs at the anchor; the two answers must be one. */
  async function agreed(data: string, h: string, what: string, signal?: AbortSignal): Promise<bigint> {
    const [x, y] = await both(rpcs, (rpc, k, sig) => view(rpc, pool, data, h, `rpc ${k} ${what}`, sig, sleep), signal);
    if (x !== y) throw new Error(`the two RPCs differ on ${what} at ${h}`);
    return x;
  }

  /** A block's timestamp, read by hash on both RPCs (kept: a hash's block never changes). */
  async function timeOf(h: string, n: bigint, signal?: AbortSignal): Promise<bigint> {
    const known = times.get(h);
    if (known !== undefined) return known;
    const [x, y] = await both(rpcs, (rpc, k, sig) => poolRead(`rpc ${k} block ${h}`, async () => blockOf(await rpc("eth_getBlockByHash", [h, false]), `rpc ${k} block ${h}`), sig, sleep), signal);
    if (x === null || y === null) return lag(`rpc ${x === null ? 0 : 1} does not know block ${h} yet`);
    if (x.hash !== h || y.hash !== h || x.number !== n || y.number !== n) throw new Error(`block ${h}: not block ${n}`);
    if (x.timestamp !== y.timestamp) throw new Error(`block ${h}: the two RPCs differ on its time`);
    times.set(h, x.timestamp);
    return x.timestamp;
  }

  /**
   * One round: the finalized anchor, the newest anchor, the pool's views at the newest, then the logs past what is
   * held up to the newest, all on both RPCs. Only once the trees built from them are the pool's at the newest anchor
   * does the cache take the leaves up to the finalized anchor; the tail is read again on the next round.
   */
  async function round(signal?: AbortSignal): Promise<Round & { stateTree: VaultTree; labelTree: VaultTree }> {
    if (!read) {
      const h = heldOf(await a.held!.read().catch(() => null), a.pin, pool);
      read = true;
      if (h !== null && h.to > heldTo) {
        held = [...h.events];
        heldTo = writtenTo = h.to;
        fromHold = true;
      }
    }
    if (!checked) {
      const ids = await both(rpcs, async (rpc, k, sig) => qty(await poolRead(`rpc ${k} eth_chainId`, () => rpc("eth_chainId", []), sig, sleep), `rpc ${k} eth_chainId`), signal);
      if (ids[0] !== chainId || ids[1] !== chainId) throw new Error(`rpcs: chain ${ids[0]} and ${ids[1]}, not ${a.pin.network}'s ${chainId}`);
    }
    // a finalized anchor at or below what is held (a pool just deployed, or an RPC's finalized behind another's) is
    // consistent: the cache stays where it is and the tail is read from past it
    const fin = await anchorAt(EVM_POOL_TAG, signal);
    const anchor = await anchorAt(EVM_NEWEST_TAG, signal);
    // a newest anchor below what is held is behind a block already final, or the pool's deploy block: a retry, never
    // the views check, where a held leaf above the anchor would read as a lie
    if (anchor.number < heldTo) return lag(`the newest agreed block ${anchor.number} is below the ${heldTo} already read`);
    if (anchor.number < fin.number) return lag(`the newest agreed block ${anchor.number} is below the ${EVM_POOL_TAG} ${fin.number}`);
    // the views first: a pruning node keeps only recent state
    if (!checked && (await agreed(VIEWS.SCOPE, anchor.hash, "SCOPE()", signal)) !== scope) throw new Error(`SCOPE(): not the scope of ${pool} on ${a.pin.network}`);
    const root = await agreed(VIEWS.currentRoot, anchor.hash, "currentRoot()", signal);
    const size = await agreed(VIEWS.currentTreeSize, anchor.hash, "currentTreeSize()", signal);
    const labelRoot = await agreed(VIEWS.currentLabelRoot, anchor.hash, "currentLabelRoot()", signal);
    const labelSize = await agreed(VIEWS.currentLabelTreeSize, anchor.hash, "currentLabelTreeSize()", signal);
    // the logs are read by range, not at a hash: a reorg between the views and the logs gives a tail of another chain
    // on one RPC or both. That is a retry, told apart from a lie by the newest anchor's height holding another hash now.
    const refuse = async (why: string): Promise<never> => {
      const now = await both(rpcs, (rpc, k, sig) => readBlock(rpc, tag(anchor.number), `rpc ${k} block ${anchor.number}`, sig, sleep), signal);
      if (now.some((b) => b === null || b.hash !== anchor.hash)) return lag(`block ${anchor.number} moved under the read (a reorg)`);
      throw new Error(why);
    };
    const fresh = anchor.number > heldTo ? await evmAgreedLogs(rpcs, poolFilter, poolDecode, heldTo + 1n, { fin, anchor }, pager, held.length, signal, sleep) : [];
    const events = [...held, ...fresh];
    const stateTree = new VaultTree(events.map((e) => e.state));
    const labels = events.flatMap((e) => (e.label === null ? [] : [e.label]));
    const labelTree = new VaultTree(labels);
    const wrong =
      BigInt(stateTree.size) !== size || (stateTree.root ?? 0n) !== root ? `the state tree from the logs (${stateTree.size} leaves) is not the pool's at ${anchor.hash} (${size})`
      : BigInt(labelTree.size) !== labelSize || (labelTree.root ?? 0n) !== labelRoot ? `the label tree from the logs (${labelTree.size} leaves) is not the pool's at ${anchor.hash} (${labelSize})`
      : null;
    if (wrong !== null && fromHold) {
      // a reorg under the read is a retry, the held part kept; else the held part is not the pool's: dropped, and the
      // pool read again from its deploy block (once: the read again holds nothing from the hold)
      await refuse(wrong).catch((e: unknown) => {
        if (e instanceof EvmLagError) throw e;
      });
      held = [];
      heldTo = writtenTo = a.pin.fromBlock - 1n;
      fromHold = false;
      return round(signal);
    }
    if (wrong !== null) await refuse(wrong);
    checked = true;
    fromHold = false;
    // the cache only ever rises
    const top = fin.number > heldTo ? fin.number : heldTo;
    held = events.filter((e) => e.block <= top);
    heldTo = top;
    if (a.held !== undefined && top > writtenTo) {
      writtenTo = top;
      await a.held.write({ network: a.pin.network, pool, fromBlock: a.pin.fromBlock, to: top, events: held }).catch(() => {});
    }
    return { fin, anchor, events, stateTree, labelTree };
  }

  /** The number of events whose block's timestamp * 1000 is below beforeMs: times never go back, so a search. */
  async function cutOf(events: Ev[], beforeMs: bigint, signal?: AbortSignal): Promise<number> {
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = events[mid]!;
      if ((await timeOf(e.blockHash, e.block, signal)) * 1000n < beforeMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  return {
    trees(beforeMs, signal, opts) {
      if (typeof beforeMs !== "bigint" || beforeMs <= 0n) return Promise.reject(new Error("beforeMs: a bigint above 0"));
      // a deposit's own note (opts.newest) reads the same newest agreed block as every epoch read
      return serial(() => evmRetryLag(async () => {
        const r = await round(signal);
        // every leaf under the cut is in only once the anchor's time reached beforeMs; later blocks' times are too
        if (r.anchor.timestamp * 1000n < beforeMs) lag(`the anchor ${r.anchor.number} (${r.anchor.timestamp * 1000n} ms) has not reached ${beforeMs}`);
        const n = await cutOf(r.events, beforeMs, signal);
        const cut = r.events.slice(0, n);
        const labels = cut.flatMap((e) => (e.label === null ? [] : [e]));
        if (n === 0 || labels.length === 0) throw new Error(`no leaf before ${beforeMs}`);
        const stateTree = n === r.events.length ? r.stateTree : new VaultTree(cut.map((e) => e.state));
        const labelTree = labels.length === r.labelTree.size ? r.labelTree : new VaultTree(labels.map((e) => e.label!));
        // the pool's own record of each epoch root: the time of the block that made it (State.sol:63-65, 172, 188)
        const last = cut[n - 1]!, lastLabel = labels[labels.length - 1]!;
        const st = await agreed(VIEWS.stateRootTimes + hex(word(stateTree.root!)), r.anchor.hash, "stateRootTimes(root)", signal);
        if (st !== (await timeOf(last.blockHash, last.block, signal))) throw new Error(`the state root built from the cut is not the pool's root of block ${last.block}`);
        const lt = await agreed(VIEWS.labelRootTimes + hex(word(labelTree.root!)), r.anchor.hash, "labelRootTimes(root)", signal);
        if (lt !== (await timeOf(lastLabel.blockHash, lastLabel.block, signal))) throw new Error(`the label root built from the cut is not the pool's root of block ${lastLabel.block}`);
        return { stateTree, labelTree, stateRoot: stateTree.root!, labelRoot: labelTree.root! };
      }, sleep, signal));
    },
    events(signal, once) {
      const one = async (): Promise<Round> => {
        const { fin, anchor, events } = await round(signal);
        return { fin, anchor, events };
      };
      return serial(() => (once === true ? one() : evmRetryLag(one, sleep, signal)));
    },
    depthAt(block, signal, hash) {
      if (typeof block !== "bigint" || block < 0n) return Promise.reject(new Error("block: a block number"));
      const once = async () => {
        const r = await round(signal);
        if (r.anchor.number < block) lag(`the newest agreed block ${r.anchor.number} is below block ${block}`);
        if (hash !== undefined) {
          const now = await both(rpcs, (rpc, k, sig) => readBlock(rpc, tag(block), `rpc ${k} block ${block}`, sig, sleep), signal);
          if (now.some((b) => b === null || b.hash !== hash)) lag(`block ${block} is no longer ${hash} (a reorg)`);
        }
        return depthOf(r.events.filter((e) => e.block <= block).length);
      };
      return serial(() => (hash === undefined ? evmRetryLag(once, sleep, signal) : once()));
    },
  };
}

/** The pool's time: the newest block both RPCs agree on (evmAgreedBlock at EVM_NEWEST_TAG), ms; never one RPC's word. */
export async function evmNow(rpcs: readonly [EvmRpc, EvmRpc], signal?: AbortSignal, sleep: Sleep = wait): Promise<bigint> {
  checkEvmRpcs(rpcs);
  return (await evmAgreedBlock(rpcs, EVM_NEWEST_TAG, signal, sleep)).timestamp * 1000n;
}

/** The higher of the two RPCs' latest block times, ms: for a check a lie may only make refuse (bind's send margin). */
export async function evmLatestHigh(rpcs: readonly [EvmRpc, EvmRpc], signal?: AbortSignal, sleep: Sleep = wait): Promise<bigint> {
  checkEvmRpcs(rpcs);
  const [x, y] = await both(rpcs, (rpc, k, sig) => readBlock(rpc, EVM_NEWEST_TAG, `rpc ${k} ${EVM_NEWEST_TAG} block`, sig, sleep), signal);
  if (x === null || y === null) return lag(`an RPC has no ${EVM_NEWEST_TAG} block`);
  return (x.timestamp > y.timestamp ? x.timestamp : y.timestamp) * 1000n;
}

/**
 * The epoch's first block: the first whose timestamp * 1000 is at or after `epochStartMs`, searched on RPC 0 at and
 * below the newest block both RPCs agree on, then it and the block before it read on both RPCs, one hash each. RPC 0's
 * block at a height it searched holding another hash now is a reorg under the search, and the two RPCs holding two
 * blocks there a moment's fork: both a retry. One hash with two times or two base fees is refused.
 */
export async function evmEpochBlock(rpcs: readonly [EvmRpc, EvmRpc], epochStartMs: bigint, signal?: AbortSignal, sleep: Sleep = wait): Promise<EvmBlock> {
  checkEvmRpcs(rpcs);
  const at = async (n: bigint | string): Promise<EvmBlock> => {
    const b = await readBlock(rpcs[0], typeof n === "string" ? n : tag(n), `rpc 0 block ${n}`, signal, sleep);
    if (b === null) return lag(`rpc 0 does not know block ${n} yet`);
    return b;
  };
  const after = (b: EvmBlock) => b.timestamp * 1000n >= epochStartMs;
  let hi = await evmAgreedBlock(rpcs, EVM_NEWEST_TAG, signal, sleep);
  if (!after(hi)) return lag(`the ${EVM_NEWEST_TAG} block ${hi.number} is before ${epochStartMs}`);
  let lo: EvmBlock | null = null;
  for (let step = 1n; hi.number > 0n; step *= 2n) {
    signal?.throwIfAborted();
    const b = await at(hi.number > step ? hi.number - step : 0n);
    if (!after(b)) {
      lo = b;
      break;
    }
    hi = b;
  }
  if (lo === null) throw new Error(`no block before ${epochStartMs}`);
  while (hi.number - lo.number > 1n) {
    signal?.throwIfAborted();
    const mid = await at((lo.number + hi.number) / 2n);
    if (after(mid)) hi = mid;
    else lo = mid;
  }
  // both blocks on both RPCs, one hash each: the first block is after the start and the one before it is not
  for (const want of [hi, lo]) {
    const [x, y] = await both(rpcs, (rpc, k, sig) => readBlock(rpc, tag(want.number), `rpc ${k} block ${want.number}`, sig, sleep), signal);
    if (x === null || y === null) return lag(`rpc ${x === null ? 0 : 1} does not know block ${want.number} yet`);
    if (x.hash !== want.hash) return lag(`block ${want.number} moved under the search (a reorg)`);
    if (y.hash !== want.hash) return lag(`the two RPCs hold different blocks at ${want.number}`);
    if (y.timestamp !== want.timestamp || y.baseFeePerGas !== want.baseFeePerGas) throw new Error(`the two RPCs differ on block ${want.number} (${want.hash})`);
  }
  if (hi.baseFeePerGas === null) throw new Error(`block ${hi.number}: no base fee`);
  return hi;
}

/** GET /v1/pool/fee's answer for an EVM pool (the helper's EvmFeeAnswer, card helper-pool-senders). */
export type EvmFeeAnswer = { chain: string; network: string; pool: string; fee_recipient: string; epoch_ms: number; epoch_start_ms: number; block: string; fee: string; step: string };

/**
 * The epoch fee rule, M356 (4) and M357 (3), a function the caller passes: bind calls it once with the epoch's first
 * block and its base fee (both RPCs), the pool's tree depth there (from the leaves both RPCs agree on) and the chain fee
 * there (the kit's evmPoolChainFeeReads at that block's hash, the same answer on both RPCs), every input the device's own
 * read, and binds only when the helper's GET /v1/pool/fee answer is exactly what it returns. The caller passes the
 * kit's evmPoolFee({ gas: evmPoolGas(depth), gasPrice: baseFeePerGas, chainFee }), which applies the kit's one floor
 * (contracts/pool-evm/script/testnet-run.mjs), the function the helper's answer is (apps/helper/src/pool/evm.ts feeOf).
 */
export type EvmEpochFeeRule = (at: { block: bigint; baseFeePerGas: bigint; depth: number; chainFee: bigint }) => bigint;

export type EvmPoolArgs = {
  /** The network's pin (EVM_POOLS[network]): the pool, the fee recipient and the deploy block, never the helper's word. */
  pin: EvmPoolPin;
  /** A pinned list of two or more providers of different operators on the pool's network, read as a pair with spares
   * (evmPair). */
  rpcs: readonly EvmRpc[];
  /**
   * The two RPCs bind reads the chain fee on, at the epoch's first block's hash, always given (never `rpcs` in their
   * place: card evm-buy-hookdata-fee, fold 4 LOW-1): each must keep
   * state that far back (card evm-buy-hookdata-fee, review fold 2 MEDIUM-A): the kit's fee pair (evmPoolVenues
   * feeProviders, held to 600 s by live check evm-buy-hookdata-fee), never its quote providers, some of which keep no
   * state that far back (card evm-quote-warm-round fold 8). The sync's pair needs wide log pages instead, and on Robinhood
   * testnet no second free provider gives both (read 2026-11-04 20:09-20:44Z: PublicNode keeps about 15 s of state and
   * pages 50,000 blocks of logs; dRPC keeps 600 s and more but refuses a 1,000-block page of the pool's old logs).
   */
  feeRpcs: readonly EvmRpc[];
  /** Where the device holds the pool's sync between syncs (EvmSyncArgs held). */
  held?: EvmSyncHold;
  /** GET /v1/pool/fee?pool=&epoch= on the helper: its answer, refused unless every field is this pool's and its fee
   * the device's own. */
  relayFee: (epochStartMs: bigint, signal?: AbortSignal) => Promise<EvmFeeAnswer>;
  /** The kit's epoch fee formula (EvmEpochFeeRule). */
  epochFee: EvmEpochFeeRule;
  /** tests only: the salt source (16 random bytes unless given) and the wait between lag retries */
  salt?: () => Uint8Array;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function evmPool(a: EvmPoolArgs): Pool<EvmPoolRequest> {
  const rpcs = evmPair(a.rpcs);
  const feeRpcs = evmPair(a.feeRpcs, "feeRpcs");
  if (typeof a.epochFee !== "function" || typeof a.relayFee !== "function") throw new Error("epochFee and relayFee: functions");
  const pool = lower(a.pin.pool);
  const feeRecipient = lower(a.pin.feeRecipient);
  addr20(feeRecipient, "feeRecipient");
  if (feeRecipient === pool || BigInt(feeRecipient) === 0n) throw new Error("feeRecipient: the pool or the zero address");
  const sync = evmTreeSync({ rpcs, pin: a.pin, ...(a.held ? { held: a.held } : {}), ...(a.sleep ? { sleep: a.sleep } : {}) });
  const scope = evmPoolScopeOf(pool, EVM_CHAIN_IDS[a.pin.network]);
  const sleep = a.sleep ?? wait;
  return {
    id: `evm:${a.pin.network}:${pool}`,
    chain: "evm",
    scope,
    ladder: EVM_LADDER,
    epochMs: EVM_EPOCH_MS,
    lifeMs: EVM_LIFE_MS,
    sendMarginMs: EVM_SEND_MARGIN_MS,
    // an agreed read: a moment's fork at the newest height is a retry here, as in every other agreed read
    now: (signal) => evmRetryLag(() => evmNow(rpcs, signal, sleep), sleep, signal),
    trees: (beforeMs, signal, opts) => sync.trees(beforeMs, signal, opts),
    async bind({ chunk, wallet, refundPrecommitment, epochStartMs, deadlineMs }, signal) {
      if (!(wallet?.publicKey instanceof Uint8Array) || typeof wallet.address !== "string" || wallet.address !== evmAddress(wallet.publicKey))
        throw new Error("wallet: an EVM W is EIP-55 of its secp256k1 public key");
      const w = lower(wallet.address);
      if (w === pool || w === feeRecipient || BigInt(w) === 0n) throw new Error("wallet: W is the pool, the fee recipient or the zero address");
      if (typeof chunk !== "bigint" || chunk <= 0n || chunk >= U128) throw new Error("chunk: above 0 and below 2^128");
      if (typeof refundPrecommitment !== "bigint" || refundPrecommitment < 0n || refundPrecommitment >= VAULT_FIELD_P) throw new Error("refundPrecommitment: not a field element");
      if (typeof epochStartMs !== "bigint" || epochStartMs <= 0n || epochStartMs % EVM_EPOCH_MS !== 0n) throw new Error("epochStartMs: not on the epoch grid");
      // the higher of the two latest times: one RPC's lie can only make this refuse
      const nowMs = await evmLatestHigh(rpcs, signal, sleep);
      if (typeof deadlineMs !== "bigint" || deadlineMs !== epochStartMs + EVM_LIFE_MS || deadlineMs > U64 || deadlineMs <= nowMs + EVM_SEND_MARGIN_MS)
        throw new Error("deadlineMs: not on the epoch grid, or too close to send");
      // the device's own fee: the epoch's first block and the tree depth there, each read on both RPCs
      // the depth on the epoch block's own chain: depthAt refuses (a retry) when that block is no longer at its height
      // and the chain fee there (the L1 data fee, and Base's operator fee), the same on both RPCs
      const { block, depth, chainFee } = await evmRetryLag(async () => {
        const block = await evmEpochBlock(rpcs, epochStartMs, signal, sleep);
        const depth = await sync.depthAt(block.number, signal, block.hash);
        const reads = evmPoolChainFeeReads(a.pin.network, evmPoolGas(depth));
        const [x, y] = await both(feeRpcs, (rpc, k, sig) => Promise.all(reads.map((r) => view(rpc, r.to, r.data.slice(2), block.hash, `fee rpc ${k} chain fee`, sig, sleep))), signal);
        if (x.some((v, i) => v !== y[i])) throw new Error(`the two RPCs differ on the chain fee at block ${block.number} (${block.hash})`);
        return { block, depth, chainFee: evmPoolChainFee(a.pin.network, EVM_POOL_TX_BYTES, x) };
      }, sleep, signal);
      const fee = a.epochFee({ block: block.number, baseFeePerGas: block.baseFeePerGas!, depth, chainFee });
      if (typeof fee !== "bigint" || fee < 0n) throw new Error("epochFee: not a fee");
      const f = await a.relayFee(epochStartMs, signal);
      if (f?.chain !== "evm" || f.network !== a.pin.network || typeof f.pool !== "string" || lower(f.pool) !== pool || typeof f.fee_recipient !== "string" || lower(f.fee_recipient) !== feeRecipient)
        throw new Error("relayFee: not this pool's or this fee recipient's answer");
      if (f.epoch_ms !== Number(EVM_EPOCH_MS) || f.epoch_start_ms !== Number(epochStartMs) || evmRpcHex(f.block) !== tag(block.number)) throw new Error("relayFee: not this epoch's or not its first block");
      if (typeof f.fee !== "string" || f.fee !== fee.toString()) throw new Error(`relayFee: the helper's ${String(f.fee)} is not the epoch's fee ${fee}`);
      if (fee * 10_000n > chunk * MAX_RELAY_FEE_BPS) throw new Error("chunk: under the pool's backstop at this fee");
      const salt = (a.salt ?? (() => crypto.getRandomValues(new Uint8Array(16))))();
      if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new Error("salt: not 16 bytes");
      const request: EvmPoolRequest = { processooor: pool, relay: { recipient: wallet.address, feeRecipient, feeCap: fee, deadlineMs, refundPrecommitment, salt: `0x${hex(salt)}` } };
      return { context: evmPoolContextOf(request, scope), feeCap: fee, request };
    },
  };
}
