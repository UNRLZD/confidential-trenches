import { POOL_CHAINS } from "@blindfill/kit";
import type { PoolChain, SignpageResults } from "@blindfill/kit";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { ROUTES } from "../../routes/routes.ts";
import { Icon } from "../signin/Icon.tsx";
import { useBalance } from "../portfolio/source.tsx";
import { CHAINS } from "../market/pads.ts";
import { usd as usdCents } from "../signin/model.ts";
import { addressHeading, ADDRESS_STATES, chainsOf, countdown, DESTS, destFundable, elapsed, getAddressOn, HELD_STATES, parseAmount, formHeld, pickAsset, poolAskAgainIn, poolQuote, poolReady, quoteFits, recentRows, sheetState, symbolsOf, usd } from "./model.ts";
import type { Answer, Asset, Dest, DryQuote, PoolOpen, QuoteRefusal, RecentRow, SheetState } from "./model.ts";
import { qrOf } from "./qr.ts";
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
// The To row (card deposit-to-pool, v2 A3) names where the money goes: the NEAR vault, the cash home, and the Solana,
// Base and Robinhood pools, each by its chain's mark (market/pads.ts). A pool takes a deposit once the signing page's
// pool.address answers its chain (card deposit-to-pool-pools; asked with no asset when the sheet opens, nothing sent);
// while it refuses, the pool picked asks no quote and shows no address, Not available. A fundable pool's Get address is
// pool.address with the asset and amount, its checked quote's address drawn as the vault's, then the pool_deposit op's
// stages under that request's id, of that chain only; Deposited only at in_pool (the notes read on two RPCs), with what
// the pool holds ready to buy from state.pools.

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
  const [dest, setDest] = useState<Dest>("near");
  const signedIn = state?.signed_in === true;
  const codeSaved = state?.code_saved !== false;
  // what pool.address answers for each pool's chain, asked once signed in with the words saved (the page refuses it
  // otherwise) and the page READY: no asset, so nothing is quoted or sent
  const [open, setOpen] = useState<PoolOpen>({});
  const { poolAddress } = src;
  const asksPools = signedIn && codeSaved && src.moneyOn;
  // busy or down is asked again on model.ts poolAskAgainIn's backoff while the sheet is open (the tile loads meanwhile);
  // any other refusal is Not available at once
  useEffect(() => {
    if (!asksPools) return;
    let live = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const ask = (chain: PoolChain, attempt: number): void =>
      void poolAddress(chain).then(({ reply }) => {
        if (!live) return;
        const wait = reply.ok ? null : poolAskAgainIn(reply.code, attempt);
        if (wait !== null) return void timers.push(setTimeout(() => ask(chain, attempt + 1), wait));
        setOpen((o) => ({ ...o, [chain]: reply.ok && reply.value.chain === chain }));
      });
    for (const chain of POOL_CHAINS) ask(chain, 0);
    return () => {
      live = false;
      for (const t of timers) clearTimeout(t);
    };
  }, [asksPools, poolAddress]);
  const fundable = destFundable(dest, open);
  const [picked, setPicked] = useState<{ symbol: string; chain: string } | null>(null);
  const asset = pickAsset(src.assets, picked);
  const [amount, setAmount] = useState(() => src.start?.amount ?? "");
  const [typedDry, setDry] = useState<Answer<DryQuote>>({ kind: "idle" });
  // no asset list (refused, or none to take) is the sheet's answer before any amount: S4.6, S4.7 or S4.8, never a skeleton
  const dry: Answer<DryQuote> = src.assetsRefused ? { kind: "refused", code: src.assetsRefused } : src.assets?.length === 0 ? { kind: "refused", code: "not_available" } : typedDry;
  const [checked, setChecked] = useState<Answer<SignpageResults["deposit.quote"]>>({ kind: "idle" });
  // the request the address came from: the place, asset and amount it was asked for. Its status is that place's op
  // only, and the address block draws its asset and amount, never a pick made after (review P1)
  const [req, setReq] = useState<{ id: string | null; dest: Dest; asset: Asset; amount: string } | null>(null);
  const [tries, setTries] = useState(0);
  const seq = useRef(0);
  const { dryQuote } = src;

  // the dry quote follows the amount: a new amount drops the old answer at once, and an older answer never lands on a
  // newer amount
  useEffect(() => {
    // a pool asks no dry quote: deposit.dry quotes what lands in the vault, never in a pool
    if (!asset || dest !== "near") return;
    const amt = parseAmount(amount);
    const n = ++seq.current;
    if (!amt) return setDry({ kind: "idle" });
    setDry({ kind: "pending" });
    void dryQuote(asset, amt).then((r) => {
      if (n === seq.current) setDry(r.ok ? { kind: "ok", value: r.value } : { kind: "refused", code: r.code });
    });
  }, [asset, amount, dryQuote, tries, dest]);

  const status = !req?.id ? null : req.dest === "near" ? src.status(req.id) : src.poolStatus(req.id, req.dest);
  const ticking = checked.kind === "ok";
  const now = useNow(src, ticking);
  const s = sheetState({ dest, poolOpen: dest === "near" ? undefined : open[dest], signedIn, moneyOn: src.moneyOn, codeSaved, asset, amount, dry, checked, status, now });

  async function getAddress() {
    const amt = parseAmount(amount);
    const d = dest;
    if (!asset || !amt || !fundable) return;
    const asked = { asset, amount: amt };
    setChecked({ kind: "pending" });
    // the vault's quote, or a pool's only when the answer names the pool asked (model.ts poolQuote); either only when it
    // is for the asset and amount asked (quoteFits): no other chain's or asset's address draws
    let id: string | null;
    let q: SignpageResults["deposit.quote"] | null;
    let code: QuoteRefusal = "quote_check_failed";
    if (d === "near") {
      const r = await src.quote(asset, amt);
      id = r.id;
      q = r.reply.ok ? r.reply.value : null;
      if (!r.reply.ok) code = r.reply.code;
    } else {
      const r = await src.poolAddress(d, asked);
      id = r.id;
      q = r.reply.ok ? poolQuote(d, r.reply.value) : null;
      if (!r.reply.ok) code = r.reply.code;
    }
    setReq({ id, dest: d, ...asked });
    setChecked(q && quoteFits(q, asked) ? { kind: "ok", value: q } : { kind: "refused", code });
  }
  // another place picked: a refusal belongs to the place it was asked for, so the new place starts unasked
  function pickDest(d: Dest) {
    setDest(d);
    if (checked.kind === "refused") setChecked({ kind: "idle" });
  }
  function again() {
    setChecked({ kind: "idle" });
    setReq(null);
    void getAddress();
  }

  const view = { route: ROUTES.find((r) => r.path === pathname)?.id ?? "discover", sheet: SHEET_ID, fields: { amount } };
  // the vault deposit's facts (a pool deposit has no held id and no USD amount: model.ts PoolDepositStatus)
  const vault = status && !("pool" in status) ? status : null;
  const heldId = vault?.held_id ?? "";
  const cents = balance;

  let body: ReactNode;
  let foot: ReactNode = null;
  if (s === "pool-in" && req && req.dest !== "near") {
    // the notes read on the pool's two RPCs (the kit's in_pool): what the pool holds ready to buy, and the rest still
    // being proved, in its own asset, as Portfolio's row for the chain
    const p = poolReady(state?.pools, req.dest);
    body = (
      <>
        <div className="ddone" data-pool={req.dest}>
          <Ring />
          {p && (
            <>
              <div className="dsub"><W id="ready" /></div>
              <div className="damt-done num" data-ready={p.ready ?? "none"}>{p.ready ?? "0"} {p.asset}</div>
            </>
          )}
          <div className="dsub">
            <W id="deposited" /> <span className="num">{checked.kind === "ok" ? checked.value.amount_in : ""}</span> {req?.asset.symbol}
          </div>
          {p?.pending != null && (
            <div className="dsub" data-pending={p.pending}>
              <W id="pending" /> <span className="num">{p.pending}</span> {p.asset}
            </div>
          )}
        </div>
        <Recent rows={recentRows(state?.ops)} />
      </>
    );
    foot = <Action kind="paper" on onClick={onClose} control="deposit-done"><W id="done" /></Action>;
  } else if (s === "S4.16") {
    body = (
      <div className="ddone">
        <Ring />
        <div className="damt-done num" data-amount={vault?.amount_usd}>{usd(vault?.amount_usd ?? "0")}</div>
        <div className="dsub">
          <W id="deposited" /> <span className="num">{checked.kind === "ok" ? checked.value.amount_in : ""}</span> {req?.asset.symbol}
        </div>
      </div>
    );
    body = (
      <>
        {body}
        <Recent rows={recentRows(state?.ops)} />
      </>
    );
    foot = <Action kind="paper" on onClick={onClose} control="deposit-done"><W id="done" /></Action>;
  } else if (s === "S4.17" || s === "refund-move") {
    body = (
      <>
        <Stat tone="warn" label={<W id="refunded" />} counter={s === "refund-move" ? elapsed(status?.since_ms, now) : null} />
        <p className="dline"><W id="refundedLine" /></p>
      </>
    );
  } else if (s === "moved") {
    // the held money moved out (card held-move-forgotten-tx): no Held mark and no withdraw, nothing waits under its id
    body = (
      <>
        <Stat tone="blue" label={<W id="moved" />} />
        <Recent rows={recentRows(state?.ops)} />
      </>
    );
    foot = <Action kind="paper" on onClick={onClose} control="deposit-done"><W id="done" /></Action>;
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
          <Qr text={q.deposit_address} />
          <div className="ca">
            {req &&
              addressHeading(req.asset).map((t, i) => (
                <span key={i} className={i ? "c" : undefined}>
                  {t}
                </span>
              ))}
          </div>
          <div className="hex num" data-address={q.deposit_address}>
            {(q.deposit_address.match(/.{1,4}/g) ?? []).join(" ")}
          </div>
          <div className="kv">
            <div><div className="k"><W id="amount" /></div><div className="v num">{q.amount_in} {req?.asset.symbol}</div></div>
            <div><div className="k"><W id="expiresIn" /></div><div className="v num">{countdown(q.deadline, now)}</div></div>
            <div className="r"><div className="k"><W id="chain" /></div><div className="v">{req?.asset.chain}</div></div>
          </div>
        </div>
      </>
    );
    foot = <Action kind="buy" on control="deposit-copy" onClick={() => src.copy(q.deposit_address)}><W id="copy" /></Action>;
  } else if (s === "pool-off") {
    body = (
      <>
        <Dests dest={dest} open={open} pick={pickDest} />
        <Stat tone="warn" label={<W id="notAvailable" />} />
        <Recent rows={recentRows(state?.ops)} />
      </>
    );
    foot = <Action kind="buy" on={false} control="deposit-get" onClick={() => {}}><W id="getAddress" /></Action>;
  } else if (s === "S4.20") {
    body = <Stat tone="warn" label={<W id="expired" />} />;
    foot = <Action kind="buy" on={src.moneyOn} control="deposit-get" onClick={again}><W id="getAddress" /></Action>;
  } else {
    body = (
      <>
        <Dests dest={dest} open={open} locked={checked.kind === "pending"} pick={pickDest} />
        <Form s={s} held={formHeld(s, checked)} lines={dest === "near"} amount={amount} setAmount={setAmount} dry={dry} asset={asset} assets={src.assets ?? []} pick={setPicked} retry={() => (checked.kind === "refused" ? again() : src.assetsRefused ? src.retryAssets() : setTries((t) => t + 1))} />
        <Recent rows={recentRows(state?.ops)} />
      </>
    );
    if (s === "S4.19")
      foot = (
        <Action kind="paper" on={src.moneyOn && src.locked === null} control="deposit-backup" onClick={() => void src.hop("backup.open", {}, { ...view, control: "deposit-backup" })}>
          <W id="backup" />
        </Action>
      );
    else foot = <Action kind="buy" on={getAddressOn(s, { signedIn, moneyOn: src.moneyOn })} control="deposit-get" onClick={() => void getAddress()}><W id="getAddress" /></Action>;
  }

  return (
    <div className="dep" data-sheet={SHEET_ID} data-state={s} data-dest={dest}>
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

function Form({ s, held, lines, amount, setAmount, dry, asset, assets, pick, retry }: { s: SheetState; held: { pickers: boolean; amount: boolean }; lines: boolean; amount: string; setAmount(a: string): void; dry: Answer<DryQuote>; asset: Asset | null; assets: readonly Asset[]; pick(p: { symbol: string; chain: string }): void; retry(): void }) {
  const loading = s === "S4.1";
  // a checked quote pending: the asset, chain and amount it was asked for are held still until it answers (review P1)
  const frozen = held.pickers;
  const q = dry.kind === "ok" && !["S4.4", "S4.5"].includes(s) ? dry.value : null;
  const cell = (v: string | null) => (s === "S4.2" ? <span className="sk" /> : <span className={v ? "num" : "num t3"}>{v ?? "—"}</span>);
  // the quote lines come from the vault's dry quote; a pool has none (its one quote is the checked one, with the address)
  let quote: ReactNode = !lines ? null : (
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
        <Pick label="asset" loading={loading} frozen={frozen} value={asset?.symbol} rows={symbolsOf(assets)} control="deposit-asset" onPick={(symbol) => pick({ symbol, chain: chainsOf(assets, symbol)[0] ?? "" })} />
        <Pick label="chain" loading={loading} frozen={frozen} value={asset?.chain} rows={asset ? chainsOf(assets, asset.symbol) : []} control="deposit-chain" onPick={(chain) => asset && pick({ symbol: asset.symbol, chain })} />
      </div>
      <label className={s === "S4.4" || s === "S4.5" ? "damt bad" : "damt"}>
        <span className="lb"><W id="amount" /></span>
        <span className="row">
          <input className="v num" inputMode="decimal" autoComplete="off" value={amount} disabled={held.amount} onChange={(e) => setAmount(e.target.value)} data-field="amount" />
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

/**
 * The To row (card deposit-to-pool): the NEAR vault and the three pools in DESTS' order, one tile each with its chain's
 * mark and name (data, market/pads.ts CHAINS). The picked tile is on; a pool pool.address has not answered is drawn
 * quieter, and picking it shows Not available in place of the form (pool-off). While an address is being asked the row
 * holds still, so the answer lands on the place it was asked for.
 */
function Dests({ dest, open, locked = false, pick }: { dest: Dest; open: PoolOpen; locked?: boolean; pick(d: Dest): void }) {
  return (
    <div className="ddest">
      <div className="lb" id="dep-to"><W id="to" /></div>
      <div className="dtiles" role="group" aria-labelledby="dep-to" data-dests={DESTS.join(" ")}>
        {DESTS.map((d) => {
          const m = CHAINS[d]!;
          return (
            <button key={d} type="button" className={d === dest ? "on" : undefined} aria-pressed={d === dest} disabled={locked} data-dest={d} data-fundable={destFundable(d, open) ? "yes" : "no"} onClick={() => pick(d)}>
              <span className="mk" style={{ padding: Math.round(20 * m.inset) }}><img src={m.logo} alt="" /></span>
              <span className="nm">{m.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One picker (R5's dpick: the label, then the row with the chevron): a native select over the row, so the phone opens its
 * own list and the keyboard works; its rows are data (symbols, chain names) from the kit's asset list.
 */
function Pick({ label, loading, frozen, value, rows, control, onPick }: { label: "asset" | "chain"; loading: boolean; frozen: boolean; value: string | undefined; rows: string[]; control: string; onPick(v: string): void }) {
  return (
    <div className="dpick">
      <div className="lb"><W id={label} /></div>
      <div className="drow">
        {loading ? (
          <span className="sk" />
        ) : (
          <>
            <select className="nm" aria-label={WORDS[label].text} value={value ?? ""} disabled={frozen || rows.length < 2} data-control={control} onChange={(e) => onPick(e.target.value)}>
              {rows.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            {rows.length > 1 && <Icon name="chevDown" size={13} />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * R5's Recent block (app.js:641-642): the account's deposits from state.ops, newest first, each by its stage's word and,
 * once done, what it credited; No activity over R5's plate when there are none. Under the form and on the done screen.
 */
function Recent({ rows }: { rows: RecentRow[] }) {
  return (
    <div className="drecent" data-recent={rows.length}>
      <div className="hd"><span><W id="recent" /></span></div>
      {rows.length === 0 ? (
        <div className="empty"><Plate /><span><W id="noActivity" /></span></div>
      ) : (
        rows.map((r) => (
          <div className="it" key={r.id} data-op={r.id}>
            <span><W id={r.word} /></span>
            {r.amount_usd !== undefined && <span className="num">{usd(r.amount_usd)}</span>}
            {r.pool !== undefined && <span className="pl" data-chain={r.pool}>{CHAINS[r.pool]!.name}</span>}
          </div>
        ))
      )}
    </div>
  );
}

/** R5's empty plate (app.js P.plate): paper dots fading to the edges, a few lit, in the text colour. */
function Plate() {
  const dots = [];
  for (let c = 0; c < 52; c++)
    for (let y = 0; y < 11; y++) {
      const dx = (c - 26) / 26, dy = (y - 5.5) / 5.5;
      if (dx * dx * 0.9 + dy * dy * 1.6 > 1) continue;
      const lit = (c * 7 + y * 13 + 2) % 37 === 0;
      dots.push(<circle key={`${c}-${y}`} cx={2.5 + c * 5} cy={2.5 + y * 5} r={1.1} fill={lit ? "var(--acc)" : "currentColor"} fillOpacity={lit ? 0.7 : 0.12} />);
    }
  return <svg className="plate" width="260" height="56" viewBox="0 0 260 56" aria-hidden="true">{dots}</svg>;
}

/** The address's QR (qr.ts), drawn in the text colour on the page colour, so it reads in dark and light. */
function Qr({ text }: { text: string }) {
  const { n, d } = useMemo(() => qrOf(text), [text]);
  return (
    <div className="qr" data-qr={text}>
      <svg viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" aria-hidden="true">
        <path d={d} fill="currentColor" />
      </svg>
    </div>
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
