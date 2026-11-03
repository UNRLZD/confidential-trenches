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
