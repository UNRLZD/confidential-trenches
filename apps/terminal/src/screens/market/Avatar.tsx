import { useState } from "react";
import "./avatar.css";
import { badgeSize, chainOf, padOf } from "./pads.ts";

/** The token's logo as the helper serves it (HELPER_HOST, which the CSP's img-src names): GET /v1/logo/{chain}/{token}.
 *  The image comes through our helper, never from a third-party host, so no image host sees which tokens a user looks
 *  at (the main app does the same through its engine's /api/icon/:id). */
export const logoUrl = (chain: string, token: string): string => `https://ct-api.unrealized.trade/v1/logo/${encodeURIComponent(chain)}/${encodeURIComponent(token)}`;

/** Whose logo an avatar draws: the helper's `icon` for the token. True asks for it (and keeps the initials on any
 *  failure); false asks for nothing. */
export type Logo = { chain: string; token: string; icon: boolean };

/** The logo over the initials: hidden until it has loaded, so the avatar never shows a broken image or a blank, and it
 *  sits absolutely in the avatar's fixed box, so its arrival moves nothing. Off-screen rows load it when they come near. */
function LogoImg({ src, size }: { src: string; size: number }) {
  const [state, setState] = useState<{ src: string; s: "wait" | "ok" | "bad" }>({ src, s: "wait" });
  const s = state.src === src ? state.s : "wait";
  if (s === "bad") return null;
  return (
    <img
      className="tok-logo"
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      data-loaded={s === "ok"}
      onLoad={() => setState({ src, s: "ok" })}
      onError={() => setState({ src, s: "bad" })}
    />
  );
}

/** `initials` false draws the gradient alone, for a mark too small for letters to read (Portfolio's Coins part, 16 px).
 *  The token avatar (UNRLZD TokenAvatar), one for every screen: the token's own logo from the helper when it has one,
 *  else the main app's fallback, two initials on a gradient from the symbol. Given a `chain` (and a `pad`), it carries
 *  the origin badges at its corners as design-lock-r5 draws them (P.badges): the launchpad's logo bottom-right, the
 *  chain's mark top-right, each with its proper name in the hover (pads.ts). An unknown or null pad draws no badge. */
export function Avatar({ symbol, size, pad, chain, logo, initials = true }: { symbol: string; size: number; pad?: string | null; chain?: string; logo?: Logo; initials?: boolean }) {
  let h = 7;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letters = Array.from(symbol.replace(/^\$/, "").normalize("NFKC").replace(/\p{M}/gu, "")).slice(0, 2).join("");
  const src = logo?.icon === true && logo.token ? logoUrl(logo.chain, logo.token) : null;
  const av = (
    <span className="tok-av" aria-hidden="true" style={{ width: size, height: size, background: `conic-gradient(from ${h}deg at 35% 30%, oklch(0.62 0.15 ${h}), oklch(0.34 0.09 ${(h + 70) % 360}), oklch(0.5 0.13 ${h}), oklch(0.62 0.15 ${h}))`, color: `oklch(0.97 0.03 ${h})`, fontSize: Math.round(size * 0.36) }}>
      {initials && letters}
      {src && <LogoImg key={src} src={src} size={size} />}
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
