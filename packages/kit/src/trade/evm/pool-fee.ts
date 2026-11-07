// The EVM pool's gas per release, the kit's one definition (M356 (4), M357): G(depth) = base + perLevel x depth, where
// depth is the pool's tree depth read at the epoch's first block (public, so every device and the helper get the same
// number). One proof serves either withdraw or buy, so G is the larger method's, and since card evm-buy-gas-depth it is
// the gas limit the helper signs a buy with, not the gas the buy uses: PrivacyPoolSimple.buy needs gasleft() >= 651,000
// (BUY_SWAP_GAS + BUY_FAIL_GAS + 1,000) before its swap and reverts under it, so eth_estimateGas lands on that floor and
// a buy's limit is about twice its gas used. The helper signs estimate x 1.2 (apps/helper pool/evm.ts) and caps
// maxFeePerGas at fee / limit, so a fee priced on G at or over that limit leaves at least 2x the epoch block's base fee
// per gas: fee_stale (the base fee over fee / limit) fires only once the base fee has doubled.
// Measured on the pool at card pool-evm-buy-pays-revert (forge, isolate = true; 7 Nov): the least gas a buy lands with,
// at every depth 1 to 32, a route at the helper's largest calldata (EVM_BODY_DATA_MAX, 2,404 bytes, its swap data all
// non-zero) through an adapter that burns 120,000 gas, the heaviest measured swap, with a fee recipient that holds no
// ETH (a funded one costs 25,000 less): 1,101,491 at depth 2, 1,749,570 at depth 32, 21,033 a level from depth 3
// (test/evm-pool-fee.test.ts holds all 32). Forge gives that least as the call's own gas, so a transaction adds its
// intrinsic gas, here at most 21,000 + 16 x 2,404 = 59,464 (every byte priced non-zero). Then G covers, at every depth,
// 1.2 x the estimate a node may return: geth and reth stop their search up to 1.5% over the least (estimate x 1000/985).
// The gas a buy uses is unchanged (636,695 at depth 2 on that route); withdraw (1,139,880 at depth 32) stays under G.

/** Gas a level of the tree adds to G: 21,033 a level measured, x 1.2 / 0.985, rounded up. */
export const EVM_POOL_GAS_PER_LEVEL = 25_624n;
/**
 * G at depth 0: the least line of slope 21,033 at or over every measured least plus 59,464 of intrinsic gas
 * (1,135,988 + 21,033 x depth, tight at depths 3 and 4), x 1.2 / 0.985, rounded up.
 */
export const EVM_POOL_GAS_BASE = 1_383_945n;
/** The deepest tree the pool takes (the Privacy Pools v1 state tree's MAX_TREE_DEPTH). */
export const EVM_POOL_MAX_DEPTH = 32;

/** G(depth): the most gas the helper signs one release (withdraw or buy) for at this tree depth. */
export function evmPoolGas(depth: number): bigint {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > EVM_POOL_MAX_DEPTH) throw new Error(`a tree depth of 0 to ${EVM_POOL_MAX_DEPTH}`);
  return EVM_POOL_GAS_BASE + EVM_POOL_GAS_PER_LEVEL * BigInt(depth);
}

// The EVM relay fee, the kit's one definition (M356 (4); card evm-buy-hookdata-fee, review fold 1 L1): what a sender
// (the helper's withdraw, buy and sell senders) may take for one transaction, which every device recomputes from its own
// reads and refuses above: max(EVM_POOL_FEE_FLOOR, ceilStep(2 x (gas x gas price + the chain fee))). The chain fee is what the chain
// charges beside the gas: on the OP Stack (Base) the L1 data fee and the operator fee, read from the GasPriceOracle
// predeploy; on Arbitrum chains (Robinhood Chain, an Orbit chain) the L1 poster fee, read from ArbGasInfo. Both are
// eth_calls the caller makes on both of its providers at one agreed block (they must answer the same), never a
// server's figure. The x 2 covers the gas price and the chain fee moving between that block and the send.

/** The step every EVM relay fee rounds up to, in wei: the helper's EVM_FEE_STEP (apps/helper pool/evm.ts), 1e13. */
export const EVM_POOL_FEE_STEP = 10_000_000_000_000n;
/** The least EVM relay fee, wei (M356 (4): floor and step are kit constants; card evm-buy-hookdata-fee, review fold 2
 *  LOW-A): one step, so a release is never sent for nothing. The one floor: evmPoolFee applies it, so the device, the
 *  helper's senders and the sell's fee cap cannot price an epoch with another; the helper refuses an env
 *  POOL_EVM_FEE_<NET> that differs from it. */
export const EVM_POOL_FEE_FLOOR = EVM_POOL_FEE_STEP;
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

/** The relay fee rule: max(EVM_POOL_FEE_FLOOR, ceilStep(2 x (gas x gasPrice + chainFee))), every input a bigint at or
 *  above 0. */
export function evmPoolFee(a: { gas: bigint; gasPrice: bigint; chainFee: bigint }): bigint {
  const { gas, gasPrice, chainFee } = a;
  if (![gas, gasPrice, chainFee].every((x) => typeof x === "bigint" && x >= 0n)) throw new Error("the fee's inputs: bigints at or above 0");
  const f = 2n * (gas * gasPrice + chainFee);
  const stepped = ((f + EVM_POOL_FEE_STEP - 1n) / EVM_POOL_FEE_STEP) * EVM_POOL_FEE_STEP;
  return stepped > EVM_POOL_FEE_FLOOR ? stepped : EVM_POOL_FEE_FLOOR;
}
