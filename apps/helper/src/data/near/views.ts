// NEAR contract views for the market reads (lists.ts, token.ts, trades.ts): `query` call_function on two public RPCs of
// two operators (scripts/ci/near-rpc-operators.mjs: FastNEAR and dRPC), asked in rotation, the other when one fails. Display only: nothing read here feeds a signature. Every answer is hostile input: bounded in size, parsed
// as JSON, and its shape checked by the caller.
//
// A read at a past block (`block_id`) needs a node that still holds that block's state: FastNEAR's free RPC answered
// GARBAGE_COLLECTED_BLOCK for a block 24 h back and dRPC answered it (read 2026-11-11 18:3xZ), so the RPCs a past read
// asks are given per read (PAST_RPCS first).

import { HOST_PACE_MS } from "../../limits/limits.ts";

/** Mainnet NEAR RPCs, two operators: FastNEAR first, dRPC second. */
export const NEAR_RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org"] as const;
/** For a read a day back: dRPC holds it, FastNEAR's free RPC has dropped it (above); near.org's keyless archival host
 *  second (FastNEAR's own archival is paid, near-rpc-operators.mjs). */
export const PAST_RPCS = ["https://near.drpc.org", "https://archival-rpc.mainnet.near.org"] as const;
/** Each host's calls start at least this far apart, shared by every NEAR market read of the process [design: FastNEAR's
 *  free RPC answered 429 "Rate limits exceeded" after ~1,500 calls in ~15 min sent 4 at once from one Mac (2026-11-11
 *  18:30Z), and the helper's vault token reads (token-status/status.ts) ask the same companies: the market reads stay
 *  near 6 a second a host at most, and far under it on their cadence (lists.ts)]. */
export const HOST_GAP_MS = 150;
/** A call whose turn at its host is further off than this fails at once, nothing sent, so a burst of new tokens never
 *  queues calls the callers stopped waiting for [design: a cold page's reads answer in about a second]. */
export const WAIT_MAX_MS = 4_000;
/** A host that answers 429 is not asked again for this long; the other host answers meanwhile. */
export const HOLD_MS = 60_000;
const ANSWER_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 8_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type At = { finality: "final" } | { block_id: number };
export type Block = { height: number; t_ms: number };

const next = new Map<string, number>();
const heldUntil = new Map<string, number>();
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** `fetch` paced per host (HOST_GAP_MS between call starts, one schedule for the whole process) and held for HOLD_MS
 *  after a 429 (a held host's call fails at once, so the other host answers): the NEAR market reads' default fetch. */
export function pacedFetch(base: Fetch = (u, i) => fetch(u, i), clock: { now: () => number; sleep: (ms: number) => Promise<unknown> } = { now: Date.now, sleep: wait }): Fetch {
  return async (url, init) => {
    const host = new URL(url).host;
    const t = clock.now();
    if ((heldUntil.get(host) ?? 0) > t) throw new Error("host held");
    const at = Math.max(t, next.get(host) ?? 0);
    if (at - t > WAIT_MAX_MS) throw new Error("host busy");
    next.set(host, at + (HOST_PACE_MS[host] ?? HOST_GAP_MS));
    if (at > t) await clock.sleep(at - t);
    const r = await base(url, init);
    if (r.status === 429) heldUntil.set(host, clock.now() + HOLD_MS);
    return r;
  };
}

async function rpcCall(fetchFn: Fetch, url: string, method: string, params: unknown): Promise<unknown> {
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (r.status !== 200) throw new Error(`rpc ${r.status}`);
  const text = await r.text();
  if (text.length > ANSWER_MAX) throw new Error("rpc answer too large");
  const j = JSON.parse(text) as { result?: unknown; error?: unknown };
  if (j.error !== undefined || j.result === undefined) throw new Error("rpc error");
  return j.result;
}

let turn = 0;
/** Asks each RPC in turn, starting with each in rotation so the calls share both companies' limits; the first answer
 *  that passes `check` wins; throws when none does. */
async function firstOf<T>(rpcs: readonly string[], fetchFn: Fetch, method: string, params: unknown, check: (r: unknown) => T): Promise<T> {
  let last: unknown = new Error("no rpc");
  const start = turn++ % rpcs.length;
  for (const url of [...rpcs.slice(start), ...rpcs.slice(0, start)]) {
    try {
      return check(await rpcCall(fetchFn, url, method, params));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** A contract view's JSON answer at `at`. */
export function view(fetchFn: Fetch, contract: string, method: string, args: object, at: At, rpcs: readonly string[] = NEAR_RPCS): Promise<unknown> {
  const params = { request_type: "call_function", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), ...at };
  return firstOf(rpcs, fetchFn, "query", params, (r) => {
    const bytes = (r as { result?: unknown }).result;
    if (!Array.isArray(bytes) || bytes.length > ANSWER_MAX || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) throw new Error("view: not bytes");
    return JSON.parse(Buffer.from(bytes as number[]).toString("utf8"));
  });
}

/** A block's height and time (`final`, or one by height). */
export function block(fetchFn: Fetch, at: At, rpcs: readonly string[] = NEAR_RPCS): Promise<Block> {
  return firstOf(rpcs, fetchFn, "block", at, (r) => {
    const h = (r as { header?: { height?: unknown; timestamp?: unknown } }).header;
    const height = h?.height;
    const ts = h?.timestamp;
    if (!Number.isSafeInteger(height) || (height as number) <= 0 || !Number.isFinite(ts)) throw new Error("block: shape");
    return { height: height as number, t_ms: Math.floor((ts as number) / 1e6) };
  });
}

/** A NEAR account id (nomicon "Account ID" rules: 2 to 64 of a-z 0-9 and `-_.`, no separator at either end or twice). */
export const nearAccount = (v: unknown): string | null =>
  typeof v === "string" && v.length >= 2 && v.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v) ? v : null;
