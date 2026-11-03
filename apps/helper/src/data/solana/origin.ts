// A Solana token's launchpad, read on chain: the account its launchpad program made for it when it launched. One read
// serves Discover's lists (lists.ts) and the token page (token.ts), so a row's `launchpad`, `curve_bps` and the page's
// `pool` say what the chain says, whatever a vendor tags.
//
// Each launchpad program keeps one account per token at an address derived from the mint, which only that program can
// make, and a token's mint is made in its launch, so the account being there, owned by the program, with the program's
// account type and the mint in it, is the launch:
//   - pump.fun (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P): the bonding curve at ["bonding-curve", mint] (lists.ts);
//   - Raydium LaunchLab (LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj): the PoolState at ["pool", mint, quote] for a quote
//     of SOL or USD1, naming the platform (bonk.fun and others launch through it) at its platformId;
//   - Meteora's Dynamic Bonding Curve (dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN): the VirtualPool at ["pool", config,
//     max(mint, quote), min(mint, quote)], whose config names the partner (Jupiter Studio, Bags and others); the config
//     is read only for a token whose provider row names one, since it is a seed.
// Layouts: raydium-io/raydium-sdk-V2 src/raydium/launchpad/layout.ts and pda.ts; MeteoraAg/dynamic-bonding-curve
// programs/dynamic-bonding-curve/src/state/virtual_pool.rs and config.rs and the pool's seeds in
// instructions/initialize_pool (all read 2026-11-03 16:45Z); every offset is checked against live accounts in
// origin.test.ts.
//
// The tag: the program that made the token names its family pad ("pump.fun", "raydium-launchlab", "met-dbc"). A
// provider's tag is kept only when the read agrees with it: Jupiter names a platform or partner pad on these programs
// together with its config (`partnerConfig`), and its tag is kept when the pool the chain holds names that same config;
// otherwise the row carries the family pad. A token none of these programs made is untagged, whatever a provider says:
// a wrong tag is worse than none. Two programs claiming one mint is no answer.
//
// Display only: nothing here feeds a signature. Every RPC value is hostile: an account counts only with the program as
// owner, its account type's discriminator, its size and the mint where the layout puts it.
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { address, b58decode, b58encode, PUMP_PROGRAM, pumpCurveAddress, pumpCurveBps } from "./lists.ts";

export const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const WSOL = "So11111111111111111111111111111111111111112";
export const USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
/** The quotes a LaunchLab pool is read for (bonk.fun launches against SOL and USD1). */
export const LAUNCHLAB_QUOTES = [WSOL, USD1] as const;

/** The family pads, spelled as the terminal's pad table spells them (apps/terminal/src/screens/market/pads.ts). */
export const FAMILY = { pump: "pump.fun", launchlab: "raydium-launchlab", dbc: "met-dbc" } as const;
export type Family = keyof typeof FAMILY;

/** A token's launch as read: its pad, its family, the account it trades in while on its curve, the platform or partner
 *  config it launched under, and its curve progress (10,000 once off its curve; null when unknown). */
export type Origin = { pad: string; family: Family; pool: string; config: string | null; curveBps: number | null };
/** A provider's word on a token: its tag and the config it names (Jupiter's `launchpad` and `partnerConfig`). */
export type Hint = { tag: string | null; config: string | null; graduated: string | null };

const enc = new TextEncoder();
const disc = (name: string) => sha256(enc.encode(`account:${name}`)).slice(0, 8);
const PUMP_CURVE = disc("BondingCurve");
const LAUNCHLAB_POOL = disc("PoolState");
const DBC_POOLS = [disc("VirtualPool"), disc("TransferHookPool")];
const DBC_CONFIGS = [disc("PoolConfig"), disc("ConfigWithTransferHook")];
/** LaunchLab PoolState: 8 discriminator, u64 epoch, u8 bump, status, decimals A and B, migrate type, u64 supply,
 *  total_sell_a, virtual_a, virtual_b, real_a, real_b, total_fund_raising_b, protocol_fee, platform_fee, migrate_fee,
 *  a vesting schedule of 5 u64, then config_id, platform_id, mint_a, mint_b (32 each). */
const LL = { size: 429, status: 17, totalSellA: 29, realA: 53, platform: 173, mintA: 205, mintB: 237 } as const;
/** DBC PoolState: 8 discriminator, a 64-byte volatility tracker, then config, creator, base_mint (32 each), base and
 *  quote vaults, u64 base_reserve, quote_reserve, four u64 fees, u128 sqrt_price, u64 activation_point, u8 pool_type,
 *  is_migrated; 416 bytes after the discriminator. */
const DBC = { size: 424, config: 72, baseMint: 136, quoteReserve: 240, isMigrated: 305 } as const;
/** DBC PoolConfig: quote_mint at 8; migration_quote_threshold at 264; 1,040 bytes after the discriminator (1,120 for
 *  ConfigWithTransferHook, which starts with the same fields). */
const DBC_CFG = { sizes: [1048, 1128], quoteMint: 8, threshold: 264 } as const;

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** A program address: the first bump from 255 down whose hash is off the curve. */
export function pda(seeds: readonly Uint8Array[], program: string): string {
  const p = b58decode(program)!;
  const s = seeds.flatMap((x) => [...x]);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(Uint8Array.from([...s, bump, ...p, ...enc.encode("ProgramDerivedAddress")]));
    if (!onCurve(h)) return b58encode(h);
  }
  throw new Error("no program address");
}

const key = (a: string) => b58decode(a)!;
/** The LaunchLab pool of a mint against a quote. */
export const launchlabPool = (mint: string, quote: string) => pda([enc.encode("pool"), key(mint), key(quote)], LAUNCHLAB_PROGRAM);
/** The DBC pool of a mint under a config against a quote: the larger key first. */
export function dbcPool(mint: string, config: string, quote: string): string {
  const [m, q] = [key(mint), key(quote)];
  const larger = Buffer.compare(Buffer.from(m), Buffer.from(q)) >= 0;
  return pda([enc.encode("pool"), key(config), larger ? m : q, larger ? q : m], DBC_PROGRAM);
}

type Account = { owner: string; data: Buffer };
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A base64 account answer, or null when it is missing or malformed. */
function account(v: unknown): Account | null {
  const a = obj(v);
  if (typeof a.owner !== "string" || !Array.isArray(a.data) || a.data[1] !== "base64" || typeof a.data[0] !== "string" || a.data[0].length > 16_384) return null;
  return { owner: a.owner, data: Buffer.from(a.data[0], "base64") };
}
const pubkey = (d: Buffer, at: number) => b58encode(d.subarray(at, at + 32));
const startsWith = (d: Buffer, prefix: Uint8Array) => d.length >= 8 && d.subarray(0, 8).equals(prefix);

/** A pump.fun bonding curve account: its progress (null when its reserves are not the standard curve's), or undefined
 *  when it is not one (owner, discriminator, size). */
export function pumpOf(v: unknown): { curveBps: number | null } | undefined {
  const a = account(v);
  if (a === null || a.owner !== PUMP_PROGRAM || a.data.length < 49 || a.data.length > 1024 || !startsWith(a.data, PUMP_CURVE)) return undefined;
  return { curveBps: pumpCurveBps(v) };
}

/** A LaunchLab pool account of `mint` against `quote` (any quote when null): its platform and progress, or null when
 *  it is not one. */
export function launchlabOf(v: unknown, mint: string, quote: string | null): { platform: string; curveBps: number } | null {
  const a = account(v);
  if (a === null || a.owner !== LAUNCHLAB_PROGRAM || a.data.length !== LL.size || !startsWith(a.data, LAUNCHLAB_POOL)) return null;
  if (pubkey(a.data, LL.mintA) !== mint || (quote !== null && pubkey(a.data, LL.mintB) !== quote)) return null;
  const status = a.data[LL.status]!;
  const total = a.data.readBigUInt64LE(LL.totalSellA);
  const real = a.data.readBigUInt64LE(LL.realA);
  if (status > 2 || total === 0n || real > total) return null;
  // status 0 is the fund raising; 1 and 2 are past it (migrating, migrated)
  return { platform: pubkey(a.data, LL.platform), curveBps: status === 0 ? Math.min(9_999, Number((real * 10_000n) / total)) : 10_000 };
}

/** A DBC pool account of `mint` under `config`: its quote reserve and whether it has migrated, or null when it is not one. */
export function dbcOf(v: unknown, mint: string, config: string): { quoteReserve: bigint; migrated: boolean } | null {
  const a = account(v);
  if (a === null || a.owner !== DBC_PROGRAM || a.data.length !== DBC.size || !DBC_POOLS.some((d) => startsWith(a.data, d))) return null;
  if (pubkey(a.data, DBC.baseMint) !== mint || pubkey(a.data, DBC.config) !== config) return null;
  const m = a.data[DBC.isMigrated]!;
  if (m > 1) return null;
  return { quoteReserve: a.data.readBigUInt64LE(DBC.quoteReserve), migrated: m === 1 };
}

/** A DBC config account: its quote mint and migration threshold, or null when it is not one. */
export function dbcConfigOf(v: unknown): { quote: string; threshold: bigint } | null {
  const a = account(v);
  if (a === null || a.owner !== DBC_PROGRAM) return null;
  const i = DBC_CONFIGS.findIndex((d) => startsWith(a.data, d));
  if (i < 0 || a.data.length !== DBC_CFG.sizes[i]) return null;
  const threshold = a.data.readBigUInt64LE(DBC_CFG.threshold);
  return threshold === 0n ? null : { quote: pubkey(a.data, DBC_CFG.quoteMint), threshold };
}

/** The Solana pads the terminal's pad table names (apps/terminal/src/screens/market/pads.ts PADS; origin.test.ts holds
 *  them equal): a provider's tag is kept only when it is one of these, so a row never carries a name the app cannot
 *  draw. */
export const APP_PADS: readonly string[] = ["pump.fun", "stonkfun", "raydium-launchlab", "Raydium", "met-dbc", "letsbonk.fun", "metadao", "jup-studio", "bags.fun", "grainpad"];

/** The provider's tag when the chain's config is the one it names and the app knows the name, else the family pad. */
const agreed = (family: Family, config: string, hint: Hint | undefined) =>
  hint?.tag != null && hint.config === config && APP_PADS.includes(hint.tag) ? hint.tag : FAMILY[family];

export const CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const AMM_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
/** The two mints of a pool a LaunchLab token graduated to: Raydium CPMM's token_0_mint and token_1_mint (168, 200;
 *  raydium-io/raydium-cp-swap states/pool.rs) or AMM v4's base and quote mints (400, 432). Only a candidate: a quote is
 *  used only when the LaunchLab pool it derives is there. */
export function graduatedMints(v: unknown): string[] {
  const a = account(v);
  if (a === null) return [];
  const at = a.owner === CPMM_PROGRAM ? [168, 200] : a.owner === AMM_V4_PROGRAM ? [400, 432] : [];
  return at.filter((o) => a.data.length >= o + 32).map((o) => pubkey(a.data, o));
}

/** Accounts of these keys, in order, from one or more getMultipleAccounts; undefined when any read fails. */
export type GetAccounts = (keys: readonly string[]) => Promise<readonly unknown[] | undefined>;

/** The first round's accounts for a token: the pump.fun curve, the LaunchLab pools per quote, then the config and the
 *  graduated pool its hint names. */
export function firstKeys(mint: string, hint: Hint | undefined): string[] {
  const keys = [pumpCurveAddress(mint), ...LAUNCHLAB_QUOTES.map((q) => launchlabPool(mint, q))];
  if (hint?.config != null) keys.push(hint.config);
  if (hint?.graduated != null) keys.push(hint.graduated);
  return keys;
}

type Pending = { mint: string; hint: Hint | undefined; found: Origin[]; next: { key: string; read: (v: unknown) => Origin | null }[] };

/** The first round: the launches it shows, and the second round's reads (the DBC pool for the config's own quote; the
 *  LaunchLab pool for the graduated pool's other mint). */
export function firstRound(mint: string, hint: Hint | undefined, accounts: readonly unknown[]): Pending {
  const keys = firstKeys(mint, hint);
  const p: Pending = { mint, hint, found: [], next: [] };
  const curve = pumpOf(accounts[0]);
  if (curve !== undefined) p.found.push({ pad: FAMILY.pump, family: "pump", pool: keys[0]!, config: null, curveBps: curve.curveBps });
  const ll = (pool: string, v: unknown, quote: string): Origin | null => {
    const x = launchlabOf(v, mint, quote);
    return x === null ? null : { pad: agreed("launchlab", x.platform, hint), family: "launchlab", pool, config: x.platform, curveBps: x.curveBps };
  };
  LAUNCHLAB_QUOTES.forEach((q, i) => {
    const o = ll(keys[1 + i]!, accounts[1 + i], q);
    if (o !== null) p.found.push(o);
  });
  let at = 1 + LAUNCHLAB_QUOTES.length;
  const cfg = hint?.config ?? null;
  if (cfg !== null) {
    const c = dbcConfigOf(accounts[at++]);
    if (c !== null) {
      const pool = dbcPool(mint, cfg, c.quote);
      p.next.push({
        key: pool,
        read: (v) => {
          const d = dbcOf(v, mint, cfg);
          if (d === null) return null;
          const bps = d.migrated ? 10_000 : Math.min(9_999, Number((d.quoteReserve * 10_000n) / c.threshold));
          return { pad: agreed("dbc", cfg, hint), family: "dbc", pool, config: cfg, curveBps: bps };
        },
      });
    }
  }
  if (hint?.graduated != null && !p.found.some((o) => o.family === "launchlab")) {
    for (const q of graduatedMints(accounts[at])) {
      if (q === mint || (LAUNCHLAB_QUOTES as readonly string[]).includes(q)) continue;
      const pool = launchlabPool(mint, q);
      p.next.push({ key: pool, read: (v) => ll(pool, v, q) });
    }
  }
  return p;
}

/** The one launch found, null when none is or two are. */
const one = (found: readonly Origin[]): Origin | null => (found.length === 1 ? found[0]! : null);

/**
 * The origins of these tokens in two rounds of account reads: absent for a token whose reads failed (read again
 * later), null for a token none of the programs made (or two claim), else its launch.
 */
export async function readOrigins(get: GetAccounts, asks: readonly { mint: string; hint: Hint | undefined }[]): Promise<Map<string, Origin | null>> {
  const out = new Map<string, Origin | null>();
  const keys = asks.map((a) => firstKeys(a.mint, a.hint));
  const got = await get(keys.flat());
  if (got === undefined || got.length !== keys.flat().length) return out;
  let k = 0;
  const pending = asks.map((a, i) => {
    const acc = got.slice(k, k + keys[i]!.length);
    k += keys[i]!.length;
    return firstRound(a.mint, a.hint, acc);
  });
  const second = pending.flatMap((p) => p.next.map((n) => n.key));
  const more = second.length === 0 ? [] : await get(second);
  if (more === undefined || more.length !== second.length) {
    // the first round stands only for tokens with no second read
    for (const p of pending) if (p.next.length === 0) out.set(p.mint, one(p.found));
    return out;
  }
  let j = 0;
  for (const p of pending) {
    for (const n of p.next) {
      const o = n.read(more[j++]);
      if (o !== null) p.found.push(o);
    }
    out.set(p.mint, one(p.found));
  }
  return out;
}

/** A known launch's progress from a fresh read of its pool (and, for a DBC pool, its config's threshold): the origin
 *  with the new progress, or null when the read is not that pool. */
export function progressOf(o: Origin, mint: string, pool: unknown, threshold: bigint | null): Origin | null {
  if (o.family === "pump") {
    const b = pumpOf(pool);
    return b === undefined ? null : { ...o, curveBps: b.curveBps };
  }
  if (o.family === "launchlab") {
    const x = launchlabOf(pool, mint, null);
    return x === null || x.platform !== o.config ? null : { ...o, curveBps: x.curveBps };
  }
  const d = dbcOf(pool, mint, o.config!);
  if (d === null) return null;
  return { ...o, curveBps: d.migrated ? 10_000 : threshold === null ? null : Math.min(9_999, Number((d.quoteReserve * 10_000n) / threshold)) };
}

/** Jupiter's word on each token of a list answer: its tag and the config it names, each checked as an id. */
export function hintsOf(answer: unknown): Map<string, Hint> {
  const out = new Map<string, Hint>();
  if (!Array.isArray(answer)) return out;
  for (const raw of answer.slice(0, 100)) {
    const j = obj(raw);
    const mint = address(j.id);
    if (mint === null) continue;
    const tag = typeof j.launchpad === "string" && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(j.launchpad) ? j.launchpad : null;
    out.set(mint, { tag, config: address(j.partnerConfig), graduated: address(j.graduatedPool) });
  }
  return out;
}

/** Launches kept, the oldest first out. */
export const ORIGIN_MAX = 20_000;
/** Tokens whose launch one refresh reads (about 3 accounts each, so about 3 getMultipleAccounts); the rest wait a
 *  refresh. */
export const ORIGIN_ASKS_PER_TICK = 100;
/** A token younger than this that no program shows is read again, since the RPC may not hold its launch yet. */
export const SETTLE_S = 60;

/** One token a refresh may read: the provider's word on it and when it was made (unix s; null when unknown). */
export type Ask = { mint: string; hint: Hint | undefined; createdS: number | null };

/**
 * Each token's launch, read once and kept (a token's launch never changes), and the progress of those still on their
 * curve, read again on each refresh. `get` is the token's origin, null for none, undefined while not read.
 */
export function createOrigins(getAccounts: GetAccounts) {
  const known = new Map<string, Origin | null>();
  const keep = (mint: string, o: Origin | null) => {
    if (!known.has(mint) && known.size >= ORIGIN_MAX) known.delete(known.keys().next().value!);
    known.set(mint, o);
  };

  /** `get`: the reads' path for this refresh (a token page reads on its caller's share). */
  async function refresh(asks: readonly Ask[], nowMs: number, get: GetAccounts = getAccounts): Promise<void> {
    const seen = new Set<string>();
    const fresh: Ask[] = [];
    const moving: [string, Origin][] = [];
    for (const a of asks) {
      if (seen.has(a.mint)) continue;
      seen.add(a.mint);
      const o = known.get(a.mint);
      if (o === undefined) {
        if (fresh.length < ORIGIN_ASKS_PER_TICK) fresh.push(a);
      }      else if (o !== null && o.curveBps !== 10_000) moving.push([a.mint, o]);
    }
    const progress = async () => {
      if (moving.length === 0) return;
      const keys = moving.flatMap(([, o]) => (o.family === "dbc" ? [o.pool, o.config!] : [o.pool]));
      const got = await get(keys);
      if (got === undefined || got.length !== keys.length) return;
      let k = 0;
      for (const [mint, o] of moving) {
        const pool = got[k++];
        const threshold = o.family === "dbc" ? (dbcConfigOf(got[k++])?.threshold ?? null) : null;
        const next = progressOf(o, mint, pool, threshold);
        if (next !== null && known.get(mint) === o) known.set(mint, next);
      }
    };
    const launches = async () => {
      const got = await readOrigins(get, fresh);
      for (const a of fresh) {
        const o = got.get(a.mint);
        if (o === undefined) continue; // the read failed: read again next refresh
        if (o === null && (a.createdS === null || nowMs / 1000 - a.createdS < SETTLE_S)) continue; // too new to call it none
        keep(a.mint, o);
      }
    };
    await Promise.all([progress(), launches()]);
  }

  return { get: (mint: string): Origin | null | undefined => known.get(mint), refresh };
}

type Rpc = { handle(chain: string, contentType: string | undefined, body: string, client?: string, reserved?: boolean): Promise<{ status: number; body: string }> };

/** GetAccounts over the helper's RPC path: one getMultipleAccounts (base64) per 100 keys, at once; `reserved` draws on
 *  the helper's own reserve (Discover's lists), else the caller's share. */
export function rpcAccounts(rpc: Rpc, reserved: boolean, client?: string): GetAccounts {
  return async (keys) => {
    const parts: string[][] = [];
    for (let i = 0; i < keys.length; i += 100) parts.push(keys.slice(i, i + 100));
    try {
      const got = await Promise.all(
        parts.map(async (part) => {
          const a = await rpc.handle("solana", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [part, { encoding: "base64", commitment: "confirmed" }] }), client, reserved);
          if (a.status !== 200) return undefined;
          const value = obj(obj(JSON.parse(a.body)).result).value;
          return Array.isArray(value) && value.length === part.length ? value : undefined;
        }),
      );
      return got.some((x) => x === undefined) ? undefined : (got as unknown[][]).flat();
    } catch {
      return undefined;
    }
  };
}
