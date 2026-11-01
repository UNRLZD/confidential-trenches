import { useState } from "react";
import type { MarketSnapshot } from "./fields.ts";
import { COLUMNS, columnRows, rowView } from "./model.ts";
import type { ColumnKey, Level, RowView, Win } from "./model.ts";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./discover.css";
import { Avatar } from "../market/Avatar.tsx";
import { useDiscoverData } from "./data.ts";

// S5 Discover (A2.1, app.md:1454; 09-design-brief S5), drawn after R5's discover-1440.html and discover-390.html
// (design-lock-r5) from a 06b snapshot: four columns from 768 px, one list with tabs on the phone (S5.18). States:
// S5.1 skeleton rows, S5.2 rows, S5.3 No tokens, S5.5 Offline with Retry. The snapshot comes from the caller;
// DiscoverRoute reads it from the helper (data.ts, card app-discover-live). Not here yet, each on its own card: the quick
// buy, the toolbar's presets, chips and filters, search, pause, the watchlist and the stale pill.

export type DiscoverData = { status: "loading" } | { status: "error" } | { status: "ready"; snapshot: MarketSnapshot };

const TITLE: Record<ColumnKey, WordId> = { new: "colNew", trending: "colTrending", hot: "colHot", graduating: "colGraduating" };
/** The column glyph's arc (R5 P.D7COLS ranges) and tone. */
const ARC: Record<ColumnKey, [number, number, string]> = {
  new: [0, 0.2, "#808080"],
  trending: [0.2, 0.75, "#bcbcbc"],
  hot: [0, 1, "var(--blue)"],
  graduating: [0.75, 1, "var(--blue)"],
};
const SKELETON_ROWS = 9;

/** A word, marked when it is still the owner's draft. */
function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
}

function Glyph({ k }: { k: ColumnKey }) {
  const r = 11, c = 2 * Math.PI * r;
  const [a, b, tone] = ARC[k];
  return (
    <svg width="30" height="30" aria-hidden="true">
      <circle cx="15" cy="15" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="3" />
      <circle cx="15" cy="15" r={r} fill="none" stroke={tone} strokeWidth="3" strokeDasharray={`${(c * (b - a)).toFixed(2)} ${c.toFixed(2)}`} strokeDashoffset={(-c * a).toFixed(2)} transform="rotate(-90 15 15)" strokeLinecap="round" />
    </svg>
  );
}

/** The stage ring around the avatar (UNRLZD CurveRing): a curve's progress, full blue once listed. */
function Ring({ v, size, stroke, av }: { v: RowView; size: number; stroke: number; av: number }) {
  const h = size / 2, R = h - stroke / 2 - 1, c = 2 * Math.PI * R;
  const f = v.stage.fill;
  const col = !v.stage.curve ? (f > 0 ? "var(--blue)" : "var(--border-strong)") : f >= 0.75 ? "var(--text-1)" : f >= 0.2 ? "#bcbcbc" : "#808080";
  return (
    <span className="dsc-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={h} cy={h} r={R} fill="none" stroke="var(--border-strong)" strokeWidth={stroke} />
        {f > 0 && <circle cx={h} cy={h} r={R} fill="none" stroke={col} strokeWidth={stroke} strokeDasharray={`${(c * f).toFixed(2)} ${c.toFixed(2)}`} strokeLinecap="round" transform={`rotate(-90 ${h} ${h})`} />}
      </svg>
      <span className="dsc-ravatar" style={{ inset: (size - av) / 2 }}>
        <Avatar symbol={v.symbol} size={av} />
      </span>
    </span>
  );
}

function Pill({ label, value }: { label: WordId; value: { text: string; level: Level } }) {
  const known = value.text !== "—";
  const tip = known ? WORDS[label].text : `${WORDS[label].text}: ${WORDS.notChecked.text}`;
  return (
    <span className="dsc-mp" data-level={value.level} title={tip} data-pill={label}>
      <PillIcon k={label} />
      {value.text}
    </span>
  );
}

/** R5 app.js P.ic paths (design-lock-r5): top10, dev, sniper. */
function PillIcon({ k }: { k: WordId }) {
  const p = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (k === "top10") return <svg {...p}><circle cx="6" cy="6" r="4.5" /><path d="M6 1.5V6h4.5" /></svg>;
  if (k === "creatorHolds") return <svg {...p}><path d="M4 3L1.5 6 4 9M8 3l2.5 3L8 9" /></svg>;
  return <svg {...p}><circle cx="6" cy="6" r="3.5" /><path d="M6 1v2.5M6 8.5V11M1 6h2.5M8.5 6H11" /></svg>;
}

/** R5 app.js P.ic "holders". */
function HoldersIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="4" r="2" />
      <path d="M1 10.5c.4-2 1.8-3 3.5-3s3.1 1 3.5 3M8.5 2.2a2 2 0 010 3.6M9.6 7.7c.8.4 1.3 1.3 1.5 2.8" />
    </svg>
  );
}

function Pad({ id }: { id: string | null }) {
  return id ? <span className="dsc-pad" title={id}>{id}</span> : null;
}

/** R5 TokenRow (desktop). */
function Row({ v, win }: { v: RowView; win: Win }) {
  return (
    <div className="dsc-row" data-token={v.token} role="listitem">
      <span className="dsc-ringw">
        <Ring v={v} size={68} stroke={3.5} av={50} />
        <span className="dsc-rpill" data-curve={v.stage.curve}>{v.stage.pill === "POOL" ? WORDS.pool.text : v.stage.pill}</span>
      </span>
      <span className="dsc-info">
        <span className="dsc-l1">
          <span className="dsc-sym" title={v.symbol}>{v.symbol}</span>
          <span className="dsc-name" title={v.name}>{v.name}</span>
        </span>
        <span className="dsc-l2">
          <span className="dsc-age" data-fresh={v.fresh}>{v.age}</span>
          <Pill label="top10" value={v.top10} />
          <Pill label="creatorHolds" value={v.dev} />
          <Pill label="snipers" value={v.snipers} />
          <Pad id={v.launchpad} />
        </span>
        <span className="dsc-l3">
          <span className="dsc-press" data-on={v.buyShare !== null} style={v.buyShare !== null ? { ["--buy" as string]: `${v.buyShare * 100}%` } : undefined} aria-hidden="true"><i /><i /></span>
          <span className="dsc-bs">{v.buys}/{v.sells}</span>
          <span className="dsc-hold" title={WORDS.holders.text}><HoldersIcon />{v.holders}</span>
        </span>
      </span>
      <span className="dsc-mkt">
        <span className="dsc-mc" title={`${WORDS.price.text} ${v.price}`}>
          <span className="dsc-lbl">{WORDS.mc.text}</span>
          {v.mc}
        </span>
        <span className="dsc-chg" data-dir={v.dir}>{v.chg}</span>
        <span className="dsc-vol"><span className="dsc-lbl">{WORDS.vol.text} {win}</span> {v.vol}</span>
      </span>
    </div>
  );
}

/** R5 LaunchRow (phone): ring, name, then age, MC, holders and dev, then the curve's 40 dots. */
function PhoneRow({ v }: { v: RowView }) {
  const lit = v.stage.fill <= 0 ? 0 : Math.max(1, Math.round(v.stage.fill * 40));
  const tier = v.stage.fill > 0.85 ? "high" : v.stage.fill > 0.5 ? "mid" : "low";
  return (
    <div className="dsc-prow" data-token={v.token} role="listitem">
      <Ring v={v} size={52} stroke={3} av={40} />
      <span className="dsc-pinfo">
        <span className="dsc-l1">
          <span className="dsc-sym" title={v.symbol}>{v.symbol}</span>
          <span className="dsc-name" title={v.name}>{v.name}</span>
        </span>
        <span className="dsc-pmeta">
          <span className="dsc-age" data-fresh={v.fresh}>{v.age}</span>
          <span title={`${WORDS.price.text} ${v.price}`}>{v.mc}</span>
          <span className="dsc-hold" title={WORDS.holders.text}><HoldersIcon />{v.holders}</span>
          <span className="dsc-pdev" data-level={v.dev.level} title={WORDS.creatorHolds.text}>{WORDS.dev.text} {v.dev.text}</span>
        </span>
        <span className="dsc-pcurve">
          <span className="dsc-dots" data-tier={v.stage.curve ? tier : "pool"} aria-hidden="true">
            {Array.from({ length: 40 }, (_, i) => <i key={i} data-on={i < lit} />)}
          </span>
          <span className="dsc-pl">{v.stage.pill === "POOL" ? WORDS.pool.text : v.stage.pill}</span>
        </span>
      </span>
    </div>
  );
}

function Skeleton({ phone }: { phone: boolean }) {
  return (
    <div className={phone ? "dsc-prow" : "dsc-row"} aria-hidden="true">
      <span className="sk dsc-skc" style={{ width: phone ? 52 : 68, height: phone ? 52 : 68 }} />
      <span className="dsc-info">
        <span className="sk" style={{ width: "62%", height: 16 }} />
        <span className="sk" style={{ width: "80%", height: 15 }} />
        <span className="sk" style={{ width: "72%", height: 14 }} />
      </span>
    </div>
  );
}

function Body({ data, k, win, phone, nowMs, onRetry }: { data: DiscoverData; k: ColumnKey; win: Win; phone: boolean; nowMs: number; onRetry: () => void }) {
  if (data.status === "loading")
    return (
      <div className="dsc-rows" role="list" aria-busy="true" aria-label={WORDS.loading.text} data-state="S5.1">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => <Skeleton key={i} phone={phone} />)}
      </div>
    );
  if (data.status === "error")
    return (
      <div className="dsc-rows dsc-msg" data-state="S5.5">
        <W id="offline" />
        <button type="button" className="dsc-retry" onClick={onRetry}>{WORDS.retry.text}</button>
      </div>
    );
  const rows = columnRows(data.snapshot, k);
  if (!rows.length)
    return (
      <div className="dsc-rows dsc-msg" data-state="S5.3">
        <W id="noTokens" />
      </div>
    );
  return (
    <div className="dsc-rows" role="list" data-state="S5.2">
      {rows.map((r) => (phone ? <PhoneRow key={r.token} v={rowView(r, win, nowMs)} /> : <Row key={r.token} v={rowView(r, win, nowMs)} win={win} />))}
    </div>
  );
}

const countOf = (data: DiscoverData, k: ColumnKey) => (data.status === "ready" ? String(columnRows(data.snapshot, k).length) : "—");

/** S5. `nowMs` is the clock ages are drawn against; `onRetry` asks the caller to read again. */
export function Discover({ data, nowMs, onRetry }: { data: DiscoverData; nowMs: number; onRetry: () => void }) {
  const [tab, setTab] = useState<ColumnKey>("new");
  const tabWin = COLUMNS.find((c) => c.key === tab)!.win;
  return (
    <section className="dsc" data-discover={data.status}>
      <div className="dsc-bar">
        <h1 className="dsc-title"><W id="discover" /></h1>
      </div>
      <div className="dsc-grid">
        {COLUMNS.map((c) => (
          <section key={c.key} className="dsc-col" data-col={c.key} aria-labelledby={`dsc-h-${c.key}`}>
            <div className="dsc-head">
              <Glyph k={c.key} />
              <span className="dsc-ht" id={`dsc-h-${c.key}`}><W id={TITLE[c.key]} /></span>
              <span className="dsc-count">{countOf(data, c.key)}</span>
            </div>
            <Body data={data} k={c.key} win={c.win} phone={false} nowMs={nowMs} onRetry={onRetry} />
          </section>
        ))}
      </div>
      <div className="dsc-phone">
        <div className="dsc-tabs" role="tablist">
          {COLUMNS.map((c) => (
            <button key={c.key} type="button" role="tab" aria-selected={tab === c.key} className="dsc-tab" data-tab={c.key} onClick={() => setTab(c.key)}>
              <W id={TITLE[c.key]} />
              <span className="dsc-count">{countOf(data, c.key)}</span>
            </button>
          ))}
        </div>
        <Body data={data} k={tab} win={tabWin} phone nowMs={nowMs} onRetry={onRetry} />
      </div>
    </section>
  );
}

/** The Discover route: the screen on the helper's lists (data.ts). */
export function DiscoverRoute() {
  const { data, nowMs, retry } = useDiscoverData();
  return <Discover data={data} nowMs={nowMs} onRetry={retry} />;
}
