// The trade box's buy side on a kit stub (run.mjs): the app's own TradeBox fed through TradeSourceProvider instead of
// the kit and SIGN_HOST. The stub answers the set preview as the kit is to (the ladder sizes, the cents in the largest
// slice), the max buy as the chain's public read is to ($100), and the kit's `buy` with its stages on the page clock:
// signed at 80 ms, sent at 150 ms, filled at 1,100 ms (R5's Landing 0.4s and Filled 1.1s). ?f=refuse refuses the buy
// with quote_check_failed at 300 ms, ?f=notsent with signpage_down and ?f=other with not_allowed; ?f=slow fills at 8 s,
// ?f=notlanded ends not_landed at 3 s, ?f=partial ends part_filled with the kit's count 1 of 2 (?f=partial-nocount: none).
// Every buy request is recorded in window.__calls. ?plant=set returns a set one cent off the amount (a planted fault
// for the run). ?pool= puts the chain's pool in the state (card trade-box-pool), from recorded runs: sol-ready and
// sol-making the devnet pool's 0.01 SOL note (scripts/live-checks/signpage-pool-notes.run.json), with the most one tap can
// spend by the kit's own rule (solanaPoolBuyMaxSpend at the worst venue, the 0.001 SOL tip cap, rent 5,080/1:
// 1,736,080 lamports) and SOL at Pyth's 4 Nov 07:40Z read; base-ready the Base Sepolia pool's 0.001 ETH chunks
// (scripts/live-checks/pool-evm-testnet-run.base-sepolia.json), ETH at a planted $3,500.12345678. ?amt= sets the
// amount in the box. ?sheet=1 (card app-phone-trade-sheet) draws the same box in the phone trade sheet with the safety
// grid under it, from the recorded token read (test/token-source/helper-token-2026-11-03.json), behind an open button, as
// the token page's phone bar opens it. Test only.
import type { BuyRoute, SignpageClientSnapshot, SignpageOutcome, SignpageState, Stage } from "@blindfill/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { centsToDecimal, ladderSplit, parseUsd } from "../../src/screens/trade/model.ts";
import { TradeBox } from "../../src/screens/trade/TradeBox.tsx";
import { TradeSheet, useTradeSheet } from "../../src/screens/trade/TradeSheet.tsx";
import { SafetyGrid } from "../../src/screens/trade/SafetyGrid.tsx";
import type { RiskRead } from "../../src/screens/trade/safety.ts";
import type { MarketRow } from "../../src/screens/discover/fields.ts";
import READ from "../token-source/helper-token-2026-11-03.json";
import { TradeSourceProvider } from "../../src/screens/trade/source.tsx";
import { liveRoute } from "../../src/screens/trade/route.ts";
import type { SetPreviewAnswer, TradeKit, TradeSource } from "../../src/screens/trade/source.tsx";
import { fontsReady } from "../../src/shell/fonts.ts";
import "../../src/shell/shell.css";

// R5's example (trenches-1440.html ticket at design-lock-r5: Bal $73.18, a $25 buy); the token and wallets are shapes only
const STATE: SignpageState = { release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "73.18", wallets: [], positions: [], orders: [], held: [], ops: [] };
// a mint in Solana's form, kept apart from a `token:` key (gitleaks reads a long id beside that word as a secret)
const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
/** Tokens per USD cent, in the token's units (6 decimals): about 1.2M tokens for $25. */
const PER_CENT = 480_000_000n;

declare global {
  interface Window {
    __calls: unknown[];
  }
}
window.__calls = [];

const q = new URLSearchParams(location.search);
const f = q.get("f") ?? "ready";
const plant = q.get("plant");
const poolMode = q.get("pool");
type Pool = NonNullable<SignpageState["pools"]>[number];
const POOLS: Record<string, { chain: "solana" | "base"; pools: Pool[] }> = {
  "sol-ready": { chain: "solana", pools: [{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00173608" }] },
  "sol-making": { chain: "solana", pools: [{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0" }] },
  "base-ready": { chain: "base", pools: [{ chain: "base", asset: "ETH", balance: "0.003", ready: "0.003", tap_max: "0.001" }] },
};
const POOL = poolMode ? POOLS[poolMode] : undefined;
if (POOL) STATE.pools = POOL.pools;
const PRICES = { solana: { price: 9_301_048_308n, expo: -8, decimals: 9 }, base: { price: 350_012_345_678n, expo: -8, decimals: 18 } };
/** An EVM token's address for the Base runs (a shape only). */
const EVM_TOKEN = "0x00000000000000000000000000000000000f1fe7";

const listeners = new Set<(id: string, stage: Stage) => void>();
// ?route=1 (card app-buy-route-strip): the signing page's route events for a buy in the kit's shape (BuyRoute, card
// signpage-buy-route-events), through the live source's own seam (source.tsx liveRoute): the buy's wallet and the quote's
// venue and pool 100 ms after the tap, the filled amount with the fill (shapes of the film's still)
const routeFeed = q.get("route") === "1";
const routeListeners = new Set<(id: string, r: BuyRoute) => void>();
const WALLET = "9DJaQ4m2x7Vn8Kp3Rt5Yb1Zc6Hf0LsEw9GdUaBZst6";
const POOL_ADDR = "G19cYh2Wq8Nv4Tp7Kx3Rb5Zm1Dc6Fs0LeAuJgHhTQki";
const SIG = "5".repeat(88);
let n = 0;

const kit: TradeKit = {
  setPreview: async (req) => {
    const amount = parseUsd(req.amount)!;
    const { sizes, rest } = ladderSplit(amount);
    const set = sizes.length ? sizes.map((s, i) => (i === 0 ? s + rest : s)) : [amount];
    if (plant === "set") set[0]! += 1n;
    const out = amount * PER_CENT;
    const answer: SetPreviewAnswer = {
      ok: true,
      preview: {
        slices: set.map((c, i) => ({ wallet: `W${i + 1}`, usd: centsToDecimal(c) })),
        out: `${out / 1_000_000n}.${String(out % 1_000_000n).padStart(6, "0")}`,
        fee_bps: 100,
        fee_usd: centsToDecimal(amount / 100n),
        network_usd: "0.02",
        route: "Metis",
      },
    };
    return answer;
  },
  maxBuy: () => "100",
  poolPrice: (chain) => (POOL && chain === POOL.chain ? PRICES[POOL.chain] : null),
  request: ((kind: string, params: unknown) => {
    const id = `buy-${++n}`;
    window.__calls.push({ kind, params, id });
    const emit = (stage: Stage) => listeners.forEach((l) => l(id, stage));
    const outcome = new Promise<SignpageOutcome<"buy">>((resolve) => {
      const code = { refuse: "quote_check_failed", notsent: "signpage_down", other: "not_allowed" }[f];
      if (code) {
        setTimeout(() => resolve({ ok: false, error: { code } }), 300);
        return;
      }
      const feed = (r: BuyRoute) => routeListeners.forEach((l) => l(id, r));
      if (routeFeed) {
        setTimeout(() => feed({ wallet: WALLET }), 100);
        setTimeout(() => feed({ venue: "pump-curve", pool: POOL_ADDR }), 100);
      }
      setTimeout(() => emit("signed"), 80);
      setTimeout(() => {
        emit("sent");
        resolve({ ok: true, result: { stage: "sent", txs: routeFeed ? [{ chain: "solana", hash: SIG }] : [] } });
      }, 150);
      if (routeFeed) setTimeout(() => feed({ out: "10600" }), 1_099);
      // slow: still landing past 5 s, filled at 8 s; notlanded: the deadline's re-read at 3 s; partial: 1 of 2 slices
      if (f === "slow") setTimeout(() => emit("filled"), 8_000);
      else if (f === "notlanded") setTimeout(() => emit("not_landed"), 3_000);
      else if (f === "partial" || f === "partial-nocount") setTimeout(() => emit("part_filled"), 1_100);
      else setTimeout(() => emit("filled"), 1_100);
    });
    return { id, outcome };
  }) as TradeKit["request"],
  route: routeFeed
    ? liveRoute((fn) => {
        routeListeners.add(fn);
        return () => void routeListeners.delete(fn);
      })
    : null,
  part: (id) => (f === "partial" && id.startsWith("buy-") ? { filled: 1, of: 2 } : null),
  onProgress: (fn) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

const snapshot: SignpageClientSnapshot = { status: "ready", release: "signpage-v1", state: STATE, stale: false };
/** The screen's clock: the page's own, which the run pauses and moves; ?plant=clock runs it 25% fast from its first read
 * (a planted fault: every time on the button then reads wrong and the run must FAIL). */
let t0 = 0;
const now = q.get("plant") === "clock" ? () => ((t0 ||= Date.now()), t0 + Math.round((Date.now() - t0) * 1.25)) : Date.now;
const src: TradeSource = { snapshot, moneyOn: true, kit, now };

/** The recorded token read's row and risk, for the safety grid under the box in the sheet. */
const ROW = Object.fromEntries(READ.fields.map((k, i) => [k, READ.row[i]])) as unknown as MarketRow;
const RISK = READ.rest.risk as unknown as RiskRead;

function SheetPage() {
  const sheet = useTradeSheet();
  return (
    <TradeSourceProvider value={src}>
      <button type="button" className="trb-fxopen" data-testid="open-sheet" onClick={sheet.open}>Open</button>
      <TradeSheet state={sheet.state} onClose={sheet.close} label="Buy TORCH" closeLabel="Close" head={<div className="trb-fxhead">TORCH</div>}>
        <TradeBox chain="solana" token={MINT} symbol="TORCH" initialAmount={q.get("amt") ?? "25"} footer={<SafetyGrid row={ROW} risk={RISK} nowMs={Date.now()} filling={false} />} />
      </TradeSheet>
    </TradeSourceProvider>
  );
}

function Page() {
  if (q.get("sheet") === "1") return <SheetPage />;
  return (
    <TradeSourceProvider value={src}>
      <div className="trb-fx">
        <TradeBox chain={POOL?.chain ?? "solana"} token={POOL?.chain === "base" ? EVM_TOKEN : MINT} symbol="TORCH" initialAmount={q.get("amt") ?? "25"} />
      </div>
    </TradeSourceProvider>
  );
}

const style = document.createElement("style");
style.textContent = `.trb-fx { box-sizing: border-box; width: 400px; margin: 8px 8px 8px auto; }
@media (max-width: 767.98px) { .trb-fx { width: auto; margin: 0; padding: 12px 16px; } }
.trb-fxopen { display: block; width: calc(100% - 32px); height: 50px; margin: 16px; border: 0; border-radius: 14px; background: #50e397; color: #04140b; font: 600 16px var(--font-ui); }
.trb-fxhead { padding: 0 16px 8px; font-size: 18px; font-weight: 600; }`;
document.head.append(style);

fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Page />
    </StrictMode>,
  ),
);
