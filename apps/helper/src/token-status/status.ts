// GET /v1/token-status?token=<id> (markets paper H7 row, M:3336, and 7.1, M:3277) and the hold the relayers call before
// any send (H3.4 check 10, M:1388-1404; V 2.10 (f), V:705-706). The answer is the kit's HelperTokenStatusAnswer.
//
// What this reads (card helper-usdc-event-watch, in place of the paper's event replay from a
// pinned checkpoint, M:1407-1460, which needs two independent indexers and two archival operators: keyless there is one
// of each, NearBlocks' testnet indexer is stalled and dRPC keeps 100k-200k blocks; scripts/live-checks/
// helper-usdc-event-watch.mjs proves the sources). USDC has no view of its halt (W D48), but while it is halted its views
// fail with its own panic "FiatToken: paused" (the real wasm in a sandbox, research RESULT 3.1), so on each of the
// network's two providers, at one block:
//   - ft_balance_of(vault) at final: a balance is open, exactly the paused panic is halted, anything else is not known;
//   - is_blocklisted(vault) at that block: exactly true or false, anything else is not known;
//   - view_account at that block: the code hash.
// A view at block h includes h's receipts (the one mainnet blocklist: false at 99022746, true at 99022747, its block),
// so the state read at a final block is the state the paper's replay would reach there. The answer is caught up only when
// both providers answered all three at final, agree on the code hash and it is the pin: the views mean what they mean
// only for the pinned code (an upgrade could change the panic), so another code hash holds everything. Then halted is
// either provider's halt and vault_blocked either's block. last_event stays null: no event log is read.
// pausedAt(h) (R3's exception for bind) reads ft_balance_of at h-1 and at h on both providers: paused at either.
// Two named limits: (1) a provider keeps only recent blocks (dRPC at least 100k, about 16 h; FastNEAR's archive is the
// one keyless archive), so a send older than that reads on one operator only and pausedAt stays null: the send stays
// pending; (2) a pause and an unpause in one block read as open at both heights, so such a send counts as one of R3's
// three tries; it costs a try, never money. Not covered here: the paper's "a pending Pause multisig request counts as a
// halt" for the ids' deposit calls (check 10, M:1388-1404; V 2.5.1 case 3): USDC has no view of a pending request, it was
// unmeasured in the paper too, and the card names it as open.
// The hold is the safe answer whenever anything is unknown: a provider that fails, two that disagree on the code, a hash
// that is not the pin, a view answer that is neither the open answer nor the exact paused panic, or no vault to read.
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
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Deps = { fetch?: Fetch; now?: () => number };

/**
 * The relayers' hold (H3.4 check 10, H4.3 step 9): true unless the watch is caught up, USDC is not halted, the vault is
 * not blocked and the code hash is the pin. Anything else, null included, holds.
 */
export function tokenHeld(s: TokenStatus): boolean {
  return !(s.caught_up === true && s.halted === false && s.vault_blocked === false && s.code_hash_ok === true && s.code_hash === USDC_CODE_HASH);
}

/** USDC's own panic while it is halted (the wasm's data; bind/send.ts matches the same message on a failed receipt). */
export const PAUSED_PANIC = "FiatToken: paused";
/** Per network: where the watch finds the vault whose block it reads (the withdraw and bind senders' own names). */
export const VAULT_ENV = {
  mainnet: ["WITHDRAW_VAULT_MAINNET", "BIND_VAULT_MAINNET"],
  testnet: ["WITHDRAW_VAULT_TESTNET", "BIND_VAULT_TESTNET"],
} as const satisfies Record<TokenNetwork, readonly [string, string]>;

/** One view's outcome: a value's text, a panic's message, or neither (any other answer). */
export type ViewOutcome = { at: number; answer: string } | { at: number; panic: string } | { at?: undefined; other: true };
/** What one provider read at one block: the halt from ft_balance_of, the block from is_blocklisted, the code hash. */
export type Read = { block_height: number; halt: ViewOutcome; blocked?: ViewOutcome; code_hash?: string };

/** The halt as one ft_balance_of outcome says it: false for a balance, true for exactly the paused panic, else null. */
export function haltOf(o: ViewOutcome | undefined): boolean | null {
  if (o === undefined) return null;
  if ("answer" in o) return /^"\d{1,40}"$/.test(o.answer) ? false : null;
  if ("panic" in o) return o.panic === PAUSED_PANIC ? true : null;
  return null;
}
/** The vault's block as one is_blocklisted outcome says it: exactly true or false, else null. */
export function blockedOf(o: ViewOutcome | undefined): boolean | null {
  return o !== undefined && "answer" in o && (o.answer === "true" || o.answer === "false") ? o.answer === "true" : null;
}

/**
 * The answer from the two providers' reads of `token`: caught up only when both read the halt, the block and the code
 * hash, agree on the code hash and it is the pin; then halted and vault_blocked are either provider's. The code hash is
 * shown whenever both read it and agree; never more than was read.
 */
export function statusFrom(a: Read | undefined, b: Read | undefined, token: string): TokenStatus {
  const agreed = a?.code_hash !== undefined && a.code_hash === b?.code_hash;
  const halts = [haltOf(a?.halt), haltOf(b?.halt)];
  const blocks = [blockedOf(a?.blocked), blockedOf(b?.blocked)];
  const known = agreed && a!.code_hash === USDC_CODE_HASH && !halts.includes(null) && !blocks.includes(null);
  return {
    token,
    caught_up: known,
    halted: known ? halts.includes(true) : null,
    vault_blocked: known ? blocks.includes(true) : null,
    code_hash_ok: known ? true : null,
    code_hash: agreed ? a!.code_hash! : "",
    block_height: agreed ? Math.min(a!.block_height, b!.block_height) : 0,
    last_event: null,
  };
}

/**
 * Was USDC paused at block `height`, from the two providers' ft_balance_of at height-1 and at height (each `[h-1, h]`):
 * paused at either, since a receipt in block h ran after h-1's state and h's view includes h's receipts. null unless all
 * four outcomes are known and the two providers agree at each height.
 */
export function pausedFrom(a: readonly [ViewOutcome | undefined, ViewOutcome | undefined], b: readonly [ViewOutcome | undefined, ViewOutcome | undefined]): boolean | null {
  const ha = a.map(haltOf);
  const hb = b.map(haltOf);
  if ([...ha, ...hb].includes(null) || ha[0] !== hb[0] || ha[1] !== hb[1]) return null;
  return ha.includes(true);
}

/** The vault the watch reads on a network: WITHDRAW_VAULT_<NET>, else BIND_VAULT_<NET>; two that differ are refused. */
export function vaultOf(env: Record<string, string | undefined>, network: TokenNetwork): string | undefined {
  const [w, bnd] = VAULT_ENV[network].map((n) => env[n] || undefined);
  if (w !== undefined && bnd !== undefined && w !== bnd) throw new Error(`${VAULT_ENV[network][0]} and ${VAULT_ENV[network][1]} must name the same vault`);
  const v = w ?? bnd;
  if (v !== undefined && (v.length < 2 || v.length > 64 || !/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v))) throw new Error(`${VAULT_ENV[network][w !== undefined ? 0 : 1]} must be a NEAR account id`);
  return v;
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

/** One view's outcome from a provider's JSON answer: its value's text, its panic's message, or other. */
export function viewOutcome(j: unknown): ViewOutcome {
  const res = (j as { result?: { result?: unknown; error?: unknown; block_height?: unknown } } | null)?.result;
  const at = res?.block_height;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return { other: true };
  if (Array.isArray(res!.result) && res!.result.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return { at, answer: Buffer.from(res!.result as number[]).toString("utf8") };
  // a view that panics: both providers answer result.error "wasm execution failed with error: HostError(GuestPanic {
  // panic_msg: \"...\" })" (read on FastNEAR and dRPC, 2026-11-02); the message is taken whole, up to its closing quote
  const m = typeof res!.error === "string" ? /HostError\(GuestPanic \{ panic_msg: "([^"\\]*)" \}\)$/.exec(res!.error) : null;
  return m ? { at, panic: m[1]! } : { other: true };
}

/** One network's watch: its own token (WATCHED) and the vault it carries (VAULT_ENV) read on its own pair. */
export function createTokenWatch(network: TokenNetwork, env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const urls = readUrls(env, network);
  const token = WATCHED[network].token;
  const vault = vaultOf(env, network);
  let cached: { at: number; status: TokenStatus } | undefined;
  let inflight: Promise<TokenStatus> | undefined;
  const pausedCache = new Map<bigint, boolean>(); // a known answer for a past height never changes

  /** One query on one provider: its JSON answer, or undefined on any failure, any status but 200 or a large answer. */
  async function query(url: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }),
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
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return undefined;
    }
  }
  const view = (url: string, method: string, account_id: string, at: { finality: "final" } | { block_id: number }) =>
    query(url, { request_type: "call_function", ...at, account_id: token, method_name: method, args_base64: Buffer.from(JSON.stringify({ account_id })).toString("base64") }).then(viewOutcome);
  /** The token's code hash at a block (or final), or undefined on any answer of the wrong shape or another block. */
  async function codeHash(url: string, at: { finality: "final" } | { block_id: number }): Promise<{ code_hash: string; block_height: number } | undefined> {
    const res = ((await query(url, { request_type: "view_account", ...at, account_id: token })) as { result?: { code_hash?: unknown; block_height?: unknown } } | undefined)?.result;
    const code_hash = res?.code_hash;
    const block_height = res?.block_height;
    if (typeof code_hash !== "string" || !HASH.test(code_hash) || typeof block_height !== "number" || !Number.isSafeInteger(block_height) || block_height <= 0) return undefined;
    if ("block_id" in at && block_height !== at.block_id) return undefined;
    return { code_hash, block_height };
  }

  /** One provider's read: the halt at final, then the vault's block and the code hash at that same block. */
  async function read(url: string): Promise<Read | undefined> {
    if (vault === undefined) {
      // no vault carried on this network: the code hash only, never caught up (nothing to carry, nothing to free)
      const c = await codeHash(url, { finality: "final" });
      return c && { ...c, halt: { other: true } };
    }
    const halt = await view(url, "ft_balance_of", vault, { finality: "final" });
    if (halt.at === undefined) return undefined;
    const [blocked, c] = await Promise.all([view(url, "is_blocklisted", vault, { block_id: halt.at }), codeHash(url, { block_id: halt.at })]);
    return { block_height: halt.at, halt, blocked, code_hash: c?.code_hash };
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

  /**
   * R3's exception for bind (bind/send.ts): was USDC paused at block `height`, by pausedFrom on both providers, with the
   * pinned code at that block on both; null when anything is not known (header: the providers' kept blocks).
   */
  async function pausedAt(height: bigint): Promise<boolean | null> {
    const known = pausedCache.get(height);
    if (known !== undefined) return known;
    if (vault === undefined || height < 2n || height > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const h = Number(height);
    const each = await Promise.all(
      urls.map(async (url) => {
        const [before, at, c] = await Promise.all([view(url, "ft_balance_of", vault, { block_id: h - 1 }), view(url, "ft_balance_of", vault, { block_id: h }), codeHash(url, { block_id: h })]);
        return { pair: [before.at === h - 1 ? before : undefined, at.at === h ? at : undefined] as const, pinned: c?.code_hash === USDC_CODE_HASH };
      }),
    );
    if (!each.every((e) => e.pinned)) return null;
    const p = pausedFrom(each[0]!.pair, each[1]!.pair);
    if (p !== null) pausedCache.set(height, p);
    return p;
  }

  return { network, token, vault, status, held, pausedAt };
}

export type TokenWatch = ReturnType<typeof createTokenWatch>;
export type TokenWatches = Record<TokenNetwork, TokenWatch>;

/** Both networks' watches from the host's environment, each on its own pair. */
export function tokenWatchesFromEnv(env: Record<string, string | undefined>, deps: Deps = {}): TokenWatches {
  return { mainnet: createTokenWatch("mainnet", env, deps), testnet: createTokenWatch("testnet", env, deps) };
}

/** What the relayers take: each network's status, and only its own. */
export const statusesOf = (w: TokenWatches): Record<TokenNetwork, () => Promise<TokenStatus>> => ({ mainnet: w.mainnet.status, testnet: w.testnet.status });

/** What bind takes: each network's pausedAt, and only its own. */
export const pausedAtsOf = (w: TokenWatches): Record<TokenNetwork, (height: bigint) => Promise<boolean | null>> => ({ mainnet: w.mainnet.pausedAt, testnet: w.testnet.pausedAt });
