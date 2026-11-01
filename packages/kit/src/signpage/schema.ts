// The shapes the signing-page client checks (app.md §2.1; APU-02, app.md:1327). Every message from the page is checked
// against its schema before the client acts on it: exact keys (an extra field fails), plain objects and arrays only,
// no `__proto__`, `constructor` or `prototype` key at any depth, bounded strings, arrays and depth. Every request is
// checked against its kind's params before it is built, so a field its kind does not allow is never sent.
// The types these schemas mirror are messages.ts's; the test checks one valid and several invalid values per kind.

import { CHAINS } from "../orders/record.ts";
import { SIGNPAGE_KINDS } from "./messages.ts";
import type { SignpageKind } from "./messages.ts";

/** A check of one value. */
export type SignpageSchema = (v: unknown) => boolean;

/** The largest message the client reads: its JSON, in UTF-8 bytes (the size cap of app.md §2.1 item 1, app.md:116-117). */
export const SIGNPAGE_MAX_MESSAGE_BYTES = 65_536;
/** The deepest nesting the client reads. */
export const SIGNPAGE_MAX_DEPTH = 12;
/** The longest array the client reads. */
export const SIGNPAGE_MAX_ARRAY = 2_000;
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
 * forbidden key, at most SIGNPAGE_MAX_DEPTH deep, and its JSON at most SIGNPAGE_MAX_MESSAGE_BYTES long. The walk counts
 * the characters of every string and key as it goes and stops past the cap, before any JSON is made.
 */
export function signpageIsPlainMessage(v: unknown): boolean {
  let chars = 0;
  const walk = (x: unknown, depth: number): boolean => {
    if (depth > SIGNPAGE_MAX_DEPTH) return false;
    if (x === null || typeof x === "boolean") return true;
    if (typeof x === "string") return (chars += x.length) <= SIGNPAGE_MAX_MESSAGE_BYTES;
    if (typeof x === "number") return Number.isFinite(x);
    if (Array.isArray(x)) return isPlainArray(x) && x.every((e) => walk(e, depth + 1));
    if (!isPlainObject(x)) return false;
    for (const k of Reflect.ownKeys(x)) {
      if (typeof k !== "string" || FORBIDDEN_KEYS.has(k)) return false;
      if ((chars += k.length) > SIGNPAGE_MAX_MESSAGE_BYTES) return false;
      if (!walk(x[k], depth + 1)) return false;
    }
    return true;
  };
  if (!walk(v, 0)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length <= SIGNPAGE_MAX_MESSAGE_BYTES;
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
const way = oneOf(["passkey", "words", "wallet"]);
const DEPOSIT = ["quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted"] as const;
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
        deposit: op(lit("deposit"), DEPOSIT),
        withdraw: op(lit("withdraw"), WITHDRAW),
        buy: op(lit("buy"), TRADE, { code: errorCode }),
        sell: op(lit("sell"), TRADE, { code: errorCode }),
        hop: op(lit("hop"), HOP),
        return: op(lit("return"), RETURN),
        restore: op(lit("restore"), RESTORE),
      }),
    ),
  },
  { way, signin_failed: obj({ way, reason: str }) },
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
  "deposit.confirm": obj({ stage: oneOf(DEPOSIT) }),
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
} as const satisfies Record<SignpageKind, SignpageSchema>;

/** The handshake, page to app. Any whole `api` passes here; the client refuses one it does not speak. */
export const signpageReadySchema = obj({ v: lit(1), type: lit("ready"), release: str, api: uint });
export const signpageStateEventSchema = obj({ v: lit(1), type: lit("state"), state });
export const signpageProgressSchema = obj({ v: lit(1), type: lit("progress"), id: str, stage: oneOf(STAGES) });

/** An answer's envelope; the result inside is checked against its kind's schema by the client. */
export const signpageAnswerOkSchema = obj({ v: lit(1), id: str, ok: lit(true), result: (v) => isPlainObject(v) });
export const signpageAnswerErrorSchema = obj({ v: lit(1), id: str, ok: lit(false), error: obj({ code: errorCode }) });

/** True when `kind` is one of the fifteen. */
export const signpageIsKind = (kind: unknown): kind is SignpageKind =>
  typeof kind === "string" && (SIGNPAGE_KINDS as readonly string[]).includes(kind);
