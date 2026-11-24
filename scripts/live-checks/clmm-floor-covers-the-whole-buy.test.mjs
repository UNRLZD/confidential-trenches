// node --test scripts/live-checks/clmm-floor-covers-the-whole-buy.test.mjs: card clmm-floor-covers-the-whole-buy's live
// check, replayed. clmm-floor-covers-the-whole-buy.answers.json holds two real runs from the Mac (`--record`, 24 Nov),
// none edited after:
// - good: MPLX's CLMM pool read on api.mainnet-beta and publicnode with the three tick arrays a buy walks, agreed, a
//   25 SOL buy priced whole on both, its floor 20 bps from DexScreener: PASS;
// - bad_lying_provider: `--plant-lie`, publicnode's tick array that holds the price carrying one more initialized tick
//   than the chain's, as a provider that lies would: FAIL, the walk cut at the pool's own cell, never one provider's
//   ticks taken.
// The chain runs were recorded before the check read SIGN_HOST; its two sign reads are recorded beside them (24 Nov):
// - sign_card_build: this card's signing page build, which holds the walk's seed: with the good chain run, PASS;
// - sign_before_release: SIGN_HOST's /app.js before this card's release, no walk in it: with the good chain run, FAIL.
// And plants on the good run: each part broken fails that part.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./clmm-floor-covers-the-whole-buy.mjs";
import { POOL, PROVIDERS } from "./solana-buy-never-below-a-hidden-market.mjs";

const A = JSON.parse(readFileSync(new URL("./clmm-floor-covers-the-whole-buy.answers.json", import.meta.url), "utf8"));
/** A recorded chain run with a recorded sign read. */
const withSign = (run, sign) => ({ ...structuredClone(run), sign: structuredClone(sign) });
const GOOD = withSign(A.good, A.sign_card_build);

test("the recorded good run passes: a 25 SOL buy priced whole on both providers, at the coin's real price, the walk served", async () => {
  const v = await judge(GOOD);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.plantLie, false);
  assert.equal(A.sign_card_build.seed, true);
});

test("the recorded SIGN_HOST before the release fails: its /app.js holds no walk, though the chain prices it whole", async () => {
  const v = await judge(withSign(A.good, A.sign_before_release));
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines.slice(0, 3).map((l) => l.slice(0, 3)), ["ok ", "ok ", "ok "]);
  assert.match(v.lines[3], /^BAD \[sign\] .*does not hold the tick array's seed/);
  // and a SIGN_HOST that answers other than 200, or no sign read at all
  assert.match((await judge(withSign(A.good, { ...A.sign_card_build, status: 503, bytes: 0, seed: false }))).lines[3], /^BAD /);
  assert.match((await judge(structuredClone(A.good))).lines[3], /^BAD \[sign\] .*not read/);
});

test("the recorded bad run fails: a provider whose tick array holds a tick the chain's does not; the walk is cut", async () => {
  const v = await judge(withSign(A.bad_lying_provider, A.sign_card_build));
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_lying_provider.plantLie, true);
  assert.match(v.lines[0], /^ok /);
  assert.match(v.lines[1], /^BAD .*cut at the ticks read/);
});

test("each part broken in the good run fails: a price far off, no price, a missing provider, an array gone on one", async () => {
  const far = structuredClone(GOOD);
  far.dex.priceNative = String(Number(A.good.dex.priceNative) * 1.1);
  assert.match((await judge(far)).lines[2], /^BAD /);
  const none = structuredClone(GOOD);
  none.dex.priceNative = null;
  assert.equal((await judge(none)).verdict, "FAIL");
  const gone = structuredClone(GOOD);
  delete gone.providers[PROVIDERS[1]];
  assert.match((await judge(gone)).lines[0], /^BAD /);
  // one provider answering no account for the array that holds the price: the providers disagree, the walk is cut
  const dropped = structuredClone(GOOD);
  for (const [k, a] of Object.entries(dropped.providers[PROVIDERS[1]])) if (k.includes(POOL) && a.value.length > 6) a.value[6] = null;
  assert.match((await judge(dropped)).lines[1], /^BAD .*cut at the ticks read/);
});
