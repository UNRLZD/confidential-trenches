// state.positions on Base and Robinhood (card signpage-positions-evm): what this device's EVM pool buys hold, in the
// same shape as Solana's (src/positions.ts), run by the same cache (positionsCache: one pass at a time, a failed pass
// tried again, a sell's or a buy's end reading it again, a sign out dropping it).
//
// - The Ws: every W whose buy record (pool-buy-evm.ts EVM_POSITION_COSTS_KEY) is this chain's and filled, with the
//   token the record names. A pending record is never shown: the load's follow (followPendingEvmBuys) asks the chain
//   for its Bought or Withdrawn and fills it or removes it, and its end reads the positions again. A withdrawn record
//   is ETH owed back, not a token.
// - Each W's amount: balanceOf(W) of the token on both pool RPCs at the lower of their two newest blocks, the two
//   answers the same (read again once), never a number from the record alone. A W whose read fails keeps the amount
//   its last agreed read gave (as src/positions.ts keeps a W's last amount); one with none leaves its token out of the
//   pass, so two providers that disagree show no position, never a wrong one, and the pass runs again.
// - The token's decimals: decimals() on both RPCs, the same (keptTokenDecimals, kept for the page), else the token is
//   left out.
// - The cost: none is recorded for an EVM buy, so "0", which the app reads as unknown.
// - Requests per pass, on each of the two RPCs: one eth_blockNumber and one balanceOf per filled W (one more per W whose
//   two answers differ), and once per token per page its decimals(). Nothing runs on a timer of its own: a pass runs at
//   the sign-in's first state read, at a buy's or a sell's end, and as a failed pass's retry (positionsCache). Each
//   chain's pass starts EVM_POSITIONS_STAGGER_MS apart from the others' (Solana's at 0), so the three never fire in the
//   same tick. Each read carries the pass's stop: a sign out or a sell's hold sends nothing more of the pass.
// - Who learns what: each pool RPC, a W of this device and the token it bought (the sell's own balance read names the
//   same pair). No other host is asked.
import type { EvmRpc } from "../../wallet/src/pool/evm.ts";
import { evmHeadNumber } from "./evm-send.ts";
import type { EvmHolding } from "./pool-buy-evm.ts";
import type { PassMemo, PassResult, Position } from "./positions.ts";
import { poolUnits } from "./rules/pool.ts";

/** Each EVM chain's pass starts this much after the one before it (Solana, then Base, then Robinhood). */
export const EVM_POSITIONS_STAGGER_MS = 300;

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
  /** The token's decimals on both RPCs, the same (keptTokenDecimals). */
  decimals(token: string): Promise<number>;
};

const word = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("balanceOf: not a word");
  return BigInt(v);
};

/** One balanceOf on both RPCs at `at`, the two the same (read again once), else failed. */
async function agreedBalance(r: EvmPositionsReads, token: string, w: string, at: string): Promise<bigint> {
  const data = `${BALANCE_OF}${BigInt(w).toString(16).padStart(64, "0")}`;
  for (let i = 0; ; i++) {
    r.signal.throwIfAborted();
    const [a, b] = await Promise.all(r.rpcs.map(async (rpc) => word(await rpc("eth_call", [{ to: token, data }, at]))));
    if (a === b) return a!;
    if (i >= 1) throw new Error("balanceOf: the two RPCs differ");
  }
}

/** One pass of this chain's positions (see the header). `memo.held` holds each "W token"'s last agreed amount. */
export async function evmPositionsPass(r: EvmPositionsReads, memo: PassMemo): Promise<PassResult> {
  const all = await r.holdings();
  // the filled buys of this chain: token -> its Ws, both lower case
  const byToken = new Map<string, Set<string>>();
  for (const [a, v] of Object.entries(all)) {
    const h = v as Partial<EvmHolding> | null;
    if (typeof h !== "object" || h === null || h.chain !== r.chain || h.state !== "filled" || typeof h.mint !== "string" || !ADDRESS.test(a) || !ADDRESS.test(h.mint)) continue;
    const t = h.mint.toLowerCase();
    byToken.set(t, (byToken.get(t) ?? new Set()).add(a.toLowerCase()));
  }
  if (byToken.size === 0) {
    memo.held = new Map();
    return { positions: [], whole: true };
  }
  r.signal.throwIfAborted();
  let whole = true;
  let at: string | null = null;
  try {
    const [x, y] = await Promise.all(r.rpcs.map((rpc) => evmHeadNumber(rpc)));
    at = `0x${(x! < y! ? x! : y!).toString(16)}`;
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
          decimals = await r.decimals(token);
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
            return { w, amount: await agreedBalance(r, token, w, at) };
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
