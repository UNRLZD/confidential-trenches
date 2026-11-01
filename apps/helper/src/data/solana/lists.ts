// GET /v1/market/lists?chain=solana: Discover's Solana lists (markets paper M4.2 and D1.1 rows D-S2 to D-S4 and D-S14,
// docs/plan1/markets.md:2265-2283; the field lists frozen with the app's screens, markets.md:3366-3367). The answer is
// 06b §6.1's `snapshot` of `Row`s, the shape the terminal reads (apps/terminal/src/screens/discover/fields.ts), with
// `buys_1h` and `sells_1h` added for the Trending column (the CO's ask from card app-discover-solana).
//
// Sources: Jupiter's `/tokens/v2/recent` (New) and `/tokens/v2/toptrending/5m` and `/1h` (limit 100), read through the
// helper's own proxy (src/proxy/), so its key, cache, 429 back-off and key-in-answer refusal apply unchanged; and, for
// the pump.fun rows still on their curve, the curve account by one `getMultipleAccounts` per 100 through the helper's
// RPC path (src/rpc/). Every row is listed, with no filter by `launchpad` (D-S4); `launchpad` is only a tag.
//
// Display only: nothing here feeds a signature. Every vendor and RPC value is hostile input: a row with no valid mint,
// symbol or name is dropped, every number is checked finite and in range or becomes null, text is cut and stripped of
// control and direction marks, and a list holds at most 100 rows.
//
// Wire forms (06b:1745-1746): USD values are decimal strings (12 significant digits, never an exponent); changes and
// shares are basis points; counts are integers; a value no source has is null.
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { gzipSync } from "node:zlib";

/** fields.ts ROW_FIELDS in its order, then the two the CO asked for the Trending column. */
export const ROW_FIELDS = [
  "chain", "token", "symbol", "name", "icon", "venue", "label", "created_s", "price_usd", "mc_usd", "vol_24h_usd",
  "chg_5m_bps", "chg_1h_bps", "chg_24h_bps", "liq_usd", "holders", "top10_bps", "src", "as_of_ms",
  "creator", "creator_sold_bps", "dev_bps", "snipers_bps", "mint_auth", "freeze_auth",
  "vol_5m_usd", "buys_5m", "sells_5m", "net_5m_usd", "risk_src",
  "launchpad", "curve_bps",
  "vol_1h_usd",
  "chg_4h_bps", "buys_24h", "sells_24h",
  "buys_1h", "sells_1h",
] as const;
export type RowField = (typeof ROW_FIELDS)[number];
export type Row = Record<RowField, string | number | boolean | null>;

export const LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"] as const;
export type Snapshot = { chain: "solana"; lists: Record<(typeof LISTS)[number], Row[]>; as_of_ms: number };

export const LIST_MAX = 100;
/** The Jupiter reads, each with limit=100 (D-S2, D-S3). */
export const READS = { new: "/tokens/v2/recent", trending_5m: "/tokens/v2/toptrending/5m", trending_1h: "/tokens/v2/toptrending/1h" } as const;
/** The refresh cadence (D-S2's 12 s): a snapshot built within it is served as is; older, it is still served (up to
 *  STALE_MS) while one refresh runs. warm() refreshes on this cadence, so no caller waits on a vendor: a cold read of
 *  the three lists and the curve accounts took 1.6 s from a Mac (Jupiter's 1h list alone 2.4 s once, 1 Nov 15:25Z). */
export const FRESH_MS = 12_000;
/** The last good snapshot serves up to 60 s; after that, with no new read, the lists answer 503 (D1's helper rules). */
export const STALE_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A base58 string's bytes, or null when it is not base58. */
export function b58decode(s: string): Uint8Array | null {
  if (s.length === 0 || s.length > 64) return null;
  const out: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < out.length; i++) {
      carry += out[i]! * 58;
      out[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      out.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== "1") break;
    out.push(0);
  }
  return Uint8Array.from(out.reverse());
}

export function b58encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let zeros = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    zeros += "1";
  }
  return zeros + digits.reverse().map((d) => B58[d]).join("");
}

/** A Solana address: base58 of exactly 32 bytes, written canonically. */
export function address(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return null;
  const b = b58decode(v);
  return b !== null && b.length === 32 && b58encode(b) === v ? v : null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Beyond this a USD value is not a market value but a broken answer. */
const USD_MAX = 1e18;

/** A number as a plain decimal string of at most 12 significant digits, or null. */
export function dec(v: unknown, signed = false): string | null {
  if (!finite(v) || Math.abs(v) > USD_MAX || (!signed && v < 0)) return null;
  if (v === 0) return "0";
  const [m, e] = v.toPrecision(12).split("e") as [string, string | undefined];
  const neg = m.startsWith("-");
  const [int, frac = ""] = m.replace("-", "").split(".") as [string, string?];
  let digits = int + frac;
  let point = int.length + (e === undefined ? 0 : Number(e));
  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  } else if (point > digits.length) digits += "0".repeat(point - digits.length);
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, "");
  const part = digits.slice(point).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${part ? `.${part}` : ""}`;
}

/** A percent as whole basis points, or null. */
function bps(pct: unknown, min = -Infinity, max = Infinity): number | null {
  if (!finite(pct) || pct < min || pct > max || Math.abs(pct) > 1e9) return null;
  return Math.round(pct * 100) || 0;
}

const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
/** A window's buy and sell sides: Jupiter drops a side that is zero (a row with buys only has no sellVolume and no
 *  numSells), so a side is 0 when the other is there, and both unknown when neither is. */
function sides(w: Record<string, unknown>, buy: string, sell: string): [unknown, unknown] {
  const has = (k: string) => Object.hasOwn(w, k);
  if (!has(buy) && !has(sell)) return [undefined, undefined];
  return [has(buy) ? w[buy] : 0, has(sell) ? w[sell] : 0];
}
const sum = (a: unknown, b: unknown): string | null => (finite(a) && finite(b) && a >= 0 && b >= 0 ? dec(a + b) : null);
const net = (a: unknown, b: unknown): string | null => (finite(a) && finite(b) && a >= 0 && b >= 0 ? dec(a - b, true) : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** An authority still set: Jupiter writes `<kind>AuthorityDisabled: true` when it is gone and, when it is not, drops
 *  the flag and names the authority (230 of 230 rows read 1 Nov 15:16Z); neither is unknown. */
const authority = (disabled: unknown, holder: unknown): boolean | null => (disabled === true ? false : address(holder) !== null ? true : null);

// C0 and C1 controls and the direction marks that can reorder a symbol on screen
const STRIP = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
/** Text cut to `max` code points, with no control or direction mark; null when nothing is left. */
export function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = [...v.slice(0, max * 4).replace(STRIP, "").trim()].slice(0, max).join("").trim();
  return s === "" ? null : s;
}

const LAUNCHPAD = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;

/** An ISO time as unix seconds, from 2009 to a day past `nowMs`, or null. */
function seconds(v: unknown, nowMs: number): number | null {
  if (typeof v !== "string" || !ISO.test(v)) return null;
  const ms = Date.parse(v.replace(/(\.\d{3})\d+Z$/, "$1Z"));
  return Number.isFinite(ms) && ms >= Date.UTC(2009, 0, 1) && ms <= nowMs + 86_400_000 ? Math.floor(ms / 1000) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------------------

/** One Jupiter list row as a Row, or null when it has no valid mint, symbol or name. */
export function toRow(raw: unknown, asOfMs: number): Row | null {
  const j = obj(raw);
  const token = address(j.id);
  const symbol = text(j.symbol, 32);
  const name = text(j.name, 64) ?? symbol;
  if (token === null || symbol === null || name === null) return null;
  const s5 = obj(j.stats5m);
  const s1 = obj(j.stats1h);
  const s24 = obj(j.stats24h);
  const [v5b, v5s] = sides(s5, "buyVolume", "sellVolume");
  const [v1b, v1s] = sides(s1, "buyVolume", "sellVolume");
  const [v24b, v24s] = sides(s24, "buyVolume", "sellVolume");
  const [n5b, n5s] = sides(s5, "numBuys", "numSells");
  const [n1b, n1s] = sides(s1, "numBuys", "numSells");
  const [n24b, n24s] = sides(s24, "numBuys", "numSells");
  const audit = obj(j.audit);
  const launchpad = typeof j.launchpad === "string" && LAUNCHPAD.test(j.launchpad) ? j.launchpad : null;
  return {
    chain: "solana",
    token,
    symbol,
    name,
    icon: false, // GET /v1/logo/{chain}/{token} is not served yet; the app draws its own
    venue: null,
    label: null,
    created_s: seconds(obj(j.firstPool).createdAt, asOfMs) ?? seconds(j.createdAt, asOfMs),
    price_usd: dec(j.usdPrice),
    mc_usd: dec(j.mcap),
    vol_24h_usd: sum(v24b, v24s),
    chg_5m_bps: bps(s5.priceChange, -100),
    chg_1h_bps: bps(s1.priceChange, -100),
    chg_24h_bps: bps(s24.priceChange, -100),
    liq_usd: dec(j.liquidity),
    holders: count(j.holderCount),
    top10_bps: bps(audit.topHoldersPercentage, 0, 100),
    src: "jupiter",
    as_of_ms: asOfMs,
    creator: address(j.dev),
    creator_sold_bps: null,
    dev_bps: bps(audit.devBalancePercentage, 0, 100),
    snipers_bps: null, // not served in the hackathon (06b Risk `snipers_bps`)
    mint_auth: authority(audit.mintAuthorityDisabled, j.mintAuthority),
    freeze_auth: authority(audit.freezeAuthorityDisabled, j.freezeAuthority),
    vol_5m_usd: sum(v5b, v5s),
    buys_5m: count(n5b),
    sells_5m: count(n5s),
    net_5m_usd: net(v5b, v5s),
    risk_src: "jupiter",
    launchpad,
    // listed: 10,000 once Jupiter names its graduated pool; on a curve: the curve read below; otherwise unknown
    curve_bps: address(j.graduatedPool) !== null ? 10_000 : null,
    vol_1h_usd: sum(v1b, v1s),
    chg_4h_bps: null, // Jupiter has no 4h window (06b)
    buys_24h: count(n24b),
    sells_24h: count(n24s),
    buys_1h: count(n1b),
    sells_1h: count(n1s),
  };
}

/** A Jupiter list answer's rows: at most LIST_MAX, each mint once, invalid rows dropped; null when it is not a list. */
export function toRows(answer: unknown, asOfMs: number): Row[] | null {
  if (!Array.isArray(answer)) return null;
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const raw of answer.slice(0, LIST_MAX)) {
    const r = toRow(raw, asOfMs);
    if (r === null || seen.has(r.token as string)) continue;
    seen.add(r.token as string);
    rows.push(r);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// pump.fun curves (D-S14; 06b's Graduating row: (793.1e12 - real_token_reserves) / 793.1e12)
// ---------------------------------------------------------------------------------------------------------------

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_PROGRAM_BYTES = b58decode(PUMP_PROGRAM)!;
/** The tokens a pump.fun curve sells before it completes, in base units (793.1 M at 6 decimals). */
export const PUMP_CURVE_TOKENS = 793_100_000_000_000n;
const BONDING_CURVE_DISCRIMINATOR = sha256(new TextEncoder().encode("account:BondingCurve")).slice(0, 8);
const enc = new TextEncoder();

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The pump.fun bonding-curve account of a mint: the program address of ["bonding-curve", mint]. */
export function pumpCurveAddress(mint: string): string {
  const m = b58decode(mint)!;
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(Uint8Array.from([...enc.encode("bonding-curve"), ...m, bump, ...PUMP_PROGRAM_BYTES, ...enc.encode("ProgramDerivedAddress")]));
    if (!onCurve(h)) return b58encode(h);
  }
  throw new Error("no program address");
}

/**
 * A curve account's progress in basis points: 10,000 once `complete`, otherwise 0-9,999 from real_token_reserves; null
 * for an account that is not a pump.fun bonding curve (wrong owner, discriminator or size, or reserves out of range).
 * Layout: 8 discriminator, then u64 virtual_token_reserves, virtual_sol_reserves, real_token_reserves,
 * real_sol_reserves, token_total_supply, then bool complete (offset 48).
 */
export function pumpCurveBps(account: unknown): number | null {
  const a = obj(account);
  if (a.owner !== PUMP_PROGRAM || !Array.isArray(a.data) || a.data[1] !== "base64" || typeof a.data[0] !== "string") return null;
  const d = Buffer.from(a.data[0], "base64");
  if (d.length < 49 || d.length > 1024 || !d.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) return null;
  if (d[48] === 1) return 10_000;
  if (d[48] !== 0) return null;
  const real = d.readBigUInt64LE(24);
  if (real > PUMP_CURVE_TOKENS) return null;
  return Math.min(9_999, Number(((PUMP_CURVE_TOKENS - real) * 10_000n) / PUMP_CURVE_TOKENS));
}

// ---------------------------------------------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------------------------------------------

/** Rows of every list at once, so each token is read once. */
const allRows = (lists: Record<string, Row[]>) => Object.values(lists).flat();

/** The rows whose curve the pump.fun read can fill: tagged pump.fun, no graduated pool, one per mint. */
export function pumpCandidates(rows: readonly Row[]): string[] {
  return [...new Set(rows.filter((r) => r.launchpad === "pump.fun" && r.curve_bps === null).map((r) => r.token as string))];
}

/** The snapshot from the three lists' rows and the curve progress read for some mints. */
export function snapshot(read: { new: Row[]; trending_5m: Row[]; trending_1h: Row[] }, curves: ReadonlyMap<string, number>, asOfMs: number): Snapshot {
  const fill = (rows: Row[]) => rows.map((r) => (r.curve_bps === null && curves.has(r.token as string) ? { ...r, curve_bps: curves.get(r.token as string)! } : r));
  const lists = { new: fill(read.new), trending_5m: fill(read.trending_5m), trending_1h: fill(read.trending_1h) };
  // Graduating (06b): still on a launchpad curve (a launchpad and 0-9,999), highest progress first, each token once
  const seen = new Set<string>();
  const graduating = allRows(lists)
    .filter((r) => r.launchpad !== null && Number.isInteger(r.curve_bps) && (r.curve_bps as number) >= 0 && (r.curve_bps as number) < 10_000)
    .filter((r) => (seen.has(r.token as string) ? false : (seen.add(r.token as string), true)))
    .sort((a, b) => (b.curve_bps as number) - (a.curve_bps as number))
    .slice(0, LIST_MAX);
  return { chain: "solana", lists: { new: lists.new, trending: lists.trending_1h, trending_5m: lists.trending_5m, trending_1h: lists.trending_1h, graduating }, as_of_ms: asOfMs };
}

// ---------------------------------------------------------------------------------------------------------------
// The served answer
// ---------------------------------------------------------------------------------------------------------------

type Answer = { status: number; headers: Record<string, string>; body: string };
type Proxy = { handle(vendor: string, path: string, rawQuery: string, body: string): Promise<Answer> };
type Rpc = { handle(chain: string, contentType: string | undefined, body: string): Promise<{ status: number; body: string }> };
export type ListsAnswer = { status: number; body: string; gzip?: Buffer; asOfMs?: number };

const UPSTREAM: ListsAnswer = { status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };

/** The curve progress of these pump.fun mints, by one getMultipleAccounts per 100; an RPC failure leaves them unknown. */
export async function readPumpCurves(rpc: Rpc, mints: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < mints.length; i += 100) {
    const part = mints.slice(i, i + 100);
    const keys = part.map(pumpCurveAddress);
    try {
      const a = await rpc.handle("solana", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys, { encoding: "base64", commitment: "confirmed" }] }));
      if (a.status !== 200) continue;
      const value = obj(obj(JSON.parse(a.body)).result).value;
      if (!Array.isArray(value) || value.length !== part.length) continue;
      part.forEach((mint, k) => {
        const b = pumpCurveBps(value[k]);
        if (b !== null) out.set(mint, b);
      });
    } catch {
      // unknown stays null
    }
  }
  return out;
}

/** Discover's Solana lists, refreshed at most once per FRESH_MS and shared by every caller. */
export function createSolanaLists(proxy: Proxy, rpc: Rpc, deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  let last: (ListsAnswer & { asOfMs: number }) | null = null;
  // when `last` was built: freshness counts from our own read, since the proxy's cache may hand back an older answer
  let builtAt = -Infinity;
  let running: Promise<ListsAnswer> | null = null;

  async function read(path: string): Promise<{ rows: Row[]; at: number } | null> {
    const a = await proxy.handle("jupiter", path, "limit=100", "");
    if (a.status !== 200) return null;
    const at = Date.parse(a.headers["X-Fetched-At"] ?? "");
    const asOf = Number.isFinite(at) ? at : now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(a.body);
    } catch {
      return null;
    }
    const rows = toRows(parsed, asOf);
    return rows === null ? null : { rows, at: asOf };
  }

  async function refresh(): Promise<ListsAnswer> {
    const [n, t5, t1] = await Promise.all([read(READS.new), read(READS.trending_5m), read(READS.trending_1h)]);
    if (n === null || t5 === null || t1 === null) return last !== null && now() - last.asOfMs <= STALE_MS ? last : UPSTREAM;
    const asOf = Math.min(n.at, t5.at, t1.at);
    const curves = await readPumpCurves(rpc, pumpCandidates([...n.rows, ...t5.rows, ...t1.rows]));
    const body = JSON.stringify(snapshot({ new: n.rows, trending_5m: t5.rows, trending_1h: t1.rows }, curves, asOf));
    last = { status: 200, body, gzip: gzipSync(body), asOfMs: asOf };
    builtAt = now();
    return last;
  }

  function start(): Promise<ListsAnswer> {
    if (!running) {
      running = refresh()
        .catch(() => (last !== null && now() - last.asOfMs <= STALE_MS ? last : UPSTREAM))
        .finally(() => (running = null));
    }
    return running;
  }

  /** The current snapshot: as is when built within FRESH_MS; while its data is under STALE_MS old, as is while one
   *  refresh runs; else the refresh's own answer. */
  async function get(): Promise<ListsAnswer> {
    if (last !== null && now() - builtAt < FRESH_MS) return last;
    if (last !== null && now() - last.asOfMs <= STALE_MS) {
      void start();
      return last;
    }
    return start();
  }

  /** Keep the snapshot fresh on its own: one refresh now and one every FRESH_MS (the server's start only; the timer
   *  never holds the process open). Returns the stop. */
  function warm(): () => void {
    void start();
    const t = setInterval(() => void start(), FRESH_MS);
    t.unref();
    return () => clearInterval(t);
  }

  return { get, warm };
}
