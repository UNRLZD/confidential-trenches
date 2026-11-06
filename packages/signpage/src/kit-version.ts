// What the page sends a client of each kit version (card kit-frame-version). The kit's client names its version in a
// hello before each handshake `state` request (packages/kit/src/signpage/messages.ts HelloMessage); a client that names
// none is kit-v1 to kit-v1.4, which all read one shape: the state with no `pools` and no `deposit_wallets`, a deposit
// op with no facts and only the eight stages kit-v1 named, and they refuse the whole state for one op they cannot
// read. So the page sends such a client the nearest thing it reads: every field after it left out, a newer deposit
// stage mapped down to the kit-v1.4 stage that tells the truth about where the money is (V1_4_DEPOSIT_STAGE), an op it
// still cannot read left out, and no route event (kit-v1.4 has no pool.buy to ask for one). A client at
// SIGNPAGE_KIT_VERSION or above gets every message as it is. A change to what the page may send raises the kit's
// SIGNPAGE_KIT_VERSION and adds the version before it here.
import type { DepositStage, Operation, SignpageKind, SignpageState, Stage } from "../../kit/src/signpage/messages.ts";

/** The levels this page sends at: kit-v1.4's shape, or everything (kit-v1.5 and above). */
export type KitLevel = "1.4" | "current";
/** A client that posts no hello. */
export const KIT_DEFAULT: KitLevel = "1.4";
/** The first kit version that names itself and reads everything this page sends. */
const CURRENT_FROM = [1, 5] as const;
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
  return major > CURRENT_FROM[0] || (major === CURRENT_FROM[0] && minor >= CURRENT_FROM[1]) ? "current" : KIT_DEFAULT;
}

/** kit-v1.4's deposit stages (kit-v1.4:packages/kit/src/signpage/schema.ts DEPOSIT). */
type V1_4Deposit = "quote_checked" | "waiting" | "in_transit" | "into_vault" | "done" | "refunded" | "held" | "halted";
/**
 * Each deposit stage as kit-v1.4 reads it: the eight it has as they are, and each later one as the stage that tells an
 * app of that kit the truth about where the money is. Typed over every DepositStage, so a stage added to the kit does
 * not compile until it is mapped here.
 * - failed: 1Click stopped the deposit; the money waits there, to come back. It does not move to the vault, so never
 *   in_transit, and it is not lost: halted, a deposit that waits.
 * - short: less arrived than the quote; 1Click holds it for the rest or a refund: halted.
 * - expired: nothing was sent, so the money never left the user: quote_checked, the address shown and nothing seen.
 *   The app has the quote's deadline (deposit.quote's answer) and reads the address as expired on its own clock, as
 *   kit-v1.4's own terminal does (apps/terminal/src/screens/deposit/model.ts statusState).
 * - refund_move: 1Click refunded the money to the one-time id and the device is moving it into the vault: refunded,
 *   never done until it lands (the refund's later legs keep their own stages, done only once the note reads back).
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
  failed: "halted",
  short: "halted",
  expired: "quote_checked",
  refund_move: "refunded",
});

/** kit-v1.4's op stages by kind (kit-v1.4 schema.ts WITHDRAW, TRADE, HOP, RETURN, RESTORE): a stage not listed is an
 *  op that client cannot read. */
const V1_4_OP_STAGES: Readonly<Record<Exclude<Operation["kind"], "deposit">, readonly string[]>> = Object.freeze({
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

/** The op as kit-v1.4 reads it, or null when it cannot read it at all. */
function opV1_4(op: Operation): Operation | null {
  if (op.kind === "deposit") {
    if (!own(V1_4_DEPOSIT_STAGE, op.stage)) return null;
    return { id: op.id, kind: "deposit", stage: V1_4_DEPOSIT_STAGE[op.stage], txs: op.txs };
  }
  if (!own(V1_4_OP_STAGES, op.kind) || !V1_4_OP_STAGES[op.kind].includes(op.stage)) return null;
  if (op.kind === "buy" || op.kind === "sell") return op.code === undefined ? { id: op.id, kind: op.kind, stage: op.stage, txs: op.txs } : { id: op.id, kind: op.kind, stage: op.stage, txs: op.txs, code: op.code };
  return { id: op.id, kind: op.kind, stage: op.stage, txs: op.txs } as Operation;
}

/** kit-v1.4's state fields (kit-v1.4 schema.ts state): any other is left out. */
const V1_4_STATE_KEYS: ReadonlySet<string> = new Set(["release", "api", "signed_in", "way", "code_saved", "signin_failed", "vault_balance", "wallets", "positions", "orders", "held", "ops"]);

/** The state as a client at `level` reads it: kit-v1.4's fields only, in the state's own order, each op mapped or left out. */
export function stateFor(level: KitLevel, s: SignpageState): SignpageState {
  if (level === "current") return s;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s)) if (V1_4_STATE_KEYS.has(k)) out[k] = k === "ops" ? s.ops.map(opV1_4).filter((o) => o !== null) : s[k as keyof SignpageState];
  return out as unknown as SignpageState;
}

/** A progress stage as a client at `level` reads it, or null when that client has no stage for it (the event is not sent). */
export function stageFor(level: KitLevel, stage: Stage): Stage | null {
  if (level === "current" || V1_4_STAGES.has(stage)) return stage;
  return own(V1_4_DEPOSIT_STAGE, stage) ? V1_4_DEPOSIT_STAGE[stage as DepositStage] : null;
}

/**
 * An answer's result of `kind` as a client at `level` reads it: the state mapped, deposit.confirm's stage mapped with no
 * facts; every other kind's result as it is (kit-v1.4 reads each kind it can ask the same as now).
 */
export function resultFor(level: KitLevel, kind: SignpageKind, result: unknown): unknown {
  if (level === "current") return result;
  if (kind === "state") return stateFor(level, result as SignpageState);
  if (kind === "deposit.confirm") return { stage: V1_4_DEPOSIT_STAGE[(result as { stage: DepositStage }).stage] };
  return result;
}
