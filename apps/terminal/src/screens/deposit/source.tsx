import type { SignpageClientSnapshot, SignpageResults } from "@blindfill/kit";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useReturnHop } from "../../shell/ReturnHop.tsx";
import type { ReturnHopView } from "../../shell/ReturnHop.tsx";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import type { Asset, DepositStatus, DryQuote, QuoteRefusal } from "./model.ts";

// What the deposit sheet reads and does. Where the kit has the call, the live source makes it: `deposit.quote` (the
// quote SIGN_HOST fetches and checks before any address exists, W:667), the deposit's stage from `state.ops` by that
// request's id, and the hops (withdraw.open with the held id, backup.open). Where the kit has none yet, the live source
// answers "not available", so the sheet shows S4.6 and never a made-up quote: the asset list, the dry quote with its
// limits, and the stages the kit's DepositStage lacks (model.ts DepositStatus). The screen tests pass fixtures through
// DepositSourceProvider, so the same sheet draws every state with no signing page.

export type Reply<T> = { ok: true; value: T } | { ok: false; code: QuoteRefusal };

export interface DepositSource {
  snapshot: SignpageClientSnapshot;
  moneyOn: boolean;
  /** The assets 1Click takes, with their limits; null while loading. Not in the kit yet. */
  assets: Asset[] | null;
  /** The quote lines for an amount, no address. Not in the kit yet. */
  dryQuote(asset: Asset, amount: string): Promise<Reply<DryQuote>>;
  /** The checked quote: kit `deposit.quote`. Returns the request id with the answer, to follow its stage. */
  quote(asset: Asset, amount: string): Promise<{ id: string | null; reply: Reply<SignpageResults["deposit.quote"]> }>;
  /** The deposit's status by the quote request's id; null before the kit reports one. */
  status(id: string): DepositStatus | null;
  hop: ReturnHopView["hop"];
  locked: string | null;
  /**
   * The amount the sheet opens with: a fixture's; null on the live source. Inside SIGN_HOST's shell an open kind draws
   * over the app's frame, which stays, so a typed amount survives the backup gate in the sheet's own state (AE-02).
   */
  start: { amount: string } | null;
  /** Unix ms; a fixture sets its own clock. */
  now(): number;
  /** Copies the address to the clipboard. */
  copy(text: string): void;
}

const Fixture = createContext<DepositSource | null>(null);
export const DepositSourceProvider = Fixture.Provider;

const KNOWN: ReadonlySet<string> = new Set(["below_min", "above_max", "not_available", "busy", "down", "quote_check_failed"]);
const refusal = (code: string): QuoteRefusal => (KNOWN.has(code) ? (code as QuoteRefusal) : "not_available");

const noDryQuote: DepositSource["dryQuote"] = async () => ({ ok: false, code: "not_available" });

export function useDepositSource(): DepositSource {
  const fixture = useContext(Fixture);
  const { client, snapshot, moneyOn } = useSignpage();
  const { hop, locked } = useReturnHop();
  const quote = useCallback<DepositSource["quote"]>(
    async (asset, amount) => {
      if (!client) return { id: null, reply: { ok: false, code: "down" } };
      const h = client.request("deposit.quote", { origin_asset: asset.id, amount });
      const o = await h.outcome;
      return { id: h.id, reply: o.ok ? { ok: true, value: o.result } : { ok: false, code: refusal(o.error.code) } };
    },
    [client],
  );
  const status = useCallback<DepositSource["status"]>(
    (id) => {
      const op = snapshot.state?.ops.find((o) => o.id === id && o.kind === "deposit");
      return op && op.kind === "deposit" ? { stage: op.stage } : null;
    },
    [snapshot],
  );
  const live: DepositSource = {
    snapshot,
    moneyOn,
    assets: [],
    dryQuote: noDryQuote,
    quote,
    status,
    hop,
    locked,
    start: null,
    now: Date.now,
    copy: (t) => void navigator.clipboard?.writeText(t).catch(() => {}),
  };
  return fixture ?? live;
}

/** The clock for the counter and the countdown: one tick a second while a state draws a time, none otherwise. */
export function useNow(src: DepositSource, ticking: boolean): number {
  const clock = src.now;
  const [now, setNow] = useState(() => clock());
  useEffect(() => {
    setNow(clock());
    if (!ticking) return;
    const t = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(t);
  }, [clock, ticking]);
  return now;
}
