// The app's Withdraw form on fixtures (run.mjs; card withdraw-in-app-to-any-chain): the app's own DepositSheet on its
// Withdraw segment, fed through DepositSourceProvider instead of the kit and SIGN_HOST, opened as a pool row opens it
// (DepositSheetProvider openWithdraw with the row's chain). ?from=<chain> names the row (none: the first place with money).
// The state holds money in Cash and in all three pools. Every hop is recorded in window.__calls and answered ok, as the
// shell's ok when SIGN_HOST's Confirm is up. Test only.
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { DepositSheet } from "../../src/screens/deposit/DepositSheet.tsx";
import { DepositSheetProvider, DepositSourceProvider, useDepositSheet } from "../../src/screens/deposit/source.tsx";
import type { DepositSource } from "../../src/screens/deposit/source.tsx";
import { applyFit } from "../../src/shell/fit.ts";
import { fontsReady } from "../../src/shell/fonts.ts";
import "../../src/shell/shell.css";

const STATE: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "62.34",
  pools: [
    { chain: "solana", asset: "SOL", balance: "0.2522" },
    { chain: "base", asset: "ETH", balance: "0.0041" },
    { chain: "robinhood", asset: "ETH", balance: "0.0123" },
  ],
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
};

declare global {
  interface Window {
    __calls: unknown[];
  }
}
window.__calls = [];

const from = new URLSearchParams(location.search).get("from");
const snapshot: SignpageClientSnapshot = { status: "ready", release: "signpage-v1", state: STATE, stale: false };
const src: DepositSource = {
  snapshot,
  moneyOn: true,
  assets: [],
  assetsRefused: null,
  retryAssets: () => {},
  dryQuote: () => new Promise(() => {}),
  quote: () => new Promise(() => {}),
  status: () => null,
  poolAddress: async (chain) => ({ id: `a-${chain}`, reply: { ok: false, code: "not_available" } as never }),
  poolStatus: () => null,
  hop: async (kind, params, view) => {
    window.__calls.push({ kind, params, view });
    return { ok: true };
  },
  locked: null,
  start: { amount: "" },
  now: () => Date.now(),
  copy: () => {},
};

/** Opens the sheet on Withdraw as a pool row's tap does (WithdrawPick.tsx through the provider). */
function Open() {
  const { open, openWithdraw } = useDepositSheet();
  useEffect(() => openWithdraw(from), [openWithdraw]);
  return open ? <DepositSheet onClose={() => void window.__calls.push({ kind: "close" })} /> : null;
}

applyFit();
fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MemoryRouter initialEntries={["/portfolio"]}>
        <DepositSourceProvider value={src}>
          <DepositSheetProvider>
            <div className="shell">
              <main className="screen" data-route="portfolio" />
            </div>
            <Open />
          </DepositSheetProvider>
        </DepositSourceProvider>
      </MemoryRouter>
    </StrictMode>,
  ),
);
