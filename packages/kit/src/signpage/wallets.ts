// Every address that holds the user's money (card app-export-every-wallet), from the signing page's state alone, so an
// app can put an export (export.open, by chain and address) on each one and no money is left on a wallet the user
// cannot take out. Addresses only: the key is shown only on SIGN_HOST's own export screen.
import { CHAINS } from "../orders/record.ts";
import type { Chain } from "../orders/record.ts";
import type { SignpageState, WalletState } from "./messages.ts";

/** One wallet of this seed that holds money. */
export interface MoneyWallet {
  chain: Chain;
  address: string;
  /** "trade": a fresh or hop wallet (a position's, or one armed, ready or returning); "deposit": a deposit wallet with money left. */
  role: "trade" | "deposit";
  /** The tokens of the user's open positions this wallet holds, in the state's order. */
  tokens: string[];
}

/** The wallet states with money on the wallet or on its way to it: never PLANNED (nothing sent yet) or EMPTY. */
const FUNDED: ReadonlySet<WalletState> = new Set(["ARMING", "READY", "IN_POSITION", "RETURNING"]);

/** A decimal string above zero. */
const aboveZero = (s: string): boolean => /[1-9]/.test(s);

/**
 * Every address of `s` that holds money, each (chain, address) once: every wallet an open position names, every fresh
 * or hop wallet that is armed, ready, in a position or returning, and every deposit wallet with money left. By chain
 * (CHAINS' order), then trade wallets before deposit wallets, each in the state's own order (positions' wallets first).
 */
export function moneyWallets(s: SignpageState): MoneyWallet[] {
  const seen = new Map<string, MoneyWallet>();
  const add = (chain: Chain, address: string, role: MoneyWallet["role"]): MoneyWallet => {
    const k = `${chain}\n${address}`;
    let w = seen.get(k);
    if (!w) seen.set(k, (w = { chain, address, role, tokens: [] }));
    return w;
  };
  for (const p of s.positions) {
    for (const a of p.wallets) {
      const w = add(p.chain, a, "trade");
      if (!w.tokens.includes(p.token)) w.tokens.push(p.token);
    }
  }
  for (const w of s.wallets) if (FUNDED.has(w.state)) add(w.chain, w.address, "trade");
  for (const d of s.deposit_wallets ?? []) if (aboveZero(d.amount)) add(d.chain, d.address, "deposit");
  const all = [...seen.values()];
  const rank = (w: MoneyWallet) => CHAINS.indexOf(w.chain as (typeof CHAINS)[number]) * 2 + (w.role === "trade" ? 0 : 1);
  return all.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map((x) => x.w);
}
