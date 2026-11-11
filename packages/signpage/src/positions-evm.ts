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
// - The floor: the block read at is at least every filled buy's own block (its route.block), the block of the last
//   trade end that asked for the pass (`floor`, a sale's block), and the block the last pass read at. A pass whose
//   lower newest block is under it reads no balance (a provider behind the trade would answer the holding from before
//   it): it is not whole, so it runs again, and each W keeps its last agreed amount, a sold token's dropped first
//   (`dropped`) so a sold row never stays on an old read. One seat under the floor while the other is past it is a
//   provider behind (stuck, or a spare the pair walked to): that pass reads on the first provider of the pool's list
//   (`spares`) whose operator neither seat's is (the kit's evmRpcOperator, by domain: one operator's second host is
//   never a second provider) and whose newest block is past the floor, still two operators that agree, so
//   one stuck provider never holds the rows back where the list has a third (mainnet's Base list has 4, Robinhood's
//   more). The block a pass read at is the floor's third part: a stuck provider holds the lower head where it is, so
//   it alone never stops a pass being whole; only a buy or sale past it does, and the spare reads past that.
// - The token's decimals: decimals() on both RPCs, the same (keptTokenDecimals, kept for the page), else the token is
//   left out.
// - The cost: none is recorded for an EVM buy, so "0", which the app reads as unknown.
// - Requests per pass, on each of the two RPCs: one eth_blockNumber and one balanceOf per filled W, and once per token
//   per page its decimals(); at most EVM_POSITIONS_IN_FLIGHT calls of the pass in flight at once, over both RPCs. A
//   sale's end adds one eth_getTransactionReceipt per hash it sent, on each RPC (its floor: src/pool-testnet.ts
//   evmSaleFloor). Ten holdings whose two RPCs never agree: 56 requests in the busiest minute on each RPC, 22 a minute
//   once the round is spent (test/positions-evm.test.ts "the worst minute").
//   Nothing runs on a timer of its own: a pass runs at the sign-in's first state read, at a buy's or a sell's end, as a
//   failed pass's retry (positionsCache, backed off EVM_POSITIONS_RETRY_MS), and, once a round of retries is spent, at
//   most once per EVM_POSITIONS_REARM_MS from a state read. Each chain's pass starts EVM_POSITIONS_STAGGER_MS apart
//   from the others' (Solana's at 0), so the three never fire in the same tick. Each read carries the pass's stop: a
//   sign out or a sell's hold sends nothing more of the pass.
// - Who learns what: each pool RPC, a W of this device and the token it bought (the sell's own balance read names the
//   same pair). No other host is asked.
import { evmRpcOperator } from "../../kit/src/trade/evm/rpc-operator.ts";
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
  /** The block of the last trade end that asked for a pass (a sale's): the pass reads at no lower block. */
  floor?: bigint;
  /** The tokens sold since the last pass (lower case): their last agreed amounts are dropped before it. */
  dropped?: ReadonlySet<string>;
  /** The pool's list of providers (each with its `url`): a seat behind the floor is read past on the first one that
   *  neither seat holds and that is past the floor, for that pass. */
  spares?: readonly EvmRpc[];
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
/** The operator an RPC's `url` names (the kit's evmRpcOperator: by domain, an alias's owner); null with none. */
const operatorOf = (url: string | undefined): string | null => (url === undefined ? null : evmRpcOperator(url));
/** The block each pass of a memo last read at (the floor's third part). */
const READ_AT = new WeakMap<PassMemo, bigint>();

/** One pass of this chain's positions (see the header). `memo.held` holds each "W token"'s last agreed amount. */
export async function evmPositionsPass(r: EvmPositionsReads, memo: PassMemo): Promise<PassResult> {
  const all = await r.holdings();
  // the filled buys of this chain: token -> its Ws, both lower case
  const byToken = new Map<string, Set<string>>();
  let floor = r.floor ?? 0n;
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
  // a sold token's last agreed amounts go: a pass under the floor never shows them again
  if (r.dropped !== undefined && r.dropped.size > 0) for (const k of [...memo.held.keys()]) if (r.dropped.has(k.slice(k.indexOf(" ") + 1))) memo.held.delete(k);
  if (byToken.size === 0) {
    memo.held = new Map();
    return { positions: [], whole: true };
  }
  r.signal.throwIfAborted();
  let whole = true;
  let at: string | null = null;
  const gate = { busy: 0, queue: [] as (() => void)[], n: EVM_POSITIONS_IN_FLIGHT };
  let rpcs: readonly [EvmRpc, EvmRpc] = [gated(r.rpcs[0], gate, r.signal), gated(r.rpcs[1], gate, r.signal)];
  try {
    const [x, y] = await Promise.all(rpcs.map((rpc) => evmHeadNumber(rpc)));
    let low = x! < y! ? x! : y!;
    // one seat under the floor, the other past it: that seat's provider is behind (stuck, or a spare the pair walked
    // to), so this pass reads on the first spare of the pool's list that is past it, a provider neither seat holds
    if (low < floor && (x! >= floor) !== (y! >= floor)) {
      const behind = x! < floor ? 0 : 1;
      const ahead = behind === 0 ? y! : x!;
      const held = new Set(r.rpcs.map((q) => operatorOf(q.url)));
      for (const spare of r.spares ?? []) {
        const h = operatorOf(spare.url);
        if (h === null || held.has(h)) continue;
        const g = gated(spare, gate, r.signal);
        const head = await evmHeadNumber(g).catch(() => -1n);
        r.signal.throwIfAborted();
        if (head < floor) continue;
        rpcs = behind === 0 ? [g, rpcs[1]] : [rpcs[0], g];
        low = head < ahead ? head : ahead;
        break;
      }
    }
    // under the floor: no balance read (see the header), not whole
    if (low >= floor) {
      at = `0x${low.toString(16)}`;
      READ_AT.set(memo, low);
    } else whole = false;
  } catch {
    r.signal.throwIfAborted();
    whole = false;
  }
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
          if (at === null) return { w, amount: null };
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
  const nextHeld = new Map<string, bigint>();
  const out: Position[] = [];
  for (const { token, decimals, amounts } of read) {
    if (decimals === undefined) whole = false;
    let total = 0n;
    let unknown = decimals === undefined;
    const wallets: string[] = [];
    for (const { w, amount } of amounts) {
      const k = `${w} ${token}`;
      if (amount === null) whole = false;
      const a = amount ?? memo.held.get(k);
      if (a === undefined) {
        unknown = true;
        continue;
      }
      nextHeld.set(k, a);
      if (a > 0n) {
        total += a;
        wallets.push(w);
      }
    }
    if (unknown || total === 0n) continue;
    out.push({ chain: r.chain, token, amount: poolUnits(total, decimals!), cost: "0", wallets: wallets.sort(), decimals: decimals! });
  }
  memo.held = nextHeld;
  out.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  return { positions: out, whole };
}

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
