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
// H_WAIT_MS to reach it; H's block at most FINAL_AGE_MAX_MS behind the wall clock and neither final standing still for
// more than FINAL_AGE_MAX_MS of a monotonic clock, so two frozen providers never answer; each caller reads its own finals,
// and callers whose H is one block share one read of it):
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
// three tries; it costs a try, never money.
// A pending Pause multisig request counts as a halt (check 10, M:1388-1404; V:303, the M1 row V:1091; card
// helper-usdc-pending-pause). USDC (near-sdk-contract-tools 1.1 simple_multisig, read in the pinned wasm) exports no view
// of a request, and its storage (~am\x02 + the id as u32 LE) is refused to view_state by both providers
// (TOO_LARGE_CONTRACT_STATE, FastNEAR and dRPC, 2026-11-07). What both providers do answer, at H, by block_id:
//   - get_next_multisig_request_id: N, the next id (mainnet 218 at 222400000 on 2026-10-31 and at 223390532);
//   - approve_multisig_request({request_id}) run as a view: a stored request reaches the caller's id and stops with
//     ProhibitedInView predecessor_account_id; an id with no request (executed, removed or never made) stops first with
//     the pinned code's unwrap panic at src/fiat_token.rs:627:87 (both read on mainnet ids 46 and 86, 2026-11-07).
// MULTISIG_PIN is each network's N at a read where no id below it could be pending: an executed or removed request never
// comes back, and a stored one stays expired (validity 432000 s in the token's ~am\x01 config). Mainnet: N was 218 from
// 2026-10-31T09:08Z (FastNEAR's archive) on, so every id below it is over five days old (the newest stored, 189, was
// made 2024-11-05, rpc.intea.rs view_state); testnet: N is 4 and its one stored id, 3, is a role request, not a Pause
// (view_state on both testnet providers). An id at or above the pin that is stored is a request whose kind these reads
// cannot tell, so the deposit's hold ("higher", the ids' deposit calls: a deposit the vault refuses is lost if a Pause
// lands before its resolve) reads not caught up, until either both providers read it as no request
// at H (executed or removed: an executed Pause is the halt itself, read by ft_balance_of) or MULTISIG_VALIDITY_NS has
// passed since its first sight: the earliest H at which this watch read it stored on both, timed by H's block timestamp
// as both providers give it (one hash, one timestamp), never the server's clock. First sight is no earlier than the
// request's creation, and NEAR's block timestamps only rise, so any block after first sight + the validity runs the
// request as expired: it can never execute. The validity is the token's ~am\x01 config, 02 00008bd6e6880100: threshold 2,
// 432000000000000 ns (432000 s), the same bytes on mainnet (rpc.intea.rs view_state) and on both testnet providers.
// Done ids (no request, or expired) at the bottom move the watch's own floor up from the pin, never below it. The ids
// read at H are the window from the floor, at most NEW_REQUESTS_MAX: more new ids than that hold the deposit while the
// floor still climbs the done ones. A withdrawal ("lower") and the display are never held by a pending request (an
// executed Pause is the halt, which holds them); the base status and the request answer are kept by block apart. The
// floor and each first sight are kept in this process and in the helper's store (HELPER_STORE_DIR/token-watch,
// requests-<token>.json, store/durable.ts, beside the relayers' folders), the folder opened once per process; a store
// another process holds (a swap's handover) or no store at all keeps them in memory, joined with the store's record at
// its first successful open (the higher floor, each id's earlier first sight). A restart with no record holds again
// from its new first sight: the safe direction, it can only hold longer.
// The relayers' answer stays token_halted on the wire: the kit's refusal is exactly { error: { code } } and its codes
// are frozen (packages/kit/src/helper/v1.ts:73, :91), and the device retries token_halted (wallet deposit/bind.ts RETRY,
// withdraw/relay.ts AGAIN); the reason, the request ids and when each frees, goes to the helper's log.
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
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { openDurableDir, type DurableDir } from "../store/durable.ts";

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
const ANSWER_MAX = 4_096; // a view's or view_account's answer: about 300 B
// a block's answer lists one chunk header per shard: 19,180 B on mainnet and 13,207 B on testnet (both providers, read
// 2026-11-03), so a cap well above a growing shard count
const BLOCK_ANSWER_MAX = 1_048_576;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The kit's HelperTokenStatusAnswer (packages/kit/src/helper/v1.ts). */
export type TokenStatus = HelperTokenStatusAnswer;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** Where a watch keeps its Requests record: the text it saved last, or null; a load or save that throws keeps memory only. */
export type RequestStore = { load(): string | null; save(text: string): void };
/**
 * now: the wall clock, for H's age only; clock: a monotonic clock in ms; sleep: a wait (tests pass their own); store:
 * the Requests record's store (default: HELPER_STORE_DIR's token-watch folder, else none).
 */
type Deps = { fetch?: Fetch; now?: () => number; clock?: () => number; sleep?: (ms: number) => Promise<void>; store?: RequestStore | null };

/** The helper store's folder for the watches (store/durable.ts), opened once per process: a second open would drop the lock. */
const STORE_DIRS = new Map<string, DurableDir | null>();
/**
 * The Requests record in HELPER_STORE_DIR/token-watch, one file per token (its account id in the name), the folder
 * opened at the first load or save without waiting for its lock: held elsewhere (a handover's other process) or
 * failing, load and save throw, are retried at the next call, and the record stays in memory meanwhile. No
 * HELPER_STORE_DIR: null.
 */
export function storeOf(env: Record<string, string | undefined>, token: string): RequestStore | null {
  const root = env.HELPER_STORE_DIR ?? "";
  if (root === "") return null;
  const dir = join(root, "token-watch");
  const open = (): DurableDir | null => {
    if (!STORE_DIRS.get(dir)) {
      try {
        STORE_DIRS.set(dir, openDurableDir(dir, nodeFs, (d) => d, 0));
      } catch {
        STORE_DIRS.set(dir, null);
      }
    }
    return STORE_DIRS.get(dir) ?? null;
  };
  if (!/^[a-z\d]([a-z\d_-]*[a-z\d])?(\.[a-z\d]([a-z\d_-]*[a-z\d])?)*$/.test(token) || token.length > 64) throw new Error(`no record name for token ${token}`);
  const name = `requests-${token}.json`;
  const opened = (): DurableDir => {
    const d = open();
    if (d === null) throw new Error("the token-watch store is held by another process");
    return d;
  };
  return {
    load: () => opened().text(name),
    save: (text) => opened().replace(name, text),
  };
}
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

/**
 * Per token: the multisig request id below which no request can be pending (the header's MULTISIG_PIN). A token with no
 * pin is never caught up.
 */
export const MULTISIG_PIN: Readonly<Record<string, number>> = { [USDC]: 218, [TESTNET_TOKEN]: 4 };
/** The token's multisig validity (its ~am\x01 config, the header): a request this long past its first sight is expired. */
export const MULTISIG_VALIDITY_NS = 432_000_000_000_000n;
/** New request ids read at H at most (one view each on each provider); more holds. */
export const NEW_REQUESTS_MAX = 16;
/** The pinned code's panic for an id with no request, run as a view (src/fiat_token.rs:627:87). */
export const NO_REQUEST_PANIC = "panicked at 'called `Option::unwrap()` on a `None` value', src/fiat_token.rs:627:87";
/** A stored request, run as a view: the token reaches the caller's id, which a view may not read. */
const STORED_ERROR = 'wasm execution failed with error: HostError(ProhibitedInView { method_name: "predecessor_account_id" })';

/** USDC's own panic while it is halted (the wasm's data; bind/send.ts matches the same message on a failed receipt). */
export const PAUSED_PANIC = "FiatToken: paused";
/** Per network: where the watch finds the vault whose block it reads (the withdraw and bind senders' own names). */
export const VAULT_ENV = {
  mainnet: ["WITHDRAW_VAULT_MAINNET", "BIND_VAULT_MAINNET"],
  testnet: ["WITHDRAW_VAULT_TESTNET", "BIND_VAULT_TESTNET"],
} as const satisfies Record<TokenNetwork, readonly [string, string]>;

/** One view's outcome: a value's text, a panic's message, or neither (any other answer). */
export type ViewOutcome = { at: number; answer: string } | { at: number; panic: string } | { at?: undefined; other: true };
/** One approve_multisig_request view's outcome: a stored request, no request, or neither (any other answer). */
export type StoredOutcome = { at: number; stored: boolean } | { at?: undefined; other: true };
/** What one provider read at one block: the halt from ft_balance_of, the block from is_blocklisted, the code hash. */
export type Read = { block_height: number; block_hash?: string; halt: ViewOutcome; blocked?: ViewOutcome; code_hash?: string };
/** What one provider read of USDC's requests at one block: the next request id, and from the floor up whether each id is stored. */
export type RequestRead = { block_height: number; next?: ViewOutcome; stored?: readonly StoredOutcome[] };

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

/** The next request id as one get_next_multisig_request_id outcome says it: a u32's digits, else null. */
export function nextIdOf(o: ViewOutcome | undefined): number | null {
  if (o === undefined || !("answer" in o) || !/^(0|[1-9]\d{0,9})$/.test(o.answer)) return null;
  const n = Number(o.answer);
  return n <= 0xffff_ffff ? n : null;
}

/** One approve_multisig_request view's outcome from a provider's JSON answer: exactly one of the two errors, else other. */
export function storedOutcome(j: unknown): StoredOutcome {
  const res = (j as { result?: { error?: unknown; block_height?: unknown } } | null)?.result;
  const at = res?.block_height;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return { other: true };
  if (res!.error === STORED_ERROR) return { at, stored: true };
  const o = viewOutcome(j);
  return "panic" in o && o.panic === NO_REQUEST_PANIC ? { at, stored: false } : { other: true };
}

/** The watch's record of USDC's new requests: its floor (never below the pin) and each stored id's first sight in ns. */
export type Requests = { floor: number; seen: Readonly<Record<string, string>> };
/** What one H's request reads say: free when no request at or above the floor may be pending; the record after them. */
export type RequestsRead = { free: boolean; rec: Requests; held: { id: number; frees: bigint }[] };

/**
 * USDC's new requests at H from both providers' reads of that block (`a.stored[i]`, `b.stored[i]`: id `from` + i) and
 * H's timestamp in ns as both providers give it (null: not read, or the two differ). The ids read are the window from
 * the floor, at most NEW_REQUESTS_MAX of them. Free only when both read one N at H, N is at least the floor and at most
 * NEW_REQUESTS_MAX above it, and every id from the floor up to N is done on both: no request, or stored and
 * MULTISIG_VALIDITY_NS past its first sight. A stored id gets its first sight at the earliest H read; the floor moves up
 * over the done ids at the window's bottom, so more than NEW_REQUESTS_MAX new ids hold while the floor still climbs
 * them. Anything unread or disagreeing is not free.
 */
export function requestsAt(a: RequestRead, b: RequestRead, from: number, rec: Requests, hNs: bigint | null): RequestsRead {
  const na = a.next?.at === a.block_height ? nextIdOf(a.next) : null;
  const nb = b.next?.at === b.block_height ? nextIdOf(b.next) : null;
  if (na === null || na !== nb || na < rec.floor) return { free: false, rec, held: [] };
  const top = Math.min(na, rec.floor + NEW_REQUESTS_MAX);
  const seen: Record<string, string> = { ...rec.seen };
  const done = new Set<number>();
  const held: { id: number; frees: bigint }[] = [];
  let known = true;
  for (let id = rec.floor; id < top; id++) {
    const [x, y] = id < from ? [undefined, undefined] : [a.stored?.[id - from], b.stored?.[id - from]];
    if (x === undefined || y === undefined || !("stored" in x) || !("stored" in y) || x.at !== a.block_height || y.at !== b.block_height || x.stored !== y.stored) {
      known = false;
      continue;
    }
    if (!x.stored) {
      done.add(id);
      continue;
    }
    if (hNs === null) {
      known = false;
      continue;
    }
    const kept = seen[id];
    const was = kept === undefined ? undefined : BigInt(kept);
    const first = was === undefined || hNs < was ? hNs : was;
    seen[id] = first.toString();
    if (hNs - first >= MULTISIG_VALIDITY_NS) done.add(id);
    else held.push({ id, frees: first + MULTISIG_VALIDITY_NS });
  }
  let floor = rec.floor;
  while (done.has(floor)) floor++;
  for (const k of Object.keys(seen)) if (Number(k) < floor) delete seen[k];
  return { free: known && held.length === 0 && na - rec.floor <= NEW_REQUESTS_MAX, rec: { floor, seen }, held };
}

/**
 * Two records of one token joined (the memory's and the store's at its first successful open): the higher floor (ids
 * below a floor are done for good) and each id's earlier first sight (any first sight is no earlier than its creation).
 */
export function mergeRequests(a: Requests | undefined, b: Requests | null): Requests | undefined {
  if (a === undefined || b === null) return a ?? b ?? undefined;
  const floor = Math.max(a.floor, b.floor);
  const seen: Record<string, string> = {};
  for (const r of [a, b])
    for (const [k, v] of Object.entries(r.seen)) {
      if (Number(k) < floor) continue;
      const was = seen[k];
      seen[k] = was === undefined || BigInt(v) < BigInt(was) ? v : was;
    }
  return { floor, seen };
}

/** A record read back from the store: a floor at or above the pin and first sights in ns, else null (start from the pin). */
export function requestsOf(text: string | null, pin: number): Requests | null {
  let j: unknown;
  try {
    j = text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
  const r = j as { floor?: unknown; seen?: unknown } | null;
  if (r === null || typeof r !== "object" || !Number.isSafeInteger(r.floor) || (r.floor as number) < pin || r.seen === null || typeof r.seen !== "object") return null;
  const seen: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.seen as Record<string, unknown>)) {
    if (!/^(0|[1-9]\d{0,9})$/.test(k) || typeof v !== "string" || !/^[1-9]\d{0,24}$/.test(v)) return null;
    seen[k] = v;
  }
  return { floor: r.floor as number, seen };
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

/** A block header as both providers give it: its height, its hash, its parent's hash and its time in ms and in ns. */
type Head = { height: number; hash: string; prev_hash: string; ms: number; ns: bigint };
function headOf(j: unknown): Head | undefined {
  const h = (j as { result?: { header?: { height?: unknown; hash?: unknown; prev_hash?: unknown; timestamp_nanosec?: unknown } } } | null)?.result?.header;
  if (h === undefined || h === null) return undefined;
  const { height, hash, prev_hash, timestamp_nanosec: ns } = h;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) return undefined;
  if (typeof hash !== "string" || !HASH.test(hash) || typeof prev_hash !== "string" || !HASH.test(prev_hash)) return undefined;
  if (typeof ns !== "string" || !/^\d{1,25}$/.test(ns)) return undefined;
  return { height, hash, prev_hash, ms: Number(BigInt(ns) / 1_000_000n), ns: BigInt(ns) };
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
  const pin = MULTISIG_PIN[token];
  const store = deps.store === undefined ? storeOf(env, token) : deps.store;
  let requests: Requests | undefined; // the record: the memory's, joined with the store's at its first successful open
  let synced = store === null; // the store's record joined in (or no store)
  const notCaughtUp = statusFrom(undefined, undefined, token);
  const byBlock = new Map<string, TokenStatus>(); // a final block's status never changes: kept by its height and hash
  const pausedCache = new Map<bigint, boolean>(); // a known answer for a past height never changes
  const inflight = new Map<string, Promise<TokenStatus>>(); // one read of a block's views at a time, by its height and hash
  const freeBlocks = new Set<string>(); // blocks whose request read was free: that answer never changes
  const freeing = new Map<string, Promise<boolean>>(); // one request read of a block at a time
  const moved = new Map<string, { height: number; since: number }>(); // each provider's final and when it last moved (monotonic)
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
        // read up to the method's cap, never more: a provider is an outside input
        const max = method === "block" ? BLOCK_ANSWER_MAX : ANSWER_MAX;
        const chunks: Uint8Array[] = [];
        let n = 0;
        for await (const c of r.body) {
          n += c.byteLength;
          if (n > max) return undefined;
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
  /** A call_function of `token` at block `hash` (asked by `block_id`) with `args`, its JSON answer of that block only. */
  const call = async (url: string, method: string, args: Record<string, unknown>, block_id: number | string, hash: string, height?: number) =>
    ofBlock(await rpc(url, "query", { request_type: "call_function", block_id, account_id: token, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }), hash, height);
  /** A view of `token` taking `account_id` at block `hash` (asked by `block_id`), its answer of that block only. */
  const view = async (url: string, method: string, account_id: string, block_id: number | string, hash: string, height?: number) => viewOutcome(await call(url, method, { account_id }, block_id, hash, height));
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

  /** Whether each id from `pin` up to `n` holds a stored request at block H on `url` (one view each, all at once). */
  const storedAt = (url: string, h: Head, pin: number, n: number): Promise<StoredOutcome[]> =>
    Promise.all(Array.from({ length: n - pin }, (_, i) => call(url, "approve_multisig_request", { request_id: pin + i }, h.height, h.hash, h.height).then(storedOutcome)));

  /** Keeps `r` as the record and saves it; a save that fails keeps it in memory (a restart then holds longer, never less). */
  function keep(r: Requests): void {
    requests = r;
    try {
      store?.save(JSON.stringify(r));
    } catch {
      // kept in memory: a restart without it holds again from its new first sight
    }
  }

  /**
   * The record: the memory's, joined at the store's first successful open with the store's (mergeRequests; a floor below
   * the pin or a bad file counts as none) and saved back when the memory added to it; else the pin's.
   */
  function record(): Requests {
    if (!synced) {
      try {
        const disk = requestsOf(store!.load(), pin!);
        synced = true;
        const joined = mergeRequests(requests, disk);
        if (joined !== undefined && JSON.stringify(joined) !== JSON.stringify(disk)) keep(joined);
        else requests = joined;
      } catch {
        // the store not open (held elsewhere, or failing): memory only until a later call opens it
      }
    }
    return (requests ??= { floor: pin!, seen: {} });
  }

  /**
   * Whether no USDC request may be pending at H (requestsAt): N at H on both providers, then the window of ids from the
   * floor (at most NEW_REQUESTS_MAX) when both name one N above the floor; H's timestamp read on both (one hash, one
   * timestamp) only when an id is stored. The record after it is kept, and saved when it changed.
   */
  async function requestsFree(h: Head): Promise<boolean> {
    if (pin === undefined || vault === undefined) return false;
    const from = record().floor;
    const [a, b]: [RequestRead, RequestRead] = await Promise.all(
      [urls[0], urls[1]].map(async (u) => ({ block_height: h.height, next: viewOutcome(await call(u, "get_next_multisig_request_id", {}, h.height, h.hash, h.height)) })) as [Promise<RequestRead>, Promise<RequestRead>],
    );
    const n = nextIdOf(a.next);
    let hNs: bigint | null = null;
    if (n !== null && n === nextIdOf(b.next) && n > from) {
      const top = Math.min(n, from + NEW_REQUESTS_MAX);
      const [sa, sb] = await Promise.all([storedAt(urls[0], h, from, top), storedAt(urls[1], h, from, top)]);
      a.stored = sa;
      b.stored = sb;
      if ([...sa, ...sb].some((x) => "stored" in x && x.stored)) {
        const [ta, tb] = await Promise.all(urls.map((u) => head(u, { block_id: h.height })));
        hNs = ta !== undefined && tb !== undefined && ta.hash === h.hash && tb.hash === h.hash && ta.ns === tb.ns ? ta.ns : null;
      }
    }
    // the record as it stands now (another block's read may have moved it while this one waited), never an older one
    const before = record();
    const r = requestsAt(a, b, from, before, hNs);
    if (JSON.stringify(r.rec) !== JSON.stringify(before)) keep(r.rec);
    if (r.held.length > 0) console.error(`token-watch ${network}: held: multisig request ${r.held.map((x) => `${x.id} stored, frees at ${new Date(Number(x.frees / 1_000_000n)).toISOString()}`).join("; ")} (block ${h.height})`);
    return r.free;
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
  /** Whether `url`'s final has stood still for over FINAL_AGE_MAX_MS of the monotonic clock: a frozen provider. */
  function frozen(url: string, f: Head): boolean {
    const t = clock();
    const was = moved.get(url);
    if (was === undefined || f.height > was.height) {
      moved.set(url, { height: f.height, since: t });
      return false;
    }
    return t - was.since > FINAL_AGE_MAX_MS;
  }

  async function readAt(at: HoldAt): Promise<[TokenStatus, Head?]> {
    // each caller reads its own finals, so its H is the move's own
    const [fa, fb] = await Promise.all(urls.map((u) => head(u, { finality: "final" })));
    if (fa === undefined || fb === undefined) return [notCaughtUp];
    if (Math.abs(fa.height - fb.height) > HEIGHT_SPREAD_MAX) return [notCaughtUp];
    const h = (at === "lower") === fa.height <= fb.height ? fa : fb;
    // two frozen providers never answer for now: H's block time on the wall clock, and each final's last move on the
    // monotonic clock (a wall clock stepped back hides a stale block time); both before any kept answer
    const still = [frozen(urls[0], fa), frozen(urls[1], fb)];
    if (now() - h.ms > FINAL_AGE_MAX_MS || still.includes(true)) return [notCaughtUp];
    const key = `${h.height} ${h.hash}`;
    const kept = byBlock.get(key);
    if (kept !== undefined) return [kept, h];
    // one read of H's block at a time, whichever rule named it
    let p = inflight.get(key);
    if (p === undefined) {
      p = readBlock(h, [fa, fb]).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return [await p, h];
  }

  /** Whether no request may be pending at block `h` (requestsFree), one read of a block at a time; a free answer kept. */
  async function freeAt(h: Head): Promise<boolean> {
    const key = `${h.height} ${h.hash}`;
    if (freeBlocks.has(key)) return true;
    let p = freeing.get(key);
    if (p === undefined) {
      p = requestsFree(h).finally(() => freeing.delete(key));
      freeing.set(key, p);
    }
    const free = await p;
    if (free) {
      freeBlocks.add(key);
      if (freeBlocks.size > BLOCKS_KEPT) freeBlocks.delete(freeBlocks.values().next().value!);
    }
    return free;
  }

  /** Both providers' views at block `h`, a provider whose final is below it given H_WAIT_MS to reach it; kept when caught up. */
  async function readBlock(h: Head, finals: readonly [Head, Head]): Promise<TokenStatus> {
    const behind = finals.findIndex((f) => f.height < h.height);
    if (behind !== -1 && !(await reaches(urls[behind]!, h.height))) return notCaughtUp;
    const [a, b] = await Promise.all([read(urls[0], h), read(urls[1], h)]);
    const s = statusFrom(a, b, token);
    if (s.caught_up) {
      byBlock.set(`${h.height} ${h.hash}`, s);
      if (byBlock.size > BLOCKS_KEPT) byBlock.delete(byBlock.keys().next().value!);
    }
    return s;
  }

  /**
   * The hold's read (H3.4 check 10, H4.3 step 9) at the move's own H: its own finals, a read of H's block shared. The
   * request hold gates only "higher", the ids' deposit calls (V:303, M1): a deposit the vault refuses is lost if a Pause
   * lands before its resolve. A withdrawal ("lower") and the display are never held by a pending request: an executed
   * Pause is the halt itself, which holds them as before. A deposit with a request that may be pending reads as not
   * caught up (the kit's rule: halted, vault_blocked and code_hash_ok null).
   */
  async function statusAt(at: HoldAt): Promise<TokenStatus> {
    const [s, h] = await readAt(at);
    if (at === "lower" || !s.caught_up || h === undefined) return s;
    return (await freeAt(h)) ? s : { ...notCaughtUp, code_hash: s.code_hash, block_height: s.block_height };
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
