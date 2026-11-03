import type { SignpageResults } from "@blindfill/kit";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { ROUTES } from "../../routes/routes.ts";
import { Icon } from "../signin/Icon.tsx";
import { useBalance } from "../portfolio/source.tsx";
import { usd as usdCents } from "../signin/model.ts";
import { ADDRESS_STATES, countdown, elapsed, getAddressOn, HELD_STATES, parseAmount, sheetState, usd } from "./model.ts";
import type { Answer, DryQuote, SheetState } from "./model.ts";
import { useDepositSource, useNow } from "./source.tsx";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./deposit.css";

// The deposit sheet S4 (app.md FR-P7 to FR-P11, branch D FR-D1 to FR-D3; R5 design/proto/assets/app.js P.deposit at
// design-lock-r5): the 330 x 900 drawer at the right edge on desktop, the sheet on the phone, one height in every state
// (BAR-05; owner pick "Same height", OD:270). The amount's quote lines come from a dry quote; Get address asks the kit
// for the checked quote, and the only address drawn is the one inside it. The deposit's status after that is the kit's,
// drawn in place: Waiting, Processing with one counter (BAR-11), Deposited only at the kit's done (BAR-12), and branch D:
// Refunded, the refund move with its counter, Held with Withdraw (withdraw.open with the id; the address is typed on
// SIGN_HOST's own form, W:684). No dialog before a step and no timer: every change is an answer or an event.

export const SHEET_ID = "deposit";

function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={id}>{w.text}</span> : <>{w.text}</>;
}

export function DepositSheet({ onClose }: { onClose(): void }) {
  const src = useDepositSource();
  const { pathname } = useLocation();
  const state = src.snapshot.state;
  const balance = useBalance(src.snapshot) ?? 0n;
  const asset = src.assets?.[0] ?? null;
  const [amount, setAmount] = useState(() => src.start?.amount ?? "");
  const [dry, setDry] = useState<Answer<DryQuote>>(src.assets?.length === 0 ? { kind: "refused", code: "not_available" } : { kind: "idle" });
  const [checked, setChecked] = useState<Answer<SignpageResults["deposit.quote"]>>({ kind: "idle" });
  const [reqId, setReqId] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const seq = useRef(0);
  const { dryQuote } = src;

  // the dry quote follows the amount: a new amount drops the old answer at once, and an older answer never lands on a
  // newer amount
  useEffect(() => {
    if (!asset) return;
    const amt = parseAmount(amount);
    const n = ++seq.current;
    if (!amt) return setDry({ kind: "idle" });
    setDry({ kind: "pending" });
    void dryQuote(asset, amt).then((r) => {
      if (n === seq.current) setDry(r.ok ? { kind: "ok", value: r.value } : { kind: "refused", code: r.code });
    });
  }, [asset, amount, dryQuote, tries]);

  const status = reqId ? src.status(reqId) : null;
  const ticking = checked.kind === "ok";
  const now = useNow(src, ticking);
  const s = sheetState({ signedIn: state?.signed_in === true, moneyOn: src.moneyOn, codeSaved: state?.code_saved !== false, asset, amount, dry, checked, status, now });

  async function getAddress() {
    const amt = parseAmount(amount);
    if (!asset || !amt) return;
    setChecked({ kind: "pending" });
    const { id, reply } = await src.quote(asset, amt);
    setReqId(id);
    setChecked(reply.ok ? { kind: "ok", value: reply.value } : { kind: "refused", code: reply.code });
  }
  function again() {
    setChecked({ kind: "idle" });
    setReqId(null);
    void getAddress();
  }

  const view = { route: ROUTES.find((r) => r.path === pathname)?.id ?? "discover", sheet: SHEET_ID, fields: { amount } };
  const heldId = status?.held_id ?? "";
  const cents = balance;

  let body: ReactNode;
  let foot: ReactNode = null;
  if (s === "S4.16") {
    body = (
      <div className="ddone">
        <Ring />
        <div className="damt-done num" data-amount={status?.amount_usd}>{usd(status?.amount_usd ?? "0")}</div>
        <div className="dsub">
          <W id="deposited" /> <span className="num">{checked.kind === "ok" ? checked.value.amount_in : ""}</span> {asset?.symbol}
        </div>
      </div>
    );
    foot = <Action kind="paper" on onClick={onClose} control="deposit-done"><W id="done" /></Action>;
  } else if (s === "S4.17" || s === "refund-move") {
    body = (
      <>
        <Stat tone="warn" label={<W id="refunded" />} counter={s === "refund-move" ? elapsed(status?.since_ms, now) : null} />
        <p className="dline"><W id="refundedLine" /></p>
      </>
    );
  } else if (HELD_STATES.has(s)) {
    body = (
      <>
        <Stat tone="warn" label={<W id="held" />} />
        <p className="dline"><W id="heldLine" /></p>
      </>
    );
    foot = (
      <Action kind="paper" on={src.moneyOn && heldId !== "" && src.locked === null} control="deposit-held-withdraw" onClick={() => void src.hop("withdraw.open", { from_id: heldId }, { ...view, control: "deposit-held-withdraw" })}>
        <W id="withdraw" />
      </Action>
    );
  } else if (ADDRESS_STATES.has(s) && checked.kind === "ok") {
    const q = checked.value;
    body = (
      <>
        {s === "S4.13" || s === "S4.14" ? (
          <Stat tone="warn" label={<W id="waiting" />} />
        ) : (
          <Stat tone="blue" label={s === "S4.18" ? <W id="short" /> : <W id="processing" />} counter={elapsed(status?.since_ms, now)} />
        )}
        <div className="addrb">
          <div className="ca">
            <span>{asset?.symbol}</span>
            <span className="gap" />
            <span>{asset?.chain}</span>
          </div>
          <div className="hex num" data-address={q.deposit_address}>
            {(q.deposit_address.match(/.{1,4}/g) ?? []).join(" ")}
          </div>
          <div className="kv">
            <div><div className="k"><W id="amount" /></div><div className="v num">{q.amount_in} {asset?.symbol}</div></div>
            <div><div className="k"><W id="expiresIn" /></div><div className="v num">{countdown(q.deadline, now)}</div></div>
            <div className="r"><div className="k"><W id="chain" /></div><div className="v">{asset?.chain}</div></div>
          </div>
        </div>
      </>
    );
    foot = <Action kind="buy" on control="deposit-copy" onClick={() => src.copy(q.deposit_address)}><W id="copy" /></Action>;
  } else if (s === "S4.20") {
    body = <Stat tone="warn" label={<W id="expired" />} />;
    foot = <Action kind="buy" on={src.moneyOn} control="deposit-get" onClick={again}><W id="getAddress" /></Action>;
  } else {
    body = <Form s={s} amount={amount} setAmount={setAmount} dry={dry} asset={asset} retry={() => (checked.kind === "refused" ? again() : setTries((t) => t + 1))} />;
    if (s === "S4.19")
      foot = (
        <Action kind="paper" on={src.moneyOn && src.locked === null} control="deposit-backup" onClick={() => void src.hop("backup.open", {}, { ...view, control: "deposit-backup" })}>
          <W id="backup" />
        </Action>
      );
    else foot = <Action kind="buy" on={getAddressOn(s, { signedIn: state?.signed_in === true, moneyOn: src.moneyOn })} control="deposit-get" onClick={() => void getAddress()}><W id="getAddress" /></Action>;
  }

  return (
    <div className="dep" data-sheet={SHEET_ID} data-state={s}>
      <div className="dep-scrim" onClick={onClose} />
      <aside className="dep-box" aria-labelledby="dep-seg-on">
        <div className="grab"><i /></div>
        <div className="dhd">
          <span className="bal num">{usdCents(cents)}</span>
          <button type="button" className="dep-x" aria-label={WORDS.close.text} onClick={onClose}>
            <Icon name="x" size={14} stroke={1.4} />
          </button>
        </div>
        <div className="dbody">
          <div className="dseg">
            <button type="button" className="on" id="dep-seg-on"><W id="deposit" /></button>
            <button type="button" disabled={!src.moneyOn || src.locked !== null} data-control="deposit-withdraw" onClick={() => void src.hop("withdraw.open", {}, { ...view, control: "deposit-withdraw" })}>
              <W id="withdraw" />
            </button>
          </div>
          {body}
        </div>
        <div className="dfoot">{foot}</div>
      </aside>
    </div>
  );
}

function Action({ kind, on, onClick, control, children }: { kind: "buy" | "paper"; on: boolean; onClick(): void; control: string; children: ReactNode }) {
  return (
    <button type="button" className={`dbtn ${on ? kind : "off"}`} disabled={!on} data-control={control} onClick={onClick}>
      {children}
    </button>
  );
}

function Stat({ tone, label, counter = null }: { tone: "warn" | "blue"; label: ReactNode; counter?: number | null }) {
  return (
    <div className={`dstat ${tone}`} data-counter={counter ?? undefined}>
      <span>{label}</span>
      {counter !== null && <span className="num cnt">{`${counter}s`.padEnd(6, "\u2007")}</span>}
    </div>
  );
}

function Form({ s, amount, setAmount, dry, asset, retry }: { s: SheetState; amount: string; setAmount(a: string): void; dry: Answer<DryQuote>; asset: { symbol: string; chain: string; min: string; max_usd: string | null } | null; retry(): void }) {
  const loading = s === "S4.1";
  const q = dry.kind === "ok" && !["S4.4", "S4.5"].includes(s) ? dry.value : null;
  const cell = (v: string | null) => (s === "S4.2" ? <span className="sk" /> : <span className={v ? "num" : "num t3"}>{v ?? "—"}</span>);
  let quote: ReactNode = (
    <>
      <div className="dget">
        <div className="lb">{s === "S4.2" ? <W id="quoting" /> : <W id="youGet" />}</div>
        <div className="v">{cell(q ? usd(q.amount_out_usd) : null)}</div>
      </div>
      <div className="dstrip">
        <div><div className="k"><W id="minimum" /></div><div className="v">{cell(q ? usd(q.min_amount_out_usd) : null)}</div></div>
        <div><div className="k"><W id="fees" /></div><div className="v">{cell(q ? usd(q.fee_usd) : null)}</div></div>
        <div><div className="k"><W id="arrives" /></div><div className="v">{cell(q ? `~${q.time_estimate_s}s` : null)}</div></div>
      </div>
    </>
  );
  if (s === "S4.6") quote = <Stat tone="warn" label={<W id="notAvailable" />} />;
  if (s === "S4.8") quote = <Stat tone="warn" label={<W id="paused" />} />;
  if (s === "S4.7" || s === "quote-refused")
    quote = (
      <div className="dstat warn row">
        <span>{s === "S4.7" ? <W id="busy" /> : <W id="quoteRefused" />}</span>
        <button type="button" className="retry" onClick={retry}><W id="retry" /></button>
      </div>
    );
  return (
    <>
      <div className="dpicks">
        <div className="dpick"><div className="lb"><W id="asset" /></div><div className="drow">{loading ? <span className="sk" /> : <span className="nm">{asset?.symbol}</span>}</div></div>
        <div className="dpick"><div className="lb"><W id="chain" /></div><div className="drow">{loading ? <span className="sk" /> : <span className="nm">{asset?.chain}</span>}</div></div>
      </div>
      <label className={s === "S4.4" || s === "S4.5" ? "damt bad" : "damt"}>
        <span className="lb"><W id="amount" /></span>
        <span className="row">
          <input className="v num" inputMode="decimal" autoComplete="off" value={amount} disabled={loading} onChange={(e) => setAmount(e.target.value)} data-field="amount" />
          <span className="u">{asset?.symbol}</span>
        </span>
      </label>
      <div className="lim">
        <span className={s === "S4.4" ? "loss" : ""}><W id="min" /> <span className="num">{asset?.min ?? "—"}</span> {asset?.symbol}</span>
        {asset?.max_usd != null && <span className={s === "S4.5" ? "loss" : ""}><W id="max" /> <span className="num">{usd(asset.max_usd).replace(/\.00$/, "")}</span></span>}
      </div>
      {quote}
    </>
  );
}

/** R5's end-screen ring (private.js P.moveRing): 24 dots, all lit, with a check. */
function Ring() {
  const dots = Array.from({ length: 24 }, (_, i) => {
    const a = -Math.PI / 2 + (i / 24) * Math.PI * 2;
    const op = (0.55 + 0.45 * Math.cos(a + Math.PI / 4) ** 2).toFixed(2);
    return <circle key={i} cx={(40 + Math.cos(a) * 34).toFixed(2)} cy={(40 + Math.sin(a) * 34).toFixed(2)} r="2.6" fill="var(--acc)" fillOpacity={op} />;
  });
  return (
    <svg width="80" height="80" viewBox="0 0 80 80" aria-hidden="true">
      {dots}
      <path d="M28 41l8 8 16-17" fill="none" stroke="var(--acc)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
