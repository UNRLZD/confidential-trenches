import "./avatar.css";
import { badgeSize, chainOf, padOf } from "./pads.ts";

/** The token avatar (UNRLZD TokenAvatar), one for every screen: two initials on a gradient from the symbol. Logos come
 *  with the helper read (GET /v1/logo, card app-discover-live). Given a `chain` (and a `pad`), it carries the origin
 *  badges at its corners as design-lock-r5 draws them (P.badges): the launchpad's logo bottom-right, the chain's mark
 *  top-right, each with its proper name in the hover (pads.ts). An unknown or null pad draws no badge. */
export function Avatar({ symbol, size, pad, chain }: { symbol: string; size: number; pad?: string | null; chain?: string }) {
  let h = 7;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letters = Array.from(symbol.replace(/^\$/, "").normalize("NFKC").replace(/\p{M}/gu, "")).slice(0, 2).join("");
  const av = (
    <span className="tok-av" aria-hidden="true" style={{ width: size, height: size, background: `conic-gradient(from ${h}deg at 35% 30%, oklch(0.62 0.15 ${h}), oklch(0.34 0.09 ${(h + 70) % 360}), oklch(0.5 0.13 ${h}), oklch(0.62 0.15 ${h}))`, color: `oklch(0.97 0.03 ${h})`, fontSize: Math.round(size * 0.36) }}>
      {letters}
    </span>
  );
  if (chain === undefined) return av;
  const p = padOf(pad);
  const c = chainOf(chain);
  const d = badgeSize(size);
  return (
    <span className="tok-avw" style={{ width: size, height: size }}>
      {av}
      {p && (
        <span className="tok-pb" data-pad={pad} title={p.name} style={{ width: d, height: d }}>
          <img src={p.logo} alt={p.name} width={d} height={d} />
        </span>
      )}
      {c && (
        <span className="tok-cb" data-chain={chain} title={c.name} style={{ width: d, height: d, padding: Math.round(d * c.inset) }}>
          <img src={c.logo} alt={c.name} />
        </span>
      )}
    </span>
  );
}
