import type { PoolChain, SignpageClientSnapshot, SignpageResults } from "@blindfill/kit";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useReturnHop } from "../../shell/ReturnHop.tsx";
import type { ReturnHopView } from "../../shell/ReturnHop.tsx";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import { assetOf, poolStatusFor, statusOf } from "./model.ts";
import type { Asset, DepositStatus, DryQuote, PoolDepositStatus, QuoteRefusal } from "./model.ts";

// What the deposit sheet reads and does, all through the kit's deposit calls (kit-deposit-assets-dry, kit-deposit-calls):
// `deposit.assets` (the assets 1Click takes, each with its minimum and the beta cap) when the sheet opens, `deposit.dry`
// (the quote lines for an amount, no address) as the amount is typed, `deposit.quote` (the quote SIGN_HOST fetches and
// checks before any address exists, W:667), and the deposit's stage and facts from `state.ops` under that request's id;
// for a pool (card deposit-to-pool-pools) `pool.address`: with no asset, whether the page answers the chain at all; with
// the asset and amount, the quote it checks to the pool's one-time address, then the pool_deposit op under that id;
// the hops (withdraw.open with the held id, backup.open) go through the shell's return hop. The screen tests pass
// fixtures through DepositSourceProvider, so the same sheet draws every state with no signing page.

export type Reply<T> = { ok: true; value: T } | { ok: false; code: QuoteRefusal };

export interface DepositSource {
  snapshot: SignpageClientSnapshot;
  moneyOn: boolean;
  /** The assets 1Click takes, with their limits (kit deposit.assets); null while loading or refused. */
  assets: Asset[] | null;
  /** Why deposit.assets was refused; null while it loads or once it answered. */
  assetsRefused: QuoteRefusal | null;
  /** Asks deposit.assets again (Retry after busy). */
  retryAssets(): void;
  /** The quote lines for an amount, no address (kit deposit.dry). */
  dryQuote(asset: Asset, amount: string): Promise<Reply<DryQuote>>;
  /** The checked quote: kit `deposit.quote`. Returns the request id with the answer, to follow its stage. */
  quote(asset: Asset, amount: string): Promise<{ id: string | null; reply: Reply<SignpageResults["deposit.quote"]> }>;
  /** The deposit's status by the quote request's id; null before the kit reports one. */
  status(id: string): DepositStatus | null;
  /**
   * kit `pool.address` for a pool's chain: with no asset, the chain's one-time address alone (nothing sent: whether the
   * page answers the chain); with the asset and amount, the checked quote to it. Returns the request id with the answer.
   */
  poolAddress(chain: PoolChain, quote?: { asset: Asset; amount: string }): Promise<{ id: string | null; reply: Reply<SignpageResults["pool.address"]> }>;
  /** A pool deposit's status by its pool.address request's id, only when the op names `chain`; null before one. */
  poolStatus(id: string, chain: PoolChain): PoolDepositStatus | null;
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

/** The dry quote waits for the typing to pause this long, so one amount typed is one request, not one per key. */
export const DRY_PAUSE_MS = 300;

export function useDepositSource(): DepositSource {
  const fixture = useContext(Fixture);
  const { client, snapshot, moneyOn } = useSignpage();
  const { hop, locked } = useReturnHop();
  const [assets, setAssets] = useState<{ list: Asset[] | null; refused: QuoteRefusal | null }>({ list: null, refused: null });
  const [asks, setAsks] = useState(0);
  // the asset list, asked once the signing page is READY and kept while the sheet is open (a READY again does not draw the
  // skeleton over a list it has); asked again on Retry. The fixture brings its own. An older ask's answer never lands.
  const loaded = assets.list !== null;
  useEffect(() => {
    if (fixture || !client || !moneyOn || loaded) return;
    let live = true;
    void client.request("deposit.assets", {}).outcome.then((o) => {
      if (live) setAssets(o.ok ? { list: o.result.assets.map(assetOf), refused: null } : { list: null, refused: refusal(o.error.code) });
    });
    return () => void (live = false);
  }, [fixture, client, moneyOn, loaded, asks]);
  const typed = useRef(0);
  const dryQuote = useCallback<DepositSource["dryQuote"]>(
    async (asset, amount) => {
      const n = ++typed.current;
      await new Promise((r) => setTimeout(r, DRY_PAUSE_MS));
      // a newer amount came while this one waited: the sheet drops this answer (its own order check), so ask nothing
      if (n !== typed.current) return { ok: false, code: "not_available" };
      if (!client) return { ok: false, code: "down" };
      const o = await client.request("deposit.dry", { origin_asset: asset.id, amount }).outcome;
      return o.ok ? { ok: true, value: o.result } : { ok: false, code: refusal(o.error.code) };
    },
    [client],
  );
  const quote = useCallback<DepositSource["quote"]>(
    async (asset, amount) => {
      if (!client) return { id: null, reply: { ok: false, code: "down" } };
      const h = client.request("deposit.quote", { origin_asset: asset.id, amount });
      const o = await h.outcome;
      return { id: h.id, reply: o.ok ? { ok: true, value: o.result } : { ok: false, code: refusal(o.error.code) } };
    },
    [client],
  );
  const poolAddress = useCallback<DepositSource["poolAddress"]>(
    async (chain, q) => {
      if (!client) return { id: null, reply: { ok: false, code: "down" } };
      const h = client.request("pool.address", q ? { chain, origin_asset: q.asset.id, amount: q.amount } : { chain });
      const o = await h.outcome;
      return { id: h.id, reply: o.ok ? { ok: true, value: o.result } : { ok: false, code: refusal(o.error.code) } };
    },
    [client],
  );
  const poolStatus = useCallback<DepositSource["poolStatus"]>((id, chain) => poolStatusFor(snapshot.state?.ops, id, chain), [snapshot]);
  const status = useCallback<DepositSource["status"]>(
    (id) => {
      const op = snapshot.state?.ops.find((o) => o.id === id);
      return op && op.kind === "deposit" ? statusOf(op) : null;
    },
    [snapshot],
  );
  const live: DepositSource = {
    snapshot,
    moneyOn,
    assets: assets.list,
    assetsRefused: assets.refused,
    retryAssets: () => {
      setAssets({ list: null, refused: null });
      setAsks((n) => n + 1);
    },
    dryQuote,
    quote,
    status,
    poolAddress,
    poolStatus,
    hop,
    locked,
    start: null,
    now: Date.now,
    copy: (t) => void navigator.clipboard?.writeText(t).catch(() => {}),
  };
  return fixture ?? live;
}

/**
 * Whether the one deposit sheet is open. The shell mounts the sheet once (shell/DepositMount.tsx); the header's Deposit,
 * the phone's +, Portfolio's Deposit and the withdraw progress's Deposit open it. Outside the shell nothing opens.
 */
interface SheetView {
  open: boolean;
  setOpen(open: boolean): void;
}

const Sheet = createContext<SheetView>({ open: false, setOpen: () => {} });

export const useDepositSheet = () => useContext(Sheet);

export function DepositSheetProvider({ children, initial = false }: { children: ReactNode; initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return <Sheet.Provider value={{ open, setOpen }}>{children}</Sheet.Provider>;
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
