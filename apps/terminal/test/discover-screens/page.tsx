// Discover on fixtures (run.mjs): the app's own header, phone header, footer and tab bar around S5, fed a fixed 06b
// snapshot (snapshots.ts) instead of the helper. ?f=<fixture> picks the state; Retry is recorded in window.__calls.
// Test only.
import type { SignpageClientSnapshot } from "@blindfill/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Discover } from "../../src/screens/discover/Discover.tsx";
import type { DiscoverData } from "../../src/screens/discover/Discover.tsx";
import { SigninSheet } from "../../src/screens/signin/SigninSheet.tsx";
import { SigninSheetProvider, SigninSourceProvider } from "../../src/screens/signin/source.tsx";
import type { SigninSource } from "../../src/screens/signin/source.tsx";
import { applyFit } from "../../src/shell/fit.ts";
import { fontsReady } from "../../src/shell/fonts.ts";
import { Footer } from "../../src/shell/Footer.tsx";
import { Header, PhoneHeader } from "../../src/shell/Header.tsx";
import { TabBar } from "../../src/shell/TabBar.tsx";
import "../../src/shell/shell.css";
import { edgy, empty, NOW_MS, solana } from "./snapshots.ts";

const FIXTURES: Record<string, DiscoverData> = {
  rows: { status: "ready", snapshot: solana },
  edges: { status: "ready", snapshot: edgy },
  loading: { status: "loading" },
  empty: { status: "ready", snapshot: empty },
  error: { status: "error" },
};

declare global {
  interface Window {
    __calls: unknown[];
  }
}
window.__calls = [];

const f = new URLSearchParams(location.search).get("f") ?? "rows";
const signedIn: SignpageClientSnapshot = {
  status: "ready",
  release: "signpage-v1",
  stale: false,
  state: { release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "73.18", wallets: [], positions: [], orders: [], held: [], ops: [] },
};
const src: SigninSource = { snapshot: signedIn, moneyOn: true, locked: null, hop: async () => null, restore: () => {} };
document.documentElement.dataset.fixture = f;

function App() {
  return (
    <SigninSourceProvider value={src}>
      <SigninSheetProvider>
        <div className="shell">
          <Header />
          <PhoneHeader />
          <main className="screen" data-route="discover">
            <Discover data={FIXTURES[f]!} nowMs={NOW_MS} onRetry={() => void window.__calls.push({ kind: "retry" })} />
          </main>
          <Footer />
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
      <MemoryRouter initialEntries={["/discover"]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  ),
);
