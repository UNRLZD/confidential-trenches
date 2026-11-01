// GET /v1/token-status?token=<id> (markets paper H7 row, M:3336, and 7.1, M:3277) and the hold the relayers call before
// any send (H3.4 check 10, M:1388-1404; V 2.10 (f), V:705-706). The answer is the kit's HelperTokenStatusAnswer.
//
// What this reads: USDC's code hash by view_account at final on two NEAR providers, which must answer and agree.
// What it cannot read yet: the halt. USDC has no view of it (W D48, W:1494; the deployed wasm, 321,491 B, sha256
// b98ccd53…cfe6, exports no pause view, read 2026-11-01 06:37Z) and view_state on it answers TOO_LARGE_CONTRACT_STATE
// on both providers (read 06:38Z), so `halted` is known only by the paper's event watch from a pinned checkpoint
// (M:1404-1420, "Where the watch starts"), which is not built. Until it is, the answer is the kit's not-caught-up one:
// caught_up false, so halted, vault_blocked and code_hash_ok are null (v1.ts), and tokenHeld() holds every move. The
// hold is the safe answer whenever anything is unknown: a provider that fails, two that disagree, a hash that is not
// the pin, or no watch.
//
// Display only (H7, H10 U7): no move into the vault rests on this answer; the relayer's own tokenHeld() call is what
// holds a move.
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** The release's pin of USDC's code (vault.md:22 "USDC" row; research proofs/g1-vault-gas/RESULT.md:36). */
export const USDC_CODE_HASH = "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q";

/** The two NEAR providers: the host's environment, else two public ones from different operators (FastNEAR, dRPC). */
export const WATCH_RPCS = [
  { env: "NEAR_RPC_URL", fallback: "https://rpc.mainnet.fastnear.com" },
  { env: "NEAR_RPC_URL_B", fallback: "https://near.drpc.org" },
] as const;
export const READ_TIMEOUT_MS = 2_000; // check 10's reads answer within 1 s at p99 [design, M4.3]; one slow answer holds
export const CACHE_MS = 1_000; // about one NEAR block: one pair of reads per block, however many callers ask
const ANSWER_MAX = 4_096;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The kit's HelperTokenStatusAnswer (packages/kit/src/helper/v1.ts), written again: the image is apps/helper alone. */
export type TokenStatus = {
  token: string;
  caught_up: boolean;
  halted: boolean | null;
  vault_blocked: boolean | null;
  code_hash_ok: boolean | null;
  code_hash: string;
  block_height: number;
  last_event: { name: "paused" | "unpaused" | "blocklist" | "unblocklist"; block_height: number; receipt_id: string } | null;
};
type Read = { code_hash: string; block_height: number };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Deps = { fetch?: Fetch; now?: () => number };

/**
 * The relayers' hold (H3.4 check 10, H4.3 step 9): true unless the watch is caught up, USDC is not halted, the vault is
 * not blocked and the code hash is the pin. Anything else, null included, holds.
 */
export function tokenHeld(s: TokenStatus): boolean {
  return !(s.caught_up === true && s.halted === false && s.vault_blocked === false && s.code_hash_ok === true && s.code_hash === USDC_CODE_HASH);
}

/** The answer from the two reads: the code hash only when both answered and agree; never more than was read. */
export function statusFrom(a: Read | undefined, b: Read | undefined): TokenStatus {
  const agreed = a !== undefined && b !== undefined && a.code_hash === b.code_hash;
  return {
    token: USDC,
    caught_up: false, // no event watch yet: the halt and the vault's block are not known (header)
    halted: null,
    vault_blocked: null,
    code_hash_ok: null,
    code_hash: agreed ? a.code_hash : "",
    block_height: agreed ? Math.min(a.block_height, b.block_height) : 0,
    last_event: null,
  };
}

export function readUrls(env: Record<string, string | undefined>): [string, string] {
  const urls = WATCH_RPCS.map(({ env: name, fallback }) => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`${name} must be an http(s) URL`);
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hash !== "") throw new Error(`${name} must be an http(s) URL with no fragment`);
    return v;
  });
  if (urls[0] === urls[1]) throw new Error(`${WATCH_RPCS[0].env} and ${WATCH_RPCS[1].env} must be two different providers`);
  return [urls[0]!, urls[1]!];
}

export function createTokenWatch(env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const urls = readUrls(env);
  let cached: { at: number; status: TokenStatus } | undefined;
  let inflight: Promise<TokenStatus> | undefined;

  /** One view_account of USDC at final, or undefined on any failure or any answer of the wrong shape. */
  async function read(url: string): Promise<Read | undefined> {
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: USDC } }),
        redirect: "error",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (r.status !== 200 || !r.body) return undefined;
      // read up to ANSWER_MAX bytes, never more: a provider is an outside input
      const chunks: Uint8Array[] = [];
      let n = 0;
      for await (const c of r.body) {
        n += c.byteLength;
        if (n > ANSWER_MAX) return undefined;
        chunks.push(c);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const res = (JSON.parse(text) as { result?: { code_hash?: unknown; block_height?: unknown } }).result;
      const code_hash = res?.code_hash;
      const block_height = res?.block_height;
      if (typeof code_hash !== "string" || !HASH.test(code_hash) || typeof block_height !== "number" || !Number.isSafeInteger(block_height) || block_height <= 0) return undefined;
      return { code_hash, block_height };
    } catch {
      return undefined;
    }
  }

  /** The status, read at most once per CACHE_MS, one pair of reads at a time. */
  function status(): Promise<TokenStatus> {
    if (cached && now() - cached.at < CACHE_MS) return Promise.resolve(cached.status);
    if (!inflight) {
      inflight = Promise.all(urls.map(read))
        .then(([a, b]) => {
          const s = statusFrom(a, b);
          cached = { at: now(), status: s };
          return s;
        })
        .finally(() => (inflight = undefined));
    }
    return inflight;
  }

  /** What a relayer calls before every send that H3.4 check 10 or H4.3 step 9 holds: true means send nothing. */
  async function held(): Promise<boolean> {
    return tokenHeld(await status());
  }

  return { status, held };
}
