// One read on two operators from a list (card device-evm-fee-read-walks-operators): the device's twin of the helper's
// evmReadPair (apps/helper/src/pool/evm.ts), for every device read on Base and Robinhood at a named block or at the
// newest. One RPC operator can be blind for a minute at a time: robinhood.drpc.org answered HTTP 400 {"code":27,
// "message":"Unknown state. First available state is 1"} to the bind's fee read at blocks 5, 60 and 120 s back (read
// 2026-11-10 20:44Z), which a fixed pair naming it could not get past. So a read walks the list, and still binds only
// on two operators' answers.
// - Who an operator is: the kit's evmRpcOperator. Two seats of one operator are one operator; a list of fewer than
//   two operators is refused.
// - The two sides: side 0 starts at the list's first operator, side 1 at its second, and each then walks the list in
//   order. A side claims an operator before it asks it and never asks one the other side has claimed for that read, so
//   the two answers are always two operators'. Each side stops at its first answer.
// - "Did not answer": the caller's read threw (a transport error, any HTTP status, a JSON-RPC error object such as
//   dRPC's code 27 or a pruned node's -32000 "historical state ... is not available", a block read answered null, a
//   shape the read refuses), or gave no answer within EVM_READ_CALL_MS (the walk cuts the call itself, so a seat that
//   hangs moves the side on). The side walks on. That operator then rests EVM_READ_REST_MS: later reads ask it after
//   every other operator, so a seat that hangs is not asked first on every try (the fault a review found in the
//   helper's walk, 2026-11-10).
//   The caller's read throws only for an error or a body it cannot read (not JSON-RPC, not the shape asked); a
//   well-formed value it dislikes on its merits is an answer, which it returns, so that value is compared.
// - "Answered": the read resolved. Two answers that differ (`same` false) are refused, EvmOperatorsDiffer, which
//   carries both: the walk never asks a third operator once both sides answered, so a disagreement is never turned
//   into agreement. One operator alone never passes: a side left with no operator refuses the read.
// - Words: a seat is named by its host, never its URL, in every message; any listed URL a provider's own words carry is
//   replaced by its host.
import { evmRpcOperator } from "./rpc-operator.ts";

/** How long one seat's call may take before its side walks on (ms). */
export const EVM_READ_CALL_MS = 4_000;
/** How long one read may take in all (ms): after it, a side with no answer refuses the read. */
export const EVM_READ_BUDGET_MS = 8_000;
/** How long an operator that did not answer is asked after every other one (ms). */
export const EVM_READ_REST_MS = 60_000;

/** One seat of a list: its URL and the caller's client for it (any shape: the read is the caller's). */
export type EvmReadSeat<R> = { readonly url: string; readonly rpc: R };
/** One side's answer: the value, and the seat that gave it (`host` is what a message names). */
export type EvmOperatorAnswer<T> = { readonly value: T; readonly url: string; readonly host: string; readonly operator: string };

/** Two operators answered one read and the answers differ: a refusal, never a reason to ask a third. */
export class EvmOperatorsDiffer<T = unknown> extends Error {
  readonly answers: readonly [EvmOperatorAnswer<T>, EvmOperatorAnswer<T>];
  constructor(what: string, answers: readonly [EvmOperatorAnswer<T>, EvmOperatorAnswer<T>]) {
    super(`${what}: ${answers[0].host} and ${answers[1].host} answered differently`);
    this.name = "EvmOperatorsDiffer";
    this.answers = answers;
  }
}

/** A read no two operators answered: each side's walk, by host, in its words; `cause`, the refusing side's last seat's
 *  own error (a caller's named failure stays that failure). */
export class EvmOperatorsUnanswered extends Error {
  constructor(m: string, cause?: unknown) {
    super(m, { cause });
    this.name = "EvmOperatorsUnanswered";
  }
}

export type EvmTwoOperators<R> = {
  /** The list's seats, in order, each with its host and operator. */
  readonly seats: readonly (EvmReadSeat<R> & { readonly host: string; readonly operator: string })[];
  /**
   * `f` on two operators' seats (see the file's head): their two answers, side 0's first; EvmOperatorsDiffer when
   * `same` says they differ; EvmOperatorsUnanswered when a side found no operator that answered. `what` names the read
   * in messages.
   */
  read<T>(what: string, f: (rpc: R, signal: AbortSignal) => Promise<T>, same: (a: T, b: T) => boolean, signal?: AbortSignal): Promise<[EvmOperatorAnswer<T>, EvmOperatorAnswer<T>]>;
};

export type EvmTwoOperatorsOpts = { callMs?: number; budgetMs?: number; restMs?: number; now?: () => number };

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/** A list of seats read as two operators (see the file's head). Refused: a seat that is not an http(s) URL, one URL
 *  twice, or fewer than two operators. */
export function evmTwoOperators<R>(list: readonly EvmReadSeat<R>[], o: EvmTwoOperatorsOpts = {}): EvmTwoOperators<R> {
  const callMs = o.callMs ?? EVM_READ_CALL_MS;
  const budgetMs = o.budgetMs ?? EVM_READ_BUDGET_MS;
  const restMs = o.restMs ?? EVM_READ_REST_MS;
  const now = o.now ?? (() => Date.now());
  if (!Array.isArray(list)) throw new Error("seats: a list");
  const seen = new Set<string>();
  const seats = list.map((s) => {
    const operator = typeof s?.url === "string" ? evmRpcOperator(s.url) : null;
    if (operator === null) throw new Error("seats: each an http or https URL");
    const key = new URL(s.url).href;
    if (seen.has(key)) throw new Error(`seats: ${hostOf(s.url)} twice`);
    seen.add(key);
    return Object.freeze({ url: s.url, rpc: s.rpc, host: hostOf(s.url), operator });
  });
  const operators = [...new Set(seats.map((s) => s.operator))];
  if (operators.length < 2) throw new Error("seats: two operators at least (two seats of one operator are one)");
  const seatsOf = new Map(operators.map((op) => [op, seats.filter((s) => s.operator === op)]));
  const restUntil = new Map<string, number>();
  // a provider's words with every listed URL as its host
  const urls = [...seats].sort((a, b) => b.url.length - a.url.length);
  const said = (e: unknown): string => {
    let m = String((e as Error | undefined)?.message ?? e);
    for (const s of urls) m = m.split(s.url).join(s.host);
    return m.slice(0, 200);
  };

  async function read<T>(what: string, f: (rpc: R, signal: AbortSignal) => Promise<T>, same: (a: T, b: T) => boolean, signal?: AbortSignal): Promise<[EvmOperatorAnswer<T>, EvmOperatorAnswer<T>]> {
    signal?.throwIfAborted();
    const start = now();
    // the order this read walks: the list's, except that a resting operator goes after every other one; the list's
    // first two (or the first two not resting) are the sides' starts
    const order = [...operators.filter((op) => (restUntil.get(op) ?? 0) <= start), ...operators.filter((op) => (restUntil.get(op) ?? 0) > start)];
    const claimed = new Set<string>([order[0]!, order[1]!]);
    const firsts = [order[0]!, order[1]!] as const;
    const ac = new AbortController();
    const stop = () => ac.abort(signal!.reason);
    signal?.addEventListener("abort", stop, { once: true });
    const side = async (k: 0 | 1): Promise<EvmOperatorAnswer<T>> => {
      const walked: string[] = [];
      let last: unknown;
      const next = (): string | undefined => {
        if (walked.length === 0) return firsts[k];
        const op = order.find((x) => !claimed.has(x));
        if (op !== undefined) claimed.add(op);
        return op;
      };
      for (let op = next(); op !== undefined; op = next()) {
        for (const s of seatsOf.get(op)!) {
          ac.signal.throwIfAborted();
          const left = start + budgetMs - now();
          if (left <= 0) throw new EvmOperatorsUnanswered(`${what}: no two operators answered in ${budgetMs} ms (side ${k}: ${walked.join("; ") || "none asked"})`, last);
          const call = new AbortController();
          const cut = AbortSignal.any([ac.signal, call.signal]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const p = f(s.rpc, cut);
          p.catch(() => {}); // an answer after the cut is dropped, never an unhandled rejection
          try {
            const value = await Promise.race([
              p,
              new Promise<never>((_, no) => {
                timer = setTimeout(() => {
                  const e = new Error(`no answer in ${Math.ceil(Math.min(callMs, left))} ms`);
                  call.abort(e);
                  no(e);
                }, Math.ceil(Math.min(callMs, left)));
              }),
            ]);
            restUntil.delete(op);
            return { value, url: s.url, host: s.host, operator: op };
          } catch (e) {
            if (ac.signal.aborted) throw ac.signal.reason;
            restUntil.set(op, now() + restMs);
            last = e;
            walked.push(`${s.host}: ${said(e)}`);
          } finally {
            clearTimeout(timer);
          }
        }
        if (walked.length === 0) walked.push(`${op}: no seat`);
      }
      throw new EvmOperatorsUnanswered(`${what}: one operator alone never passes (side ${k}: ${walked.join("; ")}; no operator left that the other side did not ask)`, last);
    };
    // one side's refusal stops the other's walk, and both settle before the read ends, so nothing runs behind it
    let first: { e: unknown } | null = null;
    const settled = (k: 0 | 1) =>
      side(k).catch((e: unknown) => {
        first ??= { e };
        ac.abort(e);
        throw e;
      });
    try {
      const rs = await Promise.allSettled([settled(0), settled(1)]);
      if (first !== null) {
        signal?.throwIfAborted();
        throw (first as { e: unknown }).e;
      }
      const two = [(rs[0] as PromiseFulfilledResult<EvmOperatorAnswer<T>>).value, (rs[1] as PromiseFulfilledResult<EvmOperatorAnswer<T>>).value] as [EvmOperatorAnswer<T>, EvmOperatorAnswer<T>];
      if (!same(two[0].value, two[1].value)) throw new EvmOperatorsDiffer(what, two);
      return two;
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  }
  return { seats: Object.freeze(seats), read };
}
