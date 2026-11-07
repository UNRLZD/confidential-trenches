// A fake pair of NEAR providers for the token watch's tests (src/token-status/status.ts), answering as nearcore does
// (FastNEAR and dRPC, read 2026-11-02): `block` by finality or height, `query` call_function and view_account by height
// or by block hash, each answer naming its block's height and hash; a view that panics answers result.error; a block
// the chain does not hold answers UNKNOWN_BLOCK. Heights may be skipped, as NEAR skips them (mainnet 222745348 has no
// block; 222745349's parent is 222745347).
import { createHash } from "node:crypto";
import { base58 } from "../../src/bind/checks.ts";
import { TESTNET_TOKEN, USDC, USDC_CODE_HASH } from "../../src/token-status/status.ts";

export const A = "https://a.example";
export const B = "https://b.example";
export const PAUSED = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })';
/** approve_multisig_request run as a view, as both mainnet providers answer it (id 46 stored, id 86 not, 2026-11-07). */
export const STORED = 'wasm execution failed with error: HostError(ProhibitedInView { method_name: "predecessor_account_id" })';
export const NO_REQUEST = "wasm execution failed with error: HostError(GuestPanic { panic_msg: \"panicked at 'called `Option::unwrap()` on a `None` value', src/fiat_token.rs:627:87\" })";
/** get_next_multisig_request_id as both providers read it on 2026-11-07: mainnet USDC 218, the testnet token 4. */
export const NEXT_ID: Record<string, number> = { [USDC]: 218, [TESTNET_TOKEN]: 4 };

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
  /** get_next_multisig_request_id's answer at block h (the token's pin by default). */
  next?: (h: number) => unknown;
  /** approve_multisig_request's answer for `id` at block h (no request by default): true for a stored one, or any answer. */
  request?: (id: number, h: number) => unknown;
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
  /** A provider that answers `block` by height with the header this many heights on (a wrong answer). */
  shift?: number;
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
    // one chunk header per shard, as nearcore lists them: about 19 KB on mainnet's nine shards (read 2026-11-03)
    if (body.method === "block" && typeof id === "number" && v.shift !== undefined) return json({ jsonrpc: "2.0", id: 1, result: { header: header(h + v.shift), chunks: [] } });
    if (body.method === "block") return json({ jsonrpc: "2.0", id: 1, result: { author: "x.near", header: header(h), chunks: Array.from({ length: 9 }, (_, shard_id) => ({ shard_id, pad: "x".repeat(2_000) })) } });
    const at = { block_height: h, block_hash: hashOf(h, v.fork) };
    const value = (x: unknown) => (typeof x === "object" && x !== null && "error" in x ? { ...at, logs: [], ...x } : { ...at, logs: [], result: [...Buffer.from(String(x))] });
    let result: unknown;
    if (p.request_type === "view_account") {
      const c = (v.code ?? (() => ({})))(h);
      result = c === undefined ? undefined : { amount: "0", locked: "0", code_hash: USDC_CODE_HASH, storage_usage: 1, ...at, ...c };
    } else if (p.method_name === "ft_balance_of") result = value((v.balance ?? (() => '"5"'))(h));
    else if (p.method_name === "is_blocklisted") result = value((v.blocked ?? (() => "false"))(h));
    else if (p.method_name === "get_next_multisig_request_id") result = value((v.next ?? (() => String(NEXT_ID[String(p.account_id)])))(h));
    else if (p.method_name === "approve_multisig_request") {
      const { request_id } = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString("utf8")) as { request_id: number };
      const r = (v.request ?? (() => false))(request_id, h);
      result = value(r === true ? { error: STORED } : r === false ? { error: NO_REQUEST } : r);
    }
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
