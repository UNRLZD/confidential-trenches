// Card buy-any-amount-on-every-chain: the screen shows, before the tap, the amount an EVM buy will really spend. An ask
// no plan carries exactly (within one buy's bound under a sum of spends) is planned at the largest amount under it one
// carries (rules/pool.ts planEvmBuy), so pool.buy.dry on Base and Robinhood answers that amount as `buys` (kit 1.16)
// whenever it is below the ask: the same pieces and bound the tap plans over (evmBuyPieces, one path for the tap and the
// dry), the same planner. Red before this card: no evmBuyPieces, evmDryAmount or evmDryBuys in src/pool-buy-evm.ts.
//   node --test test/pool-buy-evm-dry.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmBuyPieces, evmDryAmount, evmDryBuys } from "../src/pool-buy-evm.ts";
import { evmBuyMax, planEvmBuy, type PoolAsk } from "../src/rules/pool.ts";

const ETH = 10n ** 18n;
const micro = (n: bigint) => (n * ETH) / 1_000_000n;
type Ready = Parameters<typeof evmBuyPieces>[0][number];
/** A ready proof as the chain's queue hands it: only the fields the plan reads are real. */
const proof = (noteId: string, chunk: bigint, feeCap: bigint, o: { root?: "epoch" | "newest"; chain?: "evm" | "solana"; poolId?: string } = {}): Ready =>
  ({ noteId, attempt: "a", poolId: o.poolId ?? "base-eth", wallet: { chain: o.chain ?? "evm", l: 1n, j: 0, path: "", address: "0x01" }, chunk, root: o.root ?? "epoch", binding: { feeCap } }) as unknown as Ready;
// two notes: 0.01 ETH at a 0.0001 ETH relay fee, 0.005 ETH at 0.0002: spends 0.0099 and 0.0048, Max 0.0147, bound 0.0002
const READY = [proof("n1", micro(10_000n), micro(100n)), proof("n2", micro(5_000n), micro(200n))];
const MAX = micro(14_700n);
const BOUND = micro(200n);

test("evmBuyPieces: the tap's pieces and bound: EVM proofs no other tap holds, one a note (the epoch root's first), a fee under its chunk; the bound the dearest piece's fee", () => {
  const { pieces, bound, byNote } = evmBuyPieces(READY);
  assert.deepEqual(pieces, [{ noteId: "n1", chunk: micro(10_000n), fee: micro(100n) }, { noteId: "n2", chunk: micro(5_000n), fee: micro(200n) }]);
  assert.equal(bound, BOUND);
  assert.equal(evmBuyMax(pieces), MAX);
  assert.equal(byNote.get("n2"), READY[1]);
  // a note's newest-root proof listed first still gives way to its epoch-root one
  const newest = proof("n1", micro(10_000n), micro(300n), { root: "newest" });
  const two = evmBuyPieces([newest, ...READY]);
  assert.equal(two.byNote.get("n1"), READY[0]);
  assert.equal(two.bound, BOUND, "the newest-root proof's dearer fee is not the bound");
  // a Solana W's proof, a held note and a fee at or over its chunk are no piece
  const odd = evmBuyPieces([...READY, proof("s", micro(9_000n), 1n, { chain: "solana" }), proof("f", micro(100n), micro(100n)), proof("held", micro(8_000n), micro(900n))], new Set(["held"]));
  assert.deepEqual(odd.pieces.map((p) => p.noteId), ["n1", "n2"]);
  assert.equal(odd.bound, BOUND);
  assert.deepEqual(evmBuyPieces([]), { byNote: new Map(), pieces: [], bound: 0n });
});

test("pool.buy.dry's amount on Base and Robinhood: a decimal of ETH (at most 18 places) in wei; none with no amount; anything else not one", () => {
  assert.equal(evmDryAmount(undefined), null);
  assert.equal(evmDryAmount("0.0147"), MAX);
  assert.equal(evmDryAmount("1"), ETH);
  assert.equal(evmDryAmount("0.000000000000000001"), 1n);
  assert.equal(evmDryAmount("0"), 0n);
  for (const bad of ["", "-1", "1e3", ".5", "1.", " 1", "0.0000000000000000001", "0x10", "01", 1, 0.5, null, {}, ["1"]]) assert.equal(evmDryAmount(bad), undefined, JSON.stringify(bad));
});

test("pool.buy.dry on base, an amount in the band (Max less half a relay fee): buys is Max less the bound, what the tap's own plan spends", () => {
  const ask = MAX - BOUND / 2n;
  assert.equal(evmDryBuys("base", ask, "0.0147", READY), "0.0145");
  assert.equal(evmDryBuys("robinhood", ask, "0.0147", READY), "0.0145");
  // the planner's own answer over the same pieces and bound, as runEvmPoolBuy plans it
  const { pieces, bound } = evmBuyPieces(READY);
  const plan = planEvmBuy({ kind: "pool.buy", chain: "base", token: "0x02", amount: ask, slippageBps: 100, decimals: 6 } as PoolAsk, pieces, bound);
  assert.equal(plan.amount, MAX - BOUND);
  assert.equal(plan.asked, ask);
});

test("pool.buy.dry's buys is left out wherever the tap spends the ask itself or nothing is planned", () => {
  // an amount a plan carries exactly: Max, one whole note, and one under Max less the bound
  for (const a of [MAX, micro(9_900n), micro(14_500n), micro(1_000n)]) assert.equal(evmDryBuys("base", a, "0.0147", READY), null, String(a));
  // no amount, zero, over tap_max, a tap_max that is no amount, no pieces (the planner refuses)
  assert.equal(evmDryBuys("base", null, "0.0147", READY), null);
  assert.equal(evmDryBuys("base", 0n, "0.0147", READY), null);
  assert.equal(evmDryBuys("base", MAX - BOUND / 2n, "0.0145", READY), null, "over tap_max: a tap that moves Cash first");
  assert.equal(evmDryBuys("base", MAX - BOUND / 2n, "0.0146", READY), "0.0145", "at tap_max");
  assert.equal(evmDryBuys("base", MAX - BOUND / 2n, "x", READY), null);
  assert.equal(evmDryBuys("base", micro(1_000n), "0.0147", []), null);
});
