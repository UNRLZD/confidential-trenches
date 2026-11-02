// The sell side and Your position on a kit stub (run.mjs): the app's own SellBox and PositionPanel fed through the
// trade box's TradeSourceProvider (the same TradeKit stub as test/trade-box) and SellKitProvider instead of the kit
// and SIGN_HOST. The position row is Portfolio's own (portfolio(), src/screens/portfolio/model.ts) from the kit state's
// position and the market's price. The stub answers the sell preview (the share's value less the 1% fee, $0.02 network)
// and the kit's `buy` with `side: "sell"` with its stages on the page clock: signed at 80 ms, sent at 150 ms, filled at
// 1,100 ms. ?f= picks the position: up (R5's NEARLY numbers: $100 in, $219 now), down, dust (3 base units), noroute,
// refuse (the sell refused with quote_check_failed at 300 ms). Every request is recorded in window.__calls; every Share
// tap in window.__shares. Test only.
import type { SignpageClientSnapshot, SignpageOutcome, SignpageState, Stage } from "@blindfill/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mulCents, portfolio } from "../../src/screens/portfolio/model.ts";
import type { PortfolioData, TokenMarket } from "../../src/screens/portfolio/model.ts";
import { PositionPanel } from "../../src/screens/positions/PositionPanel.tsx";
import { SellBox } from "../../src/screens/positions/SellBox.tsx";
import { SellKitProvider, useSell } from "../../src/screens/positions/source.tsx";
import type { SellKit } from "../../src/screens/positions/source.tsx";
import { centsToDecimal } from "../../src/screens/trade/model.ts";
import { TradeSourceProvider } from "../../src/screens/trade/source.tsx";
import type { TradeKit, TradeSource } from "../../src/screens/trade/source.tsx";
import { fontsReady } from "../../src/shell/fonts.ts";
import "../../src/shell/shell.css";

const NOW = Date.parse("2026-11-02T06:00:00Z");
// a mint in Solana's form, kept apart from a `token:` key (gitleaks reads a long id beside that word as a secret)
const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

declare global {
  interface Window {
    __calls: unknown[];
    __shares: number;
  }
}
window.__calls = [];
window.__shares = 0;

const q = new URLSearchParams(location.search);
const f = q.get("f") ?? "up";

// the position: amount (token units, the kit's string), cost (USD), the market price (USD per unit)
const POS: Record<string, { amount: string; cost: string; price: string; route: boolean }> = {
  up: { amount: "1234567.891234", cost: "100", price: "0.000177390", route: true },
  refuse: { amount: "1234567.891234", cost: "100", price: "0.000177390", route: true },
  down: { amount: "1234567.891234", cost: "100", price: "0.0000729", route: true },
  dust: { amount: "0.000003", cost: "0.03", price: "12000", route: true },
  noroute: { amount: "1234567.891234", cost: "100", price: "0.000177390", route: false },
};
const P = POS[f]!;

const STATE: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "73.18",
  wallets: [],
  positions: [{ chain: "solana", token: MINT, amount: P.amount, cost: P.cost, wallets: ["W1", "W2"] }],
  orders: [],
  held: [],
  ops: [],
};
const MARKET: TokenMarket = { symbol: "TORCH", name: "Torch", price: P.price, route: P.route };
const DATA: PortfolioData = {
  market: () => MARKET,
  extra: () => ({ bought: P.cost, sold: "0", realized: "0", opened_at: NOW - 150 * 3_600_000 }),
  closed: [],
  series: [],
  fees: null,
  op: () => null,
  exported: [],
};
const snapshot: SignpageClientSnapshot = { status: "ready", release: "signpage-v1", state: STATE, stale: false };

const listeners = new Set<(id: string, stage: Stage) => void>();
let n = 0;
const kit: TradeKit = {
  setPreview: null,
  maxBuy: () => "100",
  request: ((kind: string, params: unknown) => {
    const id = `sell-${++n}`;
    window.__calls.push({ kind, params, id });
    const emit = (stage: Stage) => listeners.forEach((l) => l(id, stage));
    const outcome = new Promise<SignpageOutcome<"buy">>((resolve) => {
      if (f === "refuse") {
        setTimeout(() => resolve({ ok: false, error: { code: "quote_check_failed" } }), 300);
        return;
      }
      setTimeout(() => emit("signed"), 80);
      setTimeout(() => {
        emit("sent");
        resolve({ ok: true, result: { stage: "sent", txs: [] } });
      }, 150);
      setTimeout(() => emit("filled"), 1_100);
    });
    return { id, outcome };
  }) as TradeKit["request"],
  onProgress: (fn) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
const sellKit: SellKit = {
  sellPreview: async (req) => {
    const gross = mulCents(req.amount, P.price) ?? 0n;
    return { ok: true, preview: { out_usd: centsToDecimal(gross - gross / 100n), fee_bps: 100, network_usd: "0.02", route: "Metis" } };
  },
};
const src: TradeSource = { snapshot, moneyOn: true, kit, now: Date.now };

function Column() {
  const row = portfolio(snapshot, DATA, NOW).rows[0]!;
  const s = useSell(row.chain, row.token);
  return (
    <div className="sp-fx">
      <SellBox row={row} s={s} onBuy={() => {}} />
      <PositionPanel row={row} s={s} now={NOW} onShare={() => void window.__shares++} />
    </div>
  );
}

const style = document.createElement("style");
style.textContent = `.sp-fx { box-sizing: border-box; width: 400px; margin: 8px 8px 8px auto; display: flex; flex-direction: column; gap: 12px; }
@media (max-width: 767.98px) { .sp-fx { width: auto; margin: 0; padding: 12px 16px; } }`;
document.head.append(style);

fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TradeSourceProvider value={src}>
        <SellKitProvider value={sellKit}>
          <Column />
        </SellKitProvider>
      </TradeSourceProvider>
    </StrictMode>,
  ),
);
