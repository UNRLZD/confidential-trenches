// The deposit sheet on fixtures (run.mjs): the app's own DepositSheet fed through DepositSourceProvider instead of the
// kit and SIGN_HOST. ?f=<fixture> picks what each call answers; the sheet opens with the fixture's amount
// (the source's start; inside the shell a typed amount survives the backup gate in the sheet's own state, AE-02). The run fixes the page clock (Playwright page.clock) at NOW, so the
// counter and the countdown read the same in every shot. Every quote, copy and hop is recorded in window.__calls. Test only.
import type { SignpageClientSnapshot, SignpageResults, SignpageState } from "@blindfill/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Asset, DepositStatus, DryQuote, QuoteRefusal } from "../../src/screens/deposit/model.ts";
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
const STATE: SignpageState = { release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };

interface Fx {
  amount?: string;
  assets?: Asset[] | null;
  dry?: Reply<DryQuote> | "never";
  quote?: Reply<SignpageResults["deposit.quote"]>;
  status?: DepositStatus | null;
  state?: Partial<SignpageState>;
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
  "held-halted": { status: { stage: "halted", hold: "halted", held_id: "u1" } },
  "held-not-caught-up": { status: { stage: "halted", hold: "not_caught_up", held_id: "u1" } },
  "held-vault-blocked": { status: { stage: "halted", hold: "vault_blocked", held_id: "u1" } },
  expired: { status: { stage: "expired" } },
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
  dryQuote: (asset, amount) => {
    window.__calls.push({ kind: "dry", asset: asset.id, amount });
    return fx.dry === "never" ? new Promise(() => {}) : Promise.resolve(fx.dry ?? { ok: true, value: DRY });
  },
  quote: async (asset, amount) => {
    window.__calls.push({ kind: "deposit.quote", params: { origin_asset: asset.id, amount } });
    return { id: "q1", reply: fx.quote ?? { ok: true, value: CHECKED } };
  },
  status: (id) => (id === "q1" ? (fx.status ?? null) : null),
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
