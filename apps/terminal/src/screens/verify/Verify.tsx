// The Verify panel (09-design-brief S18; app.md A3.3): a right drawer on desktop, a full page on phone. Two rows, Code
// and Funds, each a status dot (blue ok, amber warn, coral danger) and a chevron; a tap opens its checks in place, each
// with its dot and the values read, hashes and blocks in Chivo 12 shortened in the middle. Under them the one block
// and the two RPCs read. It draws a VerifyView (model.ts) and nothing else: no claim, only what was read.
import { useState } from "react";
import { Icon } from "../signin/Icon.tsx";
import type { VerifyCheck, VerifyCheckId, VerifyRow, VerifyStatus, VerifyView } from "./model.ts";
// the pools (card verify-pools): a row per chain under the vault's, opened the same way: its checks, the block and the
// two RPCs it read, and two explorer links at the pool's address
import type { PoolCheck, PoolCheckId, PoolChain, PoolRow as PoolRowView, PoolsView } from "./pools.ts";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./verify.css";

function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={id}>{w.text}</span> : <>{w.text}</>;
}

const LABEL: Record<VerifyCheckId | PoolCheckId, WordId> = {
  keys: "keys", code: "codeHash", asset: "asset", registration: "registration", tokenCode: "tokenCode", balance: "balance",
  authority: "authority", owner: "owner", proxy: "proxy", poolCode: "codeHash",
};
/** A chain's name is data (deposit/model.ts CHAIN_NAME), not copy. */
const CHAIN_NAME: Record<PoolChain, string> = { solana: "Solana", base: "Base", robinhood: "Robinhood" };
/** An RPC's name is the URL it reads (the pair rule's); the screen shows its host, one to a line. */
const host = (name: string) => name.replace(/^https?:\/\//, "");
const Dot = ({ s }: { s: VerifyStatus | null }) => <span className={`vdot ${s ?? "load"}`} data-dot={s ?? "loading"} />;

function Check({ c }: { c: VerifyCheck | PoolCheck }) {
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

function Pool({ chain, row, open, toggle }: { chain: PoolChain; row: PoolRowView | null; open: boolean; toggle(): void }) {
  return (
    <section className={`vrow-box${open ? " open" : ""}`} data-pool={chain} data-status={row?.status ?? "loading"}>
      <button type="button" className="vrow" aria-expanded={open} disabled={row === null} onClick={toggle} data-control={`verify-pool-${chain}`}>
        <Dot s={row?.status ?? null} />
        <span className="nm">{CHAIN_NAME[chain]}</span>
        <span className="chev"><Icon name="chevDown" size={14} stroke={1.4} /></span>
      </button>
      {open && row && (
        <div className="vpool">
          <ul className="vchecks">{row.checks.map((c) => <Check key={c.id} c={c} />)}</ul>
          <dl className="vmeta">
            <div>
              <dt><W id="block" /></dt>
              <dd className="num">{row.height}</dd>
            </div>
            <div>
              <dt><W id="rpcs" /></dt>
              <dd className="num">{row.rpcs.length ? row.rpcs.map((r) => <span key={r} className="rpcline">{host(r)}</span>) : "—"}</dd>
            </div>
          </dl>
          {row.explorers.length > 0 && (
            <div className="vlinks">
              {row.explorers.map((e) => (
                <a key={e.name} className="vlink" href={e.href} target="_blank" rel="noopener noreferrer" data-explorer={e.name}>
                  <W id={e.name} />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const CHAINS: readonly PoolChain[] = ["solana", "base", "robinhood"];

export function Verify({ view, pools, onClose, opened = [] }: { view: VerifyView; pools?: PoolsView; onClose(): void; opened?: ("code" | "funds" | PoolChain)[] }) {
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
          {pools && (
            <div className="vpools" data-pools={pools.state}>
              <h3 className="vsec"><W id="pools" /></h3>
              {CHAINS.map((c) => {
                const row = pools.state === "read" ? (pools.rows.find((r) => r.chain === c) ?? null) : null;
                return <Pool key={c} chain={c} row={row} open={row !== null && open.has(c)} toggle={() => toggle(c)} />;
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
