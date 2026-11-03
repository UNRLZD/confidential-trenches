// Card helper-pool-senders (M356 (1), M362 (1)): SOLANA_POOL_STEP_PROGRAMS is the one list of programs a pool buy's inner
// instructions invoke. The helper carries a tag 3 only when every inner program is on it, so the list must equal the
// programs the kit's own builder invokes, for both venues and both base token programs: one the builder needs and the
// list lacks breaks every buy, and one on the list the builder never invokes is a program the helper carries for nobody
// (Token-2022's transfer hook can fail after the simulation passed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_POOL_STEP_PROGRAMS, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaPoolBuyInstructions, solanaPoolBuySteps, type SolanaPoolBuyVenue } from "../src/index.ts";
import { cfg, FEE_PAYER, release, rent, setup, W } from "./solana-pool-buy-fx.ts";

// The recorded venues, and each again on the other base token program (a Token-2022 venue fixture for a Token mint and
// the reverse): the steps' programs depend on the venue's kind and its token program, and on nothing else of it.
async function venues(): Promise<{ name: string; venue: SolanaPoolBuyVenue; req: Awaited<ReturnType<typeof setup>>["req"] }[]> {
  const out = [];
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req } = await setup(v);
    for (const tp of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) out.push({ name: `${v} ${tp === SOLANA_TOKEN_PROGRAM ? "Token" : "Token-2022"}${tp === venue.tokenProgram ? " (recorded)" : ""}`, venue: { ...venue, tokenProgram: tp }, req });
  }
  return out;
}

test("the list equals the programs the builder's steps invoke, over both venues and both token programs", async () => {
  const used = new Set<string>();
  const all = await venues();
  assert.equal(all.length, 4);
  for (const { venue, req } of all) for (const s of solanaPoolBuySteps(venue, W, req.spend, req.minOut)) used.add(s.program);
  assert.deepEqual([...used].sort(), [...SOLANA_POOL_STEP_PROGRAMS].sort());
  assert.ok(!SOLANA_POOL_STEP_PROGRAMS.includes(SOLANA_TOKEN_2022_PROGRAM), "Token-2022 is an account of the ATA create, never an inner program");
  assert.equal(new Set(SOLANA_POOL_STEP_PROGRAMS).size, SOLANA_POOL_STEP_PROGRAMS.length);
  assert.ok(Object.isFrozen(SOLANA_POOL_STEP_PROGRAMS));
});

test("every built tag 3's inner programs, read back by index, are on the list", async () => {
  for (const { name, venue, req } of await venues()) {
    const t = solanaPoolBuyInstructions(cfg, release, venue, { ...req, tip: 0n }, 6, rent, null)[2]!;
    assert.equal(t.accounts[2]!.key, FEE_PAYER);
    let at = 2 + 128 + 130 + 8;
    const count = t.data[at++]!;
    for (let i = 0; i < count; i++) {
      assert.ok(SOLANA_POOL_STEP_PROGRAMS.includes(t.accounts[t.data[at]!]!.key), `${name}: inner ${i}`);
      const n = t.data[at + 1]!;
      at += 2 + n;
      at += 2 + (t.data[at]! | (t.data[at + 1]! << 8));
    }
    assert.equal(at, t.data.length, name);
  }
});
