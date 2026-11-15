// node --test apps/terminal/test/harness/trade-pool-reads.test.mjs: the trade-pool harness's rule for the box's own
// reads (test/trade-pool/reads.mjs), on the reads its states make, and planted: a read on another chain, a second amount
// read, an amount other than the tap's ask, each FAILs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readsFault } from "../trade-pool/reads.mjs";

const EVM = "0x00000000000000000000000000000000000f1fe7";
const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const dry = (chain, amount) => ({ kind: "pool.buy.dry", params: { chain, ...(chain === "solana" ? { mint: MINT } : { token: EVM }), ...(amount === undefined ? {} : { amount }) } });
const buy = (chain, amount) => ({ kind: "pool.buy", params: { chain, token: EVM, amount, slippage_bps: 1000 } });

test("the reads the harness's states make keep the rule", () => {
  // release 135's browser run: base-chunk and base-other read Max and the tap's own amount
  assert.equal(readsFault("base-chunk", [dry("base"), dry("base", "0.001")], buy("base", "0.001")), null);
  assert.equal(readsFault("base-other", [dry("base"), dry("base", "0.000857112623895816")], buy("base", "0.000857112623895816")), null);
  assert.equal(readsFault("base-over", [dry("base")], null), null);
  assert.equal(readsFault("rh-chunk", [dry("robinhood"), dry("robinhood", "0.001")], buy("robinhood", "0.001")), null);
  assert.equal(readsFault("sol-ready", [dry("solana"), dry("solana", "0.0014")], null), null);
  assert.equal(readsFault("vault", [], null), null);
  // card buy-box-quotes-before-funds: a $0 Base box with no pool note asks the typed $5 in ETH, with no tap to ask
  assert.equal(readsFault("base-fresh", [dry("base"), dry("base", "0.00142852103982636")], null, "0.00142852103982636"), null);
});

test("planted: each break of the rule FAILs", () => {
  const cases = [
    ["base-chunk", [dry("base"), dry("solana", "0.001")], buy("base", "0.001"), "a read on another chain"],
    ["base-chunk", [dry("robinhood"), dry("base", "0.001")], buy("base", "0.001"), "a read on another chain"],
    ["base-chunk", [dry("base"), dry("base", "0.001"), dry("base", "0.001")], buy("base", "0.001"), "a second amount read"],
    ["base-chunk", [dry("base"), dry("base")], buy("base", "0.001"), "a second Max read"],
    ["base-other", [dry("base"), dry("base", "0.001")], buy("base", "0.000857112623895816"), "an amount read for another amount than the tap's ask"],
    ["base-over", [dry("base"), dry("base", "0.0011")], null, "an amount read with no tap to ask"],
    ["base-fresh", [dry("base"), dry("base", "0.002")], null, "0.0014285", "an amount read for another amount than the tap's ask"],
    ["rh-chunk", [dry("robinhood"), dry("robinhood", "0.002")], buy("robinhood", "0.001"), "an amount read for another amount than the tap's ask"],
    ["sol-ready", [dry("solana"), dry("base", "0.0014")], null, "a read on another chain"],
    ["vault", [dry("solana")], null, "a read on another chain"],
    ["base-chunk", [dry("base"), buy("base", "0.001")], buy("base", "0.001"), "a read that is not pool.buy.dry"],
  ];
  for (const c of cases) {
    const [name, reads, ask] = c;
    const [quote, why] = c.length === 5 ? [c[3], c[4]] : [null, c[3]];
    assert.equal(readsFault(name, reads, ask, quote), why, `${name} ${JSON.stringify(reads)}`);
  }
});
