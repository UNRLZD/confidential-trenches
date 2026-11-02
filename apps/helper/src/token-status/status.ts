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
//
// One watch per network (WATCHED): mainnet's reads USDC on mainnet's pair, testnet's reads the testnet token on
// testnet's pair, never the other's, so a hold on one network never opens or holds the other. The testnet token runs
// mainnet USDC's own code (contracts/vault/deployments/testnet-usdc.json code_hash), so both pin the same code hash.
import { VAULT_CONSTANTS, VAULT_TOKEN_CODE_HASH, type HelperTokenStatusAnswer } from "@blindfill/kit";

/** The vault's one token (the kit's VAULT_CONSTANTS.TOKEN, packages/kit/src/vault/shapes.ts). */
export const USDC = VAULT_CONSTANTS.TOKEN;
/** The release's pin of USDC's code (the kit's VAULT_TOKEN_CODE_HASH; vault.md:22 "USDC" row). */
export const USDC_CODE_HASH = VAULT_TOKEN_CODE_HASH;

/** The two NEAR providers: the host's environment, else two public ones from different operators (FastNEAR, dRPC). */
export const WATCH_RPCS = [
  { env: "NEAR_RPC_URL", fallback: "https://rpc.mainnet.fastnear.com" },
  { env: "NEAR_RPC_URL_B", fallback: "https://near.drpc.org" },
] as const;
/** Testnet's two providers: the host's environment, else the device's release pair (FastNEAR and dRPC). */
export const TESTNET_RPCS = [
  { env: "NEAR_TESTNET_RPC_URL", fallback: "https://test.rpc.fastnear.com" },
  { env: "NEAR_TESTNET_RPC_URL_B", fallback: "https://near-testnet.drpc.org" },
] as const;
/** The testnet token: contracts/vault/deployments/testnet-usdc.json account_id (status.test.ts reads the file). */
export const TESTNET_TOKEN = "bf-usdc-20261101t022248.testnet"; // gitleaks:allow (a public account id)

export type TokenNetwork = "mainnet" | "testnet";
/** Each network's token and its pair of providers: a network's watch reads only these. */
export const WATCHED = {
  mainnet: { token: USDC, rpcs: WATCH_RPCS },
  testnet: { token: TESTNET_TOKEN, rpcs: TESTNET_RPCS },
} as const satisfies Record<TokenNetwork, { token: string; rpcs: readonly [{ env: string; fallback: string }, { env: string; fallback: string }] }>;
export const READ_TIMEOUT_MS = 2_000; // check 10's reads answer within 1 s at p99 [design, M4.3]; one slow answer holds
export const CACHE_MS = 1_000; // about one NEAR block: one pair of reads per block, however many callers ask
const ANSWER_MAX = 4_096;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The kit's HelperTokenStatusAnswer (packages/kit/src/helper/v1.ts). */
export type TokenStatus = HelperTokenStatusAnswer;
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

/** The answer from the two reads of `token`: the code hash only when both answered and agree; never more than was read. */
export function statusFrom(a: Read | undefined, b: Read | undefined, token: string): TokenStatus {
  const agreed = a !== undefined && b !== undefined && a.code_hash === b.code_hash;
  return {
    token,
    caught_up: false, // no event watch yet: the halt and the vault's block are not known (header)
    halted: null,
    vault_blocked: null,
    code_hash_ok: null,
    code_hash: agreed ? a.code_hash : "",
    block_height: agreed ? Math.min(a.block_height, b.block_height) : 0,
    last_event: null,
  };
}

/** A network's two provider URLs from the host's environment, else its public pair; two of the same are refused. */
export function readUrls(env: Record<string, string | undefined>, network: TokenNetwork): [string, string] {
  const pair = WATCHED[network].rpcs;
  const urls = pair.map(({ env: name, fallback }) => {
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
  if (urls[0] === urls[1]) throw new Error(`${pair[0].env} and ${pair[1].env} must be two different providers`);
  return [urls[0]!, urls[1]!];
}

/** One network's watch: its own token (WATCHED) read on its own pair. */
export function createTokenWatch(network: TokenNetwork, env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const urls = readUrls(env, network);
  const token = WATCHED[network].token;
  let cached: { at: number; status: TokenStatus } | undefined;
  let inflight: Promise<TokenStatus> | undefined;

  /** One view_account of the network's token at final, or undefined on any failure or any answer of the wrong shape. */
  async function read(url: string): Promise<Read | undefined> {
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: token } }),
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
          const s = statusFrom(a, b, token);
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

  return { network, token, status, held };
}

export type TokenWatch = ReturnType<typeof createTokenWatch>;
export type TokenWatches = Record<TokenNetwork, TokenWatch>;

/** Both networks' watches from the host's environment, each on its own pair. */
export function tokenWatchesFromEnv(env: Record<string, string | undefined>, deps: Deps = {}): TokenWatches {
  return { mainnet: createTokenWatch("mainnet", env, deps), testnet: createTokenWatch("testnet", env, deps) };
}

/** What the relayers take: each network's status, and only its own. */
export const statusesOf = (w: TokenWatches): Record<TokenNetwork, () => Promise<TokenStatus>> => ({ mainnet: w.mainnet.status, testnet: w.testnet.status });

/** One pause or unpause of the token, as the watch read it from the token's own event log. */
export type PauseEvent = { name: "paused" | "unpaused"; block_height: number };
/** The watch's pause history: the state at `from`, every pause and unpause since, read through `caughtUpTo`. */
export type PauseHistory = { from: number; pausedAtFrom: boolean; caughtUpTo: number; events: readonly PauseEvent[] };

/**
 * Was the token paused at block `height` (R3's exception, M:1846): null outside what the watch has read. A receipt in
 * the same block as a pause or an unpause counts as paused there: its order inside the block is not known, and an
 * unpause in that block means it was paused before it. Later events (another pause, a blocklist) never change it.
 */
export function pausedAt(h: PauseHistory, height: number): boolean | null {
  if (height < h.from || height > h.caughtUpTo) return null;
  let paused = h.pausedAtFrom;
  for (const e of [...h.events].sort((x, y) => x.block_height - y.block_height)) {
    if (e.block_height > height) break;
    if (e.block_height === height) return true;
    paused = e.name === "paused";
  }
  return paused;
}
