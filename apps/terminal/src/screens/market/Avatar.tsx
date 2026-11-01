import "./avatar.css";

/** The token avatar (UNRLZD TokenAvatar), one for every screen: two initials on a gradient from the symbol. Logos come
 *  with the helper read (GET /v1/logo, card app-discover-live). */
export function Avatar({ symbol, size }: { symbol: string; size: number }) {
  let h = 7;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letters = Array.from(symbol.replace(/^\$/, "").normalize("NFKC").replace(/\p{M}/gu, "")).slice(0, 2).join("");
  return (
    <span className="tok-av" aria-hidden="true" style={{ width: size, height: size, background: `conic-gradient(from ${h}deg at 35% 30%, oklch(0.62 0.15 ${h}), oklch(0.34 0.09 ${(h + 70) % 360}), oklch(0.5 0.13 ${h}), oklch(0.62 0.15 ${h}))`, color: `oklch(0.97 0.03 ${h})`, fontSize: Math.round(size * 0.36) }}>
      {letters}
    </span>
  );
}
