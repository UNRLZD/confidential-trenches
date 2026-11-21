// node --test scripts/live-checks/solana-buy-never-below-a-hidden-market.test.mjs: card
// solana-buy-never-below-a-hidden-market's live check, replayed. solana-buy-never-below-a-hidden-market.answers.json holds
// two real runs from the Mac (`--record`, 21 Nov), none edited after:
// - good: MPLX's CLMM pool on api.mainnet-beta and publicnode, both answers agreed, 24190 SOL deep, 15 bps from
//   DexScreener: PASS;
// - bad_lying_provider: `--plant-lie`, the same read with publicnode's answer holding a SOL vault 5% over the chain's,
//   as a provider that lies would: FAIL, the kit's read refusing it.
// And plants on the good run: each part broken fails that part.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { POOL, PROVIDERS, judge } from "./solana-buy-never-below-a-hidden-market.mjs";

const A = JSON.parse(readFileSync(new URL("./solana-buy-never-below-a-hidden-market.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: MPLX's CLMM market agreed on two providers, deep, at its real price", async () => {
  const v = await judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.plantLie, false);
});

test("the recorded bad run fails: a provider that lies about the SOL vault is refused, never priced", async () => {
  const v = await judge(A.bad_lying_provider);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_lying_provider.plantLie, true);
  assert.match(v.lines[0], /^BAD .*SOL vault is outside the band/);
});

test("each part broken in the good run fails: a price far from the real one, a missing provider, a shallow pool", async () => {
  const far = structuredClone(A.good);
  far.dex.priceNative = String(Number(A.good.dex.priceNative) * 1.1);
  assert.equal((await judge(far)).verdict, "FAIL");
  const none = structuredClone(A.good);
  none.dex.priceNative = null;
  assert.equal((await judge(none)).verdict, "FAIL");
  const gone = structuredClone(A.good);
  delete gone.providers[PROVIDERS[1]];
  assert.equal((await judge(gone)).verdict, "FAIL");
  const shallow = structuredClone(A.good);
  for (const u of PROVIDERS) {
    for (const [k, a] of Object.entries(shallow.providers[u])) {
      if (!k.includes(POOL) || a.value.length !== 3) continue;
      const d = Buffer.from(a.value[2].data[0], "base64");
      d.writeBigUInt64LE(10n ** 9n, 64);
      a.value[2].data[0] = d.toString("base64");
    }
  }
  const s = await judge(shallow);
  assert.equal(s.verdict, "FAIL");
  assert.match(s.lines[1], /^BAD .*deep market/);
});
