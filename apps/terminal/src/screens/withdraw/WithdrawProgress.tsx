import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { ROUTES } from "../../routes/routes.ts";
import { usd } from "../deposit/model.ts";
import { HopLine } from "../signin/HopLine.tsx";
import { Icon } from "../signin/Icon.tsx";
import { balanceCents, usd as usdCents } from "../signin/model.ts";
import { close, current, EMPTY, observe, txLink } from "./model.ts";
import type { Watch, WithdrawView } from "./model.ts";
import { useNow, useWithdrawSource } from "./source.tsx";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "../deposit/deposit.css";
import "./withdraw.css";

// The withdraw progress (A1.7; S12.11, S12.12, S12.14, S12.15 and the kit's `stopped`; R5 private.js:121-152 at
// design-lock-r5): the funds drawer with Withdraw on, as the deposit sheet's box (deposit.css), drawn whenever a
// withdrawal the app follows (model.ts) is in the signing page's state, so it shows when SIGN_HOST's layer closes and
// after a reload mid-way. It has no address field and no amount field: both are typed on SIGN_HOST's form (W:924-925).
// The end screen is R5's: the dot ring, the amount, Sent with what the address got, the short destination and the tx
// link, opened only when tapped; Done, the close and Deposit drop it (Deposit then asks the mount for the deposit sheet). A stopped withdrawal moved nothing, so its one action opens the form
// again. No dialog and no timer: every change is a kit stage.

export const SHEET_ID = "withdraw";

function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={id}>{w.text}</span> : <>{w.text}</>;
}

const TONE: Record<WithdrawView, { col: string; frac: number; check: boolean }> = {
  "S12.11": { col: "var(--blue)", frac: 6 / 24, check: false },
  "S12.12": { col: "var(--blue)", frac: 12 / 24, check: false },
  "S12.14": { col: "var(--acc)", frac: 1, check: true },
  "S12.15": { col: "var(--warn)", frac: 1, check: false },
  stopped: { col: "var(--warn)", frac: 0, check: false },
};

export function WithdrawProgress({ onDeposit }: { onDeposit(): void }) {
  const src = useWithdrawSource();
  const { pathname } = useLocation();
  const state = src.snapshot.state;
  const ops = state?.ops;
  const [watch, setWatch] = useState<Watch>(EMPTY);
  const { now: clock } = src;
  useEffect(() => setWatch((w) => observe(w, ops, clock())), [ops, clock]);

  const first = current(watch, ops, clock());
  const now = useNow(clock, first?.view === "S12.12");
  const shown = current(watch, ops, now);
  if (!shown) return null;

  const { op, view, counter } = shown;
  const d = src.detail(op.id) ?? {};
  const link = txLink(op.txs);
  const done = () => setWatch((w) => close(w, op.id));
  const route = ROUTES.find((r) => r.path === pathname)?.id ?? "discover";
  const t = TONE[view];

  let status: ReactNode;
  if (view === "S12.11") status = <span className="wst blue"><W id="sending" /></span>;
  else if (view === "S12.12")
    status = (
      <span className="wst blue" data-counter={counter ?? 0}>
        <W id="processing" /> <span className="num wcnt">{`${counter ?? 0}s`.padEnd(5, "\u2007")}</span>
      </span>
    );
  else if (view === "S12.14")
    status = (
      <span className="wst">
        <W id="sent" />
        {d.amount && <> <span className="num">{d.amount}</span> {d.symbol}</>}
      </span>
    );
  else if (view === "S12.15") status = <span className="wst warn"><W id="refunded" /></span>;
  else status = <span className="wst warn"><W id="notSent" /></span>;

  let foot: ReactNode = null;
  if (view === "S12.14" || view === "S12.15")
    foot = (
      <button type="button" className="dbtn paper" data-control="withdraw-done" onClick={done}>
        <W id="done" />
      </button>
    );
  else if (view === "stopped") {
    const on = src.moneyOn && src.locked === null;
    foot = (
      <button type="button" className={`dbtn ${on ? "paper" : "off"}`} disabled={!on} data-control="withdraw-again" onClick={() => void src.hop("withdraw.open", {}, { route, sheet: SHEET_ID, control: "withdraw-again", fields: {} })}>
        <W id="withdraw" />
      </button>
    );
  }

  return (
    <div className="dep wdr" data-sheet={SHEET_ID} data-state={view} data-op={op.id}>
      <div className="dep-scrim" onClick={done} />
      <aside className="dep-box" aria-labelledby="wdr-seg-on">
        <div className="grab"><i /></div>
        <div className="dhd">
          <span className="bal num">{usdCents(state ? balanceCents(state) : 0n)}</span>
          <button type="button" className="dep-x" aria-label={WORDS.close.text} onClick={done}>
            <Icon name="x" size={14} stroke={1.4} />
          </button>
        </div>
        <div className="dbody">
          <div className="dseg">
            <button type="button" data-control="withdraw-deposit" onClick={() => (done(), onDeposit())}><W id="deposit" /></button>
            <button type="button" className="on" id="wdr-seg-on"><W id="withdraw" /></button>
          </div>
          <div className="wdone">
            <Ring col={t.col} frac={t.frac} check={t.check} />
            <div className="wamt num" data-amount={d.amount_usd}>{d.amount_usd ? usd(d.amount_usd) : "\u00a0"}</div>
            {status}
            {(d.to || link) && (
              <div className="wto">
                {d.to && <span className="num" data-to>{d.to}</span>}
                {link && view !== "S12.11" && view !== "S12.12" && (
                  <a className="wtx" href={link} target="_blank" rel="noopener noreferrer" data-tx>
                    <W id="transaction" />
                  </a>
                )}
                {view === "S12.12" && d.amount && <span className="t3"><span className="num">{d.amount}</span> {d.symbol}</span>}
              </div>
            )}
          </div>
          <HopLine control="withdraw-again" />
        </div>
        <div className="dfoot">{foot}</div>
      </aside>
    </div>
  );
}

/** R5's move ring (private.js P.moveRing): 24 dots lit in `col` up to `frac` of the way round from 12 o'clock, the rest faint; a finished move fully lit with a check. */
function Ring({ col, frac, check }: { col: string; frac: number; check: boolean }) {
  const lit = Math.round(frac * 24);
  const dots = Array.from({ length: 24 }, (_, i) => {
    const a = -Math.PI / 2 + (i / 24) * Math.PI * 2;
    const on = i < lit;
    const op = !on ? "0.12" : check ? (0.55 + 0.45 * Math.cos(a + Math.PI / 4) ** 2).toFixed(2) : (0.4 + (0.6 * i) / Math.max(1, lit - 1)).toFixed(2);
    return <circle key={i} cx={(40 + Math.cos(a) * 34).toFixed(2)} cy={(40 + Math.sin(a) * 34).toFixed(2)} r="2.6" fill={on ? col : "var(--paper)"} fillOpacity={op} />;
  });
  return (
    <svg width="80" height="80" viewBox="0 0 80 80" aria-hidden="true" data-ring={lit}>
      {dots}
      {check && <path d="M28 41l8 8 16-17" fill="none" stroke={col} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
