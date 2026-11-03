// The split of a buy over the fresh wallets on hand (card signpage-solana-trade; docs/plan1/wallet.md §2.5 the ladder,
// markets.md T1.3 the standard-size set). The arming card makes the wallets at ladder sizes (1-2-5 per power of ten
// from $2); a buy of an amount takes the fewest of the wallets on hand whose sizes sum to it exactly. A greedy take of
// the largest size first misses sums such as $6 (2+2+2) or $16 (10+2+2+2), so this finds the exact fewest (ties: the
// one with more of the larger sizes).
//
// It works one power of ten at a time, from the top: at decade d the amount still owed to decades d and below is its
// own digits below d+1 plus k tens of 10^d dollars (the carry k), the $1, $2 and $5 x 10^d wallets pay v of it, and
// the decades below owe k' = digit + 10k - v. The fewest of $1, $2 and $5 summing to v is the most $5s less zero or
// one, then the most $2s (any $1s and $2s summing to $10 hold a subset that two $5s replace, two $1s one $2), so each
// (decade, carry) costs one pass over v, and the carry is at most half the wallets below: many wallets stay quick
// (card signpage-pool-kinds). A size off the ladder is no wallet the arming card makes, and is left out.

type Three = [ones: number, twos: number, fives: number];
const RUNG = /^([125])(0*)00$/;

/** The sizes (cents) of the fewest wallets on hand summing exactly to `cents`, largest first; null when none do. */
export function ladderSplit(cents: bigint, onHand: readonly bigint[]): bigint[] | null {
  if (typeof cents !== "bigint" || cents <= 0n || cents % 100n !== 0n) return null;
  const held: Three[] = [];
  for (const s of onHand) {
    if (typeof s !== "bigint" || s < 200n) continue;
    const m = RUNG.exec(s.toString());
    if (!m) continue;
    const d = m[2]!.length;
    while (held.length <= d) held.push([0, 0, 0]);
    held[d]![m[1] === "1" ? 0 : m[1] === "2" ? 1 : 2]++;
  }
  const at = (d: number): Three => held[d] ?? [0, 0, 0];
  const digits = (cents / 100n).toString().split("").reverse().map(Number);
  const top = Math.max(digits.length, held.length) - 1;
  // room[d]: the most the decades below d can pay past the amount's own digits below d, in 10^d dollars (-1: not even those)
  const room: number[] = [0];
  for (let d = 0, cap = 0n, own = 0n, ten = 1n; d <= top; d++) {
    const [h1, h2, h5] = at(d);
    cap += BigInt(h1 + 2 * h2 + 5 * h5) * ten;
    own += BigInt(digits[d] ?? 0) * ten;
    ten *= 10n;
    room.push(cap < own ? -1 : Number((cap - own) / ten));
  }
  // the fewest $1, $2 and $5 (x 10^d) of `h` summing to v, the most $5s then $2s on a tie; null when none do
  const fewest = (v: number, [h1, h2, h5]: Three): Three | null => {
    let out: Three | null = null;
    const most = Math.min(h5, Math.floor(v / 5));
    for (let x5 = most; x5 >= Math.max(0, most - 1); x5--) {
      const r = v - 5 * x5, x2 = Math.min(h2, Math.floor(r / 2)), x1 = r - 2 * x2;
      if (x1 <= h1 && (out === null || x1 + x2 + x5 < out[0] + out[1] + out[2])) out = [x1, x2, x5];
    }
    return out;
  };
  const larger = (x: Three, y: Three) => x[2] !== y[2] ? x[2] > y[2] : x[1] !== y[1] ? x[1] > y[1] : x[0] > y[0];
  type Step = { n: number; x: Three; next: number } | null;
  const memo: Map<number, Step>[] = Array.from({ length: top + 1 }, () => new Map());
  // the fewest wallets of decades d and below paying their digits plus k tens of 10^d dollars
  const fewestBelow = (d: number, k: number): number | null => {
    if (d < 0) return k === 0 ? 0 : null;
    const seen = memo[d]!.get(k);
    if (seen !== undefined) return seen?.n ?? null;
    const h = at(d), owed = (digits[d] ?? 0) + 10 * k;
    let best: Step = null;
    for (let v = Math.min(owed, h[0] + 2 * h[1] + 5 * h[2]); v >= 0 && owed - v <= room[d]!; v--) {
      const x = fewest(v, h);
      const low = x && fewestBelow(d - 1, owed - v);
      if (!x || low === null) continue;
      const n = low + x[0] + x[1] + x[2];
      if (best === null || n < best.n || (n === best.n && larger(x, best.x))) best = { n, x, next: owed - v };
    }
    memo[d]!.set(k, best);
    return best?.n ?? null;
  };
  if (fewestBelow(top, 0) === null) return null;
  const out: bigint[] = [];
  for (let d = top, k = 0; d >= 0; d--) {
    const { x, next } = memo[d]!.get(k)!;
    const unit = 100n * 10n ** BigInt(d);
    for (const [i, t] of [[2, 5n], [1, 2n], [0, 1n]] as const) for (let j = 0; j < x[i]; j++) out.push(t * unit);
    k = next;
  }
  return out;
}
