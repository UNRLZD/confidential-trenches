// Portfolio and Activity at /portfolio (card app-portfolio-mount): the screen with each of its taps mounted; Deposit opens
// the shell's one deposit sheet (card app-deposit-mount, shell/DepositMount.tsx). A pool row's Withdraw opens SIGN_HOST's
// pool withdraw with the chain only, and the shell's withdraw progress (S12.11-S12.15) draws the withdrawal the signing
// page then reports (card app-pool-withdraw). Each
// Export opens SIGN_HOST's key export for its own wallet, one the kit's moneyWallets names (card app-export-every-wallet).
import { moneyWallets } from "@blindfill/kit";
import { useDepositSheet } from "../screens/deposit/source.tsx";
import { Portfolio } from "../screens/portfolio/Portfolio.tsx";
import type { PortfolioAction } from "../screens/portfolio/source.tsx";
import { useSignpage } from "../shell/signpage-frame.tsx";
import { useReturnHop } from "../shell/ReturnHop.tsx";
import { tapOf } from "./portfolio-taps.ts";

/** Portfolio and Activity at /portfolio, signed in, with each tap mounted. */
export function PortfolioMount() {
  const { snapshot } = useSignpage();
  const { hop } = useReturnHop();
  const deposit = useDepositSheet();
  const onAction = (a: PortfolioAction) => {
    const held = snapshot.state ? moneyWallets(snapshot.state) : [];
    const m = tapOf(a, (chain, address) => held.some((w) => w.chain === chain && w.address === address));
    const view = (control: string) => ({ route: "portfolio" as const, sheet: null, control, fields: {} });
    if (m.to === "deposit") deposit.setOpen(true);
    else if (m.to === "withdraw") void hop("withdraw.open", {}, view("withdraw"));
    else if (m.to === "pool.withdraw") void hop("pool.withdraw", m.params, view(`pool-withdraw-${m.params.chain}`));
    else if (m.to === "export") void hop("export.open", { chain: m.chain, address: m.address }, view(`export-${m.chain}-${m.address}`));
  };
  return <Portfolio onAction={onAction} />;
}
