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
//   the device reads). Each RPC pages on its own: a range-cap error halves that RPC's page and tries again, down to
//   one block, so no provider's cap (200 blocks on sepolia.base.org, 50,000 on publicnode, read 3 Nov 04:21Z) is a
//   limit on the pool.
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
// - A lagging RPC is a retry, never an answer: a tag block below beforeMs, an anchor block one RPC does not know yet,
//   or a pool state call at a hash it does not know, waits EVM_LAG_WAIT_MS and reads again, at most EVM_LAG_TRIES
//   times. Two RPCs that answer differently at one hash are refused at once.
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
// Nothing here holds a secret, and no read names a note or a wallet of the user's: only the pool's own logs and views.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { solanaSameProvider, VAULT_FIELD_P, VaultTree, type SolanaRpc } from "@blindfill/kit";
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
/** The first eth_getLogs page, in blocks; a range-cap error halves it for that RPC. */
export const EVM_LOG_PAGE_BLOCKS = 10_000n;
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
/** A JSON-RPC quantity, canonical (no leading zero), as the spec writes it. */
const qty = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(v)) throw new Error(`${what}: not a quantity`);
  return BigInt(v);
};
const H32 = /^0x[0-9a-f]{64}$/;
const hash32 = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !H32.test(v)) throw new Error(`${what}: not a 32-byte hash`);
  return v;
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

async function both<T>(rpcs: Rpcs, f: (rpc: EvmRpc, k: number) => Promise<T>, signal?: AbortSignal): Promise<[T, T]> {
  signal?.throwIfAborted();
  const r = await Promise.all([f(rpcs[0], 0), f(rpcs[1], 1)]);
  signal?.throwIfAborted();
  return r;
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

/** A JSON-RPC error that says the node does not know the block yet (a lag, not a lie). */
const UNKNOWN_BLOCK = /unknown block|header not found|block not found|no such block/i;
/** A JSON-RPC error that is a provider's cap on one eth_getLogs call's range or size (read 3 Nov 04:21Z: "eth_getLogs is
 * limited to a 200 range", "exceed maximum block range: 50000", "query exceeds max results 20000"). */
const RANGE_CAP = /block range|limited to a?\s?\d+\s?(block )?range|range (is )?too (large|wide)|max(imum)? results|more than \d+ results|response size|query exceeds|too many (results|logs|blocks)/i;

/** One pool view's 32-byte answer, by eth_call at a block hash (EIP-1898). */
async function view(rpc: EvmRpc, pool: string, data: string, blockHash: string, what: string): Promise<bigint> {
  let r: unknown;
  try {
    r = await rpc("eth_call", [{ to: pool, data: `0x${data}` }, { blockHash }]);
  } catch (e) {
    if (UNKNOWN_BLOCK.test(String((e as Error)?.message ?? e))) lag(`${what}: the RPC does not know block ${blockHash} yet`);
    throw e;
  }
  if (typeof r !== "string" || !H32.test(r)) throw new Error(`${what}: not one 32-byte word`);
  return BigInt(r);
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

/** One leaf event, as both RPCs gave it. `bytes` is every field the device reads, for the byte-for-byte compare. */
type Ev = { block: bigint; blockHash: string; logIndex: bigint; state: bigint; label: bigint | null; bytes: string };

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
  if (typeof l.data !== "string" || !new RegExp(`^0x[0-9a-f]{${64 * words}}$`).test(l.data)) throw new Error(`${what}: not ${words} data words`);
  const w = (i: number): bigint => BigInt(`0x${(l.data as string).slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
  // Deposited: _commitment, _label, ...; Withdrawn and Bought: _feeRecipient, _value, _fee, _spentNullifier, _newCommitment, ...
  const state = t0 === TOPIC_DEPOSITED ? w(0) : w(4);
  const label = t0 === TOPIC_DEPOSITED ? w(1) : null;
  for (const v of [state, label]) if (v !== null && (v === 0n || v >= VAULT_FIELD_P)) throw new Error(`${what}: a leaf is not a field element above 0`);
  const bytes = [tag(block), blockHash, tag(logIndex), tx, tag(txIndex), pool, t0, t1, l.data].join(" ");
  return { block, blockHash, logIndex, state, label, bytes };
}

/** One RPC's pool logs over from..to, in pages that end at or below `to`; a range-cap error halves its page. */
async function readLogs(rpc: EvmRpc, k: number, pool: string, from: bigint, to: bigint, page: bigint[], signal?: AbortSignal): Promise<Ev[]> {
  const out: Ev[] = [];
  for (let at = from; at <= to; ) {
    signal?.throwIfAborted();
    const end = at + page[k]! - 1n < to ? at + page[k]! - 1n : to;
    let got: unknown;
    try {
      got = await rpc("eth_getLogs", [{ address: pool, topics: [[TOPIC_DEPOSITED, TOPIC_WITHDRAWN, TOPIC_BOUGHT]], fromBlock: tag(at), toBlock: tag(end) }]);
    } catch (e) {
      if (RANGE_CAP.test(String((e as Error)?.message ?? e)) && end > at) {
        page[k] = (end - at + 1n) / 2n;
        continue;
      }
      throw e;
    }
    if (!Array.isArray(got)) throw new Error(`rpc ${k}: eth_getLogs ${at}..${end}: not a list`);
    out.push(...got.map((g, i) => decodeLog(g, pool, at, end, `rpc ${k}: log ${i} of ${at}..${end}`)));
    at = end + 1n;
  }
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!, b = out[i]!;
    if (b.block < a.block || (b.block === a.block && (b.logIndex <= a.logIndex || b.blockHash !== a.blockHash))) throw new Error(`rpc ${k}: the logs are not in order at ${i}`);
  }
  return out;
}

/** What a trees() call may ask beyond the cut: a deposit's own note's newest root, read like every other read. */
export type EvmTreesOpts = { newest?: boolean };

/** The sync's read at one anchor: every leaf event both RPCs agree on up to it, checked against the pool's views. */
type Round = { anchor: EvmBlock; events: Ev[] };

export type EvmTreeSync = {
  trees(beforeMs: bigint, signal?: AbortSignal, opts?: EvmTreesOpts): Promise<PoolTrees>;
  /** The state tree's depth after every leaf in blocks up to `block` (the pool's currentTreeDepth at that block). */
  depthAt(block: bigint, signal?: AbortSignal): Promise<number>;
};

export type EvmSyncArgs = {
  rpcs: readonly [EvmRpc, EvmRpc];
  pin: EvmPoolPin;
  /** tests only: the wait between lag retries */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const t = setTimeout(() => (signal?.removeEventListener("abort", stop), resolve()), ms);
    const stop = () => (clearTimeout(t), reject(signal!.reason));
    signal?.addEventListener("abort", stop, { once: true });
  });

/** f, again after EVM_LAG_WAIT_MS while it throws EvmLagError, at most EVM_LAG_TRIES times in all. */
async function retryLag<T>(f: () => Promise<T>, sleep: (ms: number, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof EvmLagError) || n >= EVM_LAG_TRIES) throw e;
      await sleep(EVM_LAG_WAIT_MS, signal);
    }
  }
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
  checkEvmRpcs(a.rpcs);
  const rpcs = a.rpcs;
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
  const page = [EVM_LOG_PAGE_BLOCKS, EVM_LOG_PAGE_BLOCKS];
  const times = new Map<string, bigint>();
  let turn: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const r = turn.then(f, f);
    turn = r.catch(() => {});
    return r;
  };

  /** The lower tag block of the two RPCs, by number on both, with one hash. */
  async function anchorAt(at: string, signal?: AbortSignal): Promise<EvmBlock> {
    const tops = await both(rpcs, (rpc, k) => getBlock(rpc, at, `rpc ${k} ${at} block`), signal);
    if (tops[0] === null || tops[1] === null) return lag(`an RPC has no ${at} block`);
    const n = tops[0].number < tops[1].number ? tops[0].number : tops[1].number;
    const [x, y] = await both(rpcs, (rpc, k) => getBlock(rpc, tag(n), `rpc ${k} block ${n}`), signal);
    if (x === null || y === null) return lag(`rpc ${x === null ? 0 : 1} does not know block ${n} yet`);
    if (x.hash !== y.hash || x.timestamp !== y.timestamp || x.number !== n || y.number !== n) {
      // at `latest` two honest RPCs may hold two blocks of one height for a moment; a final block never moves
      if (at === EVM_NEWEST_TAG) return lag(`the two RPCs hold different blocks at ${n}`);
      throw new Error(`the two RPCs hold different blocks at ${n}`);
    }
    return x;
  }

  /** One view on both RPCs at the anchor; the two answers must be one. */
  async function agreed(data: string, h: string, what: string, signal?: AbortSignal): Promise<bigint> {
    const [x, y] = await both(rpcs, (rpc, k) => view(rpc, pool, data, h, `rpc ${k} ${what}`), signal);
    if (x !== y) throw new Error(`the two RPCs differ on ${what} at ${h}`);
    return x;
  }

  /** A block's timestamp, read by hash on both RPCs (kept: a hash's block never changes). */
  async function timeOf(h: string, n: bigint, signal?: AbortSignal): Promise<bigint> {
    const known = times.get(h);
    if (known !== undefined) return known;
    const [x, y] = await both(rpcs, async (rpc, k) => blockOf(await rpc("eth_getBlockByHash", [h, false]), `rpc ${k} block ${h}`), signal);
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
    if (!checked) {
      const ids = await both(rpcs, async (rpc, k) => qty(await rpc("eth_chainId", []), `rpc ${k} eth_chainId`), signal);
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
      const now = await both(rpcs, (rpc, k) => getBlock(rpc, tag(anchor.number), `rpc ${k} block ${anchor.number}`), signal);
      if (now.some((b) => b === null || b.hash !== anchor.hash)) return lag(`block ${anchor.number} moved under the read (a reorg)`);
      throw new Error(why);
    };
    let fresh: Ev[] = [];
    if (anchor.number > heldTo) {
      const [x, y] = await both(rpcs, (rpc, k) => readLogs(rpc, k, pool, heldTo + 1n, anchor.number, page, signal), signal);
      for (let i = 0; i < Math.max(x.length, y.length); i++)
        if (x[i]?.bytes !== y[i]?.bytes) await refuse(`the two RPCs differ at log ${held.length + i} (blocks ${heldTo + 1n}..${anchor.number})`);
      for (const e of x)
        for (const b of [fin, anchor]) if (e.block === b.number && e.blockHash !== b.hash) throw new Error(`a log of block ${e.block} is not of the anchor ${b.hash}`);
      fresh = x;
    }
    const events = [...held, ...fresh];
    const stateTree = new VaultTree(events.map((e) => e.state));
    const labels = events.flatMap((e) => (e.label === null ? [] : [e.label]));
    const labelTree = new VaultTree(labels);
    const wrong =
      BigInt(stateTree.size) !== size || (stateTree.root ?? 0n) !== root ? `the state tree from the logs (${stateTree.size} leaves) is not the pool's at ${anchor.hash} (${size})`
      : BigInt(labelTree.size) !== labelSize || (labelTree.root ?? 0n) !== labelRoot ? `the label tree from the logs (${labelTree.size} leaves) is not the pool's at ${anchor.hash} (${labelSize})`
      : null;
    if (wrong !== null) await refuse(wrong);
    checked = true;
    // the cache only ever rises
    const top = fin.number > heldTo ? fin.number : heldTo;
    held = events.filter((e) => e.block <= top);
    heldTo = top;
    return { anchor, events, stateTree, labelTree };
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
      return serial(() => retryLag(async () => {
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
    depthAt(block, signal) {
      if (typeof block !== "bigint" || block < 0n) return Promise.reject(new Error("block: a block number"));
      return serial(() => retryLag(async () => {
        const r = await round(signal);
        if (r.anchor.number < block) lag(`the newest agreed block ${r.anchor.number} is below block ${block}`);
        return depthOf(r.events.filter((e) => e.block <= block).length);
      }, sleep, signal));
    },
  };
}

/** The pool's time: the lower of two RPCs' EVM_NEWEST_TAG block times, ms (a finalized block lags past a life). */
export async function evmNow(rpcs: readonly [EvmRpc, EvmRpc], signal?: AbortSignal): Promise<bigint> {
  checkEvmRpcs(rpcs);
  const [x, y] = await both(rpcs, (rpc, k) => getBlock(rpc, EVM_NEWEST_TAG, `rpc ${k} ${EVM_NEWEST_TAG} block`), signal);
  if (x === null || y === null) throw new Error(`an RPC has no ${EVM_NEWEST_TAG} block`);
  return (x.timestamp < y.timestamp ? x.timestamp : y.timestamp) * 1000n;
}

/**
 * The epoch's first block: the first whose timestamp * 1000 is at or after `epochStartMs`, found on RPC 0 below its
 * EVM_NEWEST_TAG block, then it and the block before it read on both RPCs, one hash each.
 */
export async function evmEpochBlock(rpcs: readonly [EvmRpc, EvmRpc], epochStartMs: bigint, signal?: AbortSignal): Promise<EvmBlock> {
  checkEvmRpcs(rpcs);
  const at = async (n: bigint | string): Promise<EvmBlock> => {
    const b = await getBlock(rpcs[0], typeof n === "string" ? n : tag(n), `rpc 0 block ${n}`);
    if (b === null) return lag(`rpc 0 does not know block ${n} yet`);
    return b;
  };
  const after = (b: EvmBlock) => b.timestamp * 1000n >= epochStartMs;
  let hi = await at(EVM_NEWEST_TAG);
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
    const [x, y] = await both(rpcs, (rpc, k) => getBlock(rpc, tag(want.number), `rpc ${k} block ${want.number}`), signal);
    if (x === null || y === null) return lag(`rpc ${x === null ? 0 : 1} does not know block ${want.number} yet`);
    if (x.hash !== want.hash || y.hash !== want.hash || y.timestamp !== want.timestamp || y.baseFeePerGas !== want.baseFeePerGas) throw new Error(`the two RPCs hold different blocks at ${want.number}`);
  }
  if (hi.baseFeePerGas === null) throw new Error(`block ${hi.number}: no base fee`);
  return hi;
}

/** GET /v1/pool/fee's answer for an EVM pool (the helper's EvmFeeAnswer, card helper-pool-senders). */
export type EvmFeeAnswer = { chain: string; network: string; pool: string; fee_recipient: string; epoch_ms: number; epoch_start_ms: number; block: string; fee: string; step: string };

/**
 * Until card evm-pool-fee-kit makes it the kit's constant (M371 (2)). The epoch fee's formula, M356 (4) and M357 (3): max(floor, ceilStep(2 x (G(depth) x basefee + the L1 fee))), G the
 * kit's evmPoolGas. It is the kit's one definition, which the helper imports too (M356 (6)); the kit on main does not
 * export it yet (card helper-pool-senders holds G), so the caller passes the kit's function. The device reads every
 * input itself: the epoch's first block (both RPCs) and the tree depth at it (the leaves both RPCs agree on).
 */
export type EvmEpochFeeRule = (at: { block: bigint; baseFeePerGas: bigint; depth: number }) => bigint;

export type EvmPoolArgs = {
  /** The network's pin (EVM_POOLS[network]): the pool, the fee recipient and the deploy block, never the helper's word. */
  pin: EvmPoolPin;
  /** Two RPCs of different operators on the pool's network. */
  rpcs: readonly [EvmRpc, EvmRpc];
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
  checkEvmRpcs(a.rpcs);
  if (typeof a.epochFee !== "function" || typeof a.relayFee !== "function") throw new Error("epochFee and relayFee: functions");
  const pool = lower(a.pin.pool);
  const feeRecipient = lower(a.pin.feeRecipient);
  addr20(feeRecipient, "feeRecipient");
  if (feeRecipient === pool || BigInt(feeRecipient) === 0n) throw new Error("feeRecipient: the pool or the zero address");
  const sync = evmTreeSync({ rpcs: a.rpcs, pin: a.pin, ...(a.sleep ? { sleep: a.sleep } : {}) });
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
    now: (signal) => evmNow(a.rpcs, signal),
    trees: (beforeMs, signal, opts) => sync.trees(beforeMs, signal, opts),
    async bind({ chunk, wallet, refundPrecommitment, epochStartMs, deadlineMs }, signal) {
      if (!(wallet?.publicKey instanceof Uint8Array) || typeof wallet.address !== "string" || wallet.address !== evmAddress(wallet.publicKey))
        throw new Error("wallet: an EVM W is EIP-55 of its secp256k1 public key");
      const w = lower(wallet.address);
      if (w === pool || w === feeRecipient || BigInt(w) === 0n) throw new Error("wallet: W is the pool, the fee recipient or the zero address");
      if (typeof chunk !== "bigint" || chunk <= 0n || chunk >= U128) throw new Error("chunk: above 0 and below 2^128");
      if (typeof refundPrecommitment !== "bigint" || refundPrecommitment < 0n || refundPrecommitment >= VAULT_FIELD_P) throw new Error("refundPrecommitment: not a field element");
      if (typeof epochStartMs !== "bigint" || epochStartMs <= 0n || epochStartMs % EVM_EPOCH_MS !== 0n) throw new Error("epochStartMs: not on the epoch grid");
      const nowMs = await evmNow(a.rpcs, signal);
      if (typeof deadlineMs !== "bigint" || deadlineMs !== epochStartMs + EVM_LIFE_MS || deadlineMs > U64 || deadlineMs <= nowMs + EVM_SEND_MARGIN_MS)
        throw new Error("deadlineMs: not on the epoch grid, or too close to send");
      // the device's own fee: the epoch's first block and the tree depth there, each read on both RPCs
      const block = await retryLag(() => evmEpochBlock(a.rpcs, epochStartMs, signal), sleep, signal);
      const depth = await sync.depthAt(block.number, signal);
      const fee = a.epochFee({ block: block.number, baseFeePerGas: block.baseFeePerGas!, depth });
      if (typeof fee !== "bigint" || fee < 0n) throw new Error("epochFee: not a fee");
      const f = await a.relayFee(epochStartMs, signal);
      if (f?.chain !== "evm" || f.network !== a.pin.network || typeof f.pool !== "string" || lower(f.pool) !== pool || typeof f.fee_recipient !== "string" || lower(f.fee_recipient) !== feeRecipient)
        throw new Error("relayFee: not this pool's or this fee recipient's answer");
      if (f.epoch_ms !== Number(EVM_EPOCH_MS) || f.epoch_start_ms !== Number(epochStartMs) || f.block !== tag(block.number)) throw new Error("relayFee: not this epoch's or not its first block");
      if (typeof f.fee !== "string" || f.fee !== fee.toString()) throw new Error(`relayFee: the helper's ${String(f.fee)} is not the epoch's fee ${fee}`);
      if (fee * 10_000n > chunk * MAX_RELAY_FEE_BPS) throw new Error("chunk: under the pool's backstop at this fee");
      const salt = (a.salt ?? (() => crypto.getRandomValues(new Uint8Array(16))))();
      if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new Error("salt: not 16 bytes");
      const request: EvmPoolRequest = { processooor: pool, relay: { recipient: wallet.address, feeRecipient, feeCap: fee, deadlineMs, refundPrecommitment, salt: `0x${hex(salt)}` } };
      return { context: evmPoolContextOf(request, scope), feeCap: fee, request };
    },
  };
}
