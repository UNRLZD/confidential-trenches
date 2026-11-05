// Card helper-pool-senders (M356 (4), M357): G(depth) is at or over every isolated measurement of both methods.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVM_POOL_GAS_PER_LEVEL, evmPoolGas } from "../src/index.ts";

const MEASURED: [string, number, bigint][] = [
  ["withdraw", 2, 494_356n], ["withdraw", 32, 1_139_880n],
  ["buy, mock adapter", 2, 570_422n], ["buy, mock adapter", 32, 1_215_964n],
  ["buy, router one hop", 2, 686_812n], ["buy, router one hop", 32, 1_332_356n],
];

test("G(32) for a buy is at least 1,332,356, and G covers every measured release", () => {
  assert.ok(evmPoolGas(32) >= 1_332_356n, `G(32) ${evmPoolGas(32)}`);
  for (const [what, d, gas] of MEASURED) assert.ok(evmPoolGas(d) >= gas, `${what} at depth ${d}: G ${evmPoolGas(d)} < ${gas}`);
  assert.equal(evmPoolGas(3) - evmPoolGas(2), EVM_POOL_GAS_PER_LEVEL);
});

test("a depth outside 0 to 32 is refused", () => {
  for (const d of [-1, 33, 1.5, Number.NaN]) assert.throws(() => evmPoolGas(d), /tree depth/);
});

// Card evm-buy-hookdata-fee, review fold 1 L1: the relay fee rule, the kit's one definition, with the chain fee
const STEP = 10n ** 13n;
const pf = (await import("../src/index.ts")) as unknown as Record<string, unknown>;
test("L1 the relay fee is max(floor, ceilStep(2 x (gas x gas price + the chain fee))), the floor the kit's one (fold 2 LOW-A)", () => {
  const fee = pf.evmPoolFee as (a: { gas: bigint; gasPrice: bigint; chainFee: bigint; floor?: bigint }) => bigint;
  assert.equal(pf.EVM_POOL_FEE_STEP, STEP);
  assert.equal(pf.EVM_POOL_FEE_FLOOR, STEP, "one step");
  assert.equal(pf.EVM_POOL_MIN_DEPOSIT, 10n ** 14n, "PrivacyPool.sol:53, 0.0001 ether");
  // 2 x (1,000,000 x 6,000,000 + 4e12) = 2e13, on the step
  assert.equal(fee({ gas: 1_000_000n, gasPrice: 6_000_000n, chainFee: 4n * 10n ** 12n }), 2n * STEP);
  // one wei over a step rounds up a step
  assert.equal(fee({ gas: 1n, gasPrice: 1n, chainFee: STEP / 2n }), 2n * STEP);
  assert.equal(fee({ gas: 1n, gasPrice: 0n, chainFee: STEP / 2n }), STEP);
  // the chain fee counts twice, as the gas does
  assert.equal(fee({ gas: 0n, gasPrice: 0n, chainFee: 5n * STEP }), 10n * STEP);
  // the floor when the fee rounds under it: nothing to pay is still one step, and no caller passes another floor
  assert.equal(fee({ gas: 0n, gasPrice: 0n, chainFee: 0n }), STEP);
  assert.equal(fee({ gas: 0n, gasPrice: 0n, chainFee: 0n, floor: 0n }), STEP);
  assert.equal(fee({ gas: 0n, gasPrice: 0n, chainFee: 0n, floor: 7n * STEP }), STEP);
  for (const bad of [{ gas: -1n }, { gasPrice: 1 as unknown as bigint }, { chainFee: -1n }]) {
    assert.throws(() => fee({ gas: 1n, gasPrice: 1n, chainFee: 0n, ...bad }), /bigints/);
  }
});

test("L1 the chain fee reads: Base's GasPriceOracle L1 fee bound and operator fee, Robinhood's ArbGasInfo L1 base fee at 16 a byte", () => {
  const reads = pf.evmPoolChainFeeReads as (chain: string, gas: bigint, txBytes?: bigint) => { to: string; data: string }[];
  const of = pf.evmPoolChainFee as (chain: string, txBytes: bigint, answers: readonly bigint[]) => bigint;
  const W = (v: bigint) => v.toString(16).padStart(64, "0");
  for (const chain of ["base", "base-sepolia"]) {
    assert.deepEqual(reads(chain, 1_000_000n, 2_600n), [
      { to: "0x420000000000000000000000000000000000000f", data: "0xf1c7a58b" + W(2_600n) }, // getL1FeeUpperBound(uint256)
      { to: "0x420000000000000000000000000000000000000f", data: "0x275aedd2" + W(1_000_000n) }, // getOperatorFee(uint256)
    ]);
    assert.equal(of(chain, 2_600n, [7_917n, 5n]), 7_922n);
    assert.throws(() => of(chain, 2_600n, [7_917n]), /not the answers/);
  }
  for (const chain of ["robinhood", "robinhood-testnet"]) {
    assert.deepEqual(reads(chain, 1_000_000n, 2_600n), [{ to: "0x000000000000000000000000000000000000006c", data: "0xf5d6ded7" }]); // getL1BaseFeeEstimate()
    assert.equal(of(chain, 2_600n, [3n]), 16n * 2_600n * 3n);
    assert.throws(() => of(chain, 2_600n, [1n, 2n]), /not the answers/);
  }
  assert.equal(reads("base", 1n)[0]!.data, "0xf1c7a58b" + W(pf.EVM_POOL_TX_BYTES as bigint));
  assert.throws(() => reads("anvil", 1n), /no chain fee rule/);
  assert.throws(() => of("anvil", 1n, [1n]), /not the answers/);
  assert.throws(() => reads("base", 0n), /above 0/);
  assert.throws(() => of("base", 1n, [-1n, 0n]), /not the answers/);
});

test("L1 the largest sell the builder makes, in its EIP-7702 transaction, is under EVM_POOL_TX_BYTES", async () => {
  const { evmPoolVenues } = await import("../src/trade/evm/buy-unpinned.ts");
  const { pinnedBuildSell, evmSellCallData } = await import("../src/trade/evm/sell-unpinned.ts");
  const venues = evmPoolVenues();
  const v = venues["base-sepolia"];
  const t = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const hops = [t(0xa1), t(0xa2), t(0xa3), "0x0000000000000000000000000000000000000000"].map((currency) => ({ currency, fee: 0xffffff - 1, tickSpacing: 32_767, hooks: "0x0000000000000000000000000000000000000000", hookData: "0x" }));
  const max = 2n ** 255n;
  const s = pinnedBuildSell(venues, "base-sepolia", { w: t(0xfe), token: t(0xa0), amount: max, target: v.poolManager!, route: { venue: "uniswap-v4", hops }, minOut: max, precommitment: 2n ** 253n, feeCap: max - 1n, feeRecipient: t(0xfd), deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 2n ** 255n });
  const data = (evmSellCallData(s, max - 1n, new Uint8Array(65).fill(0xff)).length - 2) / 2;
  // the rest of a type 4 transaction, each field at its widest: chain id, nonce, both fees and gas (8 x 9 bytes), to
  // (21), value (1), the list headers (12), one authorization (chain id, delegate, nonce, y, r, s: 9 + 21 + 9 + 1 + 33 +
  // 33, its header 3) and the signature (1 + 33 + 33): 290 bytes
  const rest = 8 * 9 + 21 + 1 + 12 + (9 + 21 + 9 + 1 + 33 + 33 + 3) + (1 + 33 + 33);
  assert.ok(BigInt(data + rest) <= (pf.EVM_POOL_TX_BYTES as bigint), `${data} + ${rest} bytes`);
});
