import type { SignpageState } from "@blindfill/kit";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HopView } from "../../shell/return-hop.ts";
import { chainOf } from "../market/pads.ts";
import { HopLine } from "../signin/HopLine.tsx";
import { pickRunner, withdrawPlaces } from "./target.ts";
import type { WithdrawPlace } from "./target.ts";
import { checkWithdraw, withdrawHop } from "./withdraw-form.ts";
import type { FormCheck } from "./withdraw-form.ts";
import { WORDS } from "./words.ts";

// The deposit sheet's Withdraw segment (card withdraw-address-in-the-app, owner 14 Nov 12:22Z picked A): in the same
// sheet as Deposit, switched in place. The places that hold money as tiles (each its chain's mark and name), the Amount
// with Max (the place's balance) and the Address typed here, then Withdraw hands both to SIGN_HOST (withdraw-form.ts
// withdrawHop), whose Confirm sheet shows them over the dimmed app; the sheet closes on the shell's ok and the withdraw
// progress draws the run. The words are the picked mock's (Amount, Max, Address, Withdraw); a refusal is the field's red
// edge here and the signing page's own words on its sheet.

/** The Withdraw button's control: locked from its tap until the signing page answers, its HopLine under the form. */
export const WITHDRAW_GO = "withdraw-go";

type Hop = (kind: "withdraw.open" | "pool.withdraw", params: never, view: HopView) => Promise<{ ok: boolean } | null>;
export type WithdrawFormDeps = {
  state: SignpageState | null | undefined;
  /** The place a Withdraw opened for (a pool row's chain), or null. */
  from: string | null;
  hop: Hop;
  locked: string | null;
  moneyOn: boolean;
  view: Omit<HopView, "control" | "fields">;
  /** Closes the sheet: the shell answered ok and SIGN_HOST's Confirm sheet is up. */
  close(): void;
};

export type WithdrawFormView = {
  places: readonly WithdrawPlace[];
  place: WithdrawPlace;
  pick(chain: string): void;
  amount: string;
  type(amount: string): void;
  max: boolean;
  tapMax(): void;
  to: string;
  setTo(to: string): void;
  check: FormCheck;
  /** Withdraw can be tapped: both fields fit, money is on and nothing is locked. */
  on: boolean;
  go(): void;
};

/** The form's state over the signing page's state: the places with money (Cash with its 0 when none), the picked one or the first. */
export function useWithdrawForm(d: WithdrawFormDeps): WithdrawFormView {
  const held = withdrawPlaces(d.state);
  // nothing held anywhere: Cash's tile with its 0 (a vault holding any is in `held`), so Withdraw stays off
  const places: WithdrawPlace[] = held.length > 0 ? held : [{ kind: "withdraw.open", chain: "near", balance: "0", symbol: "USDC" }];
  const [chain, setChain] = useState<string | null>(d.from);
  useEffect(() => setChain(d.from), [d.from]);
  const place = places.find((p) => p.chain === chain) ?? places[0]!;
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const check = checkWithdraw(place, amount, to, max);
  const on = check.ready && d.moneyOn && d.locked === null && !busy;
  // one open at a time for the sheet's life (the runner is made once, the latest hop, view and close read at the tap);
  // the sheet closes on the shell's ok only, a refusal stays with its HopLine (target.ts pickRunner)
  const deps = useRef(d);
  deps.current = d;
  const run = useMemo(
    () =>
      pickRunner((h: ReturnType<typeof withdrawHop>) => deps.current.hop(h.kind, h.params as never, { ...deps.current.view, control: WITHDRAW_GO, fields: {} }), {
        busy: setBusy,
        close: () => deps.current.close(),
      }),
    [],
  );
  return {
    places,
    place,
    pick: (c) => {
      if (c === place.chain) return;
      setChain(c);
      setAmount("");
      setMax(false);
    },
    amount: max ? place.balance : amount,
    type: (a) => {
      setMax(false);
      setAmount(a);
    },
    max,
    tapMax: () => setMax(true),
    to,
    setTo,
    check,
    on,
    go: () => void (on && run(withdrawHop(place, amount, to, max))),
  };
}

/** The segment's body: the places, the Amount with Max, the Address, and the Withdraw tap's HopLine. */
export function WithdrawBody({ f, locked }: { f: WithdrawFormView; locked: boolean }) {
  return (
    <div className="wform" data-form="withdraw" data-place={f.place.chain} data-ready={f.check.ready ? "yes" : "no"}>
      <div className="dtiles" role="group" aria-label={WORDS.withdraw.text} data-places={f.places.map((p) => p.chain).join(" ")}>
        {f.places.map((p) => {
          const m = chainOf(p.chain);
          return (
            <button key={p.chain} type="button" className={p.chain === f.place.chain ? "on" : undefined} aria-pressed={p.chain === f.place.chain} disabled={locked} data-from={p.chain} onClick={() => f.pick(p.chain)}>
              {m && <span className="mk" style={{ padding: Math.round(20 * m.inset) }}><img src={m.logo} alt="" /></span>}
              <span className="nm">{m?.name ?? p.chain}</span>
            </button>
          );
        })}
      </div>
      <label className={f.check.amount === "bad" ? "damt bad" : "damt"}>
        <span className="lb">{WORDS.amount.text}</span>
        <span className="row">
          <input className="v num" inputMode="decimal" autoComplete="off" placeholder="0" value={f.amount} disabled={locked} onChange={(e) => f.type(e.target.value)} data-field="withdraw-amount" />
          <span className="u">{f.place.symbol}</span>
        </span>
      </label>
      <div className="lim">
        <button type="button" className={f.max ? "wmax on" : "wmax"} disabled={locked} data-control="withdraw-max" onClick={f.tapMax}>
          {WORDS.max.text} <span className="num">{f.place.balance}</span> {f.place.symbol}
        </button>
      </div>
      <label className={f.check.address === "bad" ? "waddr bad" : "waddr"}>
        <span className="lb">{WORDS.address.text}</span>
        <input className="num" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={f.to} disabled={locked} onChange={(e) => f.setTo(e.target.value)} data-field="withdraw-address" />
      </label>
      <HopLine control={WITHDRAW_GO} />
    </div>
  );
}

/** The segment's action, in the sheet's foot: Withdraw, on only for a form that fits. */
export function WithdrawGo({ f }: { f: WithdrawFormView }) {
  return (
    <button type="button" className={`dbtn ${f.on ? "buy" : "off"}`} disabled={!f.on} data-control={WITHDRAW_GO} onClick={f.go}>
      {WORDS.withdraw.text}
    </button>
  );
}
