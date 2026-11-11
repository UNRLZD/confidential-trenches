// state.positions on Base and Robinhood (card signpage-positions-evm): what this device's EVM pool buys hold, in the
// same shape as Solana's (src/positions.ts), run by the same cache (positionsCache: one pass at a time, a failed pass
// tried again, a sell's or a buy's end reading it again, a sign out dropping it).
//
// - The Ws: every W whose buy record (pool-buy-evm.ts EVM_POSITION_COSTS_KEY) is this chain's and filled, with the
//   token the record names. A pending record is never shown: the load's follow (followPendingEvmBuys) asks the chain
//   for its Bought or Withdrawn and fills it or removes it, and its end reads the positions again. A withdrawn record
//   is ETH owed back, not a token.
// - Each W's amount: balanceOf(W) of the token on both pool RPCs at the lower of their two newest blocks, the two
//   answers the same, never a number from the record alone. A W whose read fails, or whose two answers differ, keeps
//   the amount its last agreed read gave (as src/positions.ts keeps a W's last amount); one with none leaves its token
//   out of the pass, so two providers that disagree show no position, never a wrong one, and the pass is not whole, so
//   it runs again (the retry is the re-read: none within the pass).
// - The floor: the block read at is at least every filled buy's own block (its route.block) and the block the last
//   pass read at. A pass whose lower newest block is under it reads no balance (a provider behind the trade would
//   answer the holding from before it): it is not whole, so it runs again, and each W keeps its last agreed amount. A
//   provider stuck behind holds the lower block where it is, so alone it never stops a pass being whole; past a buy it
//   does, and the rows wait (not whole, the last agreed amounts kept) until it moves, never a number one provider gave.
// - An open sale (`holds`, evmSaleHolds): from the sale's record, written before its send, its token shows no amount
//   agreed under the sale's floor, and none while it has none (no row, never the amount from before the sale; the
//   pass not whole, so a retry is booked). The floor is the block of the sale's Deposited, the one the read-back's
//   verdict read the same on both RPCs (pool-sell-evm.ts evmSellVerdict, its `deposited` hook); before it, once the
//   send has ended (the helper's hash or no answer), one past the lower newest block of a pass that started after the
//   send ended; for an open record a load finds, the same from EVM_SALE_FLOOR_MS past its deadline. A floor above both
//   RPCs' newest blocks EVM_SALE_FLOOR_MS after it was set is dropped. A record dropped with no Deposited read (not
//   landed, nothing sent) holds nothing more. The page hides a sale's token in rows a pass read before the sale's
//   record (src/pool-testnet.ts evmShownGen).
// - The token's decimals: decimals() on both RPCs, the same (keptTokenDecimals, kept for the page), else the token is
//   left out.
// - The cost: none is recorded for an EVM buy, so "0", which the app reads as unknown.
// - Requests per pass, on each of the two RPCs: one eth_blockNumber and one balanceOf per filled W, and once per token
//   per page its decimals(); at most EVM_POSITIONS_IN_FLIGHT calls of the pass in flight at once, over both RPCs. An
//   open sale adds none (its floor comes from the pass's own newest blocks and the read-back's). One token held by ten
//   Ws whose two RPCs never agree: 56 requests in the busiest minute on each RPC, 22 a minute once the round is spent
//   (test/positions-evm.test.ts "the worst minute"); ten tokens whose decimals the two RPCs disagree on read their
//   decimals each pass too: 105 and 42.
//   Nothing runs on a timer of its own: a pass runs at the sign-in's first state read, at a buy's or a sell's end, as a
//   failed pass's retry (positionsCache, backed off EVM_POSITIONS_RETRY_MS), and, once a round of retries is spent, at
//   most once per EVM_POSITIONS_REARM_MS from a state read. Each chain's pass starts EVM_POSITIONS_STAGGER_MS apart
//   from the others' (Solana's at 0), so the three never fire in the same tick. Each read carries the pass's stop: a
//   sign out or a sell's hold sends nothing more of the pass.
// - Who learns what: each pool RPC, a W of this device and the token it bought (the sell's own balance read names the
//   same pair). No other host is asked.
import type { EvmRpc } from "../../wallet/src/pool/evm.ts";
import { evmHeadNumber } from "./evm-send.ts";
import type { EvmHolding } from "./pool-buy-evm.ts";
import type { PassMemo, PassResult, Position } from "./positions.ts";
import { poolUnits } from "./rules/pool.ts";

/** Each EVM chain's pass starts this much after the one before it (Solana, then Base, then Robinhood). */
export const EVM_POSITIONS_STAGGER_MS = 300;
/** A pass that was not whole is tried again after these waits, the last for every later try. */
export const EVM_POSITIONS_RETRY_MS = Object.freeze([5_000, 10_000, 20_000]);
export const evmPositionsRetryMs = (tries: number): number => EVM_POSITIONS_RETRY_MS[Math.min(tries, EVM_POSITIONS_RETRY_MS.length - 1)]!;
/** Once a round of retries is spent, a state read asks one more pass at most this often. */
export const EVM_POSITIONS_REARM_MS = 30_000;
/** At most this many of a pass's calls in flight at once, over both RPCs. */
export const EVM_POSITIONS_IN_FLIGHT = 4;

const BALANCE_OF = "0x70a08231";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type EvmPositionsReads = {
  chain: "base" | "robinhood";
  /** The pool's two RPCs, of two operators. */
  rpcs: readonly [EvmRpc, EvmRpc];
  /** The pass's stop. */
  signal: AbortSignal;
  /** Every W's buy record (EVM_POSITION_COSTS_KEY). */
  holdings(): Promise<Record<string, unknown>>;
  /** The token's decimals on both of `rpcs` (the pass's, gated), the same (keptTokenDecimals). */
  decimals(token: string, rpcs: readonly [EvmRpc, EvmRpc]): Promise<number>;
  /** The tokens an open sale holds (lower case), each with its floor, or null while it has none (EvmSaleHolds.at), given
   *  the pass's two newest blocks (null when either failed): asked after the pass reads them and again at its end. */
  holds?(heads: readonly [bigint, bigint] | null): Promise<ReadonlyMap<string, bigint | null>>;
};

const word = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("balanceOf: not a word");
  return BigInt(v);
};

/** `rpc` with at most `n` of `gate`'s calls in flight at once, each started only while `signal` holds. */
function gated(rpc: EvmRpc, gate: { busy: number; queue: (() => void)[]; n: number }, signal: AbortSignal): EvmRpc {
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      while (gate.busy >= gate.n) await new Promise<void>((go) => gate.queue.push(go));
      // a stopped pass sends nothing more, and wakes the next call in line, which stops too
      if (signal.aborted) {
        gate.queue.shift()?.();
        signal.throwIfAborted();
      }
      gate.busy++;
      try {
        return await rpc(method, params);
      } finally {
        gate.busy--;
        gate.queue.shift()?.();
      }
    },
    rpc.url === undefined ? {} : { url: rpc.url },
  ) as EvmRpc;
}

/** One balanceOf on both RPCs at `at`, the two the same, else failed (the pass's retry reads it again). */
async function agreedBalance(rpcs: readonly [EvmRpc, EvmRpc], signal: AbortSignal, token: string, w: string, at: string): Promise<bigint> {
  const data = `${BALANCE_OF}${BigInt(w).toString(16).padStart(64, "0")}`;
  signal.throwIfAborted();
  const [a, b] = await Promise.all(rpcs.map(async (rpc) => word(await rpc("eth_call", [{ to: token, data }, at]))));
  if (a !== b) throw new Error("balanceOf: the two RPCs differ");
  return a!;
}
/** The block each pass of a memo last read at (the floor's third part). */
const READ_AT = new WeakMap<PassMemo, bigint>();
/** The block each of a memo's kept amounts ("W token") was agreed at. */
const HELD_AT = new WeakMap<PassMemo, Map<string, bigint>>();

/** One pass of this chain's positions (see the header). `memo.held` holds each "W token"'s last agreed amount. */
export async function evmPositionsPass(r: EvmPositionsReads, memo: PassMemo): Promise<PassResult> {
  const all = await r.holdings();
  // the filled buys of this chain: token -> its Ws, both lower case
  const byToken = new Map<string, Set<string>>();
  let floor = 0n;
  const readAt = READ_AT.get(memo);
  if (readAt !== undefined && readAt > floor) floor = readAt;
  for (const [a, v] of Object.entries(all)) {
    const h = v as Partial<EvmHolding> | null;
    if (typeof h !== "object" || h === null || h.chain !== r.chain || h.state !== "filled" || typeof h.mint !== "string" || !ADDRESS.test(a) || !ADDRESS.test(h.mint)) continue;
    const t = h.mint.toLowerCase();
    byToken.set(t, (byToken.get(t) ?? new Set()).add(a.toLowerCase()));
    const b = typeof h.route?.block === "string" && /^[0-9]{1,20}$/.test(h.route.block) ? BigInt(h.route.block) : 0n;
    if (b > floor) floor = b;
  }
  if (byToken.size === 0) {
    memo.held = new Map();
    return { positions: [], whole: true };
  }
  r.signal.throwIfAborted();
  let whole = true;
  let at: string | null = null;
  let low: bigint | null = null;
  let heads: readonly [bigint, bigint] | null = null;
  const gate = { busy: 0, queue: [] as (() => void)[], n: EVM_POSITIONS_IN_FLIGHT };
  const rpcs: readonly [EvmRpc, EvmRpc] = [gated(r.rpcs[0], gate, r.signal), gated(r.rpcs[1], gate, r.signal)];
  try {
    const [x, y] = await Promise.all(rpcs.map((rpc) => evmHeadNumber(rpc)));
    heads = [x!, y!];
    const l = x! < y! ? x! : y!;
    // under the floor: no balance read (see the header), not whole
    if (l >= floor) {
      at = `0x${l.toString(16)}`;
      low = l;
      READ_AT.set(memo, l);
    } else whole = false;
  } catch {
    r.signal.throwIfAborted();
    whole = false;
  }
  // a token an open sale holds is read only at its floor or past it, and shows no amount agreed under it
  const holdsNow = async (): Promise<ReadonlyMap<string, bigint | null>> => (r.holds === undefined ? new Map() : await r.holds(heads));
  const past = (h: ReadonlyMap<string, bigint | null>, token: string, b: bigint | null | undefined): boolean => !h.has(token) || (b !== null && b !== undefined && h.get(token) !== null && b >= h.get(token)!);
  const first = await holdsNow();
  r.signal.throwIfAborted();
  const tokens = [...byToken];
  const read = await Promise.all(
    tokens.map(async ([token, ws]) => {
      let decimals = memo.decimals.get(token);
      if (decimals === undefined) {
        try {
          decimals = await r.decimals(token, rpcs);
          memo.decimals.set(token, decimals);
        } catch {
          r.signal.throwIfAborted();
          decimals = undefined;
        }
      }
      const amounts = await Promise.all(
        [...ws].map(async (w) => {
          if (at === null || !past(first, token, low)) return { w, amount: null };
          try {
            return { w, amount: await agreedBalance(rpcs, r.signal, token, w, at) };
          } catch {
            r.signal.throwIfAborted();
            return { w, amount: null };
          }
        }),
      );
      return { token, decimals, amounts };
    }),
  );
  r.signal.throwIfAborted();
  // asked again at the end: a sale whose record was written while the pass read holds its token in this pass too
  const end = await holdsNow();
  r.signal.throwIfAborted();
  const heldAt = HELD_AT.get(memo) ?? new Map<string, bigint>();
  const nextHeld = new Map<string, bigint>();
  const nextAt = new Map<string, bigint>();
  const out: Position[] = [];
  for (const { token, decimals, amounts } of read) {
    if (decimals === undefined) whole = false;
    let total = 0n;
    let unknown = decimals === undefined;
    const wallets: string[] = [];
    for (const { w, amount } of amounts) {
      const k = `${w} ${token}`;
      if (amount === null) whole = false;
      const b = amount !== null ? low : heldAt.get(k);
      const a = past(end, token, b) ? (amount ?? memo.held.get(k)) : undefined;
      if (a === undefined) {
        whole = false;
        unknown = true;
        continue;
      }
      nextHeld.set(k, a);
      if (b !== null && b !== undefined) nextAt.set(k, b);
      if (a > 0n) {
        total += a;
        wallets.push(w);
      }
    }
    if (unknown || total === 0n) continue;
    out.push({ chain: r.chain, token, amount: poolUnits(total, decimals!), cost: "0", wallets: wallets.sort(), decimals: decimals! });
  }
  memo.held = nextHeld;
  HELD_AT.set(memo, nextAt);
  out.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  return { positions: out, whole };
}

/** A floor above both RPCs' newest blocks this long after it was set is dropped; an open sale a load found, with no
 *  floor, takes one this long past its deadline (no later block can hold it: SellDelegate.sol refuses a block past it). */
export const EVM_SALE_FLOOR_MS = 60_000;

const DIGITS = /^[0-9]{1,20}$/;
type Hold = { token: string; w: string; gen: number; floor: bigint | null; set: number; deadlineMs: number; sentMs: number | null; verdict: boolean; lapsed: boolean };
/** A sale as its open record (pool-sell-evm.ts EvmOpenSell) names it. */
export type EvmSaleOf = { note: string; chain: string; w: string; token: string; deadline: string };

/** One chain's open sales for its positions (see the header): per note, the token it sells and its floor. */
export function evmSaleHolds(chain: "base" | "robinhood") {
  const notes = new Map<string, Hold>();
  let gen = 0;
  const add = (o: EvmSaleOf): Hold | null => {
    if (o?.chain !== chain || typeof o.note !== "string" || !ADDRESS.test(String(o.w)) || !ADDRESS.test(String(o.token)) || !DIGITS.test(String(o.deadline))) return null;
    let h = notes.get(o.note);
    if (h === undefined) {
      h = { token: o.token.toLowerCase(), w: o.w.toLowerCase(), gen: ++gen, floor: null, set: 0, deadlineMs: Number(o.deadline) * 1000, sentMs: null, verdict: false, lapsed: false };
      notes.set(o.note, h);
    } else if (!h.verdict) h.deadlineMs = Number(o.deadline) * 1000;
    return h;
  };
  return {
    /** A sale's record written, before its send (or signed again: its deadline raised): its token held, no floor yet;
     *  true for a sale not held before. */
    record(o: EvmSaleOf): boolean {
      const had = typeof o?.note === "string" && notes.has(o.note);
      return add(o) !== null && !had;
    },
    /** A send of W's sale ended (the helper's hash, or no answer): a pass started after it takes a floor. */
    sendEnded(w: string, now: number): void {
      for (const h of notes.values()) if (h.w === w.toLowerCase() && !h.verdict && h.sentMs === null) h.sentMs = now;
    },
    /** The sale's Deposited, the same on both RPCs (evmSellVerdict): its block the floor. */
    deposited(o: EvmSaleOf, block: bigint, now: number): void {
      const h = add(o);
      if (h === null || (h.verdict && h.floor === block)) return;
      Object.assign(h, { gen: ++gen, floor: block, set: now, verdict: true, lapsed: false });
    },
    /** The count of the holds' changes so far (a new sale, a Deposited read). */
    gen: (): number => gen,
    /** The tokens of every sale new, or with a Deposited read, since change `since`: a pass started before it never
     *  read them under the sale (the page hides them in that pass's rows). */
    newer(since: number): Set<string> {
      const out = new Set<string>();
      for (const h of notes.values()) if (!h.lapsed && h.gen > since) out.add(h.token);
      return out;
    },
    /** The record dropped with no Deposited read (not landed, or nothing sent): nothing sold, nothing held. */
    dropped(note: string): void {
      if (notes.get(note)?.verdict === false) notes.delete(note);
    },
    /** The held tokens for a pass started at `started` that read `heads`, with `open` the records (EVM_OPEN_SELLS_KEY):
     *  each the highest floor of its sales, null while one has none. */
    at(open: Record<string, unknown>, heads: readonly [bigint, bigint] | null, started: number, now: number): Map<string, bigint | null> {
      for (const o of Object.values(open)) add(o as EvmSaleOf);
      const out = new Map<string, bigint | null>();
      for (const h of notes.values()) {
        if (h.lapsed) continue;
        const ripe = h.sentMs === null ? h.deadlineMs + EVM_SALE_FLOOR_MS : Math.min(h.sentMs, h.deadlineMs + EVM_SALE_FLOOR_MS);
        if (h.floor === null && heads !== null && ripe <= started) Object.assign(h, { floor: (heads[0] < heads[1] ? heads[0] : heads[1]) + 1n, set: now });
        if (h.floor !== null && heads !== null && h.floor > heads[0] && h.floor > heads[1] && now - h.set >= EVM_SALE_FLOOR_MS) {
          h.lapsed = true;
          continue;
        }
        const was = out.get(h.token);
        out.set(h.token, was === null || h.floor === null ? null : was === undefined || h.floor > was ? h.floor : was);
      }
      return out;
    },
  };
}
export type EvmSaleHolds = ReturnType<typeof evmSaleHolds>;

/** `pass` started `ms` after it is asked (the stagger), or not at all once `signal` stops it. */
export function staggered<T>(ms: number, signal: AbortSignal, pass: () => Promise<T>, setTimer: (f: () => void, ms: number) => unknown = setTimeout): Promise<T> {
  if (ms <= 0) return pass();
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const stop = (): void => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    setTimer(() => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    }, ms);
  }).then(pass);
}
