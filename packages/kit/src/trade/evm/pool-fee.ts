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

// The EVM relay fee, the kit's one definition (M356 (4); card evm-buy-hookdata-fee, review fold 1 L1): what a sender
// (the helper's withdraw, buy and sell senders) may take for one transaction, which every device recomputes from its own
// reads and refuses above: max(floor, ceilStep(2 x (gas x gas price + the chain fee))). The chain fee is what the chain
// charges beside the gas: on the OP Stack (Base) the L1 data fee and the operator fee, read from the GasPriceOracle
// predeploy; on Arbitrum chains (Robinhood Chain, an Orbit chain) the L1 poster fee, read from ArbGasInfo. Both are
// eth_calls the caller makes on both of its providers at one agreed block (they must answer the same), never a
// server's figure. The x 2 covers the gas price and the chain fee moving between that block and the send.

/** The step every EVM relay fee rounds up to, in wei: the helper's EVM_FEE_STEP (apps/helper pool/evm.ts), 1e13. */
export const EVM_POOL_FEE_STEP = 10_000_000_000_000n;
/** The pool's least deposit, wei: PrivacyPool.sol:53 `MIN_DEPOSIT = 0.0001 ether`, a constant of the contract (a
 *  deposit under it reverts MinimumDepositAmount, :86). */
export const EVM_POOL_MIN_DEPOSIT = 100_000_000_000_000n;
/** The bytes a pool transaction's chain fee is bounded for: above the largest one the senders send (the bound
 *  contracts/pool-evm/script/testnet-run.mjs funds every transaction for; test/evm-pool-fee.test.ts holds the largest
 *  sell under it). */
export const EVM_POOL_TX_BYTES = 2_600n;

// The OP Stack GasPriceOracle predeploy, getL1FeeUpperBound(uint256 unsignedTxSize) (Fjord) and getOperatorFee(uint256
// gasUsed) (Isthmus); Arbitrum's ArbGasInfo precompile, getL1BaseFeeEstimate(): wei per L1 gas unit, of which the
// poster charges 16 a calldata byte (its getPricesInWei's perL1CalldataByte). Read live 2026-11-04 17:1xZ on both pinned
// providers of each chain: Base Sepolia 7,917 wei for 2,600 bytes and an operator fee of 0, Base 71,091,731,029 wei and
// 0; Robinhood Chain and its testnet an L1 base fee estimate of 0 (gasUsedForL1 0 on 172 recent mainnet transactions).
const OP_ORACLE = "0x420000000000000000000000000000000000000f";
const ARB_GAS_INFO = "0x000000000000000000000000000000000000006c";
const SEL_L1_FEE_UPPER_BOUND = "f1c7a58b";
const SEL_OPERATOR_FEE = "275aedd2";
const SEL_L1_BASE_FEE_ESTIMATE = "f5d6ded7";
const ARB_GAS_PER_CALLDATA_BYTE = 16n;
const op = (chain: string) => chain === "base" || chain === "base-sepolia";
const arb = (chain: string) => chain === "robinhood" || chain === "robinhood-testnet";
const word = (v: bigint) => v.toString(16).padStart(64, "0");

/** The eth_calls that read `chain`'s chain fee for a transaction of `gas` gas and at most `txBytes` bytes; the caller
 *  makes each on both providers at one block and passes the answers' first words, in order, to evmPoolChainFee. */
export function evmPoolChainFeeReads(chain: string, gas: bigint, txBytes: bigint = EVM_POOL_TX_BYTES): { to: string; data: string }[] {
  if (typeof gas !== "bigint" || gas <= 0n || gas >= 1n << 64n || typeof txBytes !== "bigint" || txBytes <= 0n || txBytes >= 1n << 32n) throw new Error("gas and txBytes: above 0");
  if (op(chain)) return [{ to: OP_ORACLE, data: "0x" + SEL_L1_FEE_UPPER_BOUND + word(txBytes) }, { to: OP_ORACLE, data: "0x" + SEL_OPERATOR_FEE + word(gas) }];
  if (arb(chain)) return [{ to: ARB_GAS_INFO, data: "0x" + SEL_L1_BASE_FEE_ESTIMATE }];
  throw new Error(`${chain}: no chain fee rule`);
}

/** The chain fee, wei, from the answers to evmPoolChainFeeReads(chain, gas, txBytes), in their order. */
export function evmPoolChainFee(chain: string, txBytes: bigint, answers: readonly bigint[]): bigint {
  const ok = (n: number) => answers.length === n && answers.every((a) => typeof a === "bigint" && a >= 0n && a < 1n << 128n);
  if (op(chain) && ok(2)) return answers[0]! + answers[1]!;
  if (arb(chain) && ok(1)) return ARB_GAS_PER_CALLDATA_BYTE * txBytes * answers[0]!;
  throw new Error(`${chain}: not the answers its chain fee reads give`);
}

/** The relay fee rule: max(floor, ceilStep(2 x (gas x gasPrice + chainFee))), every input a bigint at or above 0. */
export function evmPoolFee(a: { floor: bigint; gas: bigint; gasPrice: bigint; chainFee: bigint }): bigint {
  const { floor, gas, gasPrice, chainFee } = a;
  if (![floor, gas, gasPrice, chainFee].every((x) => typeof x === "bigint" && x >= 0n)) throw new Error("the fee's inputs: bigints at or above 0");
  const f = 2n * (gas * gasPrice + chainFee);
  const stepped = ((f + EVM_POOL_FEE_STEP - 1n) / EVM_POOL_FEE_STEP) * EVM_POOL_FEE_STEP;
  return stepped > floor ? stepped : floor;
}
