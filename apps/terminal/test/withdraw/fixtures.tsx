// The withdraw progress on fixtures (run.mjs): the app's own WithdrawProgress fed through WithdrawSourceProvider instead
// of the kit and SIGN_HOST. ?f=<fixture> picks the signing page's state: the page first draws the fixture's `first` ops
// (the session's first state; none by default), then, once the progress has seen that, the fixture's `ops`, as a state
// event does when SIGN_HOST's layer closes. Every hop and the Deposit tap are recorded in window.__calls. Test only.
import type { Operation, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { WithdrawProgress } from "../../src/screens/withdraw/WithdrawProgress.tsx";
import { WithdrawSourceProvider } from "../../src/screens/withdraw/source.tsx";
import type { WithdrawDetail, WithdrawSource } from "../../src/screens/withdraw/source.tsx";
import { applyFit } from "../../src/shell/fit.ts";
import { fontsReady } from "../../src/shell/fonts.ts";
import "../../src/shell/shell.css";

// R5's example (private.js:121-152 at design-lock-r5; 09-design-brief S12: $10.84 to Solana, 0.0995 SOL); the tx hashes
// are shapes only
const STATE: SignpageState = { release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "62.34", wallets: [], positions: [], orders: [], held: [], ops: [] };
const DETAIL: WithdrawDetail = { amount_usd: "10.84", amount: "0.0995", symbol: "SOL", to: "5Ftu…k9Wq" };
const TXS = [
  { chain: "near" as const, hash: "9QxkTn3d2bYpW8LhF4cVzR7mKe1sJ6uA5gN0oPiHqXyD" },
  { chain: "solana" as const, hash: "5xYq2kPZbE7rN4cT8wLm1vDh3sFj6gUa9oRiKeXtBnWpQz2cM7yHd4LfVs8JaGu1" },
];
const wd = (stage: Extract<Operation, { kind: "withdraw" }>["stage"], txs = TXS): Operation => ({ id: "w1", kind: "withdraw", stage, txs });

interface Fx {
  first?: Operation[];
  ops: Operation[];
  detail?: WithdrawDetail | null;
  moneyOn?: boolean;
}

export const FIXTURES: Record<string, Fx> = {
  sending: { ops: [wd("proving", [])], detail: DETAIL },
  submitted: { ops: [wd("submitted", [])], detail: DETAIL },
  processing: { ops: [wd("in_transit", TXS.slice(0, 1))], detail: DETAIL },
  sent: { ops: [wd("sent")], detail: DETAIL },
  "sent-kit-only": { ops: [wd("sent")], detail: null },
  refunded: { ops: [wd("refunded", TXS.slice(0, 1))], detail: { amount_usd: "10.84" } },
  stopped: { ops: [wd("stopped", [])], detail: DETAIL },
  "stopped-down": { ops: [wd("stopped", [])], detail: DETAIL, moneyOn: false },
  reload: { first: [wd("in_transit", TXS.slice(0, 1))], ops: [wd("in_transit", TXS.slice(0, 1))], detail: DETAIL },
  old: { first: [wd("sent")], ops: [wd("sent")], detail: DETAIL },
};

declare global {
  interface Window {
    __calls: unknown[];
  }
}
window.__calls = [];

const fx = FIXTURES[new URLSearchParams(location.search).get("f") ?? "sent"]!;
const snap = (ops: Operation[]): SignpageClientSnapshot => ({ status: "ready", release: "signpage-v1", state: { ...STATE, ops }, stale: false });

function Page() {
  const [snapshot, setSnapshot] = useState(() => snap(fx.first ?? []));
  // runs after WithdrawProgress's own effect has seen the first state (a child's effects run before its parent's)
  useEffect(() => setSnapshot(snap(fx.ops)), []);
  const src: WithdrawSource = {
    snapshot,
    moneyOn: fx.moneyOn ?? true,
    hop: async (kind, params, view) => {
      window.__calls.push({ kind, params, view });
      return null;
    },
    locked: null,
    detail: () => fx.detail ?? null,
    now: Date.now,
  };
  return (
    <WithdrawSourceProvider value={src}>
      <div className="shell">
        <main className="screen" data-route="discover" />
      </div>
      <WithdrawProgress onDeposit={() => void window.__calls.push({ kind: "deposit" })} />
    </WithdrawSourceProvider>
  );
}

applyFit();
fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MemoryRouter initialEntries={["/discover"]}>
        <Page />
      </MemoryRouter>
    </StrictMode>,
  ),
);
