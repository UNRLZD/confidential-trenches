// Portfolio and Activity on fixtures (run.mjs): the app's own header, phone header, footer and tab bar around the
// screen, fed through PortfolioSourceProvider instead of the kit and the market data. The numbers are R5's portfolio
// fixture (r5.json, from design/proto/fixtures/data.js at design-lock-r5: real hourly closes, every time shifted to NOW).
// ?f=<fixture> picks the state; every tap the screen hands its mount is recorded in window.__calls. Test only.
import type { Operation, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { heldData } from "../../src/screens/portfolio/held.ts";
import { NO_FILTER } from "../../src/screens/portfolio/model.ts";
import type { PortfolioData, PositionExtra, TokenMarket } from "../../src/screens/portfolio/model.ts";
import { Portfolio, START } from "../../src/screens/portfolio/Portfolio.tsx";
import type { Ui } from "../../src/screens/portfolio/Portfolio.tsx";
import { PortfolioSourceProvider, useHeldReads } from "../../src/screens/portfolio/source.tsx";
import type { PortfolioSource } from "../../src/screens/portfolio/source.tsx";
import { MoveSourceProvider } from "../../src/screens/portfolio/move-source.tsx";
import type { MoveSource } from "../../src/screens/portfolio/move-source.tsx";
import { routeSteps } from "../../src/screens/portfolio/move.ts";
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
  /** The live source's own data (held.ts heldData over the state's ops and positions) with POOL_MARKETS, not R5's. */
  live?: boolean;
  /** The live source's own data from its own held reads (source.tsx useHeldReads, the kit's GET /v1/market/held and
   *  /v1/market/candles), which run.mjs answers as the helper does for exactly the tokens asked: a coin is named only
   *  when the screen asked for it. */
  reads?: boolean;
  /** The signing page has pool.move (true), or answers every dry with this refusal; absent: it has none (the kit
   *  today), so no Move is drawn. */
  move?: true | string;
}
const PX = (usd: number) => ({ price: String(usd * 1e8), expo: -8, published_s: Math.floor(NOW / 1000) - 5, read_ms: NOW - 1000 });
const FOUR: NonNullable<SignpageState["pools"]> = [
  { chain: "solana", asset: "SOL", balance: "2.5", ready: "2", tap_max: "0.5", price: PX(150) },
  { chain: "base", asset: "ETH", balance: "0.25", ready: "0.25", tap_max: "0.05", price: PX(3000) },
  { chain: "robinhood", asset: "ETH", balance: "0.1", ready: "0.1", tap_max: "0.05", price: PX(3000) },
];
const mark = (token: string, m: PositionExtra["mark"]): Partial<PortfolioData> => ({ extra: (c, t) => (t === token ? { ...EXTRA.get(`${c}:${t}`), mark: m } : EXTRA.get(`${c}:${t}`) ?? null) });
const act = (ui: Partial<Ui["act"]> = {}): Partial<Ui> => ({ pane: "activity", act: { filter: NO_FILTER, open: null, ...ui } });

// The owner's two private round trips on Solana mainnet, 12 Nov 05:36-05:40Z (card portfolio-shows-pool-trades), as the
// signing page records them once filled (src/trade-fill.ts: each trade's units and SOL from its own transaction), the
// times moved to end 5 min before NOW; USD at the SOL price of each trade's own block (Pyth's SOL/USD feed write before
// it, trade-fill.ts blockPrice: a sale's as the fill writes it, a buy's standing in for its live one). Its four
// signatures are the real ones.
const ICM = "78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump";
const at = (min: number) => NOW - min * 60_000;
const sol = (hash: string) => [{ chain: "solana" as const, hash }];
const POOL_OPS: Operation[] = [
  { id: "pd", kind: "pool_deposit", chain: "solana", stage: "in_pool", txs: [], created_ms: at(15) } as Operation,
  { id: "pb1", kind: "buy", stage: "filled", txs: sol("5Qn5LtHiu7xb7irPaPTSpcwPoreem1toPSYT3XvVBPDfH42CU3hMWmKP3AMXg3ag3qdoQb3Rnxrfo6dXVGXtvB8Q"), created_ms: at(9), chain: "solana", token: ICM, amount_usd: "0.10002700069283141", units: "16041.923776", pool_amount: "0.001205887" },
  { id: "ps1", kind: "sell", stage: "filled", txs: sol("32CSJ1GSPrJScgPxyF41zuszLjosxgiDbeFWFRM5p7G6DzbxHjeFWihPjqhQqCLobXhkn3aqBD6WxmenAXLu7Kwn"), created_ms: at(7.4), chain: "solana", token: ICM, units: "16041.923776", amount_usd: "0.04768764243129345", pool_amount: "0.000574635" },
  { id: "pb2", kind: "buy", stage: "filled", txs: sol("3sPawpfvAdoYLHa9i5MRKZVv6xEGLCmRXjJTKxEMHpNYqPMSX22QZ6eyLbdyJDNA7T6TTpWWaKamEA1LiAMaDoQr"), created_ms: at(6.3), chain: "solana", token: ICM, amount_usd: "0.0999999427770536", units: "34154.038071", pool_amount: "0.001204552" },
  { id: "ps2", kind: "sell", stage: "filled", txs: sol("3aUiLLSmj1oHFot7bPLp1VewwqHZ1eNsJnTyZvLnDFKyubfqmwK6iCq7AsSXmt497Vjx8o6AxwEbRzxeEjQr52bd"), created_ms: at(5), chain: "solana", token: ICM, units: "34154.038071", amount_usd: "0.09749603193780052", pool_amount: "0.001174666" },
];
const POOL_STATE: Partial<SignpageState> = { vault_balance: "0", positions: [], ops: POOL_OPS, pools: [{ chain: "solana", asset: "SOL", balance: "0.019392", ready: "0.019392", price: PX(83) }] };
const POOL_MARKETS = [{ chain: "solana" as const, token: ICM, symbol: "Icm", name: "Internet cat money", price_usd: "0.00000233314178549" }];

export const FIXTURES: Record<string, Fx> = {
  // card portfolio-counts-money-an-open-buy-holds, the 12 Nov mainnet buy: a $0.01 buy whose one-time wallet holds
  // 0.008478835 SOL beside the coin (its own and its accounts' rent), the pool's 0.030426 SOL at $82.37; Total and
  // Positions count the wallet's, the row reads Bought $0.01
  openbuy: {
    state: {
      ...POOL_STATE,
      pools: [{ chain: "solana", asset: "SOL", balance: "0.030426", ready: "0", tap_max: "0", price: PX(82.37) }],
      ops: [{ id: "ob1", kind: "buy", stage: "filled", txs: sol("4HSwogMa6ru6c61XhXgb1zxisrFaiPWTuWmhRDsxAaW8PwsWDJNHK9ydPq7GjGW28KC2vKiyKarAqKmfxyZANZd3"), created_ms: at(3), chain: "solana", token: ICM, amount_usd: "0.0099999", units: "4286.1", pool_amount: "0.000121043" }],
      positions: [{ chain: "solana", token: ICM, amount: "4286.1", cost: "0.0099999", wallets: ["8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p"], decimals: 6, asset_held: "0.008478835" }],
    },
    live: true,
  },
  // item 7 of card app-faults-seen-on-122: the same open buy from a page that sends no asset_held: nothing held
  "openbuy-noheld": {
    state: {
      ...POOL_STATE,
      pools: [{ chain: "solana", asset: "SOL", balance: "0.030426", ready: "0", tap_max: "0", price: PX(82.37) }],
      positions: [{ chain: "solana", token: ICM, amount: "4286.1", cost: "0.0099999", wallets: ["8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p"], decimals: 6 }],
    },
    live: true,
  },
  // the value line between $2.51 and $3.33 (the owner's four "$3" ticks)
  axis: { data: { series: [[NOW - 6 * 86_400_000, "3.33"], [NOW - 3 * 86_400_000, "3.31"], [NOW - 86_400_000, "3.33"], [NOW - 3_600_000, "2.51"], [NOW, "2.52"]] } },
  // the owner's sequence, done: both round trips on Closed (desktop), in the stats (phone) and in Activity
  pooltrades: { state: POOL_STATE, live: true, ui: { closed: true } },
  // card app-faults-seen-on-126 (the signed-in walk of release 126, 13 Nov 00:41Z: Closed drew "78GaXF", no symbol and
  // no logo): the same two round trips, nothing open, named by the screen's own held read
  "closed-reads": { state: POOL_STATE, reads: true, ui: { closed: true } },
  "pooltrades-stats": { state: POOL_STATE, live: true, ui: { pane: "stats" } },
  "pooltrades-activity": { state: POOL_STATE, live: true, ui: act() },
  // review round: the first round trip as release 118 wrote it and no fill could complete (a buy with its USD only, a
  // sale with its units only: dashes where the record holds nothing), the second as this release writes it
  "pooltrades-mixed": {
    state: {
      ...POOL_STATE,
      ops: POOL_OPS.map((o) => {
        if (o.id === "pb1") return { id: o.id, kind: o.kind, stage: o.stage, txs: o.txs, created_ms: o.created_ms, chain: o.chain, token: o.token, amount_usd: o.amount_usd } as Operation;
        if (o.id === "ps1") return { id: o.id, kind: o.kind, stage: o.stage, txs: o.txs, created_ms: o.created_ms, chain: o.chain, token: o.token, units: o.units } as Operation;
        return o;
      }),
    },
    live: true,
    ui: { closed: true },
  },
  // between the second buy and its sale: its open row, the first round trip closed
  "pooltrades-open": {
    state: { ...POOL_STATE, ops: POOL_OPS.slice(0, 4), positions: [{ chain: "solana", token: ICM, amount: "34154.038071", cost: "0.0999999427770536", wallets: ["8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p"], decimals: 6 }] },
    live: true,
  },
  // review P2-4: the same open row when its buy had no SOL price at the request (no amount_usd; the page's cost "0",
  // unknown): its value, and a dash for bought and PnL, never $0.00 bought and the whole value as profit
  "pooltrades-unknown": {
    state: {
      ...POOL_STATE,
      ops: POOL_OPS.slice(0, 4).map((o) => (o.id === "pb2" ? ({ ...o, amount_usd: undefined } as Operation) : o)),
      positions: [{ chain: "solana", token: ICM, amount: "34154.038071", cost: "0", wallets: ["8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p"], decimals: 6 }],
    },
    live: true,
  },
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
  // the owner's labels (owner 10 Nov 18:12Z): failed buys and sells, each Transaction failed with its reason on hover
  // (Price check failed, Unavailable, none for a code the app has no words for, Not landed); a filled buy has none
  failed: {
    state: {
      ops: [
        { id: "f1", kind: "buy", stage: "refused", code: "quote_check_failed", txs: [], created_ms: NOW - 60_000, chain: "solana", token: "ALPENGLOW", amount_usd: "10" },
        { id: "f2", kind: "buy", stage: "refused", code: "venue_not_pinned", txs: [], created_ms: NOW - 120_000, chain: "solana", token: "ALPENGLOW", amount_usd: "25" },
        { id: "f3", kind: "sell", stage: "refused", code: "not_allowed", txs: [], created_ms: NOW - 180_000, chain: "near", token: "HOOT", units: "4465.8702" },
        { id: "f4", kind: "sell", stage: "not_landed", txs: [], created_ms: NOW - 240_000, chain: "near", token: "HOOT", units: "4465.8702" },
        ...STATE.ops,
      ],
    },
    ui: act(),
  },
  // a price that reads zero is no read: KINU's value is the dash, never $0.00 (owner 10 Nov 18:12Z)
  zeroprice: { data: { market: (c, t) => (t === "KINU" ? { ...MARKET.get(`${c}:${t}`)!, price: "0" } : MARKET.get(`${c}:${t}`) ?? null) } },
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
  "pools-empty": { state: { vault_balance: "0", pools: [] } },
  // one balance (card portfolio-one-balance): the vault alone, the vault and one pool, the vault and all three pools, and
  // a pool deposit in flight on Robinhood; each pool at the page's own price, read 5 s before NOW
  "cash-vault": { state: { pools: [] } },
  "cash-one": { state: { pools: [{ chain: "solana", asset: "SOL", balance: "2.5", ready: "2", tap_max: "0.5", price: PX(150) }] } },
  "cash-four": { state: { pools: FOUR } },
  // card pool-balance-counts-the-remainder: the three pools with money still at each one's deposit wallet U_X
  // (state.deposit_wallets), counted in its pool's one balance and in Cash
  "pools-remainder": {
    state: {
      pools: FOUR,
      deposit_wallets: [
        { chain: "solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", asset: "SOL", amount: "0.0125" },
        { chain: "base", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", asset: "ETH", amount: "0.002" },
        { chain: "robinhood", address: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", asset: "ETH", amount: "0.0003" },
      ],
    },
  },
  "cash-moving": {
    state: {
      pools: [FOUR[0]!, FOUR[1]!, { chain: "robinhood", asset: "ETH", balance: "0", price: PX(3000) }],
      ops: [...STATE.ops, { id: "pd-live", kind: "pool_deposit", chain: "robinhood", stage: "in_transit", txs: [], since_ms: NOW - 40_000 }],
    },
  },
  // card portfolio-moves-money-between-chains: Private balance with Move, and the move sheet on pool.move.dry's and the
  // move op's shapes as kit 1.15 fixed them (wallet card one-balance-buys-on-every-chain, 19:41Z). The owner's own rows
  // (13 Nov 19:39Z shot: NEAR 0 USDC, Solana 0.021049 SOL, Base 0 ETH, Robinhood 0 ETH): a zero row's Move is off, never hidden
  "move-zero": { move: true, state: { vault_balance: "0", positions: [], ops: [], pools: [{ chain: "solana", asset: "SOL", balance: "0.021049", price: PX(150) }, { chain: "base", asset: "ETH", balance: "0", price: PX(3000) }, { chain: "robinhood", asset: "ETH", balance: "0", price: PX(3000) }] } },
  "move-rows": { move: true, state: { pools: FOUR } },
  "move-empty": { move: true, state: { vault_balance: "0", positions: [], ops: [], pools: [] } },
  // the live app today: the kit has no pool.move yet, so no Move is drawn
  "move-off": { state: { pools: FOUR } },
  "move-sheet": { move: true, state: { pools: FOUR }, ui: { move: { from: "solana", to: "near", amount: "0.5", id: null, refused: null } } },
  "move-sheet-xy": { move: true, state: { pools: FOUR }, ui: { move: { from: "solana", to: "base", amount: "0.5", id: null, refused: null } } },
  "move-over": { move: true, state: { pools: FOUR }, ui: { move: { from: "solana", to: "base", amount: "9", id: null, refused: null } } },
  "move-refused": { move: "not_allowed", state: { pools: FOUR }, ui: { move: { from: "base", to: "robinhood", amount: "0.1", id: null, refused: null } } },
  "move-running": { move: true, state: { pools: FOUR, ops: [{ id: "m1", kind: "move", from: "solana", to: "base", stage: "in_vault", txs: [], amount: "0.5" } as unknown as Operation] }, ui: { move: { from: "solana", to: "base", amount: "0.5", id: "m1", refused: null } } },
  "move-done": { move: true, state: { pools: FOUR, ops: [{ id: "m1", kind: "move", from: "solana", to: "base", stage: "done", txs: [], amount: "0.5", out: "0.0241" } as unknown as Operation] }, ui: { move: { from: "solana", to: "base", amount: "0.5", id: "m1", refused: null } } },
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
const src: PortfolioSource = { snapshot, data: fx.live ? heldData(snapshot, POOL_MARKETS, new Map(), NOW) : { ...base, ...fx.data }, now: () => NOW, tzMin: 0, act: (a) => void window.__calls.push(a) };
/** pool.move.dry's recorded answers (kit 1.15 shapes): the least that arrives in To's asset, the fee in From's, and
 *  the steps; every ask and start is recorded in window.__calls. */
const DRY_OUT: Record<string, string> = { near: "71.92", solana: "0.4791", base: "0.0241", robinhood: "0.0241" };
const moveSrc: MoveSource = {
  ships: true,
  dry: async (p) => {
    window.__calls.push({ kind: "move.dry", ...p });
    if (typeof fx.move === "string") return { kind: "refused", code: fx.move };
    return { kind: "ok", value: { out: DRY_OUT[p.to]!, fee: p.from === "near" ? "0.42" : p.from === "solana" ? "0.0021" : "0.00004", steps: routeSteps(p.from, p.to)!, time_estimate_s: p.from === "near" || p.to === "near" ? 38 : 76 } };
  },
  start: (p) => {
    window.__calls.push({ kind: "move", ...p });
    return { id: "m-new", outcome: new Promise(() => {}) };
  },
};
const signin: SigninSource = { snapshot, moneyOn: true, locked: null, hop: async () => null, restore: () => {} };

/** The source with the screen's own held reads (Fx.reads). */
function Reads({ children }: { children: ReactNode }) {
  const { markets, history } = useHeldReads(snapshot.state);
  return <PortfolioSourceProvider value={{ ...src, data: heldData(snapshot, markets, history, NOW) }}>{children}</PortfolioSourceProvider>;
}
const Pf = ({ children }: { children: ReactNode }) => (fx.reads ? <Reads>{children}</Reads> : <PortfolioSourceProvider value={src}>{children}</PortfolioSourceProvider>);
const Source = ({ children }: { children: ReactNode }) => (fx.move ? <MoveSourceProvider value={moveSrc}><Pf>{children}</Pf></MoveSourceProvider> : <Pf>{children}</Pf>);

function App() {
  return (
    <SigninSourceProvider value={signin}>
      <SigninSheetProvider>
        <Source>
          <div className="shell">
            <Header />
            <PhoneHeader />
            <main className="screen" data-route="portfolio">
              <Portfolio initial={{ ...START, ...fx.ui }} />
            </main>
            <Footer read={FOOTER_READ} />
            <TabBar />
          </div>
        </Source>
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
