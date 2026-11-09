// What the page sends a client of each kit version (card kit-frame-version). The kit's client names its version in a
// hello before each handshake `state` request (packages/kit/src/signpage/messages.ts HelloMessage); a client that names
// none is kit-v1 to kit-v1.4, which all read one shape: the state with no `pools` and no `deposit_wallets`, a deposit
// op with no facts and only the eight stages kit-v1 named, and they refuse the whole state for one op they cannot
// read. So the page sends such a client the nearest thing it reads: every field after it left out, a newer deposit
// stage mapped down to the kit-v1.4 stage that tells the truth about where the money is (V1_4_DEPOSIT_STAGE), an op it
// still cannot read left out, and no route event (kit-v1.4 has no pool.buy to ask for one). A client that names kit-v1.5
// reads everything but a deposit's moved_out fact (card held-move-forgotten-tx), which it refuses the whole state for:
// it is sent each deposit with that fact left out, so its app still draws the moved deposit as held. A client that names
// kit-v1.6 reads everything but a pool deposit's op (card pool-deposit-stages), which kit-v1.6 has no kind for: it is
// sent the state with every pool_deposit op left out (kit-v1.5 too), never the op in another kind's shape. A client at
// SIGNPAGE_KIT_VERSION or above gets every message as it is. A change to what the page may send raises the kit's
// SIGNPAGE_KIT_VERSION and adds the version before it here.
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import type { DepositStage, Operation, SignpageKind, SignpageState, Stage } from "../../kit/src/signpage/messages.ts";

/** The levels this page sends at: kit-v1.4's shape, kit-v1.5's (no moved_out, no pool_deposit op), kit-v1.6's (no
 *  pool_deposit op), or everything (kit-v1.7 and above). */
export type KitLevel = "1.4" | "1.5" | "1.6" | "current";
/** A client that posts no hello. */
export const KIT_DEFAULT: KitLevel = "1.4";
/** The first kit version that names itself and reads everything this page sends: the kit's own, as [major, minor]. */
const CURRENT_FROM = SIGNPAGE_KIT_VERSION.split(".").map(Number) as [number, number];
const VERSION = /^(\d{1,4})\.(\d{1,4})$/;

/** The kit version a hello names ({ v: 1, type: "hello", kit }, exactly), or null when `m` is not a hello. */
export function helloKit(m: unknown): string | null {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  const keys = Reflect.ownKeys(m);
  const h = m as Record<string, unknown>;
  if (keys.length !== 3 || h.v !== 1 || h.type !== "hello" || !Object.hasOwn(h, "kit") || typeof h.kit !== "string") return null;
  return h.kit;
}

/** The level a named kit version reads at: one this page cannot parse is read as kit-v1.4, the safe side. */
export function kitLevel(kit: string): KitLevel {
  const v = VERSION.exec(kit);
  if (!v) return KIT_DEFAULT;
  const [major, minor] = [Number(v[1]), Number(v[2])];
  const from = (m: number, n: number) => major > m || (major === m && minor >= n);
  return from(CURRENT_FROM[0], CURRENT_FROM[1]) ? "current" : from(1, 6) ? "1.6" : from(1, 5) ? "1.5" : KIT_DEFAULT;
}

/** kit-v1.4's deposit stages (kit-v1.4:packages/kit/src/signpage/schema.ts DEPOSIT). */
type V1_4Deposit = "quote_checked" | "waiting" | "in_transit" | "into_vault" | "done" | "refunded" | "held" | "halted";
/**
 * Each deposit stage as kit-v1.4 reads it: the eight it has as they are, and each later one as the stage that tells an
 * app of that kit the truth about where the money is. Typed over every DepositStage, so a stage added to the kit does
 * not compile until it is mapped here.
 * - failed: 1Click reported FAILED and is still processing it (messages.ts DepositStage): in_transit, 1Click processing,
 *   as the kit's own terminal draws it (S4.15, apps/terminal/src/screens/deposit/model.ts statusState). Never halted:
 *   kit-v1.4's terminal draws halted as the held screen, whose one action is a withdraw from an id the money is not under.
 * - short: less arrived than the quote and 1Click is still on it (the terminal's S4.18 keeps the address, as it does for
 *   S4.15): in_transit, for the same reason.
 * - expired: nothing was sent, so the money never left the user: quote_checked, the address shown and nothing seen.
 *   The app has the quote's deadline (deposit.quote's answer) and reads the address as expired on its own clock, as
 *   kit-v1.4's own terminal does (apps/terminal/src/screens/deposit/model.ts statusState).
 * - refund_move: 1Click refunded the money to the one-time id and the device is moving it into the vault: refunded,
 *   never done until it lands.
 * A refund's later legs (the `refunded` fact, DEPOSIT_REFUNDED_STAGES) are moving the refund, not a new deposit: on
 * in_transit or into_vault kit-v1.4 is sent refunded (depositV1_4); done, held and halted keep their stage, which is
 * where the money is.
 */
export const V1_4_DEPOSIT_STAGE: Readonly<Record<DepositStage, V1_4Deposit>> = Object.freeze({
  quote_checked: "quote_checked",
  waiting: "waiting",
  in_transit: "in_transit",
  into_vault: "into_vault",
  done: "done",
  refunded: "refunded",
  held: "held",
  halted: "halted",
  failed: "in_transit",
  short: "in_transit",
  expired: "quote_checked",
  refund_move: "refunded",
});

/** kit-v1.4's op stages by kind (kit-v1.4 schema.ts WITHDRAW, TRADE, HOP, RETURN, RESTORE): a stage not listed is an
 *  op that client cannot read. */
const V1_4_OP_STAGES: Readonly<Record<Exclude<Operation["kind"], "deposit" | "pool_deposit">, readonly string[]>> = Object.freeze({
  withdraw: ["proving", "submitted", "in_transit", "sent", "refunded", "stopped"],
  buy: ["signed", "sent", "filled", "part_filled", "refused", "not_landed"],
  sell: ["signed", "sent", "filled", "part_filled", "refused", "not_landed"],
  hop: ["in_flight", "arrived", "refunded", "fallback"],
  return: ["signed", "sent", "in_transit", "into_vault", "done"],
  restore: ["started", "reading", "done", "stalled"],
});
/** Every stage a kit-v1.4 progress event may carry (kit-v1.4 schema.ts STAGES). */
const V1_4_STAGES: ReadonlySet<string> = new Set([...Object.keys(V1_4_DEPOSIT_STAGE).filter((s) => V1_4_DEPOSIT_STAGE[s as DepositStage] === s), ...Object.values(V1_4_OP_STAGES).flat(), "queued"]);

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);

/** A deposit's stage as kit-v1.4 reads it, from its stage and its `refunded` fact; null for a stage this page has no
 *  mapping for. */
function depositV1_4(d: { stage: unknown; refunded?: unknown }): V1_4Deposit | null {
  if (typeof d.stage !== "string" || !own(V1_4_DEPOSIT_STAGE, d.stage)) return null;
  const stage = V1_4_DEPOSIT_STAGE[d.stage as DepositStage];
  return d.refunded === true && (stage === "in_transit" || stage === "into_vault") ? "refunded" : stage;
}

/** The op as kit-v1.4 reads it, or null when it cannot read it at all. */
function opV1_4(op: Operation): Operation | null {
  if (op.kind === "deposit") {
    const stage = depositV1_4(op);
    return stage === null ? null : { id: op.id, kind: "deposit", stage, txs: op.txs };
  }
  if (op.kind === "pool_deposit" || !own(V1_4_OP_STAGES, op.kind) || !V1_4_OP_STAGES[op.kind].includes(op.stage)) return null;
  if (op.kind === "buy" || op.kind === "sell") return op.code === undefined ? { id: op.id, kind: op.kind, stage: op.stage, txs: op.txs } : { id: op.id, kind: op.kind, stage: op.stage, txs: op.txs, code: op.code };
  return { id: op.id, kind: op.kind, stage: op.stage, txs: op.txs } as Operation;
}

/** kit-v1.4's state fields (kit-v1.4 schema.ts state): any other is left out. */
const V1_4_STATE_KEYS: ReadonlySet<string> = new Set(["release", "api", "signed_in", "way", "code_saved", "signin_failed", "vault_balance", "wallets", "positions", "orders", "held", "ops"]);

/**
 * A deposit's facts as kit-v1.5 reads them: a moved-out one with no moved_out and no held_id (held_id is optional on
 * held there, and a kit-v1.5 app turns its Withdraw off without one: nothing waits under it any more; review L1); the
 * object as it is when it has no moved_out.
 */
function factsV1_5<T extends object>(d: T): T {
  if (!own(d, "moved_out")) return d;
  const { moved_out: _m, held_id: _h, ...rest } = d as T & { moved_out?: unknown; held_id?: unknown };
  return rest as T;
}

/** The ops with no pool deposit's: kit-v1.6 and before have no pool_deposit kind (card pool-deposit-stages). */
const noPoolOps = (ops: readonly Operation[]): Operation[] => ops.filter((o) => o.kind !== "pool_deposit");

/** The state as a client at `level` reads it: kit-v1.6's with no pool_deposit op; kit-v1.5's, that and each deposit op
 *  with no moved_out; kit-v1.4's fields only, in the state's own order, each op mapped or left out. */
export function stateFor(level: KitLevel, s: SignpageState): SignpageState {
  if (level === "current") return s;
  if (level === "1.6") return { ...s, ops: noPoolOps(s.ops) };
  if (level === "1.5") return { ...s, ops: noPoolOps(s.ops).map((o) => (o.kind === "deposit" ? factsV1_5(o) : o)) };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s)) if (V1_4_STATE_KEYS.has(k)) out[k] = k === "ops" ? s.ops.map(opV1_4).filter((o) => o !== null) : s[k as keyof SignpageState];
  return out as unknown as SignpageState;
}

/** A progress stage as a client at `level` reads it, or null when that client has no stage for it (the event is not sent). */
export function stageFor(level: KitLevel, stage: Stage): Stage | null {
  if (level !== "1.4" || V1_4_STAGES.has(stage)) return stage;
  return own(V1_4_DEPOSIT_STAGE, stage) ? V1_4_DEPOSIT_STAGE[stage as DepositStage] : null;
}

/**
 * An answer's result of `kind` as a client at `level` reads it: for kit-v1.6 the state with no pool_deposit op; for
 * kit-v1.5 that state and deposit.confirm's facts with
 * no moved_out; for kit-v1.4 the state mapped, deposit.confirm's stage mapped with no facts; every other kind's result
 * as it is (each reads each kind it can ask the same as now).
 */
export function resultFor(level: KitLevel, kind: SignpageKind, result: unknown): unknown {
  if (level === "current") return result;
  if (level === "1.6") return kind === "state" ? stateFor(level, result as SignpageState) : result;
  if (level === "1.5") return kind === "state" ? stateFor(level, result as SignpageState) : kind === "deposit.confirm" && typeof result === "object" && result !== null ? factsV1_5(result) : result;
  if (kind === "state") return stateFor(level, result as SignpageState);
  if (kind !== "deposit.confirm") return result;
  // a stage with no mapping is sent as it is: the kit's schema refuses that answer, never a made-up stage
  const stage = depositV1_4(result as { stage: unknown; refunded?: unknown });
  return stage === null ? result : { stage };
}
