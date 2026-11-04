// The EVM pool's gas per release, the kit's one definition (M356 (4), M357): G(depth) = base + perLevel x depth, where
// depth is the pool's tree depth read at the epoch's first block (public, so every device and the helper get the same
// number). One proof serves either withdraw or buy, so G is the larger method's: buy through the router on one hop.
// Measured isolated per transaction by card pool-evm-buy (forge, isolate = true; 3 Nov): withdraw 494,356 at depth 2
// and 1,139,880 at depth 32; buy, mock adapter, 570,422 / 1,215,964; buy, router one hop, 686,812 / 1,332,356; 21,518
// a level. A multi-hop buy costs more (card evm-adapters measures it per adapter); the fee's x 2 and the pending-block
// simulation before every send cover the rest.

/** Gas a level of the tree adds to a release (M357: about 21.5k). */
export const EVM_POOL_GAS_PER_LEVEL = 21_518n;
/**
 * The buy's gas at depth 0: the line through both measured points (686,812 at depth 2, 1,332,356 at depth 32) with the
 * per-level slope above, rounded up so G is at or over every measured point (643,776 from depth 2, 643,780 from 32).
 */
export const EVM_POOL_GAS_BASE = 643_780n;
/** The deepest tree the pool takes (the Privacy Pools v1 state tree's MAX_TREE_DEPTH). */
export const EVM_POOL_MAX_DEPTH = 32;

/** G(depth): the most gas one release (withdraw or a one-hop buy) uses at this tree depth. */
export function evmPoolGas(depth: number): bigint {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > EVM_POOL_MAX_DEPTH) throw new Error(`a tree depth of 0 to ${EVM_POOL_MAX_DEPTH}`);
  return EVM_POOL_GAS_BASE + EVM_POOL_GAS_PER_LEVEL * BigInt(depth);
}

/** The pool's backstop: a relay fee is at most this share of the withdrawn value, in bps, whatever cap a proof binds
 * (contracts/pool-evm/src/PrivacyPool.sol:55 MAX_RELAY_FEE_BPS, checked at :186). */
export const EVM_POOL_MAX_RELAY_FEE_BPS = 5_000n;

/**
 * The most a tap's buy can spend from one chunk: what the pool hands the adapter, `_withdrawn - _fee`
 * (contracts/pool-evm/src/PrivacyPoolSimple.sol:64), with the fee at most the proof's fee cap (PrivacyPool.sol:179) and
 * at most EVM_POOL_MAX_RELAY_FEE_BPS of the chunk, rounded down as the pool rounds (:186). The relayer pays the gas
 * out of that fee; nothing else comes out of the chunk before the spend. The tap's ask is the chunk itself (the signing
 * page's checkEvmBuy refuses an amount other than the proof's value): this is what reaches the venue.
 */
export function evmPoolBuyMaxSpend(chunk: bigint, feeCap: bigint): bigint {
  if (typeof chunk !== "bigint" || chunk < 0n) throw new Error("chunk: a bigint at least 0");
  if (typeof feeCap !== "bigint" || feeCap < 0n) throw new Error("fee cap: a bigint at least 0");
  const backstop = (chunk * EVM_POOL_MAX_RELAY_FEE_BPS) / 10_000n;
  return chunk - (feeCap < backstop ? feeCap : backstop);
}
