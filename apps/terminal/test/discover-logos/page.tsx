// Discover on the helper's mainnet lists as served on 11 Nov 15:20Z (run.mjs; lists-2026-11-11.json, Solana, Base and
// Robinhood merged as the app merges them, data.ts mergeLists; rows cut to those that pass the release word scan), inside
// the app's own header, footer and tab bar, plus one row for each ring-table pad the served rows lack. The rows
// carry `icon` as served (false on every row that day); ?logos=1 sets it true on every row but the first (window.__noLogo), as the
// helper will once it serves GET /v1/logo/{chain}/{token}. Test only.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Discover } from "../../src/screens/discover/Discover.tsx";
import { mergeLists } from "../../src/screens/discover/data.ts";
import { PAD_RING } from "../../src/screens/market/pads.ts";
import type { MarketChain, MarketRow, MarketSnapshot } from "../../src/screens/discover/fields.ts";
import { SigninSheetProvider, SigninSourceProvider } from "../../src/screens/signin/source.tsx";
import type { SigninSource } from "../../src/screens/signin/source.tsx";
import { applyFit } from "../../src/shell/fit.ts";
import { fontsReady } from "../../src/shell/fonts.ts";
import { Footer } from "../../src/shell/Footer.tsx";
import { Header, PhoneHeader } from "../../src/shell/Header.tsx";
import { TabBar } from "../../src/shell/TabBar.tsx";
import "../../src/shell/shell.css";
import read from "./lists-2026-11-11.json";

const logos = new URLSearchParams(location.search).get("logos") === "1";
const row = (vals: unknown[]): MarketRow => Object.fromEntries(read.fields.map((f, i) => [f, vals[i]])) as unknown as MarketRow;
const parts: MarketSnapshot[] = Object.entries(read.chains).map(([chain, c]) => ({
  chain: chain as MarketChain,
  as_of_ms: c.as_of_ms,
  lists: Object.fromEntries(Object.entries(c.lists).map(([k, rows]) => [k, (rows as unknown[][]).map(row)])) as unknown as MarketSnapshot["lists"],
}));
// every pad of the ring table the served rows lack (that day's lists showed ten of eighteen): one more row on its chain,
// a copy of that chain's first served row with the pad's id and its own token id, so each pad's ring is drawn and checked
const EVM_PADS = new Set(["zora", "clanker", "doppler", "flaunch", "virtuals", "pons", "bags", "torch"]);
const served = new Set(parts.flatMap((p) => Object.values(p.lists).flat()).map((r) => r?.launchpad));
for (const pad of Object.keys(PAD_RING).filter((k) => !served.has(k))) {
  const p = parts.find((x) => x.chain === (EVM_PADS.has(pad) ? "base" : "solana"))!;
  const base = p.lists.new[0]!;
  p.lists.new.push({ ...base, token: `${base.token}-${pad}`, launchpad: pad });
}
const merged = mergeLists(parts);
let first: string | null = null;
if (logos)
  for (const rows of Object.values(merged.lists))
    for (const r of rows ?? []) {
      first ??= r.token;
      r.icon = r.token !== first;
    }
(window as unknown as { __noLogo: string | null }).__noLogo = first;
const NOW_MS = Math.max(...parts.map((p) => p.as_of_ms));
const src: SigninSource = { snapshot: { status: "loading" }, moneyOn: true, locked: null, hop: async () => null, restore: () => {} };

applyFit();
fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MemoryRouter initialEntries={["/discover"]}>
        <SigninSourceProvider value={src}>
          <SigninSheetProvider>
            <div className="shell">
              <Header />
              <PhoneHeader />
              <main className="screen" data-route="discover">
                <Discover data={{ status: "ready", snapshot: merged }} nowMs={NOW_MS} onRetry={() => {}} />
              </main>
              <Footer read={async () => ({ height: 224_081_559, ms: 120 })} />
              <TabBar />
            </div>
          </SigninSheetProvider>
        </SigninSourceProvider>
      </MemoryRouter>
    </StrictMode>,
  ),
);
