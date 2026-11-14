// The leftovers' carry to Cash (card leftovers-carry-to-cash): each pass takes one wallet that holds a leftover (a U_X a
// deposit left money at, and a W's tail), drawn at random, and carries what it holds whole into the NEAR vault as Cash:
// - What it can carry: the chain's sender reads the wallet's lower balance on two RPCs less its send's fee bound
//   (CarrySender.sendable). Under the vault's least deposit (MIN_DEPOSIT, 1 USDC: the kit's ONECLICK_VAULT_MIN_OUT) at the
//   device's price, nothing is asked: the leftover stays on its own wallet, counted in the balance, and is tried again
//   next pass. Nothing tops a wallet up and no send carries two wallets' money (one wallet a send, one send a quote).
// - Cash's own deposit quote of that amount of the chain's coin (src/pool-to-cash.ts's: a fresh U, the deposit rule at
//   the device's price, its follow op written under the quote's own id before the address is used, which binds what
//   reaches U into the vault across reloads). A refusal (the vault's floor among them) asks again next pass.
// - The open carry (CarryOpen) is written under the wallet before anything is signed; a write that fails sends nothing.
//   A reload reads it first: its sends are followed (never sent again while one can land), and only a dead one, or a
//   wallet that now holds another amount, is quoted again.
// - Landed: the wallet's leftover is cleared where it was counted (the U_X op's left, the W's tail) and the open record
//   dropped; the quote's follow op shows it on its way into Cash.
// Nothing here logs.
import type { ErrorCode, PoolChain } from "../../kit/src/signpage/messages.ts";
import type { CarryEnd, CarryOpen, CarrySender, CarrySource } from "./carry-cash.ts";
import { wTailOf } from "./w-tails.ts";

/** The vault's least deposit, USDC base units (contracts/vault/src/constants.rs MIN_DEPOSIT; kit ONECLICK_VAULT_MIN_OUT). */
export const CARRY_VAULT_MIN = 1_000_000n;
/** The wait between passes while nothing is on its way (none to carry, under the floor, a refusal). */
export const CARRY_PASS_MS = 2 * 60_000;
/** The wait while a send is on its way: it is read again this soon, until it lands or dies. */
export const CARRY_FOLLOW_MS = 15_000;
/** An open carry with nothing sent is dropped and quoted again past this age (a deposit quote's own life is longer). */
export const CARRY_UNSENT_MS = 10 * 60_000;

export type LeftoverCarryDeps = {
  /** Every wallet holding a leftover now, from the store alone (no chain read). */
  sources(): Promise<CarrySource[]>;
  /** The chain's sender; null while the page has none for it. */
  sender(chain: PoolChain): CarrySender | null;
  /** What `amount` of the chain's coin is worth in USDC base units at the device's own price; null with no price. */
  worth(chain: PoolChain, amount: bigint): bigint | null;
  /** Cash's deposit quote of `amount` of the chain's coin, its follow op written under `id`: the checked address. */
  quote(chain: PoolChain, amount: bigint, id: string): Promise<{ address: string } | { error: ErrorCode }>;
  /** Whether `a` is an address of `chain` (the deposit address must be). */
  onChain(chain: PoolChain, a: string): boolean;
  /** The wallet's open carry, and its write (undefined drops it). */
  open(src: CarrySource): Promise<CarryOpen | undefined>;
  keep(src: CarrySource, o: CarryOpen | undefined): Promise<void>;
  /** The leftover carried: cleared where the balance counted it. */
  cleared(src: CarrySource): Promise<void>;
  now(): number;
  /** A uniform draw in [0, n) (crypto, so the order names nothing). */
  draw?(n: number): number;
  signal?: AbortSignal;
};

export type CarryPass = { src: CarrySource; end: CarryEnd | "under" | "refused" | "unread" } | null;

/** One pass: one wallet of the leftovers, drawn at random, carried as far as it goes now. */
export async function carryLeftovers(d: LeftoverCarryDeps): Promise<CarryPass> {
  const all = (await d.sources()).filter((s) => d.sender(s.chain) !== null);
  if (all.length === 0) return null;
  // a wallet whose carry is open is followed to its end first (its money must not count both on the wallet and on its way
  // into Cash for long); else one drawn at random
  const opened: CarrySource[] = [];
  for (const s of all) if ((await d.open(s).catch(() => undefined)) !== undefined) opened.push(s);
  const from = opened.length > 0 ? opened : all;
  const src = from[(d.draw ?? drawUniform)(from.length)]!;
  const sender = d.sender(src.chain)!;
  const keep = (o: CarryOpen) => d.keep(src, o);
  const ended = async (end: CarryEnd): Promise<CarryPass> => {
    if (end === "landed") {
      await d.cleared(src);
      await d.keep(src, undefined);
    } else if (end === "dead" || end === "short") await d.keep(src, undefined);
    return { src, end };
  };
  const was = await d.open(src);
  if (was !== undefined) {
    // an open carry with nothing sent past its age is quoted again; one with sends is followed first
    if (was.sends.length > 0 || d.now() - Number(was.quotedMs) < CARRY_UNSENT_MS) return ended(await sender.send(src, was, keep, d.signal).catch((): CarryEnd => "fault"));
    await d.keep(src, undefined);
  }
  const amount = await sender.sendable(src, d.signal).catch(() => null);
  if (amount === null) return { src, end: "unread" };
  // under the vault's least deposit at the device's price: kept, counted, tried again next pass
  const usd = amount > 0n ? d.worth(src.chain, amount) : 0n;
  if (usd === null || usd < CARRY_VAULT_MIN) return { src, end: "under" };
  // the quote's op id names no wallet (the frame reads ops; it never learns a W): the chain and a random part
  const id = `carry/${src.chain}/${randomHex()}`;
  const q = await d.quote(src.chain, amount, id).catch(() => ({ error: "failed" as const }));
  if ("error" in q || !d.onChain(src.chain, q.address)) return { src, end: "refused" };
  const open: CarryOpen = { to: q.address, amount: amount.toString(), quote: id, quotedMs: String(d.now()), sends: [] };
  try {
    await d.keep(src, open);
  } catch {
    return { src, end: "fault" };
  }
  return ended(await sender.send(src, open, keep, d.signal).catch((): CarryEnd => "fault"));
}

/** The wallets holding a leftover, from the store alone: each U_X whose newest op ended in the pool or shows short with
 *  money left (its `left` over 0, src/pool-deposit-follow.ts depositWalletsOf's rule), and each W's tail record
 *  (src/w-tails.ts). */
export function leftoverSources(ops: readonly unknown[], tails: readonly unknown[]): CarrySource[] {
  const newest = new Map<string, { stage: string; created_ms: number; final?: true; follow: { chain: PoolChain; u: string; s: string; i: number; left?: string } }>();
  for (const v of ops) {
    if (!isUxOp(v)) continue;
    const k = `${v.follow.chain}\n${v.follow.u}`;
    const had = newest.get(k);
    if (had === undefined || v.created_ms > had.created_ms) newest.set(k, v);
  }
  const out: CarrySource[] = [];
  for (const v of newest.values()) {
    // an in_pool op only once its follow ended (nothing more of it is read or sent from U_X); a short one as it is
    if (!((v.stage === "in_pool" && v.final === true) || v.stage === "short")) continue;
    if (v.follow.left === undefined || !/^[0-9]{1,78}$/.test(v.follow.left) || BigInt(v.follow.left) === 0n) continue;
    out.push({ chain: v.follow.chain, kind: "ux", address: v.follow.u, s: v.follow.s, i: v.follow.i });
  }
  for (const t of tails) {
    const w = wTailOf(t);
    if (w !== null && w.chain === "solana" && BigInt(w.amount) > 0n) out.push({ chain: "solana", kind: "w", address: w.address, l: w.l, j: w.j });
  }
  return out;
}

function isUxOp(v: unknown): v is { kind: "pool_deposit"; stage: string; created_ms: number; final?: true; follow: { chain: PoolChain; u: string; s: string; i: number; left?: string } } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const f = o.follow as Record<string, unknown> | undefined;
  return o.kind === "pool_deposit" && typeof o.stage === "string" && typeof o.created_ms === "number" && typeof f === "object" && f !== null &&
    (f.chain === "solana" || f.chain === "base" || f.chain === "robinhood") && typeof f.u === "string" && typeof f.s === "string" && /^[0-9]{1,78}$/.test(f.s) && Number.isSafeInteger(f.i) && (f.i as number) >= 0;
}

/** `amount` base units of a coin at `decimals` in USDC base units at the device's price (`price` x 10^`expo` USD a
 *  coin), rounded down; null with no price. */
export function worthUsdc(p: { price: string; expo: number } | null | undefined, amount: bigint, decimals: number): bigint | null {
  if (p == null || !/^[0-9]{1,40}$/.test(p.price) || !Number.isSafeInteger(p.expo)) return null;
  const e = 6 + p.expo - decimals;
  const v = amount * BigInt(p.price);
  return e >= 0 ? v * 10n ** BigInt(e) : v / 10n ** BigInt(-e);
}

/** The leftover carried, cleared where the balance counted it: a U_X's newest op's `left` set to 0 (a later deposit to
 *  U_X writes its own), a W's tail record deleted. */
export async function clearLeftover(st: { keys(s: "ops"): Promise<string[]>; get(s: "ops", k: string): Promise<unknown>; update(s: "ops", k: string, f: (v: unknown) => unknown): Promise<unknown>; delete(s: "meta", k: string): Promise<void> }, src: CarrySource): Promise<void> {
  if (src.kind === "w") return st.delete("meta", `w-tail/sol/${src.address}`);
  let newest: { id: string; at: number } | null = null;
  for (const id of await st.keys("ops")) {
    const v = await st.get("ops", id).catch(() => undefined);
    if (isUxOp(v) && v.follow.chain === src.chain && v.follow.u === src.address && (newest === null || v.created_ms > newest.at)) newest = { id, at: v.created_ms };
  }
  if (newest !== null) await st.update("ops", newest.id, (v) => (isUxOp(v) && v.follow.left !== "0" ? { ...v, follow: { ...v.follow, left: "0" } } : undefined));
}

/** The meta key of a wallet's open carry (meta owed/: the frame's reader never lists it, its write moves no seed). */
export const carryOpenKey = (src: Pick<CarrySource, "chain" | "address">): string => `owed/carry-cash-${src.chain}-${src.address}`;

function randomHex(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function drawUniform(n: number): number {
  if (n <= 1) return 0;
  const lim = Math.floor(4294967296 / n) * n, b = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(b);
    if (b[0]! < lim) return b[0]! % n;
  }
}
