// A fake pair of NEAR providers for the token watch's tests (src/token-status/status.ts), answering as nearcore does
// (FastNEAR and dRPC, read 2026-11-02): `block` by finality or height, `query` call_function and view_account by height
// or by block hash, each answer naming its block's height and hash; a view that panics answers result.error; a block
// the chain does not hold answers UNKNOWN_BLOCK. Heights may be skipped, as NEAR skips them (mainnet 222745348 has no
// block; 222745349's parent is 222745347).
import { createHash } from "node:crypto";
import { base58 } from "../../src/bind/checks.ts";
import { USDC_CODE_HASH } from "../../src/token-status/status.ts";

export const A = "https://a.example";
export const B = "https://b.example";
export const PAUSED = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })';

const heights = new Map<string, number>();
/** Block h's hash: base58 of 32 bytes, one per height, on every fake chain alike (so two providers name one block); a fork names its own. */
export function hashOf(h: number, fork = ""): string {
  const s = base58(createHash("sha256").update(`block ${h}${fork}`).digest());
  heights.set(s, h);
  return s;
}

export type Views = {
  /** ft_balance_of's answer at block h: a value's text, or { error } for a panic. */
  balance?: (h: number) => unknown;
  blocked?: (h: number) => unknown;
  /** view_account's fields at block h (merged over the defaults). */
  code?: (h: number) => Record<string, unknown> | undefined;
  /** This provider's final height (500 by default), read at each call. */
  final?: number | (() => number);
  /** The final block's time in ms (the wall clock by default); each block below it 600 ms earlier. */
  ms?: number | (() => number);
  /** Heights with no block. */
  skip?: readonly number[];
  /** Another chain: every block hash its own (a provider on a fork, or on another network). */
  fork?: string;
};

const unknownBlock = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK", info: {} }, code: -32000, message: "Server error" } };
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });

/** One provider over the views `v`. */
export function nearChain(v: Views) {
  const final = () => (typeof v.final === "function" ? v.final() : (v.final ?? 500));
  const has = (h: number) => Number.isSafeInteger(h) && h > 0 && h <= final() && !(v.skip ?? []).includes(h);
  const header = (h: number) => {
    let p = h - 1;
    while ((v.skip ?? []).includes(p)) p--;
    const top = typeof v.ms === "function" ? v.ms() : (v.ms ?? Date.now());
    const ms = top - (final() - h) * 600;
    return { height: h, hash: hashOf(h, v.fork), prev_hash: hashOf(p, v.fork), timestamp: ms * 1e6, timestamp_nanosec: (BigInt(ms) * 1_000_000n).toString() };
  };
  return async (body: { method: string; params: Record<string, unknown> }): Promise<Response> => {
    const p = body.params;
    const id = p.block_id;
    const h = p.finality === "final" ? final() : typeof id === "number" ? id : typeof id === "string" ? (heights.get(id) ?? -1) : -1;
    if (!has(h)) return json(unknownBlock);
    if (body.method === "block") return json({ jsonrpc: "2.0", id: 1, result: { author: "x.near", header: header(h), chunks: [] } });
    const at = { block_height: h, block_hash: hashOf(h, v.fork) };
    const value = (x: unknown) => (typeof x === "object" && x !== null && "error" in x ? { ...at, logs: [], ...x } : { ...at, logs: [], result: [...Buffer.from(String(x))] });
    let result: unknown;
    if (p.request_type === "view_account") {
      const c = (v.code ?? (() => ({})))(h);
      result = c === undefined ? undefined : { amount: "0", locked: "0", code_hash: USDC_CODE_HASH, storage_usage: 1, ...at, ...c };
    } else if (p.method_name === "ft_balance_of") result = value((v.balance ?? (() => '"5"'))(h));
    else if (p.method_name === "is_blocklisted") result = value((v.blocked ?? (() => "false"))(h));
    return json({ jsonrpc: "2.0", id: 1, result });
  };
}

/** Two providers at `urls` (A and B by default), each call recorded with its method and params. */
export function nearPair(a: Views, b: Views = a, urls: readonly [string, string] = [A, B]) {
  const seen: { url: string; method: string; params: Record<string, unknown> }[] = [];
  const fa = nearChain(a);
  const fb = nearChain(b);
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> };
    seen.push({ url, method: body.method, params: body.params });
    return url === urls[0] ? fa(body) : fb(body);
  };
  return { seen, fetch };
}
