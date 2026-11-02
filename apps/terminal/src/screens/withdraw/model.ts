// The withdraw progress on APP_HOST (A1.7, app.md:1440; J6, app.md:371-399): S12.11 Sending, S12.12 Processing with its
// counter, S12.14 Sent and S12.15 Refunded, plus the kit's `stopped` (CH-123: the deadline passed, nothing moved). The
// form, the address and the amount live on SIGN_HOST's own screen, opened by `withdraw.open` in its shell's layer over
// the app's frame (app.md:211-219); the app never takes or passes an address (W:924-925). When the layer closes there is
// no return and no record: the app reads the withdrawal from the signing page's `state.ops`, whose events reach the
// frame while the layer is open, and draws it here. Every state comes from a kit stage; no timer makes one.
//
// Which withdrawals the app draws: one running at the session's first state (a reload mid-way), and any that first shows
// up after it, whatever its stage, so one whose run the app missed while the signing page was down still ends on its
// outcome. One already finished at the first state is old and never drawn. Done or the close drops one for the session.
import type { Operation, TxRef, WithdrawStage } from "@blindfill/kit";

export type WithdrawView = "S12.11" | "S12.12" | "S12.14" | "S12.15" | "stopped";

/** The kit's WithdrawStage (messages.ts) to the state drawn. */
export const STAGE_VIEW = {
  proving: "S12.11",
  submitted: "S12.11",
  in_transit: "S12.12",
  sent: "S12.14",
  refunded: "S12.15",
  stopped: "stopped",
} as const satisfies Record<WithdrawStage, WithdrawView>;

const FINAL: ReadonlySet<WithdrawStage> = new Set(["sent", "refunded", "stopped"]);

export type WithdrawOp = Extract<Operation, { kind: "withdraw" }>;

/** What the app keeps about withdrawals, in memory for the session. */
export interface Watch {
  /** The finished withdrawals at the session's first state: old, never drawn. Null before the first state. */
  old: readonly string[] | null;
  /** The withdrawals followed, by id, with the app's clock when it first saw each: the counter's zero. In order seen. */
  seen: readonly (readonly [string, number])[];
  /** Dropped by Done or the close. */
  closed: readonly string[];
}

export const EMPTY: Watch = { old: null, seen: [], closed: [] };

const withdrawals = (ops: readonly Operation[] | null | undefined): WithdrawOp[] => (ops ?? []).filter((o): o is WithdrawOp => o.kind === "withdraw");

/** The watch after a state from the signing page (null: none known). The same object when nothing changed. */
export function observe(w: Watch, ops: readonly Operation[] | null | undefined, now: number): Watch {
  if (!ops) return w;
  const ws = withdrawals(ops);
  const old = w.old ?? ws.filter((o) => FINAL.has(o.stage)).map((o) => o.id);
  const fresh = ws.filter((o) => !old.includes(o.id) && !w.seen.some(([id]) => id === o.id));
  if (w.old !== null && fresh.length === 0) return w;
  return { ...w, old, seen: [...w.seen, ...fresh.map((o) => [o.id, now] as const)] };
}

/** Drops a withdrawal for the session (Done, or the close). */
export function close(w: Watch, id: string): Watch {
  return w.closed.includes(id) ? w : { ...w, closed: [...w.closed, id] };
}

export interface Shown {
  op: WithdrawOp;
  view: WithdrawView;
  /** S12.12's whole seconds since the app first saw it; null in every other state. */
  counter: number | null;
}

/** The withdrawal drawn now: the first one followed, not closed, still in the state. Null: nothing to draw. */
export function current(w: Watch, ops: readonly Operation[] | null | undefined, now: number): Shown | null {
  const ws = withdrawals(ops);
  for (const [id, since] of w.seen) {
    const op = ws.find((o) => o.id === id);
    if (!op || w.closed.includes(id)) continue;
    const view = STAGE_VIEW[op.stage];
    return { op, view, counter: view === "S12.12" ? Math.max(0, Math.floor((now - since) / 1000)) : null };
  }
  return null;
}

/** Each chain's explorer, as scripts/perf-table.mjs:40-43 links a tx. */
const EXPLORER: Record<TxRef["chain"], string> = {
  solana: "https://solscan.io/tx/",
  base: "https://basescan.org/tx/",
  robinhood: "https://robinhoodchain.blockscout.com/tx/",
  near: "https://nearblocks.io/txns/",
};

/** The tx link: the withdrawal's last tx (the payout), opened only when tapped. Null with no tx. */
export function txLink(txs: readonly TxRef[]): string | null {
  const t = txs.at(-1);
  return t ? EXPLORER[t.chain] + encodeURIComponent(t.hash) : null;
}
