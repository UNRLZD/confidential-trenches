// The Verify panel (09-design-brief S18; app.md A3.3): a right drawer on desktop, a full page on phone. Two rows, Code
// and Funds, each a status dot (blue ok, amber warn, coral danger) and a chevron; a tap opens its checks in place, each
// with its dot and the values read, hashes and blocks in Chivo 12 shortened in the middle. Under them the one block
// and the two RPCs read. It draws a VerifyView (model.ts) and nothing else: no claim, only what was read.
import { useState } from "react";
import { Icon } from "../signin/Icon.tsx";
import type { VerifyCheck, VerifyCheckId, VerifyRow, VerifyStatus, VerifyView } from "./model.ts";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./verify.css";

function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={id}>{w.text}</span> : <>{w.text}</>;
}

const LABEL: Record<VerifyCheckId, WordId> = { keys: "keys", code: "codeHash", asset: "asset", registration: "registration", tokenCode: "tokenCode", balance: "balance" };
/** An RPC's name is the URL it reads (the pair rule's); the screen shows its host, one to a line. */
const host = (name: string) => name.replace(/^https?:\/\//, "");
const Dot = ({ s }: { s: VerifyStatus | null }) => <span className={`vdot ${s ?? "load"}`} data-dot={s ?? "loading"} />;

function Check({ c }: { c: VerifyCheck }) {
  // the first value sits on the check's line when the RPCs gave one answer; every other value is a line under it
  const [main, ...rest] = c.word === null ? c.values : [null, ...c.values];
  return (
    <li className="vcheck" data-check={c.id} data-status={c.status}>
      <div className="vline">
        <Dot s={c.status} />
        <span className="nm"><W id={LABEL[c.id]} /></span>
        {c.word !== null ? <span className={`st ${c.status}`}><W id={c.word} /></span> : <span className="v num">{main?.v}</span>}
      </div>
      {rest.length > 0 && (
        <dl className="vsub">
          {rest.map((x, i) => (
            <div key={i}>
              <dt><W id={x!.k} />{x!.rpc && <span className="rpc num">{host(x!.rpc)}</span>}</dt>
              <dd className="num">{x!.v}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function Row({ id, row, open, toggle }: { id: "code" | "funds"; row: VerifyRow | null; open: boolean; toggle(): void }) {
  return (
    <section className={`vrow-box${open ? " open" : ""}`} data-row={id} data-status={row?.status ?? "loading"}>
      <button type="button" className="vrow" aria-expanded={open} disabled={row === null} onClick={toggle} data-control={`verify-${id}`}>
        <Dot s={row?.status ?? null} />
        <span className="nm"><W id={id} /></span>
        <span className="chev"><Icon name="chevDown" size={14} stroke={1.4} /></span>
      </button>
      {open && row && <ul className="vchecks">{row.checks.map((c) => <Check key={c.id} c={c} />)}</ul>}
    </section>
  );
}

export function Verify({ view, onClose, opened = [] }: { view: VerifyView; onClose(): void; opened?: ("code" | "funds")[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(opened));
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (!n.delete(id)) n.add(id); return n; });
  const read = view.state === "loading" ? null : view;
  return (
    <div className="vfy" data-panel="verify" data-state={view.state} data-code={read?.code.status ?? "loading"} data-funds={read?.funds.status ?? "loading"}>
      <div className="vfy-scrim" onClick={onClose} />
      <aside className="vfy-box" aria-labelledby="vfy-title" aria-busy={read === null}>
        <div className="vhd">
          <h2 id="vfy-title"><W id="title" /></h2>
          <button type="button" className="vfy-x" aria-label={WORDS.close.text} onClick={onClose}>
            <Icon name="x" size={14} stroke={1.4} />
          </button>
        </div>
        <div className="vbody">
          {read?.state === "disagree" && <div className="vstat warn" data-word="disagree"><W id="disagree" /></div>}
          <Row id="code" row={read?.code ?? null} open={read !== null && open.has("code")} toggle={() => toggle("code")} />
          <Row id="funds" row={read?.funds ?? null} open={read !== null && open.has("funds")} toggle={() => toggle("funds")} />
          <dl className="vmeta">
            <div>
              <dt><W id="block" /></dt>
              <dd className="num">{read ? <>{read.height}{read.blockHash && <span className="t3"> {read.blockHash}</span>}</> : <span className="sk" />}</dd>
            </div>
            <div>
              <dt><W id="rpcs" /></dt>
              <dd className="num">{read ? (read.rpcs.length ? read.rpcs.map((r) => <span key={r} className="rpcline">{host(r)}</span>) : "—") : <span className="sk" />}</dd>
            </div>
          </dl>
        </div>
      </aside>
    </div>
  );
}
