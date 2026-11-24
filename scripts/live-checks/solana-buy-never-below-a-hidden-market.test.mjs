// node --test scripts/live-checks/solana-buy-never-below-a-hidden-market.test.mjs: card
// solana-buy-never-below-a-hidden-market's live check, replayed. solana-buy-never-below-a-hidden-market.answers.json holds
// three real runs from the Mac (`--record`), none edited after:
// - good (24 Nov, card clmm-floor-covers-the-whole-buy): the deployed helper listing MPLX's CLMM pool for the kit's
//   scan, and the pool read on api.mainnet-beta and publicnode with the tick arrays a buy walks, agreed, deep, its 1 SOL
//   floor near DexScreener's price: PASS;
// - bad_helper_refuses (21 Nov): the deployed helper before card solana-buy-never-below-a-hidden-market, which refuses
//   the CLMM scan (HTTP 400): FAIL. Its provider answers are that day's six accounts, before the kit read the tick
//   arrays too, so the kit's read of them is no answer now; its helper line is the part judged;
// - bad_lying_provider (24 Nov): `--plant-lie`, publicnode's answer holding a SOL vault 5% over the chain's, as a
//   provider that lies would: FAIL, the kit's read refusing it.
// And plants on the good run: each part broken fails that part.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { POOL, PROVIDERS, judge } from "./solana-buy-never-below-a-hidden-market.mjs";

const A = JSON.parse(readFileSync(new URL("./solana-buy-never-below-a-hidden-market.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: the helper lists MPLX's CLMM market, agreed on two providers, deep, at its real price", async () => {
  const v = await judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.plantLie, false);
});

test("the recorded bad runs fail: a helper that refuses the scan; a provider that lies about the SOL vault", async () => {
  const h = await judge(A.bad_helper_refuses);
  assert.equal(h.verdict, "FAIL");
  assert.equal(A.bad_helper_refuses.helper, "deployed");
  assert.match(h.lines[0], /^BAD \[helper\].*HTTP 400/);
  const v = await judge(A.bad_lying_provider);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_lying_provider.plantLie, true);
  assert.match(v.lines[1], /^BAD .*quote vault is outside the band/);
});

test("each part broken in the good run fails: a list without the pool, a price far off, a missing provider, a shallow pool", async () => {
  const unlisted = structuredClone(A.good);
  unlisted.scan.result.value = unlisted.scan.result.value.filter((e) => e.pubkey !== POOL);
  assert.match((await judge(unlisted)).lines[0], /^BAD \[helper\]/);
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
      if (!k.includes(POOL) || a.value.length < 6) continue;
      const d = Buffer.from(a.value[3].data[0], "base64");
      d.writeBigUInt64LE(10n ** 9n, 64);
      a.value[3].data[0] = d.toString("base64");
    }
  }
  const s = await judge(shallow);
  assert.equal(s.verdict, "FAIL");
  assert.match(s.lines[2], /^BAD .*deep market/);
});
