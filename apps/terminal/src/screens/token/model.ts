// The token page's drawn values as pure functions of a 06b `Row` (src/screens/discover/fields.ts). Numbers are drawn
// as Discover draws them (format.ts), so one token reads the same on both screens. The curve rule, one for every screen,
// is in ../market/curve.ts.
import type { MarketRow } from "../discover/fields.ts";
import { age, compact, count, DASH, price, priceTile, usdTile } from "../discover/format.ts";
import { curve } from "../market/curve.ts";
import type { Curve } from "../market/curve.ts";

export { curve };
export type { Curve };

const MINUS = "−";

export type Dir = "up" | "down" | "none";

/** The 24h change in basis points: two places, signed, grouped (+8.02%, −5.17%, +51,404.00%); a value that is not a
 *  whole number of basis points is the dash. */
export function change24(bps: number | null | undefined): { text: string; dir: Dir } {
  if (typeof bps !== "number" || !Number.isInteger(bps)) return { text: DASH, dir: "none" };
  const a = Math.abs(bps);
  const body = `${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
  return bps >= 0 ? { text: `+${body}%`, dir: "up" } : { text: `${MINUS}${body}%`, dir: "down" };
}

/** The 24h change in the strip's tile, at most 8 characters, the width the tile is drawn for: under 1,000% as
 *  `change24`; from 1,000% without decimals (+51,404%); from 100,000% compact as the other tiles are (+514.0K%). */
export function changeTile(bps: number | null | undefined): string {
  const c = change24(bps);
  if (c.dir === "none" || Math.abs(bps!) < 100_000) return c.text;
  const pct = Math.floor(Math.abs(bps!) / 100);
  const sign = bps! >= 0 ? "+" : MINUS;
  if (pct < 100_000) return `${sign}${pct.toLocaleString("en-US")}%`;
  const body = compact(pct);
  return `${sign}${(sign + body).length + 1 > 8 ? body.replace(/(\.\d)\d(?=[KMBT])/, "$1") : body}%`;
}

/** The page's values. A field is null while the page is filling (the helper's `filling`: Jupiter's row still coming)
 *  and has no value for it yet: the page draws its loading look there (card token-page-fills-after); otherwise a value
 *  no source has is the dash. */
export interface TokenView {
  token: string;
  symbol: string;
  /** Empty when it repeats the symbol. */
  name: string;
  price: string | null;
  /** `price` cut to the strip tile's width. */
  priceTile: string | null;
  mc: string | null;
  vol: string | null;
  liq: string | null;
  holders: string | null;
  age: string | null;
  chg: { text: string; dir: Dir } | null;
  /** `chg.text` cut to the strip tile's width. */
  chgTile: string | null;
  launchpad: string | null;
  chain: string;
  curve: Curve;
  /** The helper's `filling` (M384): Jupiter's row is still coming, so the null fields above are loading. */
  filling: boolean;
  /** The token's own links (source.ts TokenData `links`). */
  social: SocialLinks;
}

/** The row is the helper's named on chain (src "chain"), not Jupiter's: the page reads again (source.ts followToken). */
export const chainNamed = (r: MarketRow): boolean => r.src === "chain";

/** The page's values for one token. `nowMs` is the clock the age is drawn against; `filling` is the helper's. */
export function tokenView(r: MarketRow, nowMs: number, filling = false, social: SocialLinks = {}): TokenView {
  /** `drawn`, or null while the row fills and has no value for it. */
  const or = <T>(raw: unknown, drawn: T): T | null => (filling && (raw === null || raw === undefined) ? null : drawn);
  return {
    token: r.token,
    symbol: r.symbol,
    name: r.name && r.name !== r.symbol ? r.name : "",
    price: or(r.price_usd, price(r.price_usd)),
    priceTile: or(r.price_usd, priceTile(r.price_usd)),
    mc: or(r.mc_usd, usdTile(r.mc_usd)),
    vol: or(r.vol_24h_usd, usdTile(r.vol_24h_usd)),
    liq: or(r.liq_usd, usdTile(r.liq_usd)),
    holders: or(r.holders, count(r.holders)),
    age: or(r.created_s, age(r.created_s, nowMs)),
    chg: or(r.chg_24h_bps, change24(r.chg_24h_bps)),
    chgTile: or(r.chg_24h_bps, changeTile(r.chg_24h_bps)),
    launchpad: r.launchpad ?? null,
    chain: r.chain,
    curve: curve(r),
    filling,
    social,
  };
}

// ---------------------------------------------------------------------------------------------------------------- links
// The identity's link icons (card app-token-header, R5 token.js socials and explorers): only what has data. The token's
// site, X account and Telegram when the helper's token read carries them, its launchpad's page where that path is
// known; every token has an address, so its chain's explorer is drawn, and "Search on X" by that address when no X
// account is listed (R5). Explorer token pages are each explorer's own path (the tx paths are withdraw/model.ts's).
const EXPLORERS: Record<string, { href: string; name: "solscan" | "basescan" | "rhExplorer" | "nearblocks" }> = {
  solana: { href: "https://solscan.io/token/", name: "solscan" },
  base: { href: "https://basescan.org/token/", name: "basescan" },
  robinhood: { href: "https://robinhoodchain.blockscout.com/token/", name: "rhExplorer" },
  near: { href: "https://nearblocks.io/token/", name: "nearblocks" },
};

/** The token's own links as the helper's token read gives them (its `links`: the token's site, X and Telegram from its
 *  list source, card token-page-data-complete-and-fast), each checked again here (safeLink). */
export type SocialLinks = { site?: string; x?: string; telegram?: string };
/** A link the page may draw: an http(s) URL to a DNS name with no credentials, at most 300 characters; X only on
 *  x.com or twitter.com, Telegram only on t.me or telegram.me. Anything else (javascript:, data:, an IP) is no link. */
export function safeLink(raw: unknown, hosts?: readonly string[]): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username !== "" || u.password !== "") return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  if (hosts !== undefined && !hosts.some((h) => host === h || host === `www.${h}`)) return null;
  return u.href;
}
/** The helper's `links` as the page keeps them: only the ones safeLink takes. */
export function socialLinks(v: unknown): SocialLinks {
  const o = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: SocialLinks = {};
  const site = safeLink(o.site);
  const x = safeLink(o.x, ["x.com", "twitter.com"]);
  const telegram = safeLink(o.telegram, ["t.me", "telegram.me"]);
  if (site !== null) out.site = site;
  if (x !== null) out.x = x;
  if (telegram !== null) out.telegram = telegram;
  return out;
}
/** A launchpad's own page for a token, where its path is known: pump.fun's /coin/<mint>. */
const PAD_PAGES: Record<string, (token: string) => string> = { "pump.fun": (t) => `https://pump.fun/coin/${encodeURIComponent(t)}` };
/** The words a drawn link is named by when it has no word of its own: its address without the scheme (data). */
export const linkLabel = (href: string): string => href.replace(/^https?:\/\//, "").replace(/\/$/, "");

export type TokenLink =
  | { id: "explorer"; name: (typeof EXPLORERS)[string]["name"]; href: string }
  | { id: "xSearch"; href: string }
  | { id: "site" | "x" | "telegram" | "pad"; href: string; label: string };

/** The links a token's identity draws, in R5's order (socials, then the explorer): never one without data behind it.
 *  The token's own X account takes Search on X's place (R5: the search is the link when no X account is listed). */
export function tokenLinks(chain: string, token: string, social: SocialLinks = {}, launchpad: string | null = null): TokenLink[] {
  const links: TokenLink[] = [];
  if (social.site !== undefined) links.push({ id: "site", href: social.site, label: linkLabel(social.site) });
  if (social.x !== undefined) links.push({ id: "x", href: social.x, label: linkLabel(social.x) });
  else links.push({ id: "xSearch", href: `https://x.com/search?q=${encodeURIComponent(token)}` });
  if (social.telegram !== undefined) links.push({ id: "telegram", href: social.telegram, label: linkLabel(social.telegram) });
  const pad = launchpad !== null && chain === "solana" && Object.hasOwn(PAD_PAGES, launchpad) ? PAD_PAGES[launchpad]!(token) : null;
  if (pad !== null) links.push({ id: "pad", href: pad, label: launchpad! });
  const e = Object.hasOwn(EXPLORERS, chain) ? EXPLORERS[chain]! : null;
  if (e) links.push({ id: "explorer", name: e.name, href: e.href + encodeURIComponent(token) });
  return links;
}

/** The token's public link, the address the shell shows (SIGN_HOST's /token/<chain>/<id>), for Share. */
export const shareHref = (host: string, chain: string, token: string): string => new URL(`/token/${chain}/${encodeURIComponent(token)}`, host).href;

/** Writes `text` with the async clipboard, else the page's own copy command (a framed page the parent's permissions
 *  keep from the async one): true when either took it. */
export async function copyText(text: string, clip: { writeText(t: string): Promise<void> } | undefined, fallback: (t: string) => boolean): Promise<boolean> {
  try {
    if (!clip) throw new Error("no clipboard");
    await clip.writeText(text);
    return true;
  } catch {
    try {
      return fallback(text);
    } catch {
      return false;
    }
  }
}

/** The watchlist star (R5 token-watch): the tokens kept on this device, `chain/token`, in the browser's storage. A
 *  storage that throws or holds something else reads as an empty list and the star still toggles for the page. */
export const WATCH_KEY = "ct.watch.v1";
export function readWatch(store: Pick<Storage, "getItem"> | null): string[] {
  try {
    const v = JSON.parse(store?.getItem(WATCH_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
/** Toggles `key` in the stored list and returns whether it is now watched. */
export function toggleWatch(store: Pick<Storage, "getItem" | "setItem"> | null, key: string): boolean {
  const list = readWatch(store);
  const on = !list.includes(key);
  try {
    store?.setItem(WATCH_KEY, JSON.stringify(on ? [...list, key] : list.filter((k) => k !== key)));
  } catch {
    // the page's own state still shows the press
  }
  return on;
}
