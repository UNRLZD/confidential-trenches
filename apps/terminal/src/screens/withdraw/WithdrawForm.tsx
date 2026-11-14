import type { SignpageState } from "@blindfill/kit";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HopView } from "../../shell/return-hop.ts";
import { chainOf } from "../market/pads.ts";
import { HopLine } from "../signin/HopLine.tsx";
import { pickRunner, withdrawPlaces } from "./target.ts";
import type { WithdrawPlace } from "./target.ts";
import { arrivals, checkWithdraw, withdrawHop } from "./withdraw-form.ts";
import type { Arrival, FormCheck } from "./withdraw-form.ts";
import { WORDS } from "./words.ts";

// The deposit sheet's Withdraw segment (card withdraw-address-in-the-app, owner 14 Nov 12:22Z picked A): in the same
// sheet as Deposit, switched in place. The places that hold money as tiles (each its chain's mark and name), the Amount
// with Max (the place's balance) and the Address typed here, then Withdraw hands both to SIGN_HOST (withdraw-form.ts
// withdrawHop), whose Confirm sheet shows them over the dimmed app; the sheet closes on the shell's ok and the withdraw
// progress draws the run. The words are the picked mock's (Amount, Max, Address, Withdraw); a refusal is the field's red
// edge here and the signing page's own words on its sheet.
// Card withdraw-in-app-to-any-chain: the deposit's To row built twice, the places that hold money over To (where it
// arrives: a pool's on every chain, Cash's on NEAR), the To tile picked by default the place's own chain; the address is
// checked on the To chain and the tap's pool.withdraw carries it as dest. This is the app's only withdraw form. The
// places' row has no label: no picked word yet (the card's hand-back proposes "From").

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
  /** Where the money can arrive from this place, and where it will. */
  dests: readonly Arrival[];
  dest: Arrival;
  pickDest(d: Arrival): void;
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
  // the arrival chain: the one picked while this place can reach it, else the place's own
  const dests = arrivals(place);
  const [destPick, setDest] = useState<Arrival | null>(null);
  useEffect(() => setDest(null), [d.from]);
  const dest = destPick !== null && dests.includes(destPick) ? destPick : place.chain;
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const check = checkWithdraw(place, dest, amount, to, max);
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
      setDest(null);
      setAmount("");
      setMax(false);
    },
    dests,
    dest,
    pickDest: setDest,
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
    go: () => void (on && run(withdrawHop(place, dest, amount, to, max))),
  };
}

/** One chain tile, the deposit's To tile (deposit.css .dtiles): its chain's mark over its name. */
function Tile({ chain, on, locked, data, pick }: { chain: string; on: boolean; locked: boolean; data: Record<string, string>; pick(): void }) {
  const m = chainOf(chain);
  return (
    <button type="button" className={on ? "on" : undefined} aria-pressed={on} disabled={locked} onClick={pick} {...data}>
      {m && <span className="mk" style={{ padding: Math.round(20 * m.inset) }}><img src={m.logo} alt="" /></span>}
      <span className="nm">{m?.name ?? chain}</span>
    </button>
  );
}

/** The segment's body: the places, To (where it arrives), the Amount with Max, the Address, and the Withdraw tap's HopLine. */
export function WithdrawBody({ f, locked }: { f: WithdrawFormView; locked: boolean }) {
  return (
    <div className="wform" data-form="withdraw" data-place={f.place.chain} data-dest={f.dest} data-ready={f.check.ready ? "yes" : "no"}>
      <div className="dtiles" role="group" aria-label={WORDS.withdraw.text} data-places={f.places.map((p) => p.chain).join(" ")}>
        {f.places.map((p) => (
          <Tile key={p.chain} chain={p.chain} on={p.chain === f.place.chain} locked={locked} data={{ "data-from": p.chain }} pick={() => f.pick(p.chain)} />
        ))}
      </div>
      <div className="ddest">
        <div className="lb" id="wd-to">{WORDS.to.text}</div>
        <div className="dtiles" role="group" aria-labelledby="wd-to" data-dests={f.dests.join(" ")}>
          {f.dests.map((c) => (
            <Tile key={c} chain={c} on={c === f.dest} locked={locked} data={{ "data-to": c }} pick={() => f.pickDest(c)} />
          ))}
        </div>
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
