// Discover on fixtures (run.mjs): the app's own header, phone header, footer and tab bar around S5, fed a fixed 06b
// snapshot (snapshots.ts) instead of the helper. ?f=<fixture> picks the state; Retry is recorded in window.__calls.
// Test only.
import type { SignpageClientSnapshot } from "@blindfill/kit";
import { StrictMode, useEffect, useState } from "react";
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
// the footer's block read, answered here so no request leaves the page: the mainnet read the footer drew on 8 Nov 11:06Z (card app-footer-bar)
const FOOTER_READ = async () => ({ height: 223_607_563, ms: 233 });
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
  // the same lists from a read 2 h old (card app-list-age: the helper serves its last good read, dated, on a 200)
  old: { status: "ready", snapshot: { ...solana, as_of_ms: NOW_MS - 2 * 3_600_000 } },
};

/** A later read of the rows fixture: a new token on top of every column (the newest, the most 1h and 5m volume, the
 *  furthest on its curve), so each column's drawn rows would each move down a slot if they were keyed by token. */
const TOP_TOKEN = "TopNewRow1111111111111111111111111111111111";
const L = solana.lists;
const reordered: DiscoverData = {
  status: "ready",
  snapshot: {
    ...solana,
    lists: {
      new: [{ ...L.new[0]!, token: TOP_TOKEN, symbol: "TOPNEW", created_s: Math.max(...L.new.map((r) => r.created_s ?? 0)) + 1 }, ...L.new],
      trending: [{ ...L.trending_1h![0]!, token: TOP_TOKEN, symbol: "TOPNEW", vol_1h_usd: "999999999.0" }, ...L.trending_1h!],
      trending_1h: [{ ...L.trending_1h![0]!, token: TOP_TOKEN, symbol: "TOPNEW", vol_1h_usd: "999999999.0" }, ...L.trending_1h!],
      trending_5m: [{ ...L.trending_5m![0]!, token: TOP_TOKEN, symbol: "TOPNEW", vol_5m_usd: "999999999.0" }, ...L.trending_5m!],
      graduating: [{ ...L.graduating![0]!, token: TOP_TOKEN, symbol: "TOPNEW", curve_bps: 9950 }, ...L.graduating!],
    },
  },
};

declare global {
  interface Window {
    __calls: unknown[];
    /** Draws the reordered read, as Discover's 12 s refresh would (card app-discover-rows-hold). */
    __reorder?: () => void;
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
  const [data, setData] = useState<DiscoverData>(FIXTURES[f]!);
  useEffect(() => {
    window.__reorder = () => setData(reordered);
  }, []);
  return (
    <SigninSourceProvider value={src}>
      <SigninSheetProvider>
        <div className="shell">
          <Header />
          <PhoneHeader />
          <main className="screen" data-route="discover">
            <Discover data={data} nowMs={NOW_MS} onRetry={() => void window.__calls.push({ kind: "retry" })} />
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
      <MemoryRouter initialEntries={["/discover"]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  ),
);
