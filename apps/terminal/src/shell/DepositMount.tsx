import { DepositSheet } from "../screens/deposit/DepositSheet.tsx";
import { useDepositSheet } from "../screens/deposit/source.tsx";
import { WithdrawProgress } from "../screens/withdraw/WithdrawProgress.tsx";

// The one deposit sheet and the one withdraw progress, in the shell on every route (card app-deposit-mount). The header's
// Deposit, the phone's +, Portfolio's Deposit and the withdraw progress's Deposit open the same sheet. The sheet keeps
// its typed amount in its own state while SIGN_HOST's backup page draws over the app's frame (AE-02), since an open
// kind never unmounts it.
export function DepositMount() {
  const { open, setOpen } = useDepositSheet();
  return (
    <>
      {open && <DepositSheet onClose={() => setOpen(false)} />}
      <WithdrawProgress onDeposit={() => setOpen(true)} />
    </>
  );
}
