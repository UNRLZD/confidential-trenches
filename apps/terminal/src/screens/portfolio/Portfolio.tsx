import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { POOL_ASSET_DECIMALS } from "@blindfill/kit";
import { useReturnHop } from "../../shell/ReturnHop.tsx";
import { HopLine } from "../signin/HopLine.tsx";
import { Avatar } from "../market/Avatar.tsx";
import { ActivityList } from "./Activity.tsx";
import type { ActUi } from "./Activity.tsx";
import { ExitIc, Ic } from "./icons.tsx";
import { activity, amount, calendar, cents, closedRows, EDGES, filterActivity, filterRows, held, line, NO_FILTER, pct, portfolio, restored, shortAddress, stats, units, usd, walletRows } from "./model.ts";
import type { ClosedRow, PoolRow, Pools, Range, Row, Stats, Totals, WalletRow } from "./model.ts";
import { usePortfolioSource } from "./source.tsx";
import type { PortfolioAction, PortfolioSource } from "./source.tsx";
import { W } from "./W.tsx";
import { WORDS } from "./words.ts";
import "./portfolio.css";

// Portfolio (S10, A3.1 app.md:1459) and Activity (S14). The layout and look are R5's (design/proto/portfolio-1440.html
// and portfolio-390.html at design-lock-r5; M172), the words, states and data limits the brief's (09-design-brief S10,
// S14). Desktop: the header row of three panels (the total with Where it is and the value line; the PnL calendar; how
// you trade), then the positions table (Open / Closed, search, hide small) beside Allocation and Activity. Phone: the
// total, Deposit and Withdraw, the dot line, the breakdown and Where it is, then the sticky segments Positions, Orders
// (a link to the Orders route), Activity and Stats, and a position's action sheet (S10.13). Both forms are in the page
// and CSS shows one, as the shell does. Every sell, exit plan, share, export and view-key tap goes to the mount
// (PortfolioAction): those screens are other cards'. `data-states` on the root lists every brief state on screen.
// Every wallet that holds money has its own export (card app-export-every-wallet): a position row's Export key icon for
// each wallet that holds it (one wallet: the icon opens it; more: a menu of their addresses), the phone sheet's Export
// row per wallet, and Wallets under the pools for each wallet the kit's moneyWallets names that holds no position. Each
// export control carries data-export-chain and data-export-address, the wallet it asks SIGN_HOST to open.

export type Pane = "positions" | "activity" | "stats";

export interface Ui {
  range: Range;
  closed: boolean;
  q: string;
  hideSmall: boolean;
  pane: Pane;
  act: ActUi;
  sheet: string | null;
  menu: string | null;
}

export const START: Ui = { range: "1W", closed: false, q: "", hideSmall: false, pane: "positions", act: { filter: NO_FILTER, open: null }, sheet: null, menu: null };

const sgn = (c: bigint | null) => (c === null ? "" : c >= 0n ? "gain" : "loss");
const RANGES: Range[] = ["1D", "1W", "1M", "All"];
const RANGE_WORD = { "1D": "r1D", "1W": "r1W", "1M": "r1M", All: "rAll" } as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const Sk = ({ w, h, r }: { w: number; h: number; r?: number }) => <span className="sk" style={{ width: w, height: h, borderRadius: r }} />;
const DASH = <span className="t3">{"—"}</span>;

export function Portfolio({ onAction = () => {}, initial = START }: { onAction?: (a: PortfolioAction) => void; initial?: Ui }) {
  const src = usePortfolioSource(onAction);
  const [ui, set] = useState<Ui>(initial);
  const setUi = (p: Partial<Ui>) => set((u) => ({ ...u, ...p }));
  const now = src.now();
  const pf = portfolio(src.snapshot, src.data, now);
  const loading = pf.view === "S10.1";
  const closed = closedRows(src.data);
  const st = stats(closed);
  const list = ui.closed ? [] : filterRows(pf.rows, ui.q, ui.hideSmall);
  const closedList = ui.closed ? closed.filter((c) => !ui.q.trim() || c.symbol.toLowerCase().includes(ui.q.trim().toLowerCase())) : [];
  const acts = activity(src.snapshot.state?.ops, src.data);
  const actRows = filterActivity(acts, ui.act.filter, src.data);
  const sheetRow = ui.sheet ? pf.rows.find((r) => r.key === ui.sheet) ?? null : null;

  // every brief state on screen, for the shot run and the checks
  const states = new Set<string>([pf.view]);
  if (!loading) states.add(st.trades ? "S10.9" : "S10.14");
  if (pf.offline) states.add("S10.5");
  if (pf.totals?.partial) states.add("S10.4");
  for (const r of list) {
    if (r.mark === "noRoute") states.add("S10.6");
    if (r.mark === "reverted") states.add("S10.7");
    if (r.mark === "held") states.add("S10.8");
    if (r.selling) states.add("S10.12");
  }
  if (ui.closed) states.add("S10.10");
  if (ui.q.trim() || ui.hideSmall) states.add("S10.11");
  if (sheetRow) states.add("S10.13");
  if (ui.pane === "activity" && !loading) {
    states.add(acts.length ? "S14.2" : "S14.1");
    if (restored(src.snapshot.state?.ops)) states.add("S14.3");
    if (actRows.some((r) => r.kind === "export")) states.add("S14.4");
    if (ui.act.filter.kinds.length || ui.act.filter.min > 0n || ui.act.filter.q.trim()) states.add("S14.5");
    if (ui.act.open && actRows.some((r) => r.id === ui.act.open)) states.add("S14.6");
  }
  const stateList = [...states].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).join(" ");

  const actList = <ActivityList src={src} ui={ui.act} setUi={(a) => setUi({ act: a })} />;
  return (
    <div className="pf" data-screen="portfolio" data-state={pf.view} data-states={stateList} data-offline={pf.offline || undefined}>
      <div className="pfd">
        <div className="pfh">
          <Equity src={src} t={pf.totals} pools={pf.pools} loading={loading} offline={pf.offline} rows={pf.rows} ui={ui} setUi={setUi} now={now} />
          <Calendar closed={closed} now={now} loading={loading} />
          <HowYouTrade st={st} fees={src.data.fees} loading={loading} />
        </div>
        <div className="pfb">
          <section className="panel pft">
            <div className="bar1">
              <span className="t on"><W id="positions" /><span className="n">{pf.rows.length || ""}</span></span>
              <div className="seg sm">
                <button type="button" className={ui.closed ? "" : "on"} data-control="open" onClick={() => setUi({ closed: false })}><W id="open" /></button>
                <button type="button" className={ui.closed ? "on" : ""} data-control="closed" onClick={() => setUi({ closed: true })}><W id="closed" /></button>
              </div>
              <span className="grow" />
              <label className={`srch ${ui.q ? "on" : ""}`}>
                <Ic name="search" size={13} />
                <input value={ui.q} placeholder={WORDS.search.text} aria-label={WORDS.search.text} data-field="search" onChange={(e) => setUi({ q: e.target.value })} />
              </label>
              <button type="button" className="hs" aria-pressed={ui.hideSmall} data-control="hide-small" onClick={() => setUi({ hideSmall: !ui.hideSmall })}>
                <span className={`tgl ${ui.hideSmall ? "on" : ""}`} />
                <W id="hideSmall" />
              </button>
            </div>
            <div className="ptw">
              <table className="pt">
                <colgroup>
                  <col style={{ width: 250 }} /><col style={{ width: 96 }} /><col style={{ width: 96 }} /><col style={{ width: 116 }} /><col style={{ width: 104 }} /><col style={{ width: 150 }} /><col style={{ width: 104 }} /><col style={{ width: 170 }} /><col style={{ width: 70 }} /><col />
                </colgroup>
                <thead>
                  <tr>
                    <th className="l"><W id="token" /></th><th><W id="bought" /></th><th><W id="sold" /></th><th><W id="holding" /></th><th><W id="value" /></th><th><W id="pnl" /></th><th><W id="realized" /></th><th className="l"><W id="tpsl" /></th><th><W id="heldFor" /></th><th />
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: 9 }, (_, i) => (
                        <tr key={i}><td className="l"><div className="tok"><Sk w={34} h={34} r={17} /><Sk w={90} h={14} /></div></td>{Array.from({ length: 6 }, (_, j) => <td key={j}><Sk w={64} h={13} /></td>)}<td /><td /><td /></tr>
                      ))
                    : ui.closed
                      ? closedList.map((c) => <ClosedTr key={c.key} c={c} />)
                      : list.map((r) => <PosTr key={r.key} r={r} now={now} menu={ui.menu === r.key ? "more" : ui.menu === `export:${r.key}` ? "export" : null} setMenu={(m) => setUi({ menu: m === "more" ? r.key : m === "export" ? `export:${r.key}` : null })} act={src.act} />)}
                </tbody>
              </table>
              {!loading && (ui.closed ? closedList.length === 0 : list.length === 0) && (
                <div className="empty"><Plate /><span><W id="noPositions" /></span></div>
              )}
            </div>
          </section>
          <div className="pfr">
            <section className="panel alc">
              <div className="hd2 pvtabs">
                <span className="row-flex">
                  <button type="button" className={`tt ${ui.pane === "activity" ? "" : "on"}`} data-control="pane-allocation" onClick={() => setUi({ pane: "positions" })}><W id="allocation" /></button>
                  <button type="button" className={`tt ${ui.pane === "activity" ? "on" : ""}`} data-control="pane-activity" onClick={() => setUi({ pane: "activity" })}><W id="activity" /><span className="n num">{acts.length || ""}</span></button>
                </span>
                {ui.pane !== "activity" && pf.totals && <span className="t3 num">{usd(pf.totals.inPos)}</span>}
              </div>
              {ui.pane === "activity" ? actList : <Allocation rows={pf.rows} loading={loading} />}
            </section>
          </div>
        </div>
      </div>

      <div className="pfm">
        <PhoneTop src={src} t={pf.totals} pools={pf.pools} loading={loading} offline={pf.offline} rows={pf.rows} ui={ui} setUi={setUi} now={now} />
        <div className="sticky">
          <div className="msegs" role="tablist">
            <button type="button" role="tab" className={`t ${ui.pane === "positions" ? "on" : ""}`} data-control="seg-positions" onClick={() => setUi({ pane: "positions" })}><W id="positions" />{pf.rows.length > 0 && <span className="n">{pf.rows.length}</span>}</button>
            <Link to="/orders" className="t" data-control="seg-orders"><W id="orders" /></Link>
            <button type="button" role="tab" className={`t ${ui.pane === "activity" ? "on" : ""}`} data-control="seg-activity" onClick={() => setUi({ pane: "activity" })}><W id="activity" /></button>
            <button type="button" role="tab" className={`t ${ui.pane === "stats" ? "on" : ""}`} data-control="seg-stats" onClick={() => setUi({ pane: "stats" })}><W id="stats" /></button>
          </div>
        </div>
        {ui.pane === "activity" ? (
          actList
        ) : ui.pane === "stats" ? (
          <PhoneStats st={st} closed={closed} now={now} realized={pf.totals?.realized30 ?? null} />
        ) : loading ? (
          Array.from({ length: 6 }, (_, i) => <div className="mpr" key={i}><Sk w={44} h={44} r={22} /><div><Sk w={80} h={14} /><div style={{ height: 6 }} /><Sk w={50} h={11} /></div><div><Sk w={70} h={14} /></div><span /></div>)
        ) : pf.rows.length === 0 ? (
          <div className="empty"><Plate /><span><W id="noPositions" /></span></div>
        ) : (
          pf.rows.map((r) => <PhoneRow key={r.key} r={r} onOpen={() => setUi({ sheet: r.key })} act={src.act} />)
        )}
        {sheetRow && <Sheet r={sheetRow} close={() => setUi({ sheet: null })} act={src.act} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------- desktop

interface HeadProps {
  src: PortfolioSource;
  t: Totals | null;
  pools: Pools;
  loading: boolean;
  offline: boolean;
  rows: Row[];
  ui: Ui;
  setUi(p: Partial<Ui>): void;
  now: number;
}

function Equity({ src, t, pools, loading, offline, rows, ui, setUi, now }: HeadProps) {
  const pts = line(src.data.series, ui.range, now);
  const change = t && pts.length ? t.total - pts[0]![1] : null;
  const v = (c: bigint | null, plus = true): ReactNode => (loading ? <Sk w={80} h={16} /> : c === null || !t ? DASH : <span className={sgn(c)}>{usd(c, plus)}</span>);
  return (
    <section className="panel eq" data-panel="equity">
      <div className="eqtop">
        <div>
          <div className="lb"><span className="t3"><W id="total" /></span>{offline && <span className="tag warn" data-offline-tag><W id="offline" /></span>}</div>
          <div className="row-flex tl">
            <div className="tot num" data-total={t ? t.total.toString() : undefined}>{loading ? <Sk w={170} h={30} /> : usd(t?.total ?? 0n)}</div>
            {change !== null && <span className={`pill2 ${change >= 0n ? "g" : "r"}`}>{usd(change, true)}</span>}
          </div>
        </div>
        <span className="grow" />
        <div className="brk">
          <div><div className="k"><W id="unrealized" /></div><div className="v num">{v(t && rows.length ? t.unreal : null)}</div></div>
          <div><div className="k"><W id="realized30" /></div><div className="v num">{v(t && (src.data.closed.length || t.realized30) ? t.realized30 : null)}</div></div>
        </div>
      </div>
      <div className="eqsplit">
        <div className="eqbrk">
          <div className="eqh"><W id="whereItIs" /></div>
          <Where t={t} loading={loading} />
          <PoolRows p={pools} src={src} />
          <WalletRows src={src} />
        </div>
        <div className="eqch">
          <div className="ctl">
            <RangeSeg ui={ui} setUi={setUi} />
            <span className="grow" />
            <button type="button" className="btn2" data-control="withdraw" onClick={() => src.act({ kind: "withdraw" })}><Ic name="arrowUp" size={12} /><W id="withdraw" /></button>
          </div>
          <div className="chart">{loading ? <Sk w={440} h={214} /> : pts.length < 2 ? <Plate /> : <LineChart pts={pts} />}</div>
        </div>
      </div>
    </section>
  );
}

function RangeSeg({ ui, setUi }: { ui: Ui; setUi(p: Partial<Ui>): void }) {
  return (
    <div className="seg sm">
      {RANGES.map((r) => (
        <button type="button" key={r} className={ui.range === r ? "on" : ""} data-range={r} onClick={() => setUi({ range: r })}><W id={RANGE_WORD[r]} /></button>
      ))}
    </div>
  );
}

/** Where it is: Cash, Positions, On the way and the total, each with its share and a dot strip (R5 P.pvEquity). */
function Where({ t, loading, phone }: { t: Totals | null; loading: boolean; phone?: boolean }) {
  if (loading) return <div className="pvtiles">{Array.from({ length: 4 }, (_, i) => <Sk key={i} w={phone ? 150 : 140} h={phone ? 96 : 58} r={12} />)}</div>;
  const tot = t?.total ?? 0n;
  const parts = [
    { id: "cash", w: "cash" as const, v: t?.cash ?? 0n, col: "var(--paper)" },
    { id: "positions", w: "positions" as const, v: t?.inPos ?? 0n, col: "var(--acc)" },
    { id: "onway", w: "onTheWay" as const, v: t?.onWay ?? 0n, col: "var(--blue)" },
  ];
  return (
    <div className="pvtiles">
      {parts.map((p) => (
        <div className="pvt" key={p.id} data-tile={p.id} style={{ ["--tc" as string]: p.col }}>
          <div className="pvk"><W id={p.w} /></div>
          <div className="pvvr"><span className="pvv num">{usd(p.v)}</span><span className="pvp num">{tot > 0n ? pct(Number((p.v * 10000n) / tot)).replace("+", "") : "—"}</span></div>
          <Strip lit={tot > 0n ? Number((p.v * 40n) / tot) : 0} col={p.col} />
        </div>
      ))}
      <div className="pvt pvtot" data-tile="total">
        <div className="pvk"><W id="total" /></div>
        <div className="pvvr"><span className="pvv num">{usd(tot)}</span></div>
        <Strip lit={tot > 0n ? 40 : 0} col="var(--acc)" />
      </div>
    </div>
  );
}

// Chain names are names, drawn as data.
const CHAIN_NAME = { solana: "Solana", base: "Base", robinhood: "Robinhood", near: "NEAR" } as const;

/** Each chain's pool (card balances-per-chain, v2 A1), in its own asset: the private balance from the device's own
 *  notes ("12.5 SOL"), the part ready to buy (a proof made) and the rest still being proved, in the same unit. No dollar
 *  figure: a SOL or ETH pool has none until a price read exists. No proof queue running: Ready and Pending are dashes,
 *  never 0. data-pools names the view, each row its chain, asset and base units, for the checks.
 *  Each row with a balance ends in Withdraw (card app-pool-withdraw): an icon that opens SIGN_HOST's pool withdraw for
 *  that chain, where the amount and the address are typed; an open that did not happen draws its HopLine on the
 *  heading's row (portfolio.css), so the block never grows inside the desktop panel. */
function PoolRows({ p, src, phone }: { p: Pools; src: PortfolioSource; phone?: boolean }) {
  const { locked } = useReturnHop();
  const on = src.snapshot.status === "ready" && locked === null;
  const cols = p.view === "rows" || p.view === "unread" || p.view === "loading";
  const amt = (r: PoolRow, c: bigint | null, cls = ""): ReactNode => (c === null ? DASH : <span className={cls}>{amount(c, r.decimals)}</span>);
  return (
    <div className={`pools${phone ? " ph" : ""}`} data-pools={p.view}>
      <span className="plk"><W id="privateBalance" /></span>
      {cols ? (
        <><span /><span className="plc"><W id="balance" /></span><span className="plc"><W id="ready" /></span><span className="plc"><W id="pending" /></span><span /></>
      ) : (
        <span className="plst" data-pools-state={p.view}>{p.view === "offline" ? <W id="offline" /> : <W id="noBalance" />}</span>
      )}
      {p.view === "loading" &&
        [0, 1].map((i) => (
          <div className="plr" key={i}><Sk w={64} h={12} /><Sk w={56} h={12} /><Sk w={48} h={12} /><Sk w={48} h={12} /><span /></div>
        ))}
      {p.view === "unread" && (
        <div className="plr" data-pool="unread"><span className="t3">{"—"}</span><span className="num">{DASH}</span><span className="num">{DASH}</span><span className="num">{DASH}</span><span /></div>
      )}
      {p.view === "rows" &&
        p.rows.map((r) => (
          <div className="plr" key={r.chain} data-pool={r.chain} data-asset={r.asset} data-balance={r.balance.toString()} data-ready={r.ready === null ? "none" : r.ready.toString()} data-pending={r.pending === null ? "none" : r.pending.toString()}>
            <span className="ell">{CHAIN_NAME[r.chain]}</span>
            <span className="num">{amount(r.balance, r.decimals)} <span className="t3">{r.asset}</span></span>
            <span className="num">{amt(r, r.ready, r.ready ? "gain" : "")}</span>
            <span className="num t2">{amt(r, r.pending)}</span>
            <PoolWithdraw r={r} on={on} act={src.act} />
            <HopLine control={`pool-withdraw-${r.chain}`} />
          </div>
        ))}
    </div>
  );
}

/** A pool row's Withdraw: the chain only goes to the mount (PortfolioAction pool-withdraw); off with nothing held. */
function PoolWithdraw({ r, on, act }: { r: PoolRow; on: boolean; act: PortfolioSource["act"] }) {
  if (r.chain === "near") return <span />;
  const chain = r.chain;
  const control = `pool-withdraw-${chain}`;
  return (
    <button type="button" className="plw" data-control={control} aria-label={WORDS.withdraw.text} title={WORDS.withdraw.text} disabled={!on || r.balance === 0n} onClick={() => act({ kind: "pool-withdraw", chain })}>
      <Ic name="arrowUp" size={12} />
    </button>
  );
}

/** Wallets (card app-export-every-wallet): each wallet that holds money and no open position, by chain, its short
 *  address, what it holds (a deposit wallet's balance in its asset, a trade wallet's size) and its Export key icon. Drawn
 *  only when there is one, in the pools' grid. */
function WalletRows({ src, phone }: { src: PortfolioSource; phone?: boolean }) {
  const rows = walletRows(src.snapshot.state);
  if (!rows.length) return null;
  const holds = (w: WalletRow): ReactNode =>
    w.amount !== null && w.asset !== null ? <>{amount(w.amount, POOL_ASSET_DECIMALS[w.asset])} <span className="t3">{w.asset}</span></> : w.size !== null ? usd(w.size) : DASH;
  return (
    <div className={`pools wls${phone ? " ph" : ""}`} data-wallets={rows.length}>
      <span className="plk"><W id="wallets" /></span>
      {rows.map((w) => (
        <div className="plr" key={`${w.chain}:${w.address}`} data-wallet={w.address} data-wallet-chain={w.chain} data-wallet-role={w.role}>
          <span className="ell">{CHAIN_NAME[w.chain]}</span>
          <span className="t2 adr" title={w.address}>{shortAddress(w.address)}</span>
          <span className="num">{holds(w)}</span>
          <span />
          <ExportKey chain={w.chain} address={w.address} act={src.act} className="plw" size={12} />
        </div>
      ))}
    </div>
  );
}

/** One wallet's Export key icon: asks the mount for that wallet's export.open, by its chain and address. */
function ExportKey({ chain, address, act, className, size = 14 }: { chain: Row["chain"]; address: string; act: PortfolioSource["act"]; className: string; size?: number }) {
  return (
    <button type="button" className={className} data-control="export" data-export-chain={chain} data-export-address={address} aria-label={WORDS.exportKey.text} title={WORDS.exportKey.text} onClick={() => act({ kind: "export", chain, address })}>
      <Ic name="key" size={size} />
    </button>
  );
}

function Strip({ lit, col }: { lit: number; col: string }) {
  return (
    <svg className="pvtstrip" width="100%" height="15" viewBox="0 0 240 15" preserveAspectRatio="none" aria-hidden="true">
      {Array.from({ length: 40 }, (_, c) =>
        [0, 1, 2].map((y) => <circle key={`${c}-${y}`} cx={3 + c * 6} cy={2.5 + y * 5} r={1.3} fill={c < lit ? col : "var(--paper)"} fillOpacity={c < lit ? 0.45 + 0.27 * y : 0.06} />),
      )}
    </svg>
  );
}

function LineChart({ pts }: { pts: [number, bigint][] }) {
  const Wd = 440;
  const H = 214;
  const AX = 54;
  const pw = Wd - AX;
  const t0 = pts[0]![0];
  const t1 = pts.at(-1)![0];
  const vals = pts.map((p) => Number(p[1]) / 100);
  const lo = Math.min(...vals) * 0.995;
  const hi = Math.max(...vals) * 1.004 || 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (pw - 10) + 4;
  const y = (v: number) => H - 24 - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 40);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(vals[i]!).toFixed(1)}`).join("");
  const grid = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 4);
  const lx = x(t1);
  const ly = y(vals.at(-1)!);
  return (
    <svg width={Wd} height={H} viewBox={`0 0 ${Wd} ${H}`} className="eqsvg" aria-hidden="true">
      <defs>
        <linearGradient id="pf-eqg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#50e397" stopOpacity=".22" /><stop offset="1" stopColor="#50e397" stopOpacity="0" /></linearGradient>
      </defs>
      {grid.map((g) => (
        <g key={g}>
          <line x1="0" x2={pw} y1={y(g)} y2={y(g)} stroke="#171717" />
          <text x={pw + 8} y={y(g) + 4} fontFamily="Chivo Mono" fontSize="11" fill="#6e6e6e">${Math.round(g)}</text>
        </g>
      ))}
      <path d={`${d}L${lx.toFixed(1)} ${H - 22}L${x(t0).toFixed(1)} ${H - 22}z`} fill="url(#pf-eqg)" />
      <path d={d} stroke="#50e397" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="4" fill="#50e397" />
      <circle cx={lx} cy={ly} r="8" fill="#50e397" fillOpacity=".18" />
    </svg>
  );
}

function Calendar({ closed, now, loading }: { closed: ClosedRow[]; now: number; loading: boolean }) {
  const c = calendar(closed, now);
  const none = closed.length === 0;
  return (
    <section className="panel cal" data-panel="calendar">
      <div className="hd"><span className="num-ui">{MONTHS[c.month]}</span><span className={`s num ${none ? "" : sgn(c.sum)}`}>{none || loading ? "—" : usd(c.sum, true)}</span></div>
      <div className="calg">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span className="dw" key={d}>{d}</span>)}
        {Array.from({ length: c.lead }, (_, i) => <span key={`l${i}`} />)}
        {c.days.map((d) => (
          <span key={d.day} className={`c ${d.future ? "fut" : d.pnl === null ? "pre" : d.pnl > 0n ? "g" : d.pnl < 0n ? "r" : "z"} ${d.today ? "today" : ""}`} data-day={d.day}>
            <span className="d num">{d.day}</span>
            <span className="p num">{loading ? "" : d.pnl !== null && d.pnl !== 0n ? usd(d.pnl, true) : d.pnl === null && !d.future ? "—" : ""}</span>
          </span>
        ))}
      </div>
      <div className="calf">
        <span><span className="gain num">{c.green}</span> <W id="greenDays" />  <span className="loss num">{c.red}</span> <W id="red" /></span>
      </div>
    </section>
  );
}

function Ring({ st, size = 104 }: { st: Stats; size?: number }) {
  const C = 2 * Math.PI * 40;
  const p = st.winBps;
  return (
    <svg width={size} height={size} viewBox="0 0 104 104" aria-hidden="true">
      <circle cx="52" cy="52" r="40" fill="none" stroke={p === null ? "#1f1f1f" : "rgba(255,93,77,.5)"} strokeWidth="9" />
      {p !== null && <circle cx="52" cy="52" r="40" fill="none" stroke="#50e397" strokeWidth="9" strokeDasharray={`${(C * p) / 10000} ${C}`} transform="rotate(-90 52 52)" />}
      <text x="52" y={p === null ? 57 : 56} textAnchor="middle" fontFamily="Chivo Mono" fontSize={p === null ? 16 : 20} fill={p === null ? "#6e6e6e" : "#f4f4f2"}>{p === null ? "—" : `${Math.round(p / 100)}%`}</text>
    </svg>
  );
}

const BUCKETS = ["−100%", "−50%", "−20%", "0%", "+20%", "+50%", "+100%", "+300%"];

function HowYouTrade({ st, fees, loading }: { st: Stats; fees: string | null; loading: boolean }) {
  const none = st.trades === 0 || loading;
  const d = (x: ReactNode) => (none ? DASH : x);
  const mx = Math.max(1, ...st.buckets);
  const fc = cents(fees);
  return (
    <section className="panel wr" data-panel="stats">
      <div className="hd"><span><W id="howYouTrade" /></span><span className="ct num">{st.trades} <W id="closedTrades" /></span></div>
      <div className="ring">
        <div className="rw"><Ring st={none ? { ...st, winBps: null } : st} /><span className="rl"><W id="winRate" /></span></div>
        <div className="kv2">
          <div><div className="k"><W id="avgWin" /></div><div className="v gain num">{d(pct(st.avgWinBps))}</div></div>
          <div><div className="k"><W id="avgLoss" /></div><div className="v loss num">{d(pct(st.avgLossBps))}</div></div>
          <div><div className="k"><W id="avgHold" /></div><div className="v num">{d(st.avgHoldMs === null ? "" : held(st.avgHoldMs))}</div></div>
          <div><div className="k"><W id="feesPaid" /></div><div className="v num">{fc === null ? DASH : usd(fc)}</div></div>
        </div>
      </div>
      <div className="hd rpt"><span className="k"><W id="returnPerTrade" /></span><span className={`num ${st.avgRetBps !== null && st.avgRetBps < 0 ? "loss" : "gain"}`}>{d(pct(st.avgRetBps))}</span></div>
      <div className="hist">
        {st.buckets.map((n, i) => (
          <div className="b" key={i}>
            <span className="n num">{none ? "" : n || ""}</span>
            <i style={{ height: none ? 4 : Math.max(3, (n / mx) * 70), background: none || !n ? "#1f1f1f" : EDGES[i]! < 0 ? "rgba(255,93,77,.8)" : "rgba(80,227,151,.8)" }} />
            <span className="e num">{BUCKETS[i]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MarkTag({ r }: { r: Row }) {
  if (r.mark === "noRoute") return <span className="tag grey" data-mark="noRoute"><W id="noRoute" /></span>;
  if (r.mark === "reverted") return <span className="tag sell" data-mark="reverted"><W id="reverted" /></span>;
  if (r.mark === "held") return <span className="tag warn" data-mark="held"><W id="held" /></span>;
  return null;
}

function Selling({ r }: { r: Row }) {
  if (!r.selling) return null;
  return r.selling.stage === "sending" ? <W id="sending" /> : <><W id="landing" /> <span className="live num">{(r.selling.ms / 1000).toFixed(1)}s</span></>;
}

function PosTr({ r, now, menu, setMenu, act }: { r: Row; now: number; menu: "more" | "export" | null; setMenu(m: "more" | "export" | null): void; act(a: PortfolioAction): void }) {
  const at = { chain: r.chain, token: r.token };
  const one = r.addresses.length === 1 ? r.addresses[0]! : null;
  return (
    <tr className={menu || r.selling ? "hov" : ""} data-pos={r.key}>
      <td className="l">
        <div className="tok"><Avatar symbol={r.symbol} size={34} /><div className="ell"><div className="sy">{r.symbol}<MarkTag r={r} /></div><div className="s2 ui ell">{r.name}</div></div></div>
      </td>
      <td>{usd(r.bought)}</td>
      <td>{r.sold ? usd(r.sold) : DASH}</td>
      <td>{units(r.units)}<div className="s2">{r.symbol}</div></td>
      <td data-value>{r.value === null ? DASH : usd(r.value)}</td>
      <td className={sgn(r.pnl)} data-pnl>{r.pnl === null ? DASH : <>{usd(r.pnl, true)}<div className={`s2 ${sgn(r.pnl)}`}>{pct(r.pnlBps)}</div></>}</td>
      <td className={r.realized ? sgn(r.realized) : ""}>{r.realized ? usd(r.realized, true) : DASH}</td>
      <td className="l">
        {r.exit ? (
          <span className="xs"><span className="xt tp num">TP {pct(r.exit.tp_bps).replace(".0", "")}</span><span className="xt sl num">SL {pct(-r.exit.sl_bps).replace(".0", "")}</span></span>
        ) : (
          <button type="button" className="addx" data-control="exit" onClick={() => act({ kind: "exit", ...at })}><ExitIc size={26} /><W id="addExit" /></button>
        )}
      </td>
      <td className="t2">{r.openedAt !== null ? held(now - r.openedAt) : DASH}</td>
      <td className="actd">
        <div className="acts">
          {r.selling ? (
            <span className="q live" data-selling={r.selling.stage}><Selling r={r} /></span>
          ) : (
            <span className="qs">
              {(["25", "50", "100"] as const).map((p) => <button type="button" key={p} className="q num" data-control={`sell-${p}`} onClick={() => act({ kind: "sell", ...at, part: p })}>{p}%</button>)}
            </span>
          )}
          <button type="button" className="sec sell" data-control="sell" onClick={() => act({ kind: "sell", ...at, part: "box" })}><W id="sell" /></button>
          {one !== null ? (
            <ExportKey chain={r.chain} address={one} act={act} className="ico" />
          ) : r.addresses.length > 1 ? (
            <button type="button" className={`ico ${menu === "export" ? "on" : ""}`} aria-expanded={menu === "export"} aria-label={WORDS.exportKey.text} title={WORDS.exportKey.text} data-control="export-menu" data-export-count={r.addresses.length} onClick={() => setMenu(menu === "export" ? null : "export")}><Ic name="key" size={14} /></button>
          ) : null}
          <button type="button" className={`ico ${menu === "more" ? "on" : ""}`} aria-expanded={menu === "more"} aria-label={WORDS.more.text} data-control="more" onClick={() => setMenu(menu === "more" ? null : "more")}><Ic name="more" size={16} stroke={1.6} /></button>
          {menu === "more" && (
            <div className="menu rmenu">
              <button type="button" className="mi" data-control="share" onClick={() => (setMenu(null), act({ kind: "share", ...at }))}><Ic name="share" /><W id="share" /></button>
            </div>
          )}
          {menu === "export" && (
            <div className="menu rmenu" data-menu="export">
              {r.addresses.map((a) => (
                <button type="button" key={a} className="mi" data-control="export" data-export-chain={r.chain} data-export-address={a} title={a} onClick={() => (setMenu(null), act({ kind: "export", chain: r.chain, address: a }))}><Ic name="key" /><span className="num">{shortAddress(a)}</span></button>
              ))}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function ClosedTr({ c }: { c: ClosedRow }) {
  return (
    <tr data-closed={c.key}>
      <td className="l"><div className="tok"><Avatar symbol={c.symbol} size={34} /><div className="ell"><div className="sy">{c.symbol}</div><div className="s2 ui ell">{c.name}</div></div></div></td>
      <td>{usd(c.bought)}</td>
      <td>{usd(c.sold)}</td>
      <td>0</td>
      <td>{DASH}</td>
      <td>{DASH}</td>
      <td className={sgn(c.realized)}>{usd(c.realized, true)}<div className={`s2 ${sgn(c.realized)}`}>{pct(c.realizedBps)}</div></td>
      <td className="l">{DASH}</td>
      <td className="t2">{held(c.heldMs)}</td>
      <td />
    </tr>
  );
}

/** Allocation (R5 cur-18): a map sized by value, tinted by PnL. Priceless rows are left out. */
function Allocation({ rows, loading }: { rows: Row[]; loading: boolean }) {
  if (loading) return <div className="amap"><Sk w={440} h={400} r={10} /></div>;
  const items = rows.filter((r) => r.value !== null && r.value > 0n).map((r) => ({ r, v: Number(r.value) }));
  if (!items.length) return <div className="amap empty"><Plate /></div>;
  const rects: { r: Row; x: number; y: number; w: number; h: number }[] = [];
  const split = (arr: typeof items, x: number, y: number, w: number, h: number) => {
    if (arr.length === 1) return void rects.push({ r: arr[0]!.r, x, y, w, h });
    const tot = arr.reduce((a, b) => a + b.v, 0);
    let acc = 0;
    let k = 0;
    while (k < arr.length - 1 && acc + arr[k]!.v <= tot / 2) acc += arr[k++]!.v;
    if (k === 0) {
      acc = arr[0]!.v;
      k = 1;
    }
    const f = acc / tot;
    if (w >= h) {
      split(arr.slice(0, k), x, y, w * f, h);
      split(arr.slice(k), x + w * f, y, w * (1 - f), h);
    } else {
      split(arr.slice(0, k), x, y, w, h * f);
      split(arr.slice(k), x, y + h * f, w, h * (1 - f));
    }
  };
  split(items, 0, 0, 100, 100);
  return (
    <div className="amap">
      {rects.map(({ r, x, y, w, h }) => {
        const a = Math.min(1, Math.abs((r.pnlBps ?? 0) / 6000));
        const bg = (r.pnl ?? 0n) >= 0n ? `rgba(80,227,151,${(0.08 + 0.3 * a).toFixed(2)})` : `rgba(255,93,77,${(0.08 + 0.3 * a).toFixed(2)})`;
        const big = w > 19 && h > 15;
        return (
          <div className="at" key={r.key} style={{ left: `${x}%`, top: `${y}%`, width: `calc(${w}% - 4px)`, height: `calc(${h}% - 4px)`, background: bg }}>
            <div className="row-flex">{big && <Avatar symbol={r.symbol} size={32} />}{w > 13 && <span className="as ell">{r.symbol}</span>}</div>
            {big && <div className="av3 num">{usd(r.value!)}<div className={sgn(r.pnl)}>{pct(r.pnlBps)}</div></div>}
          </div>
        );
      })}
    </div>
  );
}

/** R5's empty-state plate: paper dots, a few lit. */
function Plate() {
  const dots = [];
  for (let c = 0; c < 44; c++)
    for (let y = 0; y < 12; y++) {
      const fade = 1 - Math.abs(c - 22) / 22;
      const lit = (c * 7 + y * 13) % 29 === 0;
      dots.push(<circle key={`${c}-${y}`} cx={3 + c * 6} cy={3 + y * 6} r={1.2} fill={lit ? "#50e397" : "#f4f4f2"} fillOpacity={lit ? 0.7 : 0.05 + 0.1 * fade} />);
    }
  return <svg className="plate" width="264" height="72" viewBox="0 0 264 72" aria-hidden="true">{dots}</svg>;
}

// ------------------------------------------------------------------------------------------------------------ phone

function PhoneTop({ src, t, pools, loading, offline, rows, ui, setUi, now }: HeadProps) {
  const pts = line(src.data.series, ui.range, now);
  const v = (c: bigint | null): ReactNode => (loading ? <Sk w={70} h={18} /> : c === null || !t ? "—" : <span className={sgn(c)}>{usd(c, true)}</span>);
  return (
    <div className="mpf">
      <div className="lbl"><W id="total" />{offline && <span className="tag warn" data-offline-tag><W id="offline" /></span>}</div>
      <div className="tot num">{loading ? <Sk w={220} h={46} /> : usd(t?.total ?? 0n)}</div>
      <div className="macts">
        <button type="button" className="mbtn buy" data-control="deposit" onClick={() => src.act({ kind: "deposit" })}><Ic name="arrowDown" size={14} /><W id="deposit" /></button>
        <button type="button" className="mbtn ghost" data-control="withdraw" onClick={() => src.act({ kind: "withdraw" })}><Ic name="arrowUp" size={14} /><W id="withdraw" /></button>
      </div>
      <div className="chartw">
        <DotLine pts={loading ? [] : pts} />
        <div className="seg4">
          {RANGES.map((r) => (
            <button type="button" key={r} className={ui.range === r ? "on" : ""} data-range={r} onClick={() => setUi({ range: r })}><span><W id={RANGE_WORD[r]} /></span></button>
          ))}
        </div>
      </div>
      <div className="brk two">
        <div><div className="k"><W id="unrealized" /></div><div className="v num">{v(t && rows.length ? t.unreal : null)}</div></div>
        <div><div className="k"><W id="realized30" /></div><div className="v num">{v(t && (src.data.closed.length || t.realized30) ? t.realized30 : null)}</div></div>
      </div>
      <div className="mwhere">
        <div className="lbl2"><W id="whereItIs" /></div>
        <Where t={t} loading={loading} phone />
        <PoolRows p={pools} src={src} phone />
        <WalletRows src={src} phone />
      </div>
    </div>
  );
}

/** R5's dot line (portfolio-390.html): 64 columns x 16 rows over the range, each column the value at its end. */
function DotLine({ pts }: { pts: [number, bigint][] }) {
  const cols = 64;
  const rows = 16;
  const Wd = 358;
  const H = 120;
  const cw = Wd / cols;
  const rh = H / rows;
  const known = pts.map((p) => Number(p[1]));
  const lo = known.length ? Math.min(...known) * 0.997 : 0;
  const hi = known.length ? Math.max(...known) * 1.003 : 1;
  const t0 = pts[0]?.[0] ?? 0;
  const t1 = pts.at(-1)?.[0] ?? 1;
  const valAt = (t: number) => {
    let v: number | null = null;
    for (const p of pts) if (p[0] <= t) v = Number(p[1]);
    return v;
  };
  const out = [];
  for (let c = 0; c < cols; c++) {
    const val = pts.length ? valAt(t0 + ((c + 1) / cols) * (t1 - t0)) : null;
    const n = val === null ? -1 : Math.round(((val - lo) / Math.max(1e-9, hi - lo)) * (rows - 1));
    for (let y = 0; y < rows; y++) {
      const fill = y === n ? "#50e397" : y < n ? "#50e397" : "#f4f4f2";
      const op = y === n ? 1 : y < n ? 0.07 + (0.3 * y) / Math.max(1, n) : 0.05;
      out.push(<circle key={`${c}-${y}`} cx={cw * c + cw / 2} cy={H - (rh * y + rh / 2)} r={y === n ? 1.9 : 1.6} fill={fill} fillOpacity={op} />);
    }
  }
  return <svg className="dotline" width="100%" viewBox={`0 0 ${Wd} ${H}`} aria-hidden="true">{out}</svg>;
}

function PhoneRow({ r, onOpen, act }: { r: Row; onOpen(): void; act(a: PortfolioAction): void }) {
  return (
    <div className="mpr" data-pos={r.key} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}>
      <Avatar symbol={r.symbol} size={44} />
      <div className="mn">
        <div className="sy">{r.symbol}{r.exit && <span className="t3"><Ic name="target" size={12} /></span>}<MarkTag r={r} /></div>
        <div className="h num">{units(r.units)}</div>
      </div>
      <div className="vv">
        {r.selling ? (
          <div className="v sell-live" data-selling={r.selling.stage}><Selling r={r} /></div>
        ) : (
          <>
            <div className="v num" data-value>{r.value === null ? "—" : usd(r.value)}</div>
            <span className={`pl num ${r.pnl === null ? "" : r.pnl >= 0n ? "g" : "r"}`}>{pct(r.pnlBps)}</span>
          </>
        )}
      </div>
      <button type="button" className={`sc ${r.selling ? "live" : ""}`} data-control="sell-100" onClick={(e) => (e.stopPropagation(), act({ kind: "sell", chain: r.chain, token: r.token, part: "100" }))}><span className="num">100%</span></button>
    </div>
  );
}

function Sheet({ r, close, act }: { r: Row; close(): void; act(a: PortfolioAction): void }) {
  const at = { chain: r.chain, token: r.token };
  const go = (a: PortfolioAction) => (close(), act(a));
  return (
    <>
      <div className="msheet-scrim" onClick={close} />
      <div className="msheet" role="dialog" aria-label={r.symbol} data-sheet="position">
        <div className="grab"><i /></div>
        <div className="shb">
          <div className="shh"><Avatar symbol={r.symbol} size={44} /><div className="grow"><div className="sy">{r.symbol}</div><div className="h num">{units(r.units)} · {r.value === null ? "—" : usd(r.value)}</div></div><span className={`cpill num ${r.pnl === null ? "" : r.pnl >= 0n ? "g" : "r"}`}>{pct(r.pnlBps)}</span></div>
          <div className="sheetgrid">
            {(["25", "50", "100"] as const).map((p) => <button type="button" key={p} className="num" data-control={`sheet-sell-${p}`} onClick={() => go({ kind: "sell", ...at, part: p })}>{p}%</button>)}
            <button type="button" className="n" data-control="sheet-initials" onClick={() => go({ kind: "sell", ...at, part: "initials" })}><W id="initials" /></button>
          </div>
          <div className="arows">
            <button type="button" className="arow" data-control="sheet-sell" onClick={() => go({ kind: "sell", ...at, part: "box" })}><span className="tile32 sl"><Ic name="arrowDown" /></span><span className="grow"><W id="sell" /></span><Ic name="chevR" size={13} /></button>
            <button type="button" className="arow" data-control="sheet-exit" onClick={() => go({ kind: "exit", ...at })}><span className="tile32"><ExitIc size={32} /></span><span className="grow"><W id="exitPlan" /></span>{r.exit && <><span className="xt tp num">TP {pct(r.exit.tp_bps).replace(".0", "")}</span><span className="xt sl num">SL {pct(-r.exit.sl_bps).replace(".0", "")}</span></>}<Ic name="chevR" size={13} /></button>
            {r.addresses.map((a) => (
              <button type="button" key={a} className="arow" data-control="sheet-export" data-export-chain={r.chain} data-export-address={a} onClick={() => go({ kind: "export", chain: r.chain, address: a })}><span className="tile32"><Ic name="key" /></span><span className="grow"><W id="export" /></span>{r.addresses.length > 1 && <span className="t3 num" title={a}>{shortAddress(a)}</span>}<Ic name="chevR" size={13} /></button>
            ))}
            <button type="button" className="arow" data-control="sheet-share" onClick={() => go({ kind: "share", ...at })}><span className="tile32"><Ic name="share" /></span><span className="grow"><W id="share" /></span><Ic name="chevR" size={13} /></button>
          </div>
        </div>
      </div>
    </>
  );
}

function PhoneStats({ st, closed, now, realized }: { st: Stats; closed: ClosedRow[]; now: number; realized: bigint | null }) {
  const c = calendar(closed, now);
  const none = st.trades === 0;
  const mx = Math.max(1, ...st.buckets);
  const weeks = Math.ceil((c.lead + c.days.length) / 7);
  return (
    <div className="mstats" data-pane="stats">
      <div className="mrow"><span>{MONTHS[c.month]}</span><span className={`num ${none ? "t3" : sgn(c.sum)}`}>{none ? "—" : usd(realized ?? c.sum, true)}</span></div>
      <svg className="mcal" width="100%" viewBox={`0 0 342 ${weeks * 30}`} aria-hidden="true">
        {c.days.map((d) => {
          const i = c.lead + d.day - 1;
          const fill = d.future ? "#f4f4f2" : d.pnl === null ? "#f4f4f2" : d.pnl > 0n ? "#50e397" : d.pnl < 0n ? "#ff5d4d" : "#f4f4f2";
          const op = d.future ? 0.05 : d.pnl === null ? 0.14 : d.pnl === 0n ? 0.5 : 1;
          return <circle key={d.day} cx={(i % 7) * (342 / 7) + 342 / 14} cy={Math.floor(i / 7) * 30 + 15} r={d.today ? 7 : 6} fill={fill} fillOpacity={op} />;
        })}
      </svg>
      <div className="mring">
        <div className="rw"><Ring st={st} size={112} /><span className="rl"><W id="winRate" /></span></div>
        <div className="mkv">
          <div><div className="k"><W id="avgWin" /></div><div className="v num gain">{none ? "—" : pct(st.avgWinBps)}</div></div>
          <div><div className="k"><W id="avgLoss" /></div><div className="v num loss">{none ? "—" : pct(st.avgLossBps)}</div></div>
          <div><div className="k"><W id="avgHold" /></div><div className="v num">{none || st.avgHoldMs === null ? "—" : held(st.avgHoldMs)}</div></div>
          <div><div className="k"><W id="closedTrades" /></div><div className="v num">{st.trades}</div></div>
        </div>
      </div>
      <div className="mrow k"><span><W id="returnPerTrade" /></span><span className={`num ${st.avgRetBps !== null && st.avgRetBps < 0 ? "loss" : "gain"}`}>{none ? "—" : pct(st.avgRetBps)}</span></div>
      <div className="mhist">
        {st.buckets.map((n, i) => (
          <div className="b" key={i}><i style={{ height: none ? 4 : Math.max(3, (n / mx) * 70), background: none || !n ? "#1f1f1f" : EDGES[i]! < 0 ? "#ff5d4d" : "#50e397" }} /><span className="e num">{BUCKETS[i]}</span></div>
        ))}
      </div>
    </div>
  );
}

/** The route's screen, for routes/Screen.tsx: Deposit asks the mount's deposit sheet; every other tap goes there too. */
export function PortfolioRoute() {
  return <Portfolio />;
}
