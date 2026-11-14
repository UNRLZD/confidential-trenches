// Portfolio and Activity at /portfolio (card app-portfolio-mount): the screen with each of its taps mounted; Deposit opens
// the shell's one deposit sheet (card app-deposit-mount, shell/DepositMount.tsx). A pool row's Withdraw opens the
// app's Withdraw on that pool (card withdraw-address-in-the-app; withdraw-in-app-to-any-chain: the only withdraw form it
// opens), and the shell's withdraw progress (S12.11-S12.15) draws
// the withdrawal the signing page then reports (card app-pool-withdraw). Each
// Export opens SIGN_HOST's key export for its own wallet, one the kit's moneyWallets names (card app-export-every-wallet).
import { moneyWallets } from "@blindfill/kit";
import { useNavigate } from "react-router";
import { useDepositSheet } from "../screens/deposit/source.tsx";
import { Portfolio } from "../screens/portfolio/Portfolio.tsx";
import type { PortfolioAction } from "../screens/portfolio/source.tsx";
import { useSignpage } from "../shell/signpage-frame.tsx";
import { useReturnHop } from "../shell/ReturnHop.tsx";
import { tapOf } from "./portfolio-taps.ts";
import { useWithdrawOpen } from "../screens/withdraw/WithdrawPick.tsx";

/** Portfolio and Activity at /portfolio, signed in, with each tap mounted. */
export function PortfolioMount() {
  const { snapshot } = useSignpage();
  const { hop } = useReturnHop();
  const deposit = useDepositSheet();
  const openWithdraw = useWithdrawOpen();
  const navigate = useNavigate();
  const onAction = (a: PortfolioAction) => {
    const held = snapshot.state ? moneyWallets(snapshot.state) : [];
    const m = tapOf(a, (chain, address) => held.some((w) => w.chain === chain && w.address === address));
    const view = (control: string) => ({ route: "portfolio" as const, sheet: null, control, fields: {} });
    if (m.to === "deposit") deposit.setOpen(true);
    else if (m.to === "withdraw") {
      // the app's own Withdraw, on the pool row's place when a row named one (card withdraw-in-app-to-any-chain); the
      // fallback is only for a screen drawn with no provider (WithdrawPick.tsx), never a pool form of SIGN_HOST's own
      const control = m.from ? `pool-withdraw-${m.from}` : "withdraw";
      void openWithdraw(view(control), () => hop("withdraw.open", {}, view(control)), m.from);
    }
    else if (m.to === "token") void navigate(m.href);
    else if (m.to === "export") void hop("export.open", { chain: m.chain, address: m.address }, view(`export-${m.chain}-${m.address}`));
  };
  return <Portfolio onAction={onAction} />;
}
