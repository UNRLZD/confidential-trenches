// Discover's rows: the field list, as written. The kit freezes no market field list (packages/kit/src/helper/v1.ts:
// `HelperMarketAnswer = unknown`, "its field lists are frozen with the app's screens, since they feed no signature"),
// and markets.md §7.1 says the same (research main, docs/plan1/markets.md:3368-3369). The one written list of a
// Discover row is 06b §6.1 `Row` and `snapshot` (docs/spec/06b-wallet-webapp.md:1716-1727, v1.36), which markets.md
// D1.1 fills on Solana from Jupiter's list rows (D-S2 to D-S5, D-S14; markets.md:2272-2285). These types copy it field
// for field: nothing here is a field that list lacks. Display only: no value here feeds a signature.
//
// Wire forms (06b:1745-1746): USD values are decimal strings; shares and changes are basis points; counts are integers;
// a field no source has is null (or absent) and draws "—". A trade count has two sides: one Jupiter leaves out reads 0
// when the other is there, and both unknown is null (the helper's `sides`, apps/helper/src/data/solana/lists.ts).

/** A chain id as 06b's stream names it. */
export type MarketChain = "solana" | "base" | "robinhood" | "near";

/** 06b §6.1 `Row` (v1.15 to v1.22 additions included). Every optional field may also be null. */
export interface MarketRow {
  chain: MarketChain;
  /** The token id in its chain's form (a base58 mint on Solana). */
  token: string;
  symbol: string;
  name: string;
  /** The helper has a logo for it at GET /v1/logo/{chain}/{token}. */
  icon: boolean;
  venue?: string | null;
  label?: string | null;
  /** Launch time, unix seconds. */
  created_s?: number | null;
  /** 06b has it on every row; Jupiter's recent list serves rows with no price yet (3 of 14 in the recorded read), so
   *  null is read as "no price". */
  price_usd: string | null;
  mc_usd?: string | null;
  vol_24h_usd?: string | null;
  chg_5m_bps?: number | null;
  chg_1h_bps?: number | null;
  chg_24h_bps?: number | null;
  liq_usd?: string | null;
  holders?: number | null;
  top10_bps?: number | null;
  src: string;
  as_of_ms: number;
  creator?: string | null;
  creator_sold_bps?: number | null;
  dev_bps?: number | null;
  snipers_bps?: number | null;
  mint_auth?: boolean | null;
  freeze_auth?: boolean | null;
  vol_5m_usd?: string | null;
  buys_5m?: number | null;
  sells_5m?: number | null;
  net_5m_usd?: string | null;
  risk_src?: string | null;
  /** The launchpad id. 06b v1.17 has it on every row; Plan 1 lists tokens with no launchpad too (markets.md D-S4,
   *  app.md A2.1), so null is read as "no launchpad". */
  launchpad: string | null;
  curve_bps?: number | null;
  vol_1h_usd?: string | null;
  chg_4h_bps?: number | null;
  buys_24h?: number | null;
  sells_24h?: number | null;
  /** Trending's window (1h). Like the other windows, a side Jupiter leaves out reads 0 when the other is there. */
  buys_1h?: number | null;
  sells_1h?: number | null;
}

/** 06b §6.1 `snapshot`: `trending` equals `trending_1h`; `graduating` highest `curve_bps` first. `chain` is "all" for
 *  the browser's merge of every chain's served lists (09-design-brief S1 Chain filter: "`All` merges the four chains'
 *  served lists in the browser"; data.ts readAllLists), each row still naming its own chain. */
export interface MarketSnapshot {
  chain: MarketChain | "all";
  lists: {
    new: MarketRow[];
    trending: MarketRow[];
    trending_5m?: MarketRow[];
    trending_1h?: MarketRow[];
    graduating?: MarketRow[];
  };
  as_of_ms: number;
}

/** Every `Row` field, in 06b's order. A test holds the fixtures to exactly these keys. */
export const ROW_FIELDS = [
  "chain", "token", "symbol", "name", "icon", "venue", "label", "created_s", "price_usd", "mc_usd", "vol_24h_usd",
  "chg_5m_bps", "chg_1h_bps", "chg_24h_bps", "liq_usd", "holders", "top10_bps", "src", "as_of_ms",
  "creator", "creator_sold_bps", "dev_bps", "snipers_bps", "mint_auth", "freeze_auth",
  "vol_5m_usd", "buys_5m", "sells_5m", "net_5m_usd", "risk_src",
  "launchpad", "curve_bps",
  "vol_1h_usd",
  "chg_4h_bps", "buys_24h", "sells_24h",
  "buys_1h", "sells_1h",
] as const satisfies readonly (keyof MarketRow)[];

/** The fields every row carries (06b marks the rest with `?`); `price_usd` and `launchpad` may be null. */
export const ROW_REQUIRED = ["chain", "token", "symbol", "name", "icon", "price_usd", "src", "as_of_ms", "launchpad"] as const satisfies readonly (keyof MarketRow)[];

export const SNAPSHOT_LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"] as const;
