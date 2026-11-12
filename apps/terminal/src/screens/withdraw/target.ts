// Which withdraw form a Withdraw tap opens (card withdraw-form-shows-what-you-can-send). The money is where the signing
// page's state says it is: USDC in the NEAR vault (vault_balance, SIGN_HOST's withdraw.open form) and each chain's pool
// (pools, SIGN_HOST's pool.withdraw form for that chain). Every Withdraw in the app (Portfolio's, the account menu's, the
// deposit sheet's, the withdraw progress's again) opens the form of the place that holds money: one place, that form;
// several, a pick of them (each its chain's mark and its balance with its symbol); none, or a state not read, the
// vault's form as before. The header's chain filter never decides it: the money does.
import { POOL_CHAINS } from "@blindfill/kit";
import type { PoolChain, SignpageState } from "@blindfill/kit";

/** A place money can be withdrawn from, with what it holds there as the state gives it (a decimal string). */
export type WithdrawPlace =
  | { kind: "withdraw.open"; chain: "near"; balance: string; symbol: "USDC" }
  | { kind: "pool.withdraw"; chain: PoolChain; balance: string; symbol: string };

/** Above zero: a decimal string with a digit other than 0. */
const held = (balance: string | undefined): balance is string => typeof balance === "string" && /^\d+(\.\d+)?$/.test(balance) && /[1-9]/.test(balance);

/** Every place that holds money now, the vault first, then the pools in the kit's chain order. */
export function withdrawPlaces(state: SignpageState | null | undefined): WithdrawPlace[] {
  if (!state) return [];
  const out: WithdrawPlace[] = [];
  if (held(state.vault_balance)) out.push({ kind: "withdraw.open", chain: "near", balance: state.vault_balance, symbol: "USDC" });
  for (const chain of POOL_CHAINS) {
    const p = state.pools?.find((x) => x.chain === chain);
    if (p && held(p.balance)) out.push({ kind: "pool.withdraw", chain, balance: p.balance, symbol: p.asset });
  }
  return out;
}

/** What a Withdraw tap does: open one form, or let the user pick among the places that hold money. */
export type WithdrawOpen = { to: "open"; place: WithdrawPlace | null } | { to: "pick"; places: WithdrawPlace[] };

/** A row of the pick: one open at a time (a second row does nothing meanwhile, `busy` keeps the rows off), and the pick
 *  closes only on the shell's ok; a refused or silent open leaves it up, where its HopLine draws why. */
export function pickRunner<P>(start: (p: P) => Promise<{ ok: boolean } | null>, ui: { busy(b: boolean): void; close(): void }): (p: P) => Promise<void> {
  let running = false;
  return async (p) => {
    if (running) return;
    running = true;
    ui.busy(true);
    let ok = false;
    try {
      ok = (await start(p))?.ok === true;
    } finally {
      running = false;
      ui.busy(false);
    }
    if (ok) ui.close();
  };
}

/** One place: its form; several: the pick; none: the vault's form (place null), as every Withdraw opened before. */
export function withdrawOpen(state: SignpageState | null | undefined): WithdrawOpen {
  const places = withdrawPlaces(state);
  if (places.length > 1) return { to: "pick", places };
  return { to: "open", place: places[0] ?? null };
}
