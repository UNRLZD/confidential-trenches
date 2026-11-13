// node --test packages/signpage/test/evm-epoch-fee-live.test.ts: the EVM withdraw's live check computes the fee the page
// binds. scripts/live-checks/evm-deposit-on-mainnet.mjs deviceFee is the check's own reading of the device's rule, and
// src/pool-testnet.ts evmEpochFee is the rule the page binds every withdraw at; the two agree on every bind the check
// recorded (evm-deposit-on-mainnet.answers.json, real mainnet reads of 13 Nov 00:40Z and 00:41Z) and across the tree's
// depths, so a check that passes on its fee part passes on the page's own fee.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmEpochFee } from "../src/pool-testnet.ts";

type Bind = { ok: boolean; depth: number; chainFee: string; baseFeePerGas: string; block: string };
type Run = { fee: Record<"base" | "robinhood", { bind: Bind; helper: { status: number; body: { fee: string } } }> };
const URL_CHECK = new URL("../../../scripts/live-checks/evm-deposit-on-mainnet.mjs", import.meta.url).href;
const { deviceFee } = (await import(URL_CHECK)) as { deviceFee: (b: { depth: number | string; chainFee: string; baseFeePerGas: string }) => bigint };
const A = JSON.parse(readFileSync(new URL("../../../scripts/live-checks/evm-deposit-on-mainnet.answers.json", import.meta.url), "utf8")) as Record<string, Run>;
const page = (b: { depth: number; chainFee: string; baseFeePerGas: string }) => evmEpochFee({ baseFeePerGas: BigInt(b.baseFeePerGas), depth: b.depth, chainFee: BigInt(b.chainFee) });

test("on every bind the live check recorded (Base and Robinhood, both runs), its device fee is the page's epoch fee, and on the good run the helper's", () => {
  let n = 0;
  for (const [name, run] of Object.entries(A)) {
    for (const net of ["base", "robinhood"] as const) {
      const b = run.fee?.[net]?.bind;
      if (!b?.ok) continue;
      n++;
      assert.equal(deviceFee(b), page(b), `${name} ${net} at block ${b.block}`);
      if (name === "good") assert.equal(page(b).toString(), run.fee[net].helper.body.fee, `${name} ${net}: the helper's`);
    }
  }
  assert.equal(n, 4, "two runs, two chains");
});

test("across the tree's depths 0 to 32 and the fee's step edges, the live check's fee is the page's; a rule one level off is seen", () => {
  const baseFees = [0n, 1n, 5_000_000n, 20_040_000n, 1_000_000_000n, 300_000_000_000n];
  const chainFees = [0n, 9_707_324_829n, 12_800_361_600n, 4_999_999_999_999n, 5_000_000_000_000n, 5_000_000_000_001n, 10n ** 16n];
  let seen = 0;
  for (let depth = 0; depth <= 32; depth++)
    for (const g of baseFees)
      for (const c of chainFees) {
        const b = { depth, chainFee: c.toString(), baseFeePerGas: g.toString() };
        assert.equal(deviceFee(b), page(b), JSON.stringify(b));
        // planted: the check reading the depth one level deeper than the page would differ somewhere in this sweep
        if (depth < 32 && deviceFee({ ...b, depth: depth + 1 }) !== page(b)) seen++;
      }
  assert.ok(seen > 0, "the sweep sees a rule one level off");
});
