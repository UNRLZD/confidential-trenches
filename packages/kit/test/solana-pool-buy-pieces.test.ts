// Card buy-spends-several-pieces: a tag 3 whose W is also paid by the same bundle's earlier releases (req.before):
// the build and the device's check count every piece's chunk, and only the pieces the request names.
//   node --test test/solana-pool-buy-pieces.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSolanaPoolBuy, checkSolanaPoolBuy, SOLANA_POOL_BUY_PIECES_MAX, SOLANA_POOL_JITO_TIP, solanaPoolBuyMaxSpend, solanaPoolBuyTip } from "../src/index.ts";
import { TIP, cfg, release, rent, setup } from "./solana-pool-buy-fx.ts";

const failed = (v: ReturnType<typeof checkSolanaPoolBuy>) => v.results.filter((x) => !x.ok).map((x) => x.id);
const piece = { withdrawnValue: 5_000_000n, relayFee: 1_300_000n };

test("a spend past this release's own Max builds and checks once the bundle's earlier releases pay W too", async () => {
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue } = await setup(v);
    const alone = solanaPoolBuyMaxSpend(release, venue, TIP, rent);
    const two = solanaPoolBuyMaxSpend([piece, release], venue, TIP, rent);
    // the piece adds its chunk less its relay fee, nothing more: the tip and W's accounts are the buy's, taken once
    assert.equal(two - alone, piece.withdrawnValue - piece.relayFee);
    const s = await setup(v, two);
    // this release alone does not pay it
    assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, s.req, s.chain), /does not cover|under the/);
    const req = { ...s.req, before: [piece] };
    const built = buildSolanaPoolBuy(cfg, release, venue, req, s.chain, { pick: () => 1 });
    const verdict = checkSolanaPoolBuy(built.wire, cfg, release, venue, req, s.reads);
    assert.ok(verdict.ok, JSON.stringify(verdict.results));
    assert.match(verdict.results.find((x) => x.id === "FUNDS")!.detail, /from 2 release\(s\)/);
    // the check counts only the pieces its own request names: the same bytes without them are short
    assert.deepEqual(failed(checkSolanaPoolBuy(built.wire, cfg, release, venue, s.req, s.reads)), ["FUNDS"]);
    // one lamport past the two pieces' Max: refused by both
    const over = await setup(v, two + 1n);
    assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, { ...over.req, before: [piece] }, over.chain), /under the|does not cover/);
  }
});

test("the bundle's earlier releases: at most three, each a u64 pair, each adding more than its relay fee", async () => {
  const s = await setup("pump");
  assert.throws(() => buildSolanaPoolBuy(cfg, release, s.venue, { ...s.req, before: [piece, piece, piece, piece] }, s.chain), /at most 3 releases/);
  assert.throws(() => buildSolanaPoolBuy(cfg, release, s.venue, { ...s.req, before: [{ withdrawnValue: 5, relayFee: 1n } as never] }, s.chain), /u64/);
  assert.throws(() => buildSolanaPoolBuy(cfg, release, s.venue, { ...s.req, before: [{ withdrawnValue: 1_300_000n, relayFee: 1_300_000n }] }, s.chain), /adds nothing past its relay fee/);
  const built = buildSolanaPoolBuy(cfg, release, s.venue, s.req, s.chain, { pick: () => 1 });
  assert.deepEqual(failed(checkSolanaPoolBuy(built.wire, cfg, release, s.venue, { ...s.req, before: [piece, piece, piece, piece] }, s.reads)), ["FUNDS"]);
});

test("solanaPoolBuyTip: on mainnet every count of pieces tips SOLANA_POOL_JITO_TIP (the tag 3 is its own bundle, card owners-solana-buy-lands), devnet none; a count past the most refused", () => {
  for (let k = 1; k <= SOLANA_POOL_BUY_PIECES_MAX; k++) assert.equal(solanaPoolBuyTip("mainnet", k), SOLANA_POOL_JITO_TIP, `${k}`);
  for (let k = 1; k <= SOLANA_POOL_BUY_PIECES_MAX; k++) assert.equal(solanaPoolBuyTip("devnet", k), 0n);
  for (const k of [0, SOLANA_POOL_BUY_PIECES_MAX + 1, 1.5, Number.NaN]) assert.throws(() => solanaPoolBuyTip("mainnet", k), /pieces: 1 to 4/);
});
