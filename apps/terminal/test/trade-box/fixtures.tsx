// The trade box's buy side on a kit stub (run.mjs): the app's own TradeBox fed through TradeSourceProvider instead of
// the kit and SIGN_HOST. The stub answers the set preview as the kit is to (the ladder sizes, the cents in the largest
// slice), the max buy as the chain's public read is to ($100), and the kit's `buy` with its stages on the page clock:
// signed at 80 ms, sent at 150 ms, filled at 1,100 ms (R5's Landing 0.4s and Filled 1.1s). ?f=refuse refuses the buy
// with quote_check_failed at 300 ms, ?f=notsent with signpage_down and ?f=other with not_allowed; ?f=slow fills at 8 s,
// ?f=notlanded ends not_landed at 3 s, ?f=partial ends part_filled with the kit's count 1 of 2 (?f=partial-nocount: none).
// Every buy request is recorded in window.__calls. ?plant=set returns a set one cent off the amount (a planted fault
// for the run). Test only.
import type { SignpageClientSnapshot, SignpageOutcome, SignpageState, Stage } from "@blindfill/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { centsToDecimal, ladderSplit, parseUsd } from "../../src/screens/trade/model.ts";
import { TradeBox } from "../../src/screens/trade/TradeBox.tsx";
import { TradeSourceProvider } from "../../src/screens/trade/source.tsx";
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

const listeners = new Set<(id: string, stage: Stage) => void>();
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

function Page() {
  return (
    <TradeSourceProvider value={src}>
      <div className="trb-fx">
        <TradeBox chain="solana" token={MINT} symbol="TORCH" initialAmount="25" />
      </div>
    </TradeSourceProvider>
  );
}

const style = document.createElement("style");
style.textContent = `.trb-fx { box-sizing: border-box; width: 400px; margin: 8px 8px 8px auto; }
@media (max-width: 767.98px) { .trb-fx { width: auto; margin: 0; padding: 12px 16px; } }`;
document.head.append(style);

fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Page />
    </StrictMode>,
  ),
);
