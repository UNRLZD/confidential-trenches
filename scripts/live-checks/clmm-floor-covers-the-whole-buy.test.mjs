// node --test scripts/live-checks/clmm-floor-covers-the-whole-buy.test.mjs: card clmm-floor-covers-the-whole-buy's live
// check, replayed. clmm-floor-covers-the-whole-buy.answers.json holds two real runs from the Mac (`--record`, 24 Nov),
// none edited after:
// - good: MPLX's CLMM pool read on api.mainnet-beta and publicnode with the three tick arrays a buy walks, agreed, a
//   25 SOL buy priced whole on both, its floor 20 bps from DexScreener: PASS;
// - bad_lying_provider: `--plant-lie`, publicnode's tick array that holds the price carrying one more initialized tick
//   than the chain's, as a provider that lies would: FAIL, the walk cut at the pool's own cell, never one provider's
//   ticks taken.
// And plants on the good run: each part broken fails that part.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./clmm-floor-covers-the-whole-buy.mjs";
import { POOL, PROVIDERS } from "./solana-buy-never-below-a-hidden-market.mjs";

const A = JSON.parse(readFileSync(new URL("./clmm-floor-covers-the-whole-buy.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: a 25 SOL buy priced whole on both providers, at the coin's real price", async () => {
  const v = await judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.plantLie, false);
});

test("the recorded bad run fails: a provider whose tick array holds a tick the chain's does not; the walk is cut", async () => {
  const v = await judge(A.bad_lying_provider);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_lying_provider.plantLie, true);
  assert.match(v.lines[0], /^ok /);
  assert.match(v.lines[1], /^BAD .*cut at the ticks read/);
});

test("each part broken in the good run fails: a price far off, no price, a missing provider, an array gone on one", async () => {
  const far = structuredClone(A.good);
  far.dex.priceNative = String(Number(A.good.dex.priceNative) * 1.1);
  assert.match((await judge(far)).lines[2], /^BAD /);
  const none = structuredClone(A.good);
  none.dex.priceNative = null;
  assert.equal((await judge(none)).verdict, "FAIL");
  const gone = structuredClone(A.good);
  delete gone.providers[PROVIDERS[1]];
  assert.match((await judge(gone)).lines[0], /^BAD /);
  // one provider answering no account for the array that holds the price: the providers disagree, the walk is cut
  const dropped = structuredClone(A.good);
  for (const [k, a] of Object.entries(dropped.providers[PROVIDERS[1]])) if (k.includes(POOL) && a.value.length > 6) a.value[6] = null;
  assert.match((await judge(dropped)).lines[1], /^BAD .*cut at the ticks read/);
});
