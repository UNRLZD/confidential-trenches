// The trade box's own reads (pool.buy.dry) as the trade-pool harness holds them, apart from the browser so its planted
// cases run in the unit tests (test/harness/trade-pool-reads.test.mjs):
//   - Max: one read at most with no amount, on the box's own pool chain;
//   - on Solana, the Fee of the typed amount: one read at most with an amount, on Solana;
//   - on Base and Robinhood (card buy-any-amount-on-every-chain: the box asks pool.buy.dry with the tap's amount, the
//     model's buysAskAmount), one read at most with an amount, on the box's own chain, its amount the tap's own ask's;
//     none when the box has no ask (over Max, money still being made);
//   - nothing on another chain, and never a buy.

/** The box's own pool chain from a state's name: sol-*, base-*, rh-*; null for the vault's states. */
export const ownChain = (name) => (name.startsWith("sol") ? "solana" : name.startsWith("base") ? "base" : name.startsWith("rh") ? "robinhood" : null);

/** Why `reads` break the rule for the state `name` whose tap asks `ask` (its pool.buy, or null), or null when they keep it. */
export function readsFault(name, reads, ask) {
  const own = ownChain(name);
  if (!Array.isArray(reads)) return "no reads list";
  if (reads.some((c) => c?.kind !== undefined && c.kind !== "pool.buy.dry")) return "a read that is not pool.buy.dry";
  const maxReads = reads.filter((c) => c.params?.amount === undefined);
  const amountReads = reads.filter((c) => c.params?.amount !== undefined);
  if (maxReads.length > 1) return "a second Max read";
  if (amountReads.length > 1) return "a second amount read";
  if (reads.some((c) => c.params?.chain !== own)) return "a read on another chain";
  if (amountReads.length === 0) return null;
  if (own === "solana") return null;
  if (own !== "base" && own !== "robinhood") return "an amount read with no pool";
  const want = ask?.kind === "pool.buy" && ask.params?.chain === own ? ask.params.amount : null;
  if (want === null) return "an amount read with no tap to ask";
  return amountReads[0].params.amount === want ? null : "an amount read for another amount than the tap's ask";
}
