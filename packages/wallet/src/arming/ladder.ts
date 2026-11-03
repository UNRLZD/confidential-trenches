// The split of a buy over the fresh wallets on hand (card signpage-solana-trade; docs/plan1/wallet.md §2.5 the ladder,
// markets.md T1.3 the standard-size set). The arming card makes the wallets at ladder sizes (1-2-5 per power of ten
// from $2); a buy of an amount takes the fewest of the wallets on hand whose sizes sum to it exactly. A greedy take of
// the largest size first misses sums such as $6 (2+2+2) or $16 (10+2+2+2), so this searches every count of each size,
// largest first, and keeps the fewest wallets (ties: the one with more of the larger sizes).

/** The sizes (cents) of the fewest wallets on hand summing exactly to `cents`, largest first; null when none do. */
export function ladderSplit(cents: bigint, onHand: readonly bigint[]): bigint[] | null {
  if (typeof cents !== "bigint" || cents <= 0n) return null;
  const counts = new Map<bigint, number>();
  for (const s of onHand) if (typeof s === "bigint" && s > 0n) counts.set(s, (counts.get(s) ?? 0) + 1);
  const sizes = [...counts.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  // the fewest of sizes[i..] summing to `rest`, per (i, rest): each pair is searched once
  const memo = new Map<string, bigint[] | null>();
  const best = (i: number, rest: bigint): bigint[] | null => {
    if (rest === 0n) return [];
    if (i === sizes.length) return null;
    const k = `${i}:${rest}`;
    if (memo.has(k)) return memo.get(k)!;
    const s = sizes[i]!;
    const most = Math.min(counts.get(s)!, Number(rest / s));
    let out: bigint[] | null = null;
    for (let n = most; n >= 0; n--) {
      const tail = best(i + 1, rest - s * BigInt(n));
      if (tail && (out === null || n + tail.length < out.length)) out = [...new Array<bigint>(n).fill(s), ...tail];
    }
    memo.set(k, out);
    return out;
  };
  return best(0, cents);
}
