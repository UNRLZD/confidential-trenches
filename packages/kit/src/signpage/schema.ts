// The shapes the signing-page client checks (app.md §2.1; APU-02, app.md:1327). Every message from the page is checked
// against its schema before the client acts on it: exact keys (an extra field fails), plain objects and arrays only,
// no `__proto__`, `constructor` or `prototype` key at any depth, bounded strings, arrays and depth. Every request is
// checked against its kind's params before it is built, so a field its kind does not allow is never sent.
// The types these schemas mirror are messages.ts's; the test checks one valid and several invalid values per kind.

import { base58 } from "@scure/base";
import { CHAINS, type Chain } from "../orders/record.ts";
import {
  DEPOSIT_HELD_STAGES, DEPOSIT_HOLDS, DEPOSIT_REFUNDED_STAGES, DEPOSIT_STAGES, POOL_ASSET_DECIMALS, POOL_ASSETS, POOL_CHAINS,
  SIGNPAGE_KINDS,
} from "./messages.ts";
import type { PoolAsset, SignpageKind } from "./messages.ts";

/** A check of one value. */
export type SignpageSchema = (v: unknown) => boolean;

/**
 * The largest request, app to page: its JSON, in UTF-8 bytes (the size cap of app.md §2.1 item 1, app.md:116-117).
 * Requests are small, and the app is the side that could be swapped, so the signing page refuses a bigger one.
 */
export const SIGNPAGE_MAX_REQUEST_BYTES = 65_536;
/** The longest path a `nav` carries, in UTF-8 bytes (card signpage-shell). */
export const SIGNPAGE_MAX_NAV_BYTES = 2_048;
/**
 * The largest answer or event, page to app (origin and source already checked): a precaution far above real use, never
 * a user limit (a `state` with 9,000 orders is about 3 MiB).
 */
export const SIGNPAGE_MAX_ANSWER_BYTES = 4_194_304;
/** The deepest nesting the client reads. */
export const SIGNPAGE_MAX_DEPTH = 12;
/** The longest array the client reads. */
export const SIGNPAGE_MAX_ARRAY = 10_000;
const MAX_STRING = 512;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INDEX = /^(0|[1-9]\d*)$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * A plain dense array of at most SIGNPAGE_MAX_ARRAY items whose own keys are its indexes and `length` only, checked
 * before anything iterates it: a named key (JSON drops it, so the size check never sees it), an own `__proto__`, a hole
 * or a huge sparse length is refused at once.
 */
const isPlainArray = (v: unknown): v is unknown[] => {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return false;
  const n = v.length;
  if (n > SIGNPAGE_MAX_ARRAY) return false;
  const keys = Reflect.ownKeys(v);
  if (keys.length !== n + 1) return false;
  for (const k of keys) {
    if (k === "length") continue;
    if (typeof k !== "string" || !INDEX.test(k) || Number(k) >= n) return false;
  }
  return true;
};

/**
 * True when `v` is made of plain objects, plain dense arrays, strings, finite numbers, booleans and null only, with no
 * forbidden key, at most SIGNPAGE_MAX_DEPTH deep, and its JSON at most SIGNPAGE_MAX_ANSWER_BYTES long. The walk counts
 * one per value it visits, plus the characters of every string and key, and stops past the cap, before any JSON is
 * made: every value is at least one byte of JSON, so a JSON within the cap never needs more visits than that. This
 * also bounds a message that shares one array many times over (structured clone keeps shared references), whose
 * leaves would otherwise be walked once per path. A count, not a seen-set: it bounds unshared values too.
 */
export function signpageIsPlainMessage(v: unknown): boolean {
  let chars = 0;
  const walk = (x: unknown, depth: number): boolean => {
    if (depth > SIGNPAGE_MAX_DEPTH || ++chars > SIGNPAGE_MAX_ANSWER_BYTES) return false;
    if (x === null || typeof x === "boolean") return true;
    if (typeof x === "string") return (chars += x.length) <= SIGNPAGE_MAX_ANSWER_BYTES;
    if (typeof x === "number") return Number.isFinite(x);
    if (Array.isArray(x)) return isPlainArray(x) && x.every((e) => walk(e, depth + 1));
    if (!isPlainObject(x)) return false;
    for (const k of Reflect.ownKeys(x)) {
      if (typeof k !== "string" || FORBIDDEN_KEYS.has(k)) return false;
      if ((chars += k.length) > SIGNPAGE_MAX_ANSWER_BYTES) return false;
      if (!walk(x[k], depth + 1)) return false;
    }
    return true;
  };
  if (!walk(v, 0)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length <= SIGNPAGE_MAX_ANSWER_BYTES;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ builders
const str: SignpageSchema = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_STRING;
/** A decimal string: digits, an optional fraction. */
const dec: SignpageSchema = (v) => typeof v === "string" && /^\d{1,78}(\.\d{1,78})?$/.test(v);
const bool: SignpageSchema = (v) => typeof v === "boolean";
const uint: SignpageSchema = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const bps = (min: number): SignpageSchema => (v) => uint(v) && (v as number) >= min && (v as number) <= 10_000;
const iso: SignpageSchema = (v) => str(v) && /^\d{4}-\d{2}-\d{2}T/.test(v as string) && !Number.isNaN(Date.parse(v as string));
/**
 * nav's path: APP_HOST's own path and query, never another origin's: it starts with "/" and its second character is
 * neither "/" nor "\\" (each would read as another host), no control character, at most SIGNPAGE_MAX_NAV_BYTES of UTF-8.
 * The shell checks it again by its own rule (packages/signpage/src/shell.ts, appSrc).
 */
const navPath: SignpageSchema = (v) =>
  typeof v === "string" && v.startsWith("/") && v[1] !== "/" && v[1] !== "\\" && !/[\u0000-\u001f\u007f]/.test(v) &&
  new TextEncoder().encode(v).length <= SIGNPAGE_MAX_NAV_BYTES;
/** A return key: a name from the release's fixed list (app.md §2.1 item 5). */
const returnKey: SignpageSchema = (v) => typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v);
const lit = (x: unknown): SignpageSchema => (v) => v === x;
const oneOf = (xs: readonly unknown[]): SignpageSchema => (v) => xs.includes(v);
const arr = (item: SignpageSchema, min = 0): SignpageSchema => (v) => isPlainArray(v) && v.length >= min && v.every(item);
/** An object with exactly these keys: every required one, any of the optional ones, nothing else. */
const obj = (req: Record<string, SignpageSchema>, opt: Record<string, SignpageSchema> = {}): SignpageSchema => (v) => {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(req)) if (!Object.hasOwn(v, k) || !req[k]!(v[k])) return false;
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== "string" || FORBIDDEN_KEYS.has(k)) return false;
    if (Object.hasOwn(req, k)) continue;
    if (!Object.hasOwn(opt, k) || !opt[k]!(v[k])) return false;
  }
  return true;
};
/** A union told apart by one key's value. */
const by = (key: string, cases: Record<string, SignpageSchema>): SignpageSchema => (v) => {
  if (!isPlainObject(v)) return false;
  const tag = v[key];
  return typeof tag === "string" && Object.hasOwn(cases, tag) && cases[tag]!(v);
};

// ------------------------------------------------------------------------------------------------ messages.ts's types
const chain = oneOf(CHAINS);
const poolChain = oneOf(POOL_CHAINS);
const way = oneOf(["passkey", "words", "wallet"]);
const DEPOSIT = DEPOSIT_STAGES;
const WITHDRAW = ["proving", "submitted", "in_transit", "sent", "refunded", "stopped"] as const;
const TRADE = ["signed", "sent", "filled", "part_filled", "refused", "not_landed"] as const;
const HOP = ["in_flight", "arrived", "refunded", "fallback"] as const;
const RETURN = ["signed", "sent", "in_transit", "into_vault", "done"] as const;
const RESTORE = ["started", "reading", "done", "stalled"] as const;
const STAGES = [...new Set([...DEPOSIT, ...WITHDRAW, ...TRADE, ...HOP, ...RETURN, ...RESTORE, "queued"])];
const walletState = oneOf(["PLANNED", "ARMING", "READY", "IN_POSITION", "RETURNING", "EMPTY"]);
const orderState = oneOf(["SIGNED", "ARMED", "FILLED", "CANCELLED", "DEAD"]);
const orderKind = oneOf(["stop", "take_profit", "limit"]);
const txs = arr(obj({ chain, hash: str }));
const trigger = obj({ kind: orderKind, pool: str, venue: str, direction: oneOf(["lte", "gte"]), price: dec, quote_asset: str });
const op = (kind: SignpageSchema, stages: readonly string[], extra: Record<string, SignpageSchema> = {}) =>
  obj({ id: str, kind, stage: oneOf(stages), txs }, extra);
const errorCode: SignpageSchema = (v) => typeof v === "string" && /^[a-z0-9_.-]{1,64}$/.test(v);

/** A deposit's facts (messages.ts DepositFacts), each checked by type here and by stage in depositFactsFit. */
const DEPOSIT_FACTS = { refunded: bool, hold: oneOf(DEPOSIT_HOLDS), held_id: str, since_ms: uint, amount_usd: dec };
/** Each fact only on the stages it belongs to, so the app never draws a stage with a fact the device cannot have set. */
const depositFactsFit = (v: unknown): boolean => {
  const d = v as { stage: (typeof DEPOSIT)[number]; refunded?: unknown; hold?: unknown; held_id?: unknown; since_ms?: unknown; amount_usd?: unknown };
  if (d.hold !== undefined && d.stage !== "halted") return false;
  if (d.amount_usd !== undefined && d.stage !== "done") return false;
  if (d.held_id !== undefined && !DEPOSIT_HELD_STAGES.includes(d.stage)) return false;
  if (d.refunded !== undefined && !DEPOSIT_REFUNDED_STAGES.includes(d.stage)) return false;
  if (d.since_ms !== undefined && (d.stage === "quote_checked" || d.stage === "expired")) return false;
  return true;
};
const depositOp: SignpageSchema = (v) => op(lit("deposit"), DEPOSIT, DEPOSIT_FACTS)(v) && depositFactsFit(v);
const depositConfirm: SignpageSchema = (v) => obj({ stage: oneOf(DEPOSIT) }, DEPOSIT_FACTS)(v) && depositFactsFit(v);

/** The asset each chain's pool holds: the Solana pool wrapped SOL, the EVM pools native ETH, the NEAR vault USDC. */
const POOL_CHAIN_ASSET: Readonly<Record<Chain, PoolAsset>> = Object.freeze({ solana: "SOL", base: "ETH", robinhood: "ETH", near: "USDC" });
/** A dec string in base units at `d` decimals, or null when it has more fraction digits than `d`. */
const unitsAt = (s: string, d: number): bigint | null => {
  const [w, f = ""] = s.split(".");
  return f.length > d ? null : BigInt(w! + f.padEnd(d, "0"));
};
/** The private balance per chain's pool: each entry exact, its asset one of POOL_ASSETS (no decimals key: they come
 * from POOL_ASSET_DECIMALS only) and the one its chain's pool holds, its amounts with no more fraction digits than the
 * asset has decimals, its ready at most its balance, its tap_max only with a ready and at most that ready (one
 * proof's spend, at most its chunk; "0" when the fee and W's new accounts eat every chunk), one entry per chain (a chain twice is refused). */
/** The pool asset's USD price as the page read it (card signpage-pool-price): one asset is price x 10^expo USD, price a
 * positive integer with no leading zero, expo an integer in -18..0 (poolUsdPrice's bounds), published_s the feed's own
 * time and read_ms the device's clock at the read; only on a chain with a feed (POOL_USD_FEEDS: not NEAR). */
const poolPrice = obj({
  price: (v) => typeof v === "string" && /^[1-9]\d{0,77}$/.test(v),
  expo: (v) => Number.isInteger(v) && (v as number) <= 0 && (v as number) >= -18,
  published_s: uint,
  read_ms: uint,
});
const PRICED: readonly Chain[] = ["solana", "base", "robinhood"];
const poolEntry = obj({ chain, asset: oneOf(POOL_ASSETS), balance: dec }, { ready: dec, tap_max: dec, price: poolPrice });
const poolFits: SignpageSchema = (v) => {
  if (!poolEntry(v)) return false;
  const p = v as { chain: Chain; asset: PoolAsset; balance: string; ready?: string; tap_max?: string; price?: unknown };
  if (POOL_CHAIN_ASSET[p.chain] !== p.asset) return false;
  if (p.price !== undefined && !PRICED.includes(p.chain)) return false;
  const d = POOL_ASSET_DECIMALS[p.asset];
  const balance = unitsAt(p.balance, d);
  if (balance === null) return false;
  if (p.ready === undefined) return p.tap_max === undefined;
  const ready = unitsAt(p.ready, d);
  if (ready === null || ready > balance) return false;
  if (p.tap_max === undefined) return true;
  const tapMax = unitsAt(p.tap_max, d);
  return tapMax !== null && tapMax <= ready;
};
const poolList = arr(poolFits);
const pools: SignpageSchema = (v) =>
  poolList(v) && new Set((v as { chain: unknown }[]).map((p) => p.chain)).size === (v as unknown[]).length;

/** A deposit wallet with money left (card app-export-every-wallet): exact, its asset its chain's pool asset, its amount
 * with no more fraction digits than that asset has decimals; one entry per wallet (a chain and address twice is refused). */
const depositWalletEntry = obj({ chain, address: str, asset: oneOf(POOL_ASSETS), amount: dec });
const depositWalletFits: SignpageSchema = (v) => {
  if (!depositWalletEntry(v)) return false;
  const w = v as { chain: Chain; asset: PoolAsset; amount: string };
  return POOL_CHAIN_ASSET[w.chain] === w.asset && unitsAt(w.amount, POOL_ASSET_DECIMALS[w.asset]) !== null;
};
const depositWalletList = arr(depositWalletFits);
const depositWallets: SignpageSchema = (v) =>
  depositWalletList(v) && new Set((v as { chain: string; address: string }[]).map((w) => `${w.chain}\n${w.address}`)).size === (v as unknown[]).length;

const state = obj(
  {
    release: str,
    api: lit(1),
    signed_in: bool,
    code_saved: bool,
    vault_balance: dec,
    wallets: arr(obj({ chain, address: str, role: oneOf(["fresh", "hop"]), size: dec, state: walletState })),
    positions: arr(obj({ chain, token: str, amount: dec, cost: dec, wallets: arr(str) })),
    orders: arr(
      obj(
        { order_id: str, chain, wallet: str, token: str, group_id: str, trigger, state: orderState },
        { last_check: uint },
      ),
    ),
    held: arr(obj({ id: str, asset: str, amount: dec })),
    ops: arr(
      by("kind", {
        deposit: depositOp,
        withdraw: op(lit("withdraw"), WITHDRAW),
        buy: op(lit("buy"), TRADE, { code: errorCode }),
        sell: op(lit("sell"), TRADE, { code: errorCode }),
        hop: op(lit("hop"), HOP),
        return: op(lit("return"), RETURN),
        restore: op(lit("restore"), RESTORE),
      }),
    ),
  },
  { way, signin_failed: obj({ way, reason: str }), pools, deposit_wallets: depositWallets },
);

const open = obj({ pending: lit(true) });

/** The result of each kind, as SignpageResults names it. */
export const SIGNPAGE_RESULT_SCHEMAS = {
  "deposit.quote": obj({
    deposit_address: str,
    origin_asset: str,
    amount_in: dec,
    min_amount_out: dec,
    deadline: iso,
    time_estimate_s: uint,
  }),
  "deposit.confirm": depositConfirm,
  arm: obj({ stage: lit("queued") }),
  buy: obj({ stage: oneOf(TRADE), txs }),
  hop: obj({ stage: oneOf(HOP), txs }),
  "orders.set": obj({ orders: arr(obj({ order_id: str, group_id: str, kind: orderKind, state: orderState })) }),
  "orders.cancel": obj({ orders: arr(obj({ order_id: str, state: orderState })), txs }),
  return: obj({ stage: oneOf(RETURN), txs }),
  "withdraw.open": open,
  "signin.open": open,
  "backup.open": open,
  "export.open": open,
  signout: open,
  restore: obj({ stage: lit("started") }),
  state,
  nav: obj({}),
  reload: obj({}),
  "pool.deposit": obj({ stage: oneOf(TRADE), txs }),
  "pool.buy": obj({ stage: oneOf(TRADE), txs }),
  "pool.sell": obj({ stage: oneOf(TRADE), txs }),
  "pool.withdraw": open,
} as const satisfies Record<SignpageKind, SignpageSchema>;

const exit = obj({ trigger_price: dec, share_bps: bps(1) });

/** The params of each kind, as SignpageParams names them: exactly its allowed fields (W §2.8 rows; APU-02). */
export const SIGNPAGE_PARAM_SCHEMAS = {
  "deposit.quote": obj({ origin_asset: str, amount: dec }),
  "deposit.confirm": obj({ deposit_address: str }),
  arm: obj({ chain, amount: dec }),
  buy: obj({ chain, token: str, side: oneOf(["buy", "sell"]), amount: dec, slippage_bps: bps(0) }),
  hop: obj({ from: chain, to: chain, amount: dec }),
  "orders.set": obj({ chain, token: str, slippage_bps: bps(0) }, { tp: exit, sl: exit }),
  "orders.cancel": obj({ order_ids: arr(str, 1) }),
  return: obj({ chain, wallet: str }),
  "withdraw.open": obj({ return_key: returnKey }, { from_id: str }),
  "signin.open": obj({ return_key: returnKey, way }),
  "backup.open": obj({ return_key: returnKey }),
  "export.open": obj({ return_key: returnKey, chain, address: str }),
  signout: obj({ return_key: returnKey }),
  restore: obj({}),
  state: obj({}),
  nav: obj({ path: navPath }),
  reload: obj({}),
  "pool.deposit": obj({ chain: poolChain, amount: dec }),
  "pool.buy": obj({ chain: poolChain, token: str, amount: dec, slippage_bps: bps(0) }),
  "pool.sell": obj({ chain: poolChain, token: str, amount: dec, slippage_bps: bps(0) }),
  "pool.withdraw": obj({ return_key: returnKey, chain: poolChain }),
} as const satisfies Record<SignpageKind, SignpageSchema>;

/** The handshake, page to app. Any whole `api` passes here; the client refuses one it does not speak. */
export const signpageReadySchema = obj({ v: lit(1), type: lit("ready"), release: str, api: uint });
export const signpageStateEventSchema = obj({ v: lit(1), type: lit("state"), state });
export const signpageProgressSchema = obj({ v: lit(1), type: lit("progress"), id: str, stage: oneOf(STAGES) });
/** A route event's `out`: a token amount above 0 in whole units, at most 78 digits each side of the point, no leading
 *  zero, no trailing zero after it. The signing page tells no amount this refuses (src/pool-buy.ts). */
export const SIGNPAGE_ROUTE_OUT = /^(0|[1-9]\d{0,77})(\.\d{0,77}[1-9])?$/;
const routeOutAmount: SignpageSchema = (v) => typeof v === "string" && v !== "0" && SIGNPAGE_ROUTE_OUT.test(v);
/** A Solana address: base58 of exactly 32 bytes. */
const solAddress: SignpageSchema = (v) => {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false;
  try {
    return base58.decode(v).length === 32;
  } catch {
    return false;
  }
};
/** A Solana transaction signature: base58 of exactly 64 bytes. */
const solSignature: SignpageSchema = (v) => {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v)) return false;
  try {
    return base58.decode(v).length === 64;
  } catch {
    return false;
  }
};
/** A route event (messages.ts BuyRoute): a progress event with no stage and exactly one of its four shapes. W and the
 *  pool are addresses; the venue is the page's name for it, a free string; tx a signature. */
const routeHead = { v: lit(1), type: lit("progress"), id: str };
const routeWallet = obj({ ...routeHead, wallet: solAddress });
const routeVenue = obj({ ...routeHead, venue: str, pool: solAddress });
const routeOut = obj({ ...routeHead, out: routeOutAmount });
const routeTx = obj({ ...routeHead, tx: solSignature });
export const signpageProgressRouteSchema: SignpageSchema = (v) => routeWallet(v) || routeVenue(v) || routeOut(v) || routeTx(v);

/** An answer's envelope; the result inside is checked against its kind's schema by the client. */
export const signpageAnswerOkSchema = obj({ v: lit(1), id: str, ok: lit(true), result: (v) => isPlainObject(v) });
export const signpageAnswerErrorSchema = obj({ v: lit(1), id: str, ok: lit(false), error: obj({ code: errorCode }) });

/** True when `kind` is one of the twenty-one. */
export const signpageIsKind = (kind: unknown): kind is SignpageKind =>
  typeof kind === "string" && (SIGNPAGE_KINDS as readonly string[]).includes(kind);
