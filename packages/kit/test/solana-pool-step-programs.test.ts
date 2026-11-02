// Card helper-pool-senders (M356 (1)): SOLANA_POOL_STEP_PROGRAMS is the one list of programs a pool buy's inner
// instructions invoke. The helper carries a tag 3 only when every inner program is on it, so the list must hold every
// program the kit's own builder uses, for both venues, and the builder refuses a step outside it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_POOL_STEP_PROGRAMS, solanaPoolBuyInstructions, solanaPoolBuySteps } from "../src/index.ts";
import { cfg, FEE_PAYER, release, rent, setup, W } from "./solana-pool-buy-fx.ts";

for (const v of ["pump", "pumpswap"] as const) {
  test(`${v}: every program the buy's steps invoke is on SOLANA_POOL_STEP_PROGRAMS`, async () => {
    const { venue, req } = await setup(v);
    const used = solanaPoolBuySteps(venue, W, req.spend, req.minOut).map((s) => s.program);
    for (const p of used) assert.ok(SOLANA_POOL_STEP_PROGRAMS.includes(p), `${p} is missing`);
    // and the built tag 3's inner programs, read back by index, are on it too
    const t = solanaPoolBuyInstructions(cfg, release, venue, { ...req, tip: 0n }, 6, rent, null)[2]!;
    assert.equal(t.accounts[2]!.key, FEE_PAYER);
    let at = 2 + 128 + 130 + 8;
    const count = t.data[at++]!;
    for (let i = 0; i < count; i++) {
      assert.ok(SOLANA_POOL_STEP_PROGRAMS.includes(t.accounts[t.data[at]!]!.key));
      const n = t.data[at + 1]!;
      at += 2 + n;
      at += 2 + (t.data[at]! | (t.data[at + 1]! << 8));
    }
    assert.equal(at, t.data.length);
  });
}

test("the list holds exactly the two venues, the token programs, the ATA program and the system program", () => {
  assert.equal(SOLANA_POOL_STEP_PROGRAMS.length, 6);
  assert.equal(new Set(SOLANA_POOL_STEP_PROGRAMS).size, 6);
  assert.ok(Object.isFrozen(SOLANA_POOL_STEP_PROGRAMS));
});
