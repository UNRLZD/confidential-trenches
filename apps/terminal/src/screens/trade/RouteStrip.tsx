import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { stepView } from "./route.ts";
import type { Route, StepId } from "./route.ts";
import { WORDS } from "./words.ts";
import { WORDS as TOKEN_WORDS } from "../token/words.ts";

// The buy route strip (card app-buy-route-strip; spec docs/drafts/buy-route-strip-spec.md in the research repo; locked
// design design-lock-r5, assets/private.js P.pvTrade, P.pvGlyph, P.pvLink and the film's four-step path): Private balance,
// the buy's one-time wallet, the pool, the token, joined by dotted links. It draws what route.ts says and times nothing:
// a check pops, a link fills and a value fades in on its own CSS clock from the moment its event sets the state.

// ---------------------------------------------------------------------------------------------------- the dot glyphs
// An 11 x 11 dot cell lit from the top left (private.js SHAPES notes, ghost, pool and light()).
const N = 11;
const PAPER = "#f4f4f2";
const ACC = "#50e397";
const BLUE = "#5b8cff";
const light = (c: number, y: number) => 0.45 + 0.55 * (1 - Math.hypot(c, N - 1 - y) / Math.hypot(N - 1, N - 1));
const SHAPES: Record<"notes" | "ghost" | "pool", (c: number, y: number) => number> = {
  notes: (c, y) => {
    for (let k = 0; k < 3; k++) {
      const y0 = 2 + 3 * k;
      const dx = (c - 5) / 4.7;
      const dy = (y - y0) / 1.25;
      if (dx * dx + dy * dy <= 1) return k === 2 ? 1 : 0.7 - 0.12 * (2 - k);
    }
    return 0;
  },
  ghost: (c, y) => {
    const d = Math.hypot(c - 5, y - 5);
    return Math.abs(d - 4.3) < 0.62 ? ((c + y) % 2 ? 0.55 : 1) : d < 1.2 ? 1 : 0;
  },
  pool: (c, y) => {
    const lip = 6 - Math.abs(c - 5) * 0.12;
    const wave = 5 + Math.round(Math.sin(c * 1.1) * 0.6);
    const inBowl = Math.hypot((c - 5) / 5.2, (y - 6) / 6) <= 1 && y <= lip;
    return inBowl ? (y <= wave ? 1 : 0) : 0;
  },
};
const TONE = { notes: PAPER, ghost: BLUE, pool: ACC } as const;

function Glyph({ kind, size = 28 }: { kind: keyof typeof SHAPES; size?: number }) {
  const px = size / N;
  const r = px * 0.34;
  const dots: ReactNode[] = [];
  for (let c = 0; c < N; c++)
    for (let j = 0; j < N; j++) {
      const v = SHAPES[kind](c, N - 1 - j);
      if (!v) continue;
      dots.push(<circle key={`${c}-${j}`} cx={(c + 0.5) * px} cy={(j + 0.5) * px} r={r * (v === 1 ? 1.08 : 1)} fill={TONE[kind]} fillOpacity={+(v * light(c, N - 1 - j)).toFixed(2)} />);
    }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ overflow: "visible" }}>
      {dots}
    </svg>
  );
}

const Check = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
);
const Cross = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
);
export const LinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l.9-.9a2.5 2.5 0 0 1 3.5 3.5l-.9.9M9 11.5l-.9.9a2.5 2.5 0 0 1-3.5-3.5l.9-.9" /></svg>
);

/** A link: a row of dots that brightens toward the arrow; its green layer fills left to right when the step before it checks. */
function Link({ full, id }: { full: boolean; id: string }) {
  return (
    <span className="rs-l" data-full={full || undefined} data-testid={`route-link-${id}`}>
      <span className="rs-ld"><i /></span>
      <svg width="7" height="8" viewBox="0 0 7 8" aria-hidden="true"><circle cx="1.5" cy="1.4" r="1.2" /><circle cx="4.5" cy="4" r="1.3" /><circle cx="1.5" cy="6.6" r="1.2" /></svg>
    </span>
  );
}

/** A label on two lines, the last word on the second ("Private / balance", "New one-time / wallet", "Raydium / pool"). */
function Label({ text }: { text: string }) {
  const at = text.lastIndexOf(" ");
  return at < 0 ? <>{text}</> : <>{text.slice(0, at)}<br />{text.slice(at + 1)}</>;
}

/** Each step's test id, spelled out so the deployed bundle can be read for them (the live check). */
const TID: Record<StepId, string> = { balance: "route-balance", wallet: "route-wallet", pool: "route-pool", token: "route-token" };

function Node({ route, step, glyph, label, value }: { route: Route; step: StepId; glyph: ReactNode; label: ReactNode; value: string | null }) {
  const { state } = stepView(route, step);
  return (
    <span className="rs-n" data-step={step} data-state={state} data-testid={TID[step]}>
      <span className="rs-g">
        {glyph}
        {(state === "done" || state === "error") && <span className="rs-ck" data-kind={state}>{state === "done" ? <Check /> : <Cross />}</span>}
      </span>
      <span className="rs-k">{label}</span>
      <span className="rs-v" data-on={value !== null || undefined} data-testid={`${TID[step]}-value`}>{value ?? " "}</span>
    </span>
  );
}

/** The token step's picture: the symbol's first letter in a ring (the box has no token image). */
const TokenGlyph = ({ symbol }: { symbol: string }) => <span className="rs-tk" aria-hidden="true">{symbol.slice(0, 1)}</span>;

export function RouteStrip({ route, symbol, outText }: { route: Route; symbol: string; outText: string | null }) {
  const v = (s: StepId) => stepView(route, s).value;
  const poolLabel = route.venue ? `${route.venue} ${WORDS.poolSuffix.text}` : WORDS.poolBare.text;
  const poolDraft = route.venue ? WORDS.poolSuffix.draft : WORDS.poolBare.draft;
  return (
    <div className="rs" data-testid="route-strip" data-route={route.k} data-steps={route.st.join(" ")}>
      <div className="rs-flow">
        <Node route={route} step="balance" glyph={<Glyph kind="notes" />} label={<Label text={WORDS.privateBalance.text} />} value={v("balance")} />
        <Link full={route.links[0]} id="1" />
        <div className="rs-grp" data-in={route.walletIn || undefined} aria-hidden={!route.walletIn || undefined}>
          <Node route={route} step="wallet" glyph={<Glyph kind="ghost" />} label={<span data-draft-copy={WORDS.newWallet.text}><Label text={WORDS.newWallet.text} /></span>} value={v("wallet")} />
          <Link full={route.links[1]} id="2" />
        </div>
        <Node route={route} step="pool" glyph={<Glyph kind="pool" />} label={<span {...(poolDraft ? { "data-draft-copy": poolLabel } : {})}><Label text={poolLabel} /></span>} value={v("pool")} />
        <Link full={route.links[2]} id="3" />
        <Node route={route} step="token" glyph={<TokenGlyph symbol={symbol} />} label={<Label text={symbol} />} value={v("token") === null ? null : outText} />
      </div>
    </div>
  );
}

/** The fill toast (S8.12): the symbol, this buy's line, a link icon to the transaction; fades in and slides down 12 px, centred at the top. */
export function FillToast({ symbol, line, href, chainName, onClose }: { symbol: string; line: string; href: string | null; chainName: "solscan" | "basescan" | "rhExplorer" | "nearblocks" | null; onClose: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(true);
  }, []);
  return (
    <div className="rs-toast" role="status" data-shown={shown || undefined} data-testid="fill-toast" onClick={onClose}>
      <div className="rs-toastBody">
        <span className="rs-toastTitle">{symbol}</span>
        <span className="rs-toastLine" data-testid="fill-toast-line">{line}</span>
      </div>
      {href && chainName && (
        <a className="rs-toastLink" href={href} target="_blank" rel="noopener noreferrer" aria-label={TOKEN_WORDS[chainName].text} onClick={(e) => e.stopPropagation()}>
          <LinkIcon />
        </a>
      )}
    </div>
  );
}
