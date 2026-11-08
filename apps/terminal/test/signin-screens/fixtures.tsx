// The sign-in screens on fixtures (run.mjs): the app's own header, phone header, footer, tab bar and sign-in sheet,
// fed a fixed signing page snapshot through SigninSourceProvider instead of SIGN_HOST. ?f=<fixture> picks the state;
// window.__fixture(name) moves to another one in place, as a `state` event would (S19.1 to S19.3). Every hop and
// restore the screens ask for is recorded in window.__calls. Test only.
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { PhoneAccountMenu } from "../../src/screens/signin/Account.tsx";
import { SigninSheet } from "../../src/screens/signin/SigninSheet.tsx";
import { SigninSheetProvider, SigninSourceProvider } from "../../src/screens/signin/source.tsx";
import type { SigninSource } from "../../src/screens/signin/source.tsx";
import { applyFit } from "../../src/shell/fit.ts";
import { fontsReady } from "../../src/shell/fonts.ts";
import { Footer } from "../../src/shell/Footer.tsx";
// the footer's block read, answered here so no request leaves the page: the mainnet read the footer drew on 8 Nov 11:06Z (card app-footer-bar)
const FOOTER_READ = async () => ({ height: 223_607_563, ms: 233 });
import { Header, PhoneHeader } from "../../src/shell/Header.tsx";
import { TabBar } from "../../src/shell/TabBar.tsx";
import "../../src/shell/shell.css";

const base: SignpageState = { release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const st = (s: Partial<SignpageState>): SignpageState => ({ ...base, ...s });
const restore = (stage: "reading" | "done" | "stalled") => [{ id: "r1", kind: "restore" as const, stage, txs: [] }];
const ready = (state: SignpageState | null): SignpageClientSnapshot => ({ status: "ready", release: "signpage-v1", state, stale: false });

export const FIXTURES: Record<string, SignpageClientSnapshot> = {
  out: ready(st({ signed_in: false, way: undefined })),
  "out-noprf": ready(st({ signed_in: false, way: undefined, signin_failed: { way: "passkey", reason: "no_prf" } })),
  "out-down": { status: "down", release: null, state: null, stale: false },
  loading: { status: "connecting", release: null, state: null, stale: false },
  "new-unsaved": ready(st({ code_saved: false })),
  "new-saved": ready(st({})),
  balance: ready(st({ vault_balance: "73.18" })),
  "wallet-new": ready(st({ way: "wallet" })),
  "wallet-restored": ready(st({ way: "wallet", vault_balance: "73.18", ops: restore("done") })),
  scanning: ready(st({ vault_balance: "0", ops: restore("reading") })),
  growing: ready(st({ vault_balance: "41.06", ops: restore("reading") })),
  done: ready(st({ vault_balance: "73.18", ops: restore("done") })),
  nothing: ready(st({ ops: restore("done") })),
  offline: ready(st({ vault_balance: "12.50", ops: restore("stalled") })),
};

declare global {
  interface Window {
    __fixture(name: string): void;
    __calls: unknown[];
  }
}
window.__calls = [];

const q = new URLSearchParams(location.search);
const path = q.get("path") ?? "/discover";

function App() {
  const [name, setName] = useState(q.get("f") ?? "out");
  useEffect(() => {
    window.__fixture = setName;
  }, []);
  const snapshot = FIXTURES[name]!;
  const src: SigninSource = {
    snapshot,
    moneyOn: snapshot.status === "ready",
    locked: null,
    hop: async (kind, params, view) => {
      window.__calls.push({ kind, params, view });
      return null;
    },
    restore: () => void window.__calls.push({ kind: "restore" }),
  };
  document.documentElement.dataset.fixture = name;
  return (
    <SigninSourceProvider value={src}>
      <SigninSheetProvider>
        <div className="shell">
          <Header />
          <PhoneHeader />
          <main className="screen" data-route={path}>
            {path === "/profile" && <PhoneAccountMenu />}
          </main>
          <Footer read={FOOTER_READ} />
          <TabBar />
        </div>
        <SigninSheet />
      </SigninSheetProvider>
    </SigninSourceProvider>
  );
}

applyFit();
fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  ),
);
