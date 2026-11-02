import { useState } from "react";
import { txLink } from "../withdraw/model.ts";
import { activity, ACT_KINDS, filterActivity, groupByDay, restored } from "./model.ts";
import type { ActFilter, ActKind, ActRow, PortfolioData } from "./model.ts";
import { usd as usdC, units } from "./model.ts";
import type { PortfolioSource } from "./source.tsx";
import { Ic } from "./icons.tsx";
import { W } from "./W.tsx";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";

// Activity (S14; 09-design-brief S14): what this browser did, newest first, under day headers (Today, Yesterday, then
// the date), with the type chips (CN-28's labels), the min size and the token search (CN-103), a tap-only tx link per
// row and the row opened in place to its receipt. The list is local: the kit's ops joined with their local facts
// (model.ts activity). After a restore (the kit's restore op done) the list says older history is not restorable.

const KIND: Record<ActKind, WordId> = { buy: "kBuy", sell: "kSell", deposit: "kDeposit", withdraw: "kWithdraw", export: "kExport" };
const FINAL = new Set(["done", "sent", "filled", "part_filled", "refused", "not_landed", "refunded", "stopped", "held", "halted", "key_exported"]);

export interface ActUi {
  filter: ActFilter;
  open: string | null;
}

export function ActivityList({ src, ui, setUi }: { src: PortfolioSource; ui: ActUi; setUi(u: ActUi): void }) {
  const ops = src.snapshot.state?.ops;
  const d = src.data;
  const all = activity(ops, d);
  const rows = filterActivity(all, ui.filter, d);
  const groups = groupByDay(rows, src.now(), src.tzMin);
  const kinds = ACT_KINDS.filter((k) => all.some((r) => r.kind === k));
  const f = ui.filter;
  const filtered = f.kinds.length > 0 || f.min > 0n || f.q.trim() !== "";
  const [minText, setMinText] = useState(f.min > 0n ? String(f.min / 100n) : "");
  const toggle = (k: ActKind) => setUi({ ...ui, filter: { ...f, kinds: f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k] } });

  if (!src.snapshot.state) return <div className="pf-acts" data-act="loading">{Array.from({ length: 6 }, (_, i) => <div className="ai" key={i}><span className="sk" style={{ width: 30, height: 30 }} /><span className="sk" style={{ width: 160, height: 14 }} /></div>)}</div>;

  return (
    <div className="pf-acts" data-act={all.length ? "S14.2" : "S14.1"} data-filtered={filtered || undefined}>
      {all.length > 0 && (
        <div className="afl">
          <div className="chips">
            {kinds.map((k) => (
              <button type="button" key={k} className={`chip ${f.kinds.includes(k) ? "on" : ""}`} aria-pressed={f.kinds.includes(k)} data-chip={k} onClick={() => toggle(k)}>
                <W id={KIND[k]} />
              </button>
            ))}
          </div>
          <label className="afld min">
            <span className="t3"><W id="minSize" /></span>
            <span className="num">$</span>
            <input inputMode="decimal" value={minText} data-field="min" aria-label={WORDS.minSize.text} onChange={(e) => {
              const v = e.target.value.replace(/[^\d]/g, "").slice(0, 9);
              setMinText(v);
              setUi({ ...ui, filter: { ...f, min: v ? BigInt(v) * 100n : 0n } });
            }} />
          </label>
          <label className="afld q">
            <Ic name="search" size={13} />
            <input value={f.q} placeholder={WORDS.search.text} data-field="q" aria-label={WORDS.search.text} onChange={(e) => setUi({ ...ui, filter: { ...f, q: e.target.value } })} />
          </label>
        </div>
      )}
      {restored(ops) && <div className="arst t3"><W id="notRestorable" /></div>}
      {all.length === 0 ? (
        <div className="empty"><span><W id="noActivity" /></span></div>
      ) : (
        <div className="alist">
          {groups.map((g, i) => (
            <div key={`${g.label}-${i}`} className="agrp">
              {g.label !== null && <div className="adh">{g.label === "today" ? <W id="today" /> : g.label === "yesterday" ? <W id="yesterday" /> : <span className="num">{g.label}</span>}</div>}
              {g.rows.map((r) => <Row key={r.id} r={r} d={d} src={src} tzMin={src.tzMin} open={ui.open === r.id} onOpen={() => setUi({ ...ui, open: ui.open === r.id ? null : r.id })} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const hhmm = (t: number, tzMin: number) => new Date(t + tzMin * 60_000).toISOString().slice(11, 16);

function Row({ r, d, src, tzMin, open, onOpen }: { r: ActRow; d: PortfolioData; src: PortfolioSource; tzMin: number; open: boolean; onOpen(): void }) {
  const m = r.chain && r.token ? d.market(r.chain, r.token) : null;
  const link = txLink(r.txs);
  const ic = r.kind === "buy" ? <span className="aic g"><Ic name="arrowUp" size={13} /></span> : r.kind === "sell" ? <span className="aic r"><Ic name="arrowDown" size={13} /></span> : r.kind === "export" ? <span className="aic"><Ic name="key" size={13} /></span> : <span className="aic"><Ic name={r.kind === "deposit" ? "deposit" : "arrowUp"} size={13} /></span>;
  const pending = !FINAL.has(r.stage);
  return (
    <div className={`arow2 ${open ? "open" : ""}`} data-row={r.id} data-kind={r.kind}>
      <div className="ai" role="button" tabIndex={0} aria-expanded={open} onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}>
        {ic}
        <div className="grow">
          <div className="aw">
            {r.kind === "export" ? <W id="keyExported" /> : <W id={KIND[r.kind]} />} {m && <span>{m.symbol}</span>}
            {pending && <span className="tag blue"><W id="processing" /></span>}
            {r.stage === "refunded" && <span className="tag warn"><W id="refunded" /></span>}
          </div>
          <div className="at2">{r.at !== null ? hhmm(r.at, tzMin) : "—"}{r.address && <> · {r.address}</>}</div>
        </div>
        <div className="avl">
          {r.usd !== null ? <span className={r.kind === "sell" ? "gain" : ""}>{usdC(r.usd)}</span> : <span className="t3">{"—"}</span>}
          {r.units && <div className="t3">{units(r.units)}</div>}
        </div>
        {r.kind === "export" ? (
          <button type="button" className="abtn" data-control="view-key" onClick={(e) => (e.stopPropagation(), src.act({ kind: "view-key", id: r.id }))}><W id="viewKey" /></button>
        ) : link ? (
          <a className="atx" href={link} target="_blank" rel="noopener noreferrer" data-tx onClick={(e) => e.stopPropagation()}><W id="tx" /></a>
        ) : (
          <span className="atx" />
        )}
      </div>
      {open && (
        <div className="rcpt" data-receipt={r.id}>
          <div className="rh"><W id="receipt" /></div>
          <div className="rl num">{r.id}</div>
          {r.at !== null && <div className="rl num">{new Date(r.at).toISOString().replace(".000", "")}</div>}
          {r.chain && r.token && <div className="rl num ell">{r.chain} {r.token}</div>}
          {r.txs.map((t) => (
            <div key={t.hash} className="rl num ell" data-receipt-tx>{t.chain} {t.hash}</div>
          ))}
        </div>
      )}
    </div>
  );
}
