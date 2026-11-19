// The live numbers held still (card app-legend-holds-still), on fixtures (run.mjs): the chart's own Legend over a plot
// of the desktop's and the phone's size, and the desktop's own Footer over a stand-in signing page client. run.mjs
// drives them with window.__fx: the legend's bars, its crosshair bar and its unit, the footer's SOL and ETH prices, and
// the token page's own About (LowerPanel.tsx About, drawn from the first paint), each through values of every length,
// and reads every layout shift. Test only.
import type { SignpageClient, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Bar } from "../../src/screens/token/candles.ts";
import { pricePrecision } from "../../src/screens/token/candles.ts";
import { Legend } from "../../src/screens/token/TokenPage.tsx";
import type { MarketRow } from "../../src/screens/discover/fields.ts";
import { About } from "../../src/screens/token/LowerPanel.tsx";
import { Row } from "../../src/screens/token/Rail.tsx";
import type { Tape } from "../../src/screens/token/trades.ts";
import type { ChartUnit } from "../../src/screens/token/units.ts";
import { RunLabel } from "../../src/screens/trade/States.tsx";
import "../../src/screens/trade/trade.css";
import { Footer } from "../../src/shell/Footer.tsx";
import { fontsReady } from "../../src/shell/fonts.ts";
import { SignpageFrame } from "../../src/shell/signpage-frame.tsx";
import "../../src/shell/shell.css";

interface Fx {
  bars: Bar[];
  /** The bar under the crosshair, by index; null: the newest. */
  at: number | null;
  unit: ChartUnit;
  /** The pools' USD prices the footer draws (8 decimals, as a feed's price and expo). */
  sol: number;
  eth: number;
  /** The trade box's clock: its Slow counter runs from a tap at 0. */
  now: number;
  /** The desktop rail's rows (Rail.tsx Row, one slot each, keyed by slot as the rail keys them): MC and 24h change. */
  rail: { mc: string; chg: number }[];
  /** About's row fields: the change windows, the 5m tiles, liquidity and 24h volume, the flows' counts. */
  about: Partial<MarketRow>;
}

let fx: Fx = { bars: [], at: null, unit: { mc: false, quote: false }, sol: 151.23, eth: 3456, now: 6_000, rail: [], about: {} };
const subs = new Set<() => void>();
const store = {
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  get: () => fx,
};

const STATE: SignpageState = { release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const pool = (chain: "solana" | "base", asset: "SOL" | "ETH", usd: number) => {
  const now = Date.now();
  return { chain, asset, balance: "1", price: { price: String(Math.round(usd * 1e8)), expo: -8, published_s: Math.floor(now / 1000), read_ms: now } };
};
const snap = (): SignpageClientSnapshot => ({ status: "ready", release: "signpage-v1", stale: false, state: { ...STATE, pools: [pool("solana", "SOL", fx.sol), pool("base", "ETH", fx.eth)] } as SignpageState });
let current = snap();
const listeners = new Set<(s: SignpageClientSnapshot) => void>();
const client = {
  snapshot: () => current,
  subscribe: (f: (s: SignpageClientSnapshot) => void) => (listeners.add(f), () => void listeners.delete(f)),
  retry: () => undefined,
} as unknown as SignpageClient;

declare global {
  interface Window {
    __fx: (p: Partial<Fx>) => void;
  }
}
window.__fx = (p) => {
  fx = { ...fx, ...p };
  for (const f of subs) f();
  if ("sol" in p || "eth" in p) {
    current = snap();
    for (const f of listeners) f(current);
  }
};

const phone = matchMedia("(max-width: 767.98px)").matches;

function Plot() {
  const s = useSyncExternalStore(store.subscribe, store.get);
  if (s.bars.length === 0) return null;
  const at = s.at === null ? null : s.bars[s.at]!;
  return <Legend sym="PEPE" tf="15m" bars={s.bars} at={at} precision={pricePrecision(s.bars)} unit={s.unit} phone={phone} />;
}

function Cta() {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return (
    <div className="trb" style={{ width: 358 }}>
      <button type="button" className="trb-cta" data-kind="live" data-testid="cta">
        <RunLabel phase={{ k: "landing", id: "t1", at: 0 }} now={s.now} />
      </button>
    </div>
  );
}

const seen = new Map<string, number>();
const railRow = (i: number, mc: string, chg: number): MarketRow => ({ chain: "solana", token: `T${i}`, symbol: `TK${i}`, name: "", icon: false, price_usd: "0.0012", mc_usd: mc, chg_24h_bps: chg, src: "fixture", as_of_ms: 0, launchpad: null });

function Rail() {
  const s = useSyncExternalStore(store.subscribe, store.get);
  if (phone || s.rail.length === 0) return null;
  return (
    <aside className="tkr" data-testid="token-rail" data-slim="false" style={{ width: 340 }}>
      <div className="tkr-rows" role="list">
        {s.rail.map((x, i) => <Row key={i} r={railRow(i, x.mc, x.chg)} nowMs={0} sel={false} seen={seen} />)}
      </div>
    </aside>
  );
}

// no trades list: About draws the row's own numbers, as before the page's list lands
const NO_TAPE: Tape = { trades: [], status: "none" };
const aboutRow = (p: Partial<MarketRow>): MarketRow => ({ chain: "solana", token: "AB", symbol: "ABOUT", name: "", icon: false, price_usd: "0.0012", mc_usd: "1000", src: "fixture", as_of_ms: 0, launchpad: null, ...p });

function AboutPanel() {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return (
    <div style={phone ? undefined : { width: 440 }}>
      <About row={aboutRow(s.about)} tape={NO_TAPE} />
    </div>
  );
}

function App() {
  return (
    <SignpageFrame client={client}>
      <div className="shell">
        <main className="screen" data-route="token">
          <div className="tkp-chart" style={{ height: 420 }}>
            <div className="tkp-plot" data-drawn="true">
              <Plot />
            </div>
          </div>
          <Rail />
          <Cta />
          <AboutPanel />
        </main>
        <Footer read={async () => ({ height: 223_607_563, ms: 233 })} />
      </div>
    </SignpageFrame>
  );
}

fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  ),
);
