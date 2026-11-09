// Portfolio and Activity on fixtures (run.mjs): the app's own header, phone header, footer and tab bar around the
// screen, fed through PortfolioSourceProvider instead of the kit and the market data. The numbers are R5's portfolio
// fixture (r5.json, from design/proto/fixtures/data.js at design-lock-r5: real hourly closes, every time shifted to NOW).
// ?f=<fixture> picks the state; every tap the screen hands its mount is recorded in window.__calls. Test only.
import type { Operation, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { NO_FILTER } from "../../src/screens/portfolio/model.ts";
import type { PortfolioData, PositionExtra, TokenMarket } from "../../src/screens/portfolio/model.ts";
import { Portfolio, START } from "../../src/screens/portfolio/Portfolio.tsx";
import type { Ui } from "../../src/screens/portfolio/Portfolio.tsx";
import { PortfolioSourceProvider } from "../../src/screens/portfolio/source.tsx";
import type { PortfolioSource } from "../../src/screens/portfolio/source.tsx";
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
import R5 from "./r5.json";

export const NOW = Date.parse("2026-11-02T03:00:00Z");

type Pos = (typeof R5.open)[number];
type Act = (typeof R5.activity)[number];
/** An R5 Activity row as the signing page sends its op (card kit-portfolio-reads, kit OpDetail): every op its time; a
 *  deposit its USD at done; a buy its chain, token and USD spend (trade.ts); a sell its chain, token and units
 *  (pool-sell.ts). Nothing the page does not send. */
const opOf = (a: Act): Operation => {
  const txs = [{ chain: (a.chain ?? "near") as "near", hash: `${a.id}Hx9QxkTn3d2bYpW8LhF4cVzR7mKe1sJ6uA5gN0oPiHq` }];
  if (a.kind === "deposit") return { id: a.id, kind: "deposit", stage: "done", txs, created_ms: a.at, amount_usd: a.usd };
  const trade = { id: a.id, kind: a.kind as "buy" | "sell", stage: "filled" as const, txs, created_ms: a.at, chain: a.chain as "near", token: a.token };
  return a.kind === "buy" ? { ...trade, amount_usd: a.usd } : { ...trade, units: a.units };
};
const STATE: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: R5.cash,
  wallets: [],
  positions: R5.open.map((p) => ({ chain: p.chain as Pos["chain"] & SignpageState["positions"][number]["chain"], token: p.token, amount: p.amount, cost: p.cost, wallets: [`${p.token}-w1`] })),
  orders: [],
  held: [],
  ops: R5.activity.map(opOf),
};
const MARKET = new Map<string, TokenMarket>(R5.open.map((p) => [`${p.chain}:${p.token}`, { symbol: p.symbol, name: p.name, price: p.price, route: true }]));
for (const c of R5.closed) if (!MARKET.has(`${c.chain}:${c.token}`)) MARKET.set(`${c.chain}:${c.token}`, { symbol: c.symbol, name: c.name, price: null, route: true });
const EXTRA = new Map<string, PositionExtra>(R5.open.map((p) => [`${p.chain}:${p.token}`, { bought: p.cost, realized: p.realized, opened_at: p.opened_at, exit: p.exit ? { tp_bps: 10000, sl_bps: 3000 } : undefined }]));

const base: PortfolioData = {
  market: (c, t) => MARKET.get(`${c}:${t}`) ?? null,
  extra: (c, t) => EXTRA.get(`${c}:${t}`) ?? null,
  closed: R5.closed.map((c) => ({ chain: c.chain as "near", token: c.token, bought: c.bought, sold: c.sold, opened_at: c.opened_at, closed_at: c.closed_at })),
  series: R5.series as [number, string][],
  fees: "4.37",
  exported: [],
};

interface Fx {
  snap?: Partial<SignpageClientSnapshot>;
  state?: Partial<SignpageState>;
  data?: Partial<PortfolioData>;
  ui?: Partial<Ui>;
}
const PX = (usd: number) => ({ price: String(usd * 1e8), expo: -8, published_s: Math.floor(NOW / 1000) - 5, read_ms: NOW - 1000 });
const FOUR: NonNullable<SignpageState["pools"]> = [
  { chain: "solana", asset: "SOL", balance: "2.5", ready: "2", tap_max: "0.5", price: PX(150) },
  { chain: "base", asset: "ETH", balance: "0.25", ready: "0.25", tap_max: "0.05", price: PX(3000) },
  { chain: "robinhood", asset: "ETH", balance: "0.1", ready: "0.1", tap_max: "0.05", price: PX(3000) },
];
const mark = (token: string, m: PositionExtra["mark"]): Partial<PortfolioData> => ({ extra: (c, t) => (t === token ? { ...EXTRA.get(`${c}:${t}`), mark: m } : EXTRA.get(`${c}:${t}`) ?? null) });
const act = (ui: Partial<Ui["act"]> = {}): Partial<Ui> => ({ pane: "activity", act: { filter: NO_FILTER, open: null, ...ui } });

export const FIXTURES: Record<string, Fx> = {
  rows: {},
  loading: { snap: { status: "connecting", state: null } },
  empty: { state: { positions: [], ops: [] }, data: { closed: [], series: [], fees: null } },
  partial: { data: { market: (c, t) => (t === "KINU" ? { ...MARKET.get(`${c}:${t}`)!, price: null } : MARKET.get(`${c}:${t}`) ?? null) } },
  offline: { snap: { status: "down", stale: true } },
  noroute: { data: { market: (c, t) => (t === "SWORDCAT" ? { ...MARKET.get(`${c}:${t}`)!, route: false } : MARKET.get(`${c}:${t}`) ?? null) } },
  reverted: { data: mark("ALPENGLOW", "reverted") },
  held: { data: mark("HOODL", "held") },
  closed: { ui: { closed: true } },
  search: { ui: { q: "r", hideSmall: true } },
  selling: {
    state: { ops: [...STATE.ops, { id: "sell-live", kind: "sell", stage: "sent", txs: [], created_ms: NOW - 500, chain: "near", token: "WTH", units: "891485.96" }] },
  },
  sheet: { ui: { sheet: "near:NEARLY" } },
  notrades: { data: { closed: [], fees: null } },
  activity: { ui: act() },
  "activity-empty": { state: { ops: [] }, ui: act() },
  restored: {
    state: { ops: [{ id: "rs", kind: "restore", stage: "done", txs: [] }, ...STATE.ops.filter((o) => o.kind === "buy" || o.kind === "sell")] },
    ui: act(),
  },
  exported: { data: { exported: [{ id: "xk1", at: NOW - 3_600_000, chain: "near", token: "WTH", address: "5Ftu…k9Wq" }] }, ui: act() },
  filtered: { ui: act({ filter: { kinds: ["buy"], min: 2000n, q: "" } }) },
  receipt: { ui: act({ open: "op1" }) },
  // the pools (card balances-per-chain): rows with ready, rows while no proof queue runs (dashes), none held
  pools: { state: { pools: [{ chain: "solana", asset: "SOL", balance: "1250000.5", ready: "999999.99" }, { chain: "base", asset: "ETH", balance: "0.25", ready: "0.2" }, { chain: "robinhood", asset: "ETH", balance: "0", ready: "0" }] } },
  "pools-noready": { state: { pools: [{ chain: "solana", asset: "SOL", balance: "12.5" }, { chain: "base", asset: "ETH", balance: "0.001" }] } },
  "pools-empty": { state: { pools: [] } },
  // one balance (card portfolio-one-balance): the vault alone, the vault and one pool, the vault and all three pools, and
  // a pool deposit in flight on Robinhood; each pool at the page's own price, read 5 s before NOW
  "cash-vault": { state: { pools: [] } },
  "cash-one": { state: { pools: [{ chain: "solana", asset: "SOL", balance: "2.5", ready: "2", tap_max: "0.5", price: PX(150) }] } },
  "cash-four": { state: { pools: FOUR } },
  "cash-moving": {
    state: {
      pools: [FOUR[0]!, FOUR[1]!, { chain: "robinhood", asset: "ETH", balance: "0", price: PX(3000) }],
      ops: [...STATE.ops, { id: "pd-live", kind: "pool_deposit", chain: "robinhood", stage: "in_transit", txs: [], since_ms: NOW - 40_000 }],
    },
  },
};

declare global {
  interface Window {
    __calls: unknown[];
  }
}
window.__calls = [];

const f = new URLSearchParams(location.search).get("f") ?? "rows";
const fx = FIXTURES[f]!;
document.documentElement.dataset.fixture = f;
const state: SignpageState | null = fx.snap && "state" in fx.snap ? (fx.snap.state ?? null) : { ...STATE, ...fx.state };
const snapshot: SignpageClientSnapshot = { status: "ready", release: "signpage-v1", stale: false, ...fx.snap, state };
const src: PortfolioSource = { snapshot, data: { ...base, ...fx.data }, now: () => NOW, tzMin: 0, act: (a) => void window.__calls.push(a) };
const signin: SigninSource = { snapshot, moneyOn: true, locked: null, hop: async () => null, restore: () => {} };

function App() {
  return (
    <SigninSourceProvider value={signin}>
      <SigninSheetProvider>
        <PortfolioSourceProvider value={src}>
          <div className="shell">
            <Header />
            <PhoneHeader />
            <main className="screen" data-route="portfolio">
              <Portfolio initial={{ ...START, ...fx.ui }} />
            </main>
            <Footer read={FOOTER_READ} />
            <TabBar />
          </div>
        </PortfolioSourceProvider>
        <SigninSheet />
      </SigninSheetProvider>
    </SigninSourceProvider>
  );
}

applyFit();
fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MemoryRouter initialEntries={["/portfolio"]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  ),
);
