// GET /v1/token-status?token=<id> (markets paper H7 row, M:3336, and 7.1, M:3277) and the hold the relayers call before
// any send (H3.4 check 10, M:1388-1404; V 2.10 (f), V:705-706). The answer is the kit's HelperTokenStatusAnswer.
//
// What this reads (card helper-usdc-event-watch, in place of the paper's event replay from a
// pinned checkpoint, M:1407-1460, which needs two independent indexers and two archival operators: keyless there is one
// of each, NearBlocks' testnet indexer is stalled and dRPC keeps 100k-200k blocks; scripts/live-checks/
// helper-usdc-event-watch.mjs proves the sources). USDC has no view of its halt (W D48), but while it is halted its views
// fail with its own panic "FiatToken: paused" (the real wasm in a sandbox, research RESULT 3.1), so on each of the
// network's two providers, at the move's own block H (markets.md check 10: the two finals at most HEIGHT_SPREAD_MAX
// apart; H the lower for a withdrawal, the higher for a deposit, its provider one or a few blocks behind given up to
// H_WAIT_MS to reach it; H's block at most FINAL_AGE_MAX_MS behind the wall clock, so two frozen providers never answer):
//   - ft_balance_of(vault): a balance is open, exactly the paused panic is halted, anything else is not known;
//   - is_blocklisted(vault): exactly true or false, anything else is not known;
//   - view_account: the code hash;
// each by block_id = H, and each answer counts only when it names H's height and H's hash.
// A view at block h includes h's receipts (the one mainnet blocklist: false at 99022746, true at 99022747, its block),
// so the state read at a final block is the state the paper's replay would reach there. The answer is caught up only when
// both providers answered all three at H, agree on the code hash and it is the pin: the views mean what they mean
// only for the pinned code (an upgrade could change the panic), so another code hash holds everything. Then halted is
// either provider's halt and vault_blocked either's block. last_event stays null: no event log is read. A final block's
// answer never changes, so it is kept by its height and hash; the display (/v1/token-status, at the lower final) is
// read at most once per CACHE_MS on a monotonic clock. One 429 is waited out (Retry-After, at most BACKOFF_429_MS).
// pausedAt(h) (R3's exception for bind) reads block h's header on both providers (one hash), then ft_balance_of at its
// parent (by hash: NEAR skips heights, so h-1 may be no block) and at h, with the pin at both: paused at either.
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
export const CACHE_MS = 1_000; // the display's answer, about one NEAR block, on the monotonic clock
/** Two providers' finals may stand this many blocks apart at most (withdraw/fee.ts HEIGHT_SPREAD_MAX; status.test.ts: one value). */
export const HEIGHT_SPREAD_MAX = 30;
/** H's block may stand this far behind the wall clock at most (withdraw/index.ts MAX_FINAL_AGE_MS; status.test.ts: one value). */
export const FINAL_AGE_MAX_MS = 30_000;
/** Check 10's wait for a provider one or a few blocks behind to hold H (markets.md check 10, 2 s [design]). */
export const H_WAIT_MS = 2_000;
const H_POLL_MS = 300; // about half a NEAR block between two reads of the lagging provider's final
/** One 429 is waited out this long at most (markets.md check 6's budget: one 429 backed off 10 s). */
export const BACKOFF_429_MS = 10_000;
const BLOCKS_KEPT = 64;
const ANSWER_MAX = 4_096;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The kit's HelperTokenStatusAnswer (packages/kit/src/helper/v1.ts). */
export type TokenStatus = HelperTokenStatusAnswer;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** now: the wall clock, for H's age only; clock: a monotonic clock in ms; sleep: a wait (tests pass their own). */
type Deps = { fetch?: Fetch; now?: () => number; clock?: () => number; sleep?: (ms: number) => Promise<void> };
/**
 * Which final is the move's H (markets.md check 10, "H is set by what a missed halt costs the move"): the lower of the
 * two providers' finals for withdrawals and A's delegates (a halt above it costs them no money), the higher for the
 * ids' deposit calls (a halt between the move and its resolve can strand USDC in the vault).
 */
export type HoldAt = "lower" | "higher";

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
export type Read = { block_height: number; block_hash?: string; halt: ViewOutcome; blocked?: ViewOutcome; code_hash?: string };

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
 * The answer from the two providers' reads of `token` at one block: both of one height and one hash. Caught up only
 * when both read the halt and the block at that block, agree on the code hash and it is the pin; then halted and
 * vault_blocked are either provider's. The code hash is shown whenever both read it at that block and agree; never more
 * than was read.
 */
export function statusFrom(a: Read | undefined, b: Read | undefined, token: string): TokenStatus {
  const one = a !== undefined && b !== undefined && a.block_height === b.block_height && a.block_hash !== undefined && a.block_hash === b.block_hash;
  const agreed = one && a.code_hash !== undefined && a.code_hash === b.code_hash;
  // each view's own block is H: an answer of another block says nothing of H
  const atH = (r: Read) => r.halt.at === r.block_height && r.blocked?.at === r.block_height;
  const halts = [haltOf(a?.halt), haltOf(b?.halt)];
  const blocks = [blockedOf(a?.blocked), blockedOf(b?.blocked)];
  const known = agreed && atH(a) && atH(b) && a.code_hash === USDC_CODE_HASH && !halts.includes(null) && !blocks.includes(null);
  return {
    token,
    caught_up: known,
    halted: known ? halts.includes(true) : null,
    vault_blocked: known ? blocks.includes(true) : null,
    code_hash_ok: known ? true : null,
    code_hash: agreed ? a.code_hash! : "",
    block_height: agreed ? a.block_height : 0,
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

/** A block header as both providers give it: its height, its hash, its parent's hash and its time in ms. */
type Head = { height: number; hash: string; prev_hash: string; ms: number };
function headOf(j: unknown): Head | undefined {
  const h = (j as { result?: { header?: { height?: unknown; hash?: unknown; prev_hash?: unknown; timestamp_nanosec?: unknown } } } | null)?.result?.header;
  if (h === undefined || h === null) return undefined;
  const { height, hash, prev_hash, timestamp_nanosec: ns } = h;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) return undefined;
  if (typeof hash !== "string" || !HASH.test(hash) || typeof prev_hash !== "string" || !HASH.test(prev_hash)) return undefined;
  if (typeof ns !== "string" || !/^\d{1,25}$/.test(ns)) return undefined;
  return { height, hash, prev_hash, ms: Number(BigInt(ns) / 1_000_000n) };
}

/** A query answer only when it is of block `hash` (and at `height` when given): a provider's answer of any other block is no answer. */
function ofBlock(j: unknown, hash: string, height?: number): unknown {
  const res = (j as { result?: { block_hash?: unknown; block_height?: unknown } } | null)?.result;
  return res?.block_hash === hash && (height === undefined || res?.block_height === height) ? j : undefined;
}

/** How long one 429 is waited out: its Retry-After in seconds when it gives one, never over BACKOFF_429_MS. */
export function backoffOf(retryAfter: string | null): number {
  const s = retryAfter !== null && /^\d{1,5}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) * 1_000 : BACKOFF_429_MS;
  return Math.min(s, BACKOFF_429_MS);
}

/** One network's watch: its own token (WATCHED) and the vault it carries (VAULT_ENV) read on its own pair. */
export function createTokenWatch(network: TokenNetwork, env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now; // the wall clock: only for H's age against its block time
  const clock = deps.clock ?? (() => performance.now()); // monotonic: the display's cache and the wait for H
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const urls = readUrls(env, network);
  const token = WATCHED[network].token;
  const vault = vaultOf(env, network);
  const notCaughtUp = statusFrom(undefined, undefined, token);
  const byBlock = new Map<string, TokenStatus>(); // a final block's status never changes: kept by its height and hash
  const pausedCache = new Map<bigint, boolean>(); // a known answer for a past height never changes
  const inflight = new Map<HoldAt, Promise<TokenStatus>>();
  let shown: { at: number; status: TokenStatus } | undefined;
  let showing: Promise<TokenStatus> | undefined;

  /**
   * One JSON-RPC call on one provider: its JSON answer, or undefined on any failure, any status but 200 or a large
   * answer. One 429 is waited out (its Retry-After, at most BACKOFF_429_MS) and the call made once more.
   */
  async function rpc(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    for (let tries = 0; ; tries++) {
      try {
        const r = await doFetch(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          redirect: "error",
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (r.status === 429 && tries === 0) {
          await r.body?.cancel();
          await sleep(backoffOf(r.headers.get("retry-after")));
          continue;
        }
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
  }
  const head = async (url: string, at: { finality: "final" } | { block_id: number }) => {
    const h = headOf(await rpc(url, "block", at));
    return h !== undefined && ("finality" in at || h.height === at.block_id) ? h : undefined;
  };
  /** A view of `token` at block `hash` (asked by `block_id`), its answer of that block only. */
  const view = async (url: string, method: string, account_id: string, block_id: number | string, hash: string, height?: number) =>
    viewOutcome(ofBlock(await rpc(url, "query", { request_type: "call_function", block_id, account_id: token, method_name: method, args_base64: Buffer.from(JSON.stringify({ account_id })).toString("base64") }), hash, height));
  /** The token's code hash at block `hash`, or undefined on any answer of the wrong shape or another block. */
  async function codeHash(url: string, block_id: number | string, hash: string, height?: number): Promise<string | undefined> {
    const j = ofBlock(await rpc(url, "query", { request_type: "view_account", block_id, account_id: token }), hash, height);
    const code_hash = (j as { result?: { code_hash?: unknown } } | undefined)?.result?.code_hash;
    return typeof code_hash === "string" && HASH.test(code_hash) ? code_hash : undefined;
  }

  /** One provider's read at block H: the halt, the vault's block and the code hash, each answered of that block. */
  async function read(url: string, h: Head): Promise<Read> {
    if (vault === undefined) {
      // no vault carried on this network: the code hash only, never caught up (nothing to carry, nothing to free)
      return { block_height: h.height, block_hash: h.hash, halt: { other: true }, code_hash: await codeHash(url, h.height, h.hash, h.height) };
    }
    const [halt, blocked, code_hash] = await Promise.all([view(url, "ft_balance_of", vault, h.height, h.hash, h.height), view(url, "is_blocklisted", vault, h.height, h.hash, h.height), codeHash(url, h.height, h.hash, h.height)]);
    return { block_height: h.height, block_hash: h.hash, halt, blocked, code_hash };
  }

  /** Whether `url`'s final reaches `height` within H_WAIT_MS on the monotonic clock (check 10's wait for H). */
  async function reaches(url: string, height: number): Promise<boolean> {
    const until = clock() + H_WAIT_MS;
    while (clock() < until) {
      await sleep(H_POLL_MS);
      const f = await head(url, { finality: "final" });
      if (f !== undefined && f.height >= height) return true;
    }
    return false;
  }

  /**
   * The status at the move's own H (markets.md check 10): the two providers' finals, at most HEIGHT_SPREAD_MAX apart,
   * one block where they meet; H the lower for a withdrawal, the higher for a deposit, its block at most
   * FINAL_AGE_MAX_MS behind the wall clock; then both providers' views at H, each answer of H's own hash.
   */
  async function readAt(at: HoldAt): Promise<TokenStatus> {
    const [fa, fb] = await Promise.all(urls.map((u) => head(u, { finality: "final" })));
    if (fa === undefined || fb === undefined) return notCaughtUp;
    if (Math.abs(fa.height - fb.height) > HEIGHT_SPREAD_MAX) return notCaughtUp;
    const h = (at === "lower") === fa.height <= fb.height ? fa : fb;
    if (now() - h.ms > FINAL_AGE_MAX_MS) return notCaughtUp; // two frozen providers never answer for now
    const key = `${h.height} ${h.hash}`;
    const kept = byBlock.get(key);
    if (kept !== undefined) return kept;
    const behind = [fa, fb].findIndex((f) => f.height < h.height);
    if (behind !== -1 && !(await reaches(urls[behind]!, h.height))) return notCaughtUp;
    const [a, b] = await Promise.all(urls.map((u) => read(u, h)));
    const s = statusFrom(a, b, token);
    if (s.caught_up) {
      byBlock.set(key, s);
      if (byBlock.size > BLOCKS_KEPT) byBlock.delete(byBlock.keys().next().value!);
    }
    return s;
  }

  /** The hold's read (H3.4 check 10, H4.3 step 9) at the move's H; one read per rule at a time. */
  function statusAt(at: HoldAt): Promise<TokenStatus> {
    let p = inflight.get(at);
    if (p === undefined) {
      p = readAt(at).finally(() => inflight.delete(at));
      inflight.set(at, p);
    }
    return p;
  }

  /** /v1/token-status (display only): the status at the lower final, read at most once per CACHE_MS of the monotonic clock. */
  function status(): Promise<TokenStatus> {
    if (shown && clock() - shown.at < CACHE_MS) return Promise.resolve(shown.status);
    if (!showing) {
      showing = statusAt("lower")
        .then((s) => {
          shown = { at: clock(), status: s };
          return s;
        })
        .finally(() => (showing = undefined));
    }
    return showing;
  }

  /** What a relayer calls before every send that H3.4 check 10 or H4.3 step 9 holds: true means send nothing. */
  async function held(at: HoldAt): Promise<boolean> {
    return tokenHeld(await statusAt(at));
  }

  /**
   * R3's exception for bind (bind/send.ts): was USDC paused at block `height`, by pausedFrom on both providers: block
   * `height`'s header on both (one hash, one parent), ft_balance_of at its parent (the state its receipts ran on; a
   * skipped height before it is no block) and at the block itself, with the pinned code at both; null when anything is
   * not known (header: the providers' kept blocks), and null is never kept.
   */
  async function pausedAt(height: bigint): Promise<boolean | null> {
    const known = pausedCache.get(height);
    if (known !== undefined) return known;
    if (vault === undefined || height < 2n || height > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const each = await Promise.all(
      urls.map(async (url) => {
        const h = await head(url, { block_id: Number(height) });
        if (h === undefined) return undefined;
        const [before, after, c0, c1] = await Promise.all([view(url, "ft_balance_of", vault, h.prev_hash, h.prev_hash), view(url, "ft_balance_of", vault, h.hash, h.hash, h.height), codeHash(url, h.prev_hash, h.prev_hash), codeHash(url, h.hash, h.hash, h.height)]);
        return { h, pair: [before, after] as const, pinned: c0 === USDC_CODE_HASH && c1 === USDC_CODE_HASH };
      }),
    );
    const [a, b] = each;
    if (a === undefined || b === undefined || a.h.hash !== b.h.hash || a.h.prev_hash !== b.h.prev_hash || !a.pinned || !b.pinned) return null;
    const p = pausedFrom(a.pair, b.pair);
    if (p !== null) pausedCache.set(height, p);
    return p;
  }

  return { network, token, vault, status, statusAt, held, pausedAt };
}

export type TokenWatch = ReturnType<typeof createTokenWatch>;
export type TokenWatches = Record<TokenNetwork, TokenWatch>;

/** Both networks' watches from the host's environment, each on its own pair. */
export function tokenWatchesFromEnv(env: Record<string, string | undefined>, deps: Deps = {}): TokenWatches {
  return { mainnet: createTokenWatch("mainnet", env, deps), testnet: createTokenWatch("testnet", env, deps) };
}

/** What the relayers take: each network's hold at the move's H, and only its own. */
export const statusesOf = (w: TokenWatches): Record<TokenNetwork, (at: HoldAt) => Promise<TokenStatus>> => ({ mainnet: w.mainnet.statusAt, testnet: w.testnet.statusAt });
