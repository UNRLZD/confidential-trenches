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

export interface TokenView {
  token: string;
  symbol: string;
  /** Empty when it repeats the symbol. */
  name: string;
  price: string;
  /** `price` cut to the strip tile's width. */
  priceTile: string;
  mc: string;
  vol: string;
  liq: string;
  holders: string;
  age: string;
  chg: { text: string; dir: Dir };
  /** `chg.text` cut to the strip tile's width. */
  chgTile: string;
  launchpad: string | null;
  chain: string;
  curve: Curve;
}

/** The page's values for one token. `nowMs` is the clock the age is drawn against. */
export function tokenView(r: MarketRow, nowMs: number): TokenView {
  return {
    token: r.token,
    symbol: r.symbol,
    name: r.name && r.name !== r.symbol ? r.name : "",
    price: price(r.price_usd),
    priceTile: priceTile(r.price_usd),
    mc: usdTile(r.mc_usd),
    vol: usdTile(r.vol_24h_usd),
    liq: usdTile(r.liq_usd),
    holders: count(r.holders),
    age: age(r.created_s, nowMs),
    chg: change24(r.chg_24h_bps),
    chgTile: changeTile(r.chg_24h_bps),
    launchpad: r.launchpad ?? null,
    chain: r.chain,
    curve: curve(r),
  };
}

// ---------------------------------------------------------------------------------------------------------------- links
// The identity's link icons (card app-token-header, R5 token.js socials and explorers): only what has data. The row
// carries no website, X account or Telegram, so none of those is drawn; every token has an address, so its chain's
// explorer is, and "Search on X" by that address (R5's link when no X account is listed). Explorer token pages are
// each explorer's own path (the tx paths are withdraw/model.ts's).
const EXPLORERS: Record<string, { href: string; name: "solscan" | "basescan" | "rhExplorer" | "nearblocks" }> = {
  solana: { href: "https://solscan.io/token/", name: "solscan" },
  base: { href: "https://basescan.org/token/", name: "basescan" },
  robinhood: { href: "https://robinhoodchain.blockscout.com/token/", name: "rhExplorer" },
  near: { href: "https://nearblocks.io/token/", name: "nearblocks" },
};

export type TokenLink = { id: "explorer"; name: (typeof EXPLORERS)[string]["name"]; href: string } | { id: "xSearch"; href: string };

/** The links a token's identity draws, in R5's order (socials, then the explorer): never one without data behind it. */
export function tokenLinks(chain: string, token: string): TokenLink[] {
  const links: TokenLink[] = [{ id: "xSearch", href: `https://x.com/search?q=${encodeURIComponent(token)}` }];
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
