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
// - Words: a seat is named by its host, never its URL, in every message (seatWords, card device-evm-read-residuals):
//   every secret part of a seat's own URL (its user, password, query keys and values, path segments and fragment, each
//   of SEAT_SECRET_MIN characters or more), as written, percent-decoded, percent-encoded or with JSON's escaped slash,
//   in any case, and any start of one of SEAT_SECRET_MIN or more, becomes <key>, wherever it stands (a path alone, an
//   unlisted host, a backslash path); then any URL of any scheme becomes its host (<url> when it does not parse), and
//   any listed host followed by a path, a trailing dot or a backslash becomes the host. errors[] and cause carry the
//   same words: each seat error is a copy of its class with its message, string fields and cause so cleaned.
// - What the walk gives up against a fixed pair (independent review, 2026-11-10): any two of the list's operators that
//   collude, with the others blocked, can now agree, where before only the fixed two could. Accepted for the reads on
//   it: the bind's fee must still equal the helper's answer, is capped at 50% of the chunk and goes to the pinned
//   recipient; Verify is a display. Independence as far as it can be read from outside (the clients' own version
//   answers, read by the review): Robinhood: nitro v3.12.4-rc.3 on Robinhood's own, v3.12.1 and v3.12.2 on Pocket, a
//   modified build on publicnode, hidden on dRPC; Base: reth v2.5.2 on base.org, publicnode and Pocket, hidden on dRPC
//   and Tenderly.
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

/** A read no two operators answered: each side's walk, by host, in its words; `errors`, every seat error of the side
 *  that refused, in the order it walked (a caller judges them all: a lag only when every one lagged); `cause`, the last. */
export class EvmOperatorsUnanswered extends Error {
  readonly errors: readonly unknown[];
  constructor(m: string, errors: readonly unknown[] = []) {
    super(m, { cause: errors[errors.length - 1] });
    this.name = "EvmOperatorsUnanswered";
    this.errors = Object.freeze([...errors]);
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

/** A secret part of a seat's URL is one of this many characters or more (a shorter one is a word, "v2" or "rpc"). */
const SEAT_SECRET_MIN = 8;
/** A secret's start matched at most this long (a longer secret is still removed whole where it stands whole). */
const SEAT_SECRET_START_MAX = 256;
const decodeOr = (x: string): string => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};
/** A provider's words with nothing of the seats' URLs but their hosts (the file's head, Words), at most 200 characters.
 *  Each pattern is built once; each pass reads the words as they are (no index into a case-folded copy), bounded first. */
function seatWords(urls: readonly string[]): (e: unknown) => string {
  const secrets = new Set<string>();
  const hosts = new Set<string>();
  for (const url of urls) {
    const p = new URL(url);
    hosts.add(p.hostname.replace(/\.$/, ""));
    for (const x of [p.username, p.password, ...[...p.searchParams].flat(), ...p.pathname.split("/"), p.hash.slice(1)]) {
      for (const f of [x, decodeOr(x), encodeURIComponent(decodeOr(x))]) {
        if (f.length < SEAT_SECRET_MIN) continue;
        secrets.add(f);
        if (f.includes("/")) secrets.add(f.replaceAll("/", "\\/"));
      }
    }
  }
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // each secret, longest first: its first SEAT_SECRET_MIN characters, then each next one optional inside the one before,
  // so a whole secret and any start of it go in one pass with no backtracking past a character
  const starts = [...secrets]
    .sort((x, y) => y.length - x.length)
    .map((k) => [...k].slice(0, SEAT_SECRET_START_MAX).map(esc))
    .map((cs) => new RegExp(`${cs.slice(0, SEAT_SECRET_MIN).join("")}${cs.slice(SEAT_SECRET_MIN).map((c) => `(?:${c}`).join("")}${")?".repeat(Math.max(0, cs.length - SEAT_SECRET_MIN))}`, "gi"));
  const wholes = [...secrets].sort((x, y) => y.length - x.length);
  // any scheme's URL run, passing over a secret already put as <key>
  const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/(?:<key>|[^\s"'<>`])*/gi;
  const bare = [...hosts].map((h) => ({ h, re: new RegExp(`\\b${esc(h)}\\.?(?::\\d+)?[/?#\\\\][^\\s"'<>]*`, "gi") }));
  return (e) => {
    let m = String((e as Error | undefined)?.message ?? e);
    for (const k of wholes) m = m.split(k).join("<key>");
    m = m.slice(0, 2_000);
    for (const r of starts) m = m.replace(r, "<key>");
    m = m.replace(ANY_URL, (u) => {
      try {
        return new URL(u).host || "<url>";
      } catch {
        return "<url>";
      }
    });
    for (const { h, re } of bare) m = m.replace(re, h);
    return m.slice(0, 200);
  };
}

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
  const said = seatWords(seats.map((s) => s.url));
  // a seat's error as errors[] and cause carry it: its own class (a caller tells a lag by it), its words said()'s
  const clean = (e: unknown, depth = 0): unknown => {
    if (!(e instanceof Error)) return said(e);
    try {
      const c = Object.create(Object.getPrototypeOf(e) as object) as Error;
      for (const k of Reflect.ownKeys(e)) {
        if (k === "message" || k === "stack" || k === "cause") continue;
        // each own field as its value (an accessor read once, never carried as a getter), a string's words said()'s
        const v = (e as unknown as Record<PropertyKey, unknown>)[k];
        Object.defineProperty(c, k, { value: typeof v === "string" ? said(v) : v, writable: true, configurable: true, enumerable: Object.prototype.propertyIsEnumerable.call(e, k) });
      }
      // a name or code read through the prototype (a DOMException's getters throw on a copy) kept as its own value
      for (const k of ["name", "code"] as const) {
        const v = (e as unknown as Record<string, unknown>)[k];
        if (!Object.hasOwn(c, k) && v !== undefined) Object.defineProperty(c, k, { value: typeof v === "string" ? said(v) : v, writable: true, configurable: true });
      }
      Object.defineProperty(c, "message", { value: said(e), writable: true, configurable: true });
      Object.defineProperty(c, "stack", { value: `${c.name}: ${c.message}`, writable: true, configurable: true });
      if ("cause" in e) Object.defineProperty(c, "cause", { value: depth < 2 ? clean(e.cause, depth + 1) : said(e.cause), writable: true, configurable: true });
      return c;
    } catch {
      return Object.assign(new Error(said(e)), { name: "Error" });
    }
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
      const errors: unknown[] = [];
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
          if (left <= 0) throw new EvmOperatorsUnanswered(`${what}: no two operators answered in ${budgetMs} ms (side ${k}: ${walked.join("; ") || "none asked"})`, errors);
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
            const c = clean(e);
            errors.push(c);
            walked.push(`${s.host}: ${c instanceof Error ? c.message : String(c)}`);
          } finally {
            clearTimeout(timer);
          }
        }
        if (walked.length === 0) walked.push(`${op}: no seat`);
      }
      throw new EvmOperatorsUnanswered(`${what}: one operator alone never passes (side ${k}: ${walked.join("; ")}; no operator left that the other side did not ask)`, errors);
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
