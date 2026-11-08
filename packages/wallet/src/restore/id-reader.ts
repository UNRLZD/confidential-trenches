// The restore's IdReader on NEAR (card wallet-restore-id-reader; docs/plan1/wallet.md §2.3 "Restore" step 5, l.297-303,
// and its cost, l.312-324). What one deposit id U (a NEAR implicit account, U_{s,i}) shows, from public views only:
//
// - "money": U holds the vault's asset on the token (ft_balance_of(U) > 0; 1Click delivers to U's own NEAR account,
//   §2.4 step 5) or any token inside intents.near (mt_tokens_for_owner(U) lists one and mt_batch_balance_of shows it
//   above 0; D45).
// - "used": U holds nothing now, and a lasting public trace shows it was used:
//   - storage_balance_of(U) on the token is not null: a never-used implicit id has no storage there (D16), and 1Click's
//     delivery registers U (its ft_withdraw with storage_deposit, D12). Read on mainnet USDC at block 223638277:
//     9c484fa5…21c5c1 answers {"total":"1250000000000000000000","available":"0"} with ft_balance_of "0" (used, empty);
//     abab…ab answers null at block 223638170 (never used).
//   - view_account(U) answers an account: U was created (the relayer's prepay Transfer, §2.4). Read at block 223638199:
//     a8969c04…f264e4 answers {"amount":"20000000000000000000000","storage_usage":428} with storage null and no token
//     in intents.near; abab…ab answers UNKNOWN_ACCOUNT at block 223638171.
//   Not a trace: has_public_key(U, U's key) is true for every implicit id, used or not (D15), and intents.near's nonces
//   are pruned (below), so neither is read.
// - Both providers are read and the stronger answer is taken: money over used over unused (review F1). A provider that
//   hides money (answering used) or a trace (answering unused) is outvoted by the other; only money on the first one
//   read ends the id's read early, as no answer is stronger. A false money or used only reads the lane further
//   (bounded by step 5's walk end). A listed intents.near token at 0 is no trace: intents.near at 16d04f6 deletes a
//   balance that falls to 0 (core/src/amounts.rs:137-140, its entry_or_default; crates/map-utils/src/cleanup.rs:19-20).
// - One block for the whole restore pass (review F6, N1 and its fold): openRestorePass reads both providers' final
//   blocks (view_account of intents.near). Over VAULT_SYNC_LAG_MAX (120) blocks apart refuses the pass at once; the
//   floor is the HIGHER of the two, and the provider behind is re-read until its final reaches it (PASS_TRIES reads,
//   PASS_WAIT_MS apart), or the pass is refused ("the RPCs' finals did not meet"). The floor block's hash is then read
//   on both by its height, and the two must agree. Every view of every id, on both providers, reads at that hash
//   (block_id) and must answer from that block, so money moving between two views never reads as used, and no single
//   provider picks the block: a low final changes nothing (the floor is the higher), a high one the other cannot reach
//   refuses the pass (a stop, never a wrong answer), and a fake hash fails the agreement. Money that lands after the
//   pinned block is step 7's 72-h re-reads' (./wallets.ts afterRestore), as anything after the restore.
// - A pass is used only while fresh and only on the providers it was opened on (review P1, P2): building a reader reads
//   both finals once and refuses a pass more than VAULT_SYNC_LAG_MAX below the lower of them; a scan that exists to see
//   money after a height opens its own pass above it (openRereadPass, arms.ts openSecondScanPass); and the pass keeps
//   its two provider objects, matched by identity, never by name.
// - An indexer (NearBlocks, the intents explorer) is a server's word: it may turn an id both providers see as unused
//   into "used" (`indexer` answers true), never anything into "unused"; a failed or false answer changes nothing.
//
// The trace this cannot see (review 2, gap 1): an id whose whole life was inside intents.near (a refunded quote moved
// out by an intent to a pool wallet or by withdraw.open) leaves no storage on the token and no NEAR account. Its
// intents' nonces do not last: intents.near runs near/intents 16d04f6 (contract_source_metadata, block 223637676),
// whose cleanup_nonces prunes a V1 versioned nonce once its deadline is past or its salt is no longer valid
// (contracts/defuse/src/contract/garbage_collector.rs:9-43, is_nonce_cleanable l.32-42), by the DAO or the
// GarbageCollector role; a legacy (unversioned) nonce is never cleaned (l.33-35), but "Legacy nonces can still be used
// at this time, but will be prohibited out in the near future" (core/src/nonce/versioned.rs:20). So a seed-derived
// nonce read back by is_nonce_used is no lasting proof. Such an id reads "unused" here unless the indexer says used;
// its money is still under the 12 words.
//
// Failures (review 2, gap 2): every view is retried on its provider with doubling backoff (ID_READ_TRIES, from
// ID_READ_BACKOFF_MS) before that provider's read of the id fails (a provider a block behind catches up in that time).
// Unless one provider shows money, both must answer: an id whose reads still fail on either throws, and step 5 counts
// it as failed (restoreDepositIds), so one provider always down ends a lane with its named error, never with an
// answer taken on one provider's word. A view that fails with "FiatToken: paused" is a halt, never a zero: it
// fails the read, to be read again.
//
// Each request names U or the token and nothing else (§2.9 row 8); the provider read first is drawn at random per id,
// so the reads spread over both operators (l.322-324). Nothing here logs.
import { VAULT_SYNC_LAG_MAX } from "@blindfill/kit";
import { base64 } from "@scure/base";
import { NEAR_NETWORKS, nearPairNetwork, nearPairRule, type NearNetwork, type NearRpc } from "../deposit/account.ts";
import type { IdReader, IdState } from "./wallets.ts";

export const INTENTS = "intents.near";
/** Tries of one view on one provider before that provider's read fails. */
export const ID_READ_TRIES = 4;
/** The wait before a view's second try; it doubles on each try after. */
export const ID_READ_BACKOFF_MS = 250;
const HALT = "FiatToken: paused";
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
// a block hash: 32 bytes in base58 (43 or 44 characters)
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const sleepMs = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const randomBit = (): number => globalThis.crypto.getRandomValues(new Uint8Array(1))[0]! & 1;

/** A server's word that an id was used: true says used; false or a throw says nothing. */
export type IdIndexer = (id: string) => Promise<boolean>;
export type IdReaderOpts = { tries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void>; first?: () => number; indexer?: IdIndexer };
/** Reads of the provider behind before the pass is refused, and the wait between two of them (about 10 s in all). */
export const PASS_TRIES = 10;
export const PASS_WAIT_MS = 1_000;

type Block = { h: number; hash: string };
/** The block a view is asked at: the final one, one by its height (the floor's hash), or the pass's block by its hash. */
type Ask = "final" | { height: number } | Block;
/** The restore pass's one block, read and agreed on both providers by openRestorePass; only its own are taken. */
export type RestorePass = { readonly network: NearNetwork; readonly rpcs: readonly [string, string]; readonly h: number; readonly hash: string };
// each pass openRestorePass opened, with the two provider objects it was opened on (matched by identity, review P2)
const PASSES = new WeakMap<RestorePass, readonly [NearRpc, NearRpc]>();

/** The view's answer and its block, or null for an account the provider says does not exist (view_account only). */
async function view(rpc: NearRpc, params: Obj, what: string, ask: Ask): Promise<{ v: unknown; b: Block | null }> {
  const a = await rpc.query(ask === "final" ? { ...params, finality: "final" } : { ...params, block_id: "hash" in ask ? ask.hash : ask.height });
  if (!isObj(a)) throw new Error(`${rpc.name}: ${what}: not a JSON-RPC answer`);
  const text = JSON.stringify(a.error ?? (isObj(a.result) ? a.result.error : undefined) ?? "");
  if (text.includes(HALT)) throw new Error(`${rpc.name}: ${what}: the token is halted (${HALT})`);
  if (a.error !== undefined) {
    const cause = isObj(a.error) && isObj(a.error.cause) ? a.error.cause.name : undefined;
    if (params.request_type === "view_account" && cause === "UNKNOWN_ACCOUNT") return { v: null, b: null };
    throw new Error(`${rpc.name}: ${what}: ${String(isObj(a.error) ? (a.error.name ?? a.error.message) : "an error")}`.slice(0, 200));
  }
  const r = a.result;
  if (!isObj(r) || r.error !== undefined || !Number.isSafeInteger(r.block_height) || (r.block_height as number) <= 0 || typeof r.block_hash !== "string" || !HASH.test(r.block_hash))
    throw new Error(`${rpc.name}: ${what}: not a view result`);
  const b: Block = { h: r.block_height as number, hash: r.block_hash };
  if (ask !== "final" && ("hash" in ask ? b.hash !== ask.hash || b.h !== ask.h : b.h !== ask.height))
    throw new Error(`${rpc.name}: ${what}: answered at block ${b.h} ${b.hash}, not ${"hash" in ask ? `${ask.h} ${ask.hash}` : ask.height}`);
  if (params.request_type === "view_account") {
    if (typeof r.amount !== "string" || !DIGITS.test(r.amount)) throw new Error(`${rpc.name}: ${what}: not an account`);
    return { v: r, b };
  }
  const bytes = r.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error(`${rpc.name}: ${what}: no result bytes`);
  try {
    return { v: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes as number[]))), b };
  } catch {
    throw new Error(`${rpc.name}: ${what}: the result is not JSON`);
  }
}

const call = (account: string, method: string, args: Obj): Obj => ({
  request_type: "call_function",
  account_id: account,
  method_name: method,
  args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
});
const amount = (x: unknown, what: string): bigint => {
  if (typeof x !== "string" || !DIGITS.test(x)) throw new Error(`${what}: not a decimal string`);
  return BigInt(x);
};

// the pair's checks, the network's token and one view on one provider retried with doubling backoff
function setup(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], opts: IdReaderOpts) {
  if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new Error(`unknown network ${String(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new Error(nearPairRule(network));
  const token = NEAR_NETWORKS[network].usdc;
  const tries = opts.tries ?? ID_READ_TRIES;
  const backoff = opts.backoffMs ?? ID_READ_BACKOFF_MS;
  if (!Number.isSafeInteger(tries) || tries < 1) throw new Error("tries is a count above 0");
  if (!Number.isSafeInteger(backoff) || backoff < 0) throw new Error("backoffMs is a time in ms");
  const sleep = opts.sleep ?? sleepMs;
  const first = opts.first ?? randomBit;

  // one view on one provider, retried with doubling backoff; the last failure is its error
  const retried = async (rpc: NearRpc, params: Obj, what: string, ask: Ask): Promise<{ v: unknown; b: Block | null }> => {
    for (let k = 0; ; k++) {
      try {
        return await view(rpc, params, what, ask);
      } catch (e) {
        if (k + 1 >= tries) throw e;
        await sleep(backoff * 2 ** k);
      }
    }
  };
  // one provider's block for a view of intents.near's account (the pass's finals and its block)
  const blockOf = async (rpc: NearRpc, ask: Ask, what: string): Promise<Block> => {
    const { b } = await retried(rpc, INTENTS_ACCOUNT, what, ask);
    if (b === null) throw new Error(`${rpc.name}: ${what}: no block`);
    return b;
  };
  return { token, retried, first, sleep, blockOf };
}
type Retried = (rpc: NearRpc, params: Obj, what: string, ask: Ask) => Promise<{ v: unknown; b: Block | null }>;
const INTENTS_ACCOUNT: Obj = { request_type: "view_account", account_id: INTENTS };

/**
 * Opens the restore pass (review N1's fold): both providers' finals within VAULT_SYNC_LAG_MAX, the provider behind
 * re-read until it reaches the higher (PASS_TRIES reads, PASS_WAIT_MS apart), and that block's hash read on both by its
 * height and agreed. Every id and balance read of the pass is at that block. `after`: a pass whose block is not above
 * it is refused (a scan that exists to see money after a height: openRereadPass, arms.ts openSecondScanPass; review
 * P1). Refused by name otherwise; a bad network, pair or option throws at once.
 */
export type PassOpts = Omit<IdReaderOpts, "indexer" | "first"> & { passTries?: number; passWaitMs?: number; after?: number };
export function openRestorePass(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], opts: PassOpts = {}): Promise<RestorePass> {
  const { sleep, blockOf } = setup(network, rpcs, opts);
  if (opts.after !== undefined && (!Number.isSafeInteger(opts.after) || opts.after < 0)) throw new Error("after is a block height");
  const passTries = opts.passTries ?? PASS_TRIES;
  const passWait = opts.passWaitMs ?? PASS_WAIT_MS;
  if (!Number.isSafeInteger(passTries) || passTries < 1) throw new Error("passTries is a count above 0");
  if (!Number.isSafeInteger(passWait) || passWait < 0) throw new Error("passWaitMs is a time in ms");
  const at = (k: number, ask: Ask, what: string): Promise<Block> => blockOf(rpcs[k]!, ask, what);
  return (async () => {
    const fin = await Promise.all([at(0, "final", "the pass's final"), at(1, "final", "the pass's final")]);
    if (Math.abs(fin[0].h - fin[1].h) > VAULT_SYNC_LAG_MAX) throw new Error(`the RPCs' final heights ${fin[0].h} and ${fin[1].h} are over ${VAULT_SYNC_LAG_MAX} blocks apart; the restore does not start`);
    const floor = Math.max(fin[0].h, fin[1].h);
    const behind = fin[0].h < floor ? 0 : 1;
    for (let k = 0; fin[behind]!.h < floor; k++) {
      if (k >= passTries) throw new Error(`the RPCs' finals did not meet; the restore does not start (${rpcs[behind]!.name} at ${fin[behind]!.h}, the other at ${floor})`);
      await sleep(passWait);
      fin[behind] = await at(behind, "final", "the pass's final");
    }
    const [x, y] = await Promise.all([at(0, { height: floor }, "the pass's block"), at(1, { height: floor }, "the pass's block")]);
    if (x.hash !== y.hash) throw new Error(`the RPCs' blocks at ${floor} differ (${x.hash}, ${y.hash}); the restore does not start`);
    if (opts.after !== undefined && floor <= opts.after) throw new Error(`the pass at block ${floor} is not past block ${opts.after}; read again once the chain is past it`);
    const pass: RestorePass = Object.freeze({ network, rpcs: Object.freeze([rpcs[0].name, rpcs[1].name]) as readonly [string, string], h: floor, hash: x.hash });
    PASSES.set(pass, rpcs);
    return pass;
  })();
}

/** A pass for the open's step 7 re-reads (./wallets.ts afterRestore): they exist to see money after the restore's pass. */
export function openRereadPass(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], restored: RestorePass, opts: Omit<PassOpts, "after"> = {}): Promise<RestorePass> {
  if (!PASSES.has(restored)) throw new Error("the pass is not one openRestorePass opened");
  return openRestorePass(network, rpcs, { ...opts, after: restored.h });
}

// a pass openRestorePass gave, on this network and these very providers (review P2: by identity, never by name)
function pinOf(pass: RestorePass, network: NearNetwork, rpcs: readonly [NearRpc, NearRpc]): Block {
  const own = PASSES.get(pass);
  if (own === undefined) throw new Error("the pass is not one openRestorePass opened");
  if (pass.network !== network || own[0] !== rpcs[0] || own[1] !== rpcs[1]) throw new Error("the pass was opened on other RPCs");
  return { h: pass.h, hash: pass.hash };
}

// review P1: a reader is built on a pass only while it is fresh: its block no more than VAULT_SYNC_LAG_MAX below the
// lower of both providers' finals now. An old pass reads a chain from before money landed, and nothing errors until
// the providers drop its block.
async function fresh(pass: RestorePass, rpcs: readonly [NearRpc, NearRpc], blockOf: (rpc: NearRpc, ask: Ask, what: string) => Promise<Block>): Promise<void> {
  const [a, b] = await Promise.all([blockOf(rpcs[0], "final", "the reader's final"), blockOf(rpcs[1], "final", "the reader's final")]);
  if (pass.h < Math.min(a.h, b.h) - VAULT_SYNC_LAG_MAX)
    throw new Error(`the pass at block ${pass.h} is stale: the RPCs' finals are at ${a.h} and ${b.h}, over ${VAULT_SYNC_LAG_MAX} blocks past it; open a fresh pass`);
}

/**
 * The IdReader of step 5 on the network's token and intents.near, through one FastNEAR RPC and the dRPC RPC of that
 * network (nearPairNetwork), in either order, every view at the pass's block (openRestorePass).
 */
export function nearIdReader(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], pass: RestorePass, opts: IdReaderOpts = {}): Promise<IdReader> {
  const { token, retried, first, blockOf } = setup(network, rpcs, opts);
  const at = pinOf(pass, network, rpcs);

  // the strongest answer one provider gives of U at the pass's block
  const readOn = async (rpc: NearRpc, u: string): Promise<IdState> => {
    const storage = (await retried(rpc, call(token, "storage_balance_of", { account_id: u }), "storage_balance_of", at)).v;
    if (storage !== null && !(isObj(storage) && typeof storage.total === "string" && DIGITS.test(storage.total))) throw new Error(`${rpc.name}: storage_balance_of: neither null nor a balance`);
    // an account with no storage on the token holds none of it (NEP-145): the balance is read only when registered
    if (storage !== null && amount((await retried(rpc, call(token, "ft_balance_of", { account_id: u }), "ft_balance_of", at)).v, `${rpc.name}: ft_balance_of`) > 0n) return "money";
    if ((await intentsSum(retried, rpc, u, at)) > 0n) return "money";
    if (storage !== null) return "used";
    return (await retried(rpc, { request_type: "view_account", account_id: u }, "view_account", at)).v === null ? "unused" : "used";
  };
  const RANK: Record<IdState, number> = { unused: 0, used: 1, money: 2 };

  return fresh(pass, rpcs, blockOf).then((): IdReader => async (u: string): Promise<IdState> => {
    if (typeof u !== "string" || !HEX64.test(u)) throw new Error("an id is a 64-hex implicit account id");
    const a = first() === 0 ? 0 : 1;
    const got: (IdState | Error)[] = [];
    for (const p of [a, 1 - a]) {
      try {
        const x = await readOn(rpcs[p]!, u);
        if (x === "money") return x; // nothing is stronger
        got.push(x);
      } catch (e) {
        got.push(e instanceof Error ? e : new Error("the read failed"));
      }
    }
    // no money on either: both must have answered, and the stronger answer is taken
    const failed = got.find((x): x is Error => x instanceof Error);
    if (failed) throw failed;
    const state = (got as IdState[]).reduce((x, y) => (RANK[y] > RANK[x] ? y : x));
    if (state === "unused" && opts.indexer) {
      try {
        if ((await opts.indexer(u)) === true) return "used";
      } catch {
        // a server's silence proves nothing
      }
    }
    return state;
  });
}

/** What intents.near holds for an account at the pass's block: the sum of its listed tokens (0 when none is listed). */
async function intentsSum(retried: Retried, rpc: NearRpc, a: string, at: Block): Promise<bigint> {
  const listed = (await retried(rpc, call(INTENTS, "mt_tokens_for_owner", { account_id: a }), "mt_tokens_for_owner", at)).v;
  if (!Array.isArray(listed) || !listed.every((t) => isObj(t) && typeof t.token_id === "string" && t.token_id !== "")) throw new Error(`${rpc.name}: mt_tokens_for_owner: not a token list`);
  if (listed.length === 0) return 0n;
  const ids = listed.map((t) => (t as { token_id: string }).token_id);
  const held = (await retried(rpc, call(INTENTS, "mt_batch_balance_of", { account_id: a, token_ids: ids }), "mt_batch_balance_of", at)).v;
  if (!Array.isArray(held) || held.length !== ids.length) throw new Error(`${rpc.name}: mt_batch_balance_of: not one balance per token`);
  return held.reduce((sum: bigint, x) => sum + amount(x, `${rpc.name}: mt_batch_balance_of`), 0n);
}

/** What an account holds on one read (restore/arms.ts BalanceReader): only above 0 matters to step 5. */
export type NearBalanceRead = "usdc" | "near" | "intents";

/**
 * Step 5's balance reads of R, V and A (./arms.ts restoreArmAccounts) on NEAR: "usdc" ft_balance_of on the network's
 * token, "near" the account's own NEAR (view_account; none is 0), "intents" the sum of what intents.near lists for it.
 * As nearIdReader: each view retried with backoff, the first provider drawn at random and the other read when it
 * fails; a balance above 0 on either provider is enough, and 0 only when both answer 0, so a provider that hides money
 * never makes the restore pass over it. A halt ("FiatToken: paused") fails the read.
 */
export function nearBalanceReader(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], pass: RestorePass, opts: Omit<IdReaderOpts, "indexer"> = {}): Promise<(what: NearBalanceRead, account: string) => Promise<bigint>> {
  const { token, retried, first, blockOf } = setup(network, rpcs, opts);
  const at = pinOf(pass, network, rpcs);
  const readOn = async (rpc: NearRpc, what: NearBalanceRead, a: string): Promise<bigint> => {
    if (what === "usdc") return amount((await retried(rpc, call(token, "ft_balance_of", { account_id: a }), "ft_balance_of", at)).v, `${rpc.name}: ft_balance_of`);
    if (what === "near") {
      const acct = (await retried(rpc, { request_type: "view_account", account_id: a }, "view_account", at)).v;
      return acct === null ? 0n : amount((acct as Obj).amount, `${rpc.name}: view_account`);
    }
    return intentsSum(retried, rpc, a, at);
  };
  return fresh(pass, rpcs, blockOf).then(() => async (what: NearBalanceRead, a: string): Promise<bigint> => {
    if (what !== "usdc" && what !== "near" && what !== "intents") throw new Error(`unknown read ${String(what)}`);
    if (typeof a !== "string" || !HEX64.test(a)) throw new Error("an account is a 64-hex implicit account id");
    const x = first() === 0 ? 0 : 1;
    let failed: unknown;
    for (const p of [x, 1 - x]) {
      try {
        const v = await readOn(rpcs[p]!, what, a);
        if (v > 0n) return v;
      } catch (e) {
        failed = e;
      }
    }
    // 0 only when both answered 0
    if (failed !== undefined) throw failed;
    return 0n;
  });
}
