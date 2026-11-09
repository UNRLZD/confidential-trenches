// The deposit sheet on fixtures (run.mjs): the app's own DepositSheet fed through DepositSourceProvider instead of the
// kit and SIGN_HOST. ?f=<fixture> picks what each call answers; the sheet opens with the fixture's amount
// (the source's start; inside the shell a typed amount survives the backup gate in the sheet's own state, AE-02). The run fixes the page clock (Playwright page.clock) at NOW, so the
// counter and the countdown read the same in every shot. Every quote, copy and hop is recorded in window.__calls. Test only.
import type { PoolChain, SignpageClientSnapshot, SignpageResults, SignpageState } from "@blindfill/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Asset, DepositStatus, DryQuote, PoolDepositStatus, PoolOpen, QuoteRefusal } from "../../src/screens/deposit/model.ts";
import { DepositSheet } from "../../src/screens/deposit/DepositSheet.tsx";
import { DepositSourceProvider } from "../../src/screens/deposit/source.tsx";
import type { DepositSource, Reply } from "../../src/screens/deposit/source.tsx";
import { applyFit } from "../../src/shell/fit.ts";
import { fontsReady } from "../../src/shell/fonts.ts";
import "../../src/shell/shell.css";

const NOW = Date.parse("2026-11-01T18:00:00Z");
// R5's example (09-design-brief S4: 15 NEAR in, $73.18 out); the address is a 1Click NEAR deposit address shape
const NEAR: Asset = { id: "nep141:wrap.near", chain: "NEAR", symbol: "NEAR", min: "2.1", max_usd: "1000" };
const DRY: DryQuote = { amount_out_usd: "73.18", min_amount_out_usd: "72.45", fee_usd: "0.62", time_estimate_s: 37 };
const CHECKED: SignpageResults["deposit.quote"] = {
  deposit_address: "8b0c4e2f61a94d7cb35e0f1a7d29c6e48f5a3b1d07e9c2a64f8d1b5e3a7c9f20",
  origin_asset: NEAR.id,
  amount_in: "15",
  min_amount_out: "72.45",
  deadline: new Date(NOW + 72 * 3_600_000 - 48_000).toISOString(),
  time_estimate_s: 37,
};
// card deposit-to-pool-pools: Solana's pool answers pool.address (its one-time address U_X, base58), Base's and
// Robinhood's refuse it, as the page does before pool-deposit-follow-evm; the checked quote to U_X is the vault's shape
const U_SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const POOL_ANSWER: SignpageResults["pool.address"] = { chain: "solana", address: U_SOL, asset: "SOL", quote: { ...CHECKED, min_amount_out: "0.4" } };
const SOL_IN_POOL = (ready?: string): Partial<SignpageState> => ({
  pools: [{ chain: "solana", asset: "SOL", balance: "0.41", ...(ready ? { ready } : {}) }],
  ops: [{ id: "p1", kind: "pool_deposit", chain: "solana", stage: "in_pool", txs: [], since_ms: NOW - 40_000 }],
});
const STATE: SignpageState = { release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };

interface Fx {
  amount?: string;
  assets?: Asset[] | null;
  dry?: Reply<DryQuote> | "never";
  quote?: Reply<SignpageResults["deposit.quote"]>;
  status?: DepositStatus | null;
  state?: Partial<SignpageState>;
  /** pool.address with no asset, per chain: true answers the chain's address, else refused. Default: Solana only. */
  pools?: PoolOpen;
  /** Refusals pool.address answers in turn for a chain's opening ask, before `pools` answers it. */
  flaky?: Partial<Record<PoolChain, QuoteRefusal[]>>;
  /** pool.address with the asset and amount. Default: Solana's checked quote. */
  poolQuote?: Reply<SignpageResults["pool.address"]>;
  /** The pool_deposit op under that request's id, on Solana. */
  poolStatus?: PoolDepositStatus | null;
}
const refused = (code: QuoteRefusal) => ({ ok: false as const, code });
const since = (s: number) => NOW - s * 1000;

export const FIXTURES: Record<string, Fx> = {
  loading: { assets: null },
  quoting: { dry: "never" },
  quote: {},
  "below-min": { amount: "1.5" },
  "above-max": { amount: "250", dry: { ok: true, value: { ...DRY, amount_out_usd: "1219.70", min_amount_out_usd: "1207.50" } } },
  "not-available": { dry: refused("not_available") },
  busy: { dry: refused("busy") },
  paused: { dry: refused("down") },
  "quote-refused": { quote: refused("quote_check_failed") },
  "backup-first": { state: { code_saved: false } },
  address: { status: null },
  waiting: { status: { stage: "waiting", since_ms: since(3) } },
  processing: { status: { stage: "in_transit", since_ms: since(12) } },
  "into-vault": { status: { stage: "into_vault", since_ms: since(40) } },
  failed: { status: { stage: "failed", since_ms: since(95) } },
  short: { status: { stage: "short", since_ms: since(61) } },
  deposited: { status: { stage: "done", amount_usd: "73.18" }, state: { vault_balance: "73.18" } },
  refunded: { status: { stage: "refunded", refunded: true, held_id: "u1" } },
  "refund-move": { status: { stage: "refund_move", refunded: true, since_ms: since(8), held_id: "u1" } },
  "refund-done": { status: { stage: "done", refunded: true, amount_usd: "73.18" }, state: { vault_balance: "73.18" } },
  held: { status: { stage: "held", held_id: "u1" } },
  moved: { status: { stage: "held", held_id: "u1", since_ms: since(30), moved_out: true } },
  "held-halted": { status: { stage: "halted", hold: "halted", held_id: "u1" } },
  "held-not-caught-up": { status: { stage: "halted", hold: "not_caught_up", held_id: "u1" } },
  "held-vault-blocked": { status: { stage: "halted", hold: "vault_blocked", held_id: "u1" } },
  expired: { status: { stage: "expired" } },
  // card deposit-to-pool-pools: the Solana tile picked first (run.mjs), its pool_deposit op's stages
  "pools-closed": { pools: {} },
  "pool-quote": {},
  "pool-address": { poolStatus: null },
  "pool-waiting": { poolStatus: { pool: "solana", stage: "waiting", since_ms: since(3) } },
  "pool-processing": { poolStatus: { pool: "solana", stage: "in_transit", since_ms: since(12) } },
  "pool-failed": { poolStatus: { pool: "solana", stage: "failed", since_ms: since(95) } },
  "pool-short": { poolStatus: { pool: "solana", stage: "short", since_ms: since(61) } },
  "pool-refunded": { poolStatus: { pool: "solana", stage: "refunded", since_ms: since(70) } },
  "pool-refund-move": { poolStatus: { pool: "solana", stage: "refund_move", refunded: true, since_ms: since(8) } },
  "pool-in": { poolStatus: { pool: "solana", stage: "in_pool", since_ms: since(40) }, state: SOL_IN_POOL("0.4") },
  "pool-in-proving": { poolStatus: { pool: "solana", stage: "in_pool", since_ms: since(40) }, state: SOL_IN_POOL() },
  "pool-expired": { poolStatus: { pool: "solana", stage: "expired" } },
  "pool-refused": { poolQuote: refused("not_available") },
  // the opening ask answered busy then down, then the address: asked again, Solana fundable; down past the bound: Not available
  "pool-flaky": { flaky: { solana: ["busy", "down"] } },
  "pool-down": { flaky: { solana: ["down", "down", "down", "down", "down", "down"] } },
  "pool-other-chain": { poolQuote: { ok: true, value: { ...POOL_ANSWER, chain: "base", asset: "ETH" } } },
};

declare global {
  interface Window {
    __calls: unknown[];
  }
}
window.__calls = [];

const fx = FIXTURES[new URLSearchParams(location.search).get("f") ?? "quote"]!;
const snapshot: SignpageClientSnapshot = { status: "ready", release: "signpage-v1", state: { ...STATE, ...fx.state }, stale: false };
const src: DepositSource = {
  snapshot,
  moneyOn: true,
  assets: fx.assets === undefined ? [NEAR] : fx.assets,
  assetsRefused: null,
  retryAssets: () => {},
  dryQuote: (asset, amount) => {
    window.__calls.push({ kind: "dry", asset: asset.id, amount });
    return fx.dry === "never" ? new Promise(() => {}) : Promise.resolve(fx.dry ?? { ok: true, value: DRY });
  },
  quote: async (asset, amount) => {
    window.__calls.push({ kind: "deposit.quote", params: { origin_asset: asset.id, amount } });
    return { id: "q1", reply: fx.quote ?? { ok: true, value: CHECKED } };
  },
  status: (id) => (id === "q1" ? (fx.status ?? null) : null),
  poolAddress: async (chain: PoolChain, q) => {
    window.__calls.push({ kind: "pool.address", params: q ? { chain, origin_asset: q.asset.id, amount: q.amount } : { chain } });
    if (q) return { id: "p1", reply: fx.poolQuote ?? { ok: true, value: POOL_ANSWER } };
    const next = fx.flaky?.[chain]?.shift();
    if (next) return { id: `a-${chain}`, reply: refused(next) };
    const open = (fx.pools ?? { solana: true })[chain] === true;
    return { id: `a-${chain}`, reply: open ? { ok: true, value: { chain, address: U_SOL, asset: "SOL" } } : refused("not_available") };
  },
  poolStatus: (id, chain) => (id === "p1" && chain === "solana" ? (fx.poolStatus ?? null) : null),
  hop: async (kind, params, view) => {
    window.__calls.push({ kind, params, view });
    return null;
  },
  locked: null,
  start: { amount: fx.amount ?? "15" },
  now: () => Date.now(),
  copy: (text) => void window.__calls.push({ kind: "copy", text }),
};

applyFit();
fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MemoryRouter initialEntries={["/discover"]}>
        <DepositSourceProvider value={src}>
          <div className="shell">
            <main className="screen" data-route="discover" />
          </div>
          <DepositSheet onClose={() => void window.__calls.push({ kind: "close" })} />
        </DepositSourceProvider>
      </MemoryRouter>
    </StrictMode>,
  ),
);
