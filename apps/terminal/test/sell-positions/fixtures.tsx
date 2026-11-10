// The sell side and Your position on a kit stub (run.mjs): the app's own SellBox and PositionPanel fed through the
// trade box's TradeSourceProvider (the same TradeKit stub as test/trade-box) and SellKitProvider instead of the kit
// and SIGN_HOST. The position row is Portfolio's own (portfolio(), src/screens/portfolio/model.ts) from the kit state's
// position and the market's price. The stub answers the sell preview (the share's value less the 1% fee, $0.02 network)
// and the kit's `buy` with `side: "sell"` with its stages on the page clock: signed at 80 ms, sent at 150 ms, filled at
// 1,100 ms. ?f= picks the position: up (R5's NEARLY numbers: $100 in, $219 now), down, dust (3 base units), noroute,
// refuse (the sell refused with quote_check_failed at 300 ms), nodec (up's position with no decimals read: a percent floors
// at the string's scale plus 4, card app-sell-mount re-check P3; its chain has a pool, so it asks pool.sell), nodec-vault
// (no decimals and no pool: the vault's sell takes whole base units, so the app refuses it and sends nothing, re-check 2
// P3-3), open (a box mounted while the device's record holds a sell at sent: every sell button locked, re-check 2 P2).
// Every position names the token's 6 decimals in the signing page's state (positions[].decimals, kit 1.8), the one
// source a sell is sized from, but the two nodec (a page of an earlier release).
// The stub answers as the signing page does: the vault's `buy` side sell takes whole base units only (trade.ts UNITS),
// pool.sell a share of the whole holding (share_bps 1 to 10,000, which the page turns into units from its own reads,
// floored at the base unit; card pool-sell-share-across-wallets) or an amount with a fraction no longer than the token's
// 6 (rules/pool.ts checkPoolRequest); any other is refused not_allowed at 300 ms (pool-kinds.ts). The trade states (app-trade-box-states), on up's
// position: notsent (signpage_down) and other (not_allowed) refusals, slow (filled at 8 s), notlanded (not_landed at 3 s),
// partial (part_filled, the kit's count 1 of 2) and partial-nocount. Every request is recorded in window.__calls; every Share
// tap in window.__shares. ?pool=sol puts the devnet Solana pool in the state (card trade-box-pool: the 0.01 SOL note of
// scripts/live-checks/signpage-pool-notes.run.json), so the sell goes into the pool (pool.sell). Test only.
import type { SignpageClientSnapshot, SignpageOutcome, SignpageState, Stage } from "@blindfill/kit";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { mulCents, portfolio } from "../../src/screens/portfolio/model.ts";
import type { PortfolioData, TokenMarket } from "../../src/screens/portfolio/model.ts";
import { PositionPanel } from "../../src/screens/positions/PositionPanel.tsx";
import { SellBox } from "../../src/screens/positions/SellBox.tsx";
import { SellKitProvider, useSell } from "../../src/screens/positions/source.tsx";
import type { SellKit } from "../../src/screens/positions/source.tsx";
import { centsToDecimal } from "../../src/screens/trade/model.ts";
import { TradeSourceProvider, useTradeSource } from "../../src/screens/trade/source.tsx";
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

// the position: amount (token units, the kit's string), cost (USD), the market price (USD per unit), the token's decimals
// as the token read gives them (null: none read)
const POS: Record<string, { amount: string; cost: string; price: string; route: boolean; decimals: number | null }> = {
  up: { amount: "1234567.891234", cost: "100", price: "0.000177390", route: true, decimals: 6 },
  refuse: { amount: "1234567.891234", cost: "100", price: "0.000177390", route: true, decimals: 6 },
  down: { amount: "1234567.891234", cost: "100", price: "0.0000729", route: true, decimals: 6 },
  dust: { amount: "0.000003", cost: "0.03", price: "12000", route: true, decimals: 6 },
  noroute: { amount: "1234567.891234", cost: "100", price: "0.000177390", route: false, decimals: 6 },
  nodec: { amount: "1234567.891234", cost: "100", price: "0.000177390", route: true, decimals: null },
  "nodec-vault": { amount: "1234567.891234", cost: "100", price: "0.000177390", route: true, decimals: null },
  open: { amount: "1234567.891234", cost: "100", price: "0.000177390", route: true, decimals: 6 },
};
/** The vault's sell amount, as trade.ts takes it: whole base units. */
const UNITS = /^[1-9]\d{0,19}$/;
/** The token's own decimals, which the signing page reads itself: a longer fraction is refused there. */
const TOKEN_DECIMALS = 6;
const P = POS[f] ?? POS.up!;

const STATE: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "73.18",
  wallets: [],
  positions: [{ chain: "solana", token: MINT, amount: P.amount, cost: P.cost, wallets: ["W1", "W2"], ...(P.decimals === null ? {} : { decimals: P.decimals }) }],
  orders: [],
  held: [],
  // open: the device's record holds a sell at sent that this mount did not start (a remount while it runs)
  ops: f === "open" ? [{ id: "sell-elsewhere", kind: "sell", stage: "sent", txs: [] }] : [],
  ...(q.get("pool") === "sol" || f === "nodec" ? { pools: [{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00173608" }] } : {}),
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
let snapshot: SignpageClientSnapshot = { status: "ready", release: "signpage-v1", state: STATE, stale: false };
let setSnapshot: (s: SignpageClientSnapshot) => void = () => {};
/** A token amount's base units at the token's decimals. */
const unitsOf = (s: string): bigint => BigInt(s.replace(".", "").replace(/^0+(?=\d)/, "")) * 10n ** BigInt(TOKEN_DECIMALS - (s.split(".")[1]?.length ?? 0));
/** `bps` of `amount` as the signing page sells it, floored at the base unit, as a decimal string. */
function shareOf(amount: string, bps: number): string {
  const n = (unitsOf(amount) * BigInt(bps)) / 10_000n;
  const s = n.toString().padStart(TOKEN_DECIMALS + 1, "0");
  return `${s.slice(0, -TOKEN_DECIMALS)}.${s.slice(-TOKEN_DECIMALS)}`.replace(/\.?0+$/, "") || "0";
}
/** The device's record as the signing page keeps it: the sell's op at each stage, and the position less what a fill
 *  sold (all of the ask; half of it, floored to the base unit, on a part fill), in the same state. */
function record(id: string, stage: string, ask: string, pooled: boolean): void {
  const st = snapshot.state!;
  const ops = [...st.ops.filter((o) => o.id !== id), { id, kind: "sell", stage, txs: [] } as SignpageState["ops"][number]];
  let positions = st.positions;
  if (stage === "filled" || stage === "part_filled") {
    const units = (s: string) => BigInt(s.replace(".", "").replace(/^0+(?=\d)/, "")) * 10n ** BigInt(TOKEN_DECIMALS - (s.split(".")[1]?.length ?? 0));
    const sold = pooled ? units(ask) : BigInt(ask);
    positions = positions.map((p) => {
      const left = units(p.amount) - (stage === "filled" ? sold : sold / 2n);
      const s = left.toString().padStart(TOKEN_DECIMALS + 1, "0");
      return { ...p, amount: `${s.slice(0, -TOKEN_DECIMALS)}.${s.slice(-TOKEN_DECIMALS)}`.replace(/\.?0+$/, "") };
    });
  }
  snapshot = { ...snapshot, state: { ...st, ops, positions } };
  setSnapshot(snapshot);
}

const listeners = new Set<(id: string, stage: Stage) => void>();
let n = 0;
const kit: TradeKit = {
  setPreview: null,
  maxBuy: () => "100",
  poolPrice: () => null,
  request: ((kind: string, params: unknown) => {
    const id = `sell-${++n}`;
    window.__calls.push({ kind, params, id });
    const share = (params as { share_bps?: unknown }).share_bps;
    // a share sells its part of the position as the page reads it, floored at the base unit (all of it at 10,000)
    const ask = typeof share === "number" ? shareOf(snapshot.state!.positions.find((p) => p.token === MINT)!.amount, share) : String((params as { amount?: unknown }).amount ?? "");
    const emit = (stage: Stage) => {
      record(id, stage, ask, kind === "pool.sell");
      listeners.forEach((l) => l(id, stage));
    };
    const outcome = new Promise<SignpageOutcome<"buy">>((resolve) => {
      const amount = String((params as { amount?: unknown }).amount ?? "");
      const frac = /\.(\d+)$/.exec(amount)?.[1] ?? "";
      const bad = kind === "pool.sell" ? (typeof share === "number" ? !(Number.isInteger(share) && share >= 1 && share <= 10_000) || ask === "0" : frac.length > TOKEN_DECIMALS) : !UNITS.test(amount);
      const code = bad ? "not_allowed" : { refuse: "quote_check_failed", notsent: "signpage_down", other: "not_allowed" }[f];
      if (code) {
        setTimeout(() => {
          record(id, "refused", ask, kind === "pool.sell");
          resolve({ ok: false, error: { code } });
        }, 300);
        return;
      }
      setTimeout(() => emit("signed"), 80);
      setTimeout(() => {
        emit("sent");
        resolve({ ok: true, result: { stage: "sent", txs: [] } });
      }, 150);
      // slow: still landing past 5 s, filled at 8 s; notlanded: the deadline's re-read at 3 s; partial: 1 of 2 slices
      if (f === "slow") setTimeout(() => emit("filled"), 8_000);
      else if (f === "notlanded") setTimeout(() => emit("not_landed"), 3_000);
      else if (f === "partial" || f === "partial-nocount") setTimeout(() => emit("part_filled"), 1_100);
      else setTimeout(() => emit("filled"), 1_100);
    });
    return { id, outcome };
  }) as TradeKit["request"],
  part: (id) => (f === "partial" && id.startsWith("sell-") ? { filled: 1, of: 2 } : null),
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
/** The screen's clock: the page's own, which the run pauses and moves; ?plant=clock runs it 25% fast from its first read
 * (a planted fault: every time on the button then reads wrong and the run must FAIL). */
let t0 = 0;
const now = q.get("plant") === "clock" ? () => ((t0 ||= Date.now()), t0 + Math.round((Date.now() - t0) * 1.25)) : Date.now;
const src: TradeSource = { snapshot, moneyOn: true, kit, now };

function Column() {
  const [snap, set] = useState(snapshot);
  setSnapshot = set;
  return (
    <TradeSourceProvider value={{ ...src, snapshot: snap }}>
      <SellKitProvider value={sellKit}>
        <Panels />
      </SellKitProvider>
    </TradeSourceProvider>
  );
}

function Panels() {
  // a 100% fill leaves no row (portfolio drops a zero position): the panels go with it
  const row = portfolio(useTradeSource().snapshot, DATA, NOW).rows[0];
  const s = useSell(row?.chain ?? "solana", row?.token ?? MINT, 1000, row?.units ?? null);
  if (!row) return null;
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
      <Column />
    </StrictMode>,
  ),
);
