// A W's tail (card one-balance-buys-on-every-chain; card pool-amounts-are-standard-sizes writes them): what a sale or a
// buy leaves on its one-time wallet W under the pool's smallest rung, which no pool deposit takes. Each is one record in
// the wallet store's "meta" under the store's WALLET_W_TAIL_PREFIX ("w-tail/") + "<chain>/<address>", written by the
// rent back at its floor end and deleted once W reads empty or a sweep is sent:
//   { chain, address, l, j, amount }
//   chain: "sol" (the derive path's chain name); address: W's own address; l: W's label (a decimal string, as
//   OwedRentBack.l); j: W's index; amount: what W holds, lamports as a decimal string.
// From the store alone: nothing here reads a chain or names W in a request. Each tail is counted in the balance
// (state.deposit_wallets, beside each U_X's leftover) and carried to Cash by pool to Cash (src/pool-to-cash.ts).
import type { PoolAsset, PoolChain } from "../../kit/src/signpage/messages.ts";

export type WTail = { chain: PoolChain; address: string; l: string; j: number; amount: string };

/** The record's chain name, the derive path's, as the pool chain. */
const CHAINS: Readonly<Record<string, PoolChain>> = Object.freeze({ sol: "solana" });
const UNITS = /^[0-9]{1,78}$/;

/** The record as stored, or null for anything that is not one exactly. */
export function wTailOf(v: unknown): WTail | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  const chain = typeof t.chain === "string" && Object.hasOwn(CHAINS, t.chain) ? CHAINS[t.chain]! : null;
  if (chain === null || typeof t.address !== "string" || t.address === "") return null;
  if (typeof t.l !== "string" || !UNITS.test(t.l) || typeof t.j !== "number" || !Number.isSafeInteger(t.j) || t.j < 0) return null;
  if (typeof t.amount !== "string" || !UNITS.test(t.amount)) return null;
  return { chain, address: t.address, l: t.l, j: t.j, amount: t.amount };
}

/** The tails above 0 as state.deposit_wallets entries, in whole units of the chain pool's coin. */
export function wTailWallets(rows: readonly unknown[], decimals: (chain: PoolChain) => number, asset: (chain: PoolChain) => PoolAsset): { chain: PoolChain; address: string; asset: PoolAsset; amount: string }[] {
  const out: { chain: PoolChain; address: string; asset: PoolAsset; amount: string }[] = [];
  for (const v of rows) {
    const t = wTailOf(v);
    if (t === null || BigInt(t.amount) === 0n) continue;
    const d = decimals(t.chain);
    const s = t.amount.padStart(d + 1, "0");
    const frac = s.slice(s.length - d).replace(/0+$/, "");
    out.push({ chain: t.chain, address: t.address, asset: asset(t.chain), amount: frac === "" ? s.slice(0, s.length - d) : `${s.slice(0, s.length - d)}.${frac}` });
  }
  return out;
}
