// Restore of the fresh wallets the buys used, from the 12 words (card wallet-per-buy; plan v2 W3: one fresh Solana and
// one fresh EVM wallet per buy, on standard paths, so a restore finds them).
//
// - One W per buy: every proof the queue makes pays W_{chain, l, j} of the note it spends (./queue.ts prove), with l
//   the note's label and j = jOf(its ref) (./queue.ts, keys.ts changeIndex). So every spent note of a pool names its W,
//   and this file derives it the same way, through freshWallet only (m/44'/coin'/a'/b', every step hardened: BIP-32 for
//   secp256k1, SLIP-10 for ed25519; wallet.md:62). W's secret key is zeroed at once; only its address and path leave.
// - Which notes: a pool's SPENT notes, and its RESERVED ones too: a RESERVED note's proof has left the device, so its
//   release may have paid W already. A HELD note's proof never left, so its W has nothing. The notes come from the
//   pool's restore (Solana: ./solana-restore.ts, called by solanaRestoreWallets below) or from the store (spentNotesOf).
//   Two notes that give one W, in one pool or across pools (one pool given twice), stop the later pool: a W serves one
//   note, and is listed once.
// - Where holdings are read: through the helper's POST /v1/rpc/{chain}, its keyed provider (the kit's solanaHelperRpc;
//   the same route for base and robinhood), on one reader. No read from the device names a W: a public provider would
//   learn the user's whole set of wallets by IP, and the free ones cannot serve these reads anyway (getTokenAccountsByOwner
//   refused, no Solana, no finalized EVM state). Holdings are shown, never signed on, so one reader is enough; every
//   read that gates a signature keeps two providers, as elsewhere.
// - One state per read: on Solana getBalance and both getTokenAccountsByOwner answers must share one context.slot, read
//   again with minContextSlot at the highest until they do, at most SOL_HOLDINGS_ROUNDS times, then refused. A backend
//   behind the slot asked (-32016) is asked again a slot later, within the budget every Solana read has (./solana.ts
//   SOL_LAG_SLOTS, card sol-restore-race): a wait for the chain, never a failed round. On EVM one
//   block is read ("latest": Robinhood serves no finalized state) and every call names its hash (EIP-1898).
// - Holdings: native plus tokens. Solana: lamports, and every account W owns under the Token program and Token-2022,
//   decoded from its own bytes (the asked program's, owned by W, a pubkey seen once across both programs); a frozen
//   account flags its mint. EVM: wei, and balanceOf(W) for each token on the list given; a token whose call reverts
//   (JSON-RPC code 3) or that has no code ("0x") is listed unreadable. Any other error (a block a lagging backend lacks,
//   a limit) or answer not in the asked shape stops that pool, so it is read again.
// - Pacing: both helper readers run in the kit's provider queue (solanaPacedRpc, any (method, params) call) at
//   HOLDINGS_RPC_LIMIT (M367), on one queue of their own per helper route URL: keyed on the readers' own function,
//   never the route's URL, so a restore never slows the trade path's calls on the same /v1/rpc route. A Solana round's
//   three calls go out in one tick and the limit's total is one round, so they are booked as one unit, at one
//   instant, and a failed round leaves no call behind it. The helper's 429 is a failed round: the reader waits its
//   Retry-After (at most RETRY_AFTER_MAX_MS, else RETRY_AFTER_DEFAULT_MS) and reads again, within SOL_HOLDINGS_ROUNDS
//   or EVM_HOLDINGS_ROUNDS. The budget the helper enforces per client is card helper-abuse-limits.
// - One failure never hides the rest: a pool that fails reports its error and the others still list.
// - Privacy: every request names one W and nothing else of the user's: no batch, no call carries two Ws. The Ws of every
//   pool are read one after another in a random order, never in the notes' order.
// - Errors carry a wallet's index in its pool, never a note's ref, label, W or path; an RPC's error is cut to its code.
// - Not here: a full EVM restore from the 12 words alone (the EVM pool's notes, and W's tokens found from its Transfer
//   logs) is card notes-per-pool-evm; until then the EVM side takes its spent notes as input.
import { HELPER_FETCH_INIT, HELPER_V1_PREFIX, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaDecodeTokenAccount, solanaHelperRpc, solanaJsonRpc, solanaPacedRpc, type SolanaFetch, type SolanaRpc, type SolanaRpcLimit } from "@blindfill/kit";
import { base64 } from "@scure/base";
import { freshWallet, toChecksum } from "../derive/index.ts";
import type { NoteRef } from "../notes/secrets.ts";
import { refKey, type NoteStore } from "../notes/store.ts";
import { evmRpcHex } from "./evm.ts";
import { jOf } from "./queue.ts";
import { solanaRestoreNotes, type SolanaRestoredNote, type SolanaRestoredSpend } from "./solana-restore.ts";
import { SOL_LAG_SLOTS, SOL_LAG_WAIT_MS } from "./solana.ts";

/** The chains whose pools pay a buy's W today. */
export type BuyChain = "sol" | "evm";

/** One token's balance in base units; frozen when an account holding it is frozen (Solana). */
export type TokenHolding = { amount: bigint; frozen: boolean };
/** What a W holds: the native coin and each token, keyed by its address (Solana: the mint, base58; EVM: the contract,
 * lowercase 0x hex), and the listed tokens that could not be read (EVM: a revert, or no code). */
export type Holdings = { native: bigint; tokens: ReadonlyMap<string, TokenHolding>; unreadable: readonly string[] };

/** One provider's read of one W's holdings, at one state. */
export interface HoldingsReader {
  readonly chain: BuyChain;
  read(address: string, signal?: AbortSignal): Promise<Holdings>;
}

/** A spent note of a pool: its ref and the label of its leaf. */
export type SpentNote = { ref: NoteRef; label: bigint };

export type BuyPool = {
  /** A name for the pool on the device; never sent. */
  id: string;
  chain: BuyChain;
  spent: readonly SpentNote[];
  reader: HoldingsReader;
};

/** A fresh wallet a buy used, and what it holds now. */
export type BuyWallet = { pool: string; chain: BuyChain; note: string; l: bigint; j: number; path: string; address: string; holdings: Holdings };
export type BuyWallets = { wallets: BuyWallet[]; failed: { pool: string; error: string }[] };

/** A Solana W's three reads are made again at the highest slot at most this many times before a refusal: about a third
 * of mainnet-beta's rounds answer from backends at different slots, and a W took up to 4 rounds live (M367; see
 * HOLDINGS_RPC_LIMIT), so 8 leaves a refusal to a chain that keeps moving under the reads. */
export const SOL_HOLDINGS_ROUNDS = 8;
/** An EVM W's reads are made again after the helper's 429 at most this many times before a refusal. */
export const EVM_HOLDINGS_ROUNDS = 4;
/** The holdings readers' own pace on a helper route (M367), both chains: one Solana round (getBalance and the two
 * getTokenAccountsByOwner) in any 3 s, booked as one unit: `total` is the round's three calls and binds, so the round's
 * calls, made in one tick, start at one instant (calls spread over the finalized slot, which moves about every 400 ms,
 * never meet: M361b's one call of a method a 1.1 s refused every Solana W live). It is the fallback upstream's,
 * measured; it rises once the helper has a keyed primary and paces its upstream itself (card helper-abuse-limits).
 * Measured on 2026-11-03 from one IP, the reader as built (its own url-less queue) on the helper's fallback upstreams,
 * 12 Ws of the all-zero test seed a run, 3 runs 15 s apart:
 *   api.mainnet-beta.solana.com, 1 round in 3 s, 8 rounds: 0 HTTP 429s in every run; 12/12, 12/12, 12/12 Ws read, each
 *     at one slot; 16, 19, 17 rounds (at most 4 for a W); 45.2, 54.4, 48.5 s (03:50-03:53Z)
 *   mainnet.base.org, the same limit (one token, three calls a W): 0 HTTP 429s in every run; 12/12 read in each;
 *     34.4, 34.1, 34.2 s (03:53-03:56Z)
 *   mainnet-beta, 1 round in 2.2 s, 4 rounds: one 429 in every run; 12/12, 12/12, 10/12 read (two Ws met at no one
 *     slot in 4 rounds); 18, 17, 20 rounds; 37.5, 35.3, 41.9 s (03:44-03:46Z)
 *   mainnet-beta, the 12-W call mix (36 calls, no slot rule) at 10 and 5 calls a second: 14 429s in each of 6 runs
 *     (02:02-02:04Z); at 9 a method in 10 s: 8, 0, 0; at 9 in 11 s: 2, 1, 3 (02:08-02:14Z)
 * mainnet-beta's answers to one round's three calls, sent at one instant, come from backends at different finalized
 * slots in about a third of rounds, hence SOL_HOLDINGS_ROUNDS. getTokenAccountsByOwner alone: 400 ms apart, calls
 * 1-10 answer and the 11th draws a 429 with Retry-After 10 (02:06Z); in bursts of 9 at a 10 s or 11 s window's edge,
 * 6 or 7 of 9 are refused (02:10Z, 02:12Z); 1.1 s apart, 27 of 27 answer (02:15Z). So about 10 of it in 10 s, never in
 * a burst: a round's two in 3 s keep it at 6.7. A JSON-RPC batch of the three is no fix: its answers came from
 * backends of two versions, and batches drew a 429 at one in 2.2 s (03:47-03:49Z). */
export const HOLDINGS_RPC_LIMIT: SolanaRpcLimit = /* @__PURE__ */ Object.freeze({ windowMs: 3_000, total: 3, perMethod: 2 });
/** Solana's JSON-RPC code for a minContextSlot the node has not reached. */
const MIN_CONTEXT_SLOT_NOT_REACHED = "-32016";
/** The JSON-RPC code of an eth_call that reverted ("execution reverted"); every other error is the provider's. */
const EXECUTION_REVERTED = "3";

/** The store's notes of one pool (its scope) whose W a release may have paid: SPENT and RESERVED, in leaf order. */
export async function spentNotesOf(store: NoteStore, scope: bigint): Promise<SpentNote[]> {
  // a note has its leaf from UNSPENT on (../notes/store.ts), so every SPENT or RESERVED note has one
  const spent = (await store.list()).filter((n) => n.scope === scope && (n.state === "SPENT" || n.state === "RESERVED"));
  spent.sort((x, y) => (x.leaf!.leafIndex < y.leaf!.leafIndex ? -1 : 1));
  return spent.map((n) => ({ ref: n.ref, label: n.leaf!.label }));
}

const randomIndex = (n: number): number => {
  const max = Math.floor(0x1_0000_0000 / n) * n;
  const b = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(b);
  while (b[0]! >= max);
  return b[0]! % n;
};
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every W the pools' spent notes paid, with its holdings. The Ws are read in a random order (`pick`: tests only). */
export async function buyWallets(seed64: Uint8Array, pools: readonly BuyPool[], opts: { signal?: AbortSignal; pick?: (n: number) => number } = {}): Promise<BuyWallets> {
  const pick = opts.pick ?? randomIndex;
  const failed = new Map<number, string>();
  const found: (BuyWallet | undefined)[][] = pools.map(() => []);
  const jobs: { p: number; k: number; address: string }[] = [];
  const seen = new Map<string, [number, number]>(); // a W -> its pool and wallet index, across every pool
  pools.forEach((p, pi) => {
    try {
      if (p.reader?.chain !== p.chain || typeof p.reader.read !== "function") throw new Error(`the reader is not of chain ${p.chain}`);
      p.spent.forEach((s, k) => {
        const j = jOf(s.ref);
        const w = freshWallet(seed64, p.chain, s.label, j);
        w.secretKey.fill(0);
        const key = `${p.chain}/${w.address.toLowerCase()}`;
        const had = seen.get(key);
        if (had !== undefined) throw new Error(`wallet ${k}: its W is ${had[0] === pi ? "" : `pool ${had[0]} `}wallet ${had[1]}'s`);
        seen.set(key, [pi, k]);
        found[pi]!.push({ pool: p.id, chain: p.chain, note: refKey(s.ref), l: s.label, j, path: w.path, address: w.address, holdings: { native: 0n, tokens: new Map(), unreadable: [] } });
        jobs.push({ p: pi, k, address: w.address });
      });
    } catch (e) {
      failed.set(pi, msg(e));
    }
  });
  // Fisher-Yates over every pool's Ws
  for (let i = jobs.length - 1; i > 0; i--) {
    const r = pick(i + 1);
    if (!Number.isInteger(r) || r < 0 || r > i) throw new Error("pick: not an index");
    [jobs[i], jobs[r]] = [jobs[r]!, jobs[i]!];
  }
  for (const { p, k, address } of jobs) {
    if (failed.has(p)) continue;
    opts.signal?.throwIfAborted();
    try {
      found[p]![k]!.holdings = await pools[p]!.reader.read(address, opts.signal);
    } catch (e) {
      opts.signal?.throwIfAborted();
      failed.set(p, `wallet ${k}: ${msg(e)}`);
    }
  }
  return {
    wallets: found.flatMap((ws, p) => (failed.has(p) ? [] : (ws as BuyWallet[]))),
    failed: [...failed].sort(([a], [b]) => a - b).map(([p, error]) => ({ pool: pools[p]!.id, error })),
  };
}

// ---------- transport ----------
/** One JSON-RPC call: resolves the call's `result`. */
export type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
/** A call whose failure keeps only its JSON-RPC code or HTTP status: the provider's text never reaches an error. */
class RpcFailed extends Error {
  readonly code: string | undefined;
  readonly http: number | undefined;
  constructor(method: string, code: string | undefined, http: number | undefined) {
    super(`${method}: ${code !== undefined ? `rpc error ${code}` : http !== undefined ? `http ${http}` : "the call failed"}`);
    this.code = code;
    this.http = http;
  }
}
async function call(rpc: JsonRpc, method: string, params: readonly unknown[]): Promise<unknown> {
  try {
    return await rpc(method, params);
  } catch (e) {
    const http = /^HTTP (\d{3})$/.exec(msg(e))?.[1]; // the kit's JSON-RPC client's text for a non-2xx answer
    throw new RpcFailed(method, /RPC error (-?\d+)/.exec(msg(e))?.[1], http === undefined ? undefined : Number(http));
  }
}
const is429 = (e: unknown): boolean => e instanceof RpcFailed && e.http === 429;

/** A helper's 429 is a failed round: the reader waits this long (its Retry-After, capped), then reads again. */
export const RETRY_AFTER_MAX_MS = 10_000;
export const RETRY_AFTER_DEFAULT_MS = 1_000;
/** A Retry-After header's wait: delay-seconds or an HTTP date (RFC 9110's IMF-fixdate), capped at RETRY_AFTER_MAX_MS,
 * never below 0; absent or not one of the two, RETRY_AFTER_DEFAULT_MS. */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
export function retryAfterMs(header: string | null, nowMs: number): number {
  const h = header?.trim() ?? "";
  // delay-seconds past the cap waits the cap, a digit string too long for a number (Infinity) included
  if (/^\d+$/.test(h)) return Math.min(Number(h) * 1000, RETRY_AFTER_MAX_MS);
  const ms = IMF_FIXDATE.test(h) ? Date.parse(h) - nowMs : NaN;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS) : RETRY_AFTER_DEFAULT_MS;
}
/** The helper transport's fetch, which keeps the Retry-After of the latest 429 it saw for the reader's next wait. */
function retryAfterFetch(): { fetch: SolanaFetch; wait429: () => number } {
  // a reader waits only after a 429 this fetch saw, so `next` is always that answer's wait
  let next = RETRY_AFTER_DEFAULT_MS;
  return {
    fetch: async (url, init) => {
      const r = await globalThis.fetch(url, init);
      if (r.status === 429) next = retryAfterMs(r.headers.get("retry-after"), Date.now());
      return r;
    },
    wait429: () => next,
  };
}
/** The readers' paced transport on one helper route URL, at HOLDINGS_RPC_LIMIT, made once and shared by every reader
 * of it. Its queue is keyed on its own function with no url, so the kit never adds this limit to the route URL's
 * queue, where the trade path's calls (send.ts rpcPath, solanaPacedRpc on the helper) are paced. */
const holdingsRoutes = new Map<string, { rpc: SolanaRpc; wait429: () => number }>();
function holdingsRoute(make: (fetch: SolanaFetch) => SolanaRpc): { rpc: SolanaRpc; wait429: () => number } {
  const t = retryAfterFetch();
  const bare = make(t.fetch);
  let r = holdingsRoutes.get(String(bare.url));
  if (r === undefined) {
    const own: SolanaRpc = (method, params) => bare(method, params); // no url: the kit keys its queue on this function
    r = { rpc: solanaPacedRpc(own, HOLDINGS_RPC_LIMIT), wait429: t.wait429 };
    holdingsRoutes.set(String(bare.url), r);
  }
  return r;
}
/** How a reader waits after a 429: wait429 gives the wait (the transport's Retry-After; RETRY_AFTER_DEFAULT_MS when
 * none), sleep waits it (tests only). */
export type ReaderOpts = { wait429?: () => number; sleep?: (ms: number) => Promise<void> };
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function helperUrl(origin: string, chain: "base" | "robinhood"): string {
  let u: URL;
  try { u = new URL(origin); } catch { throw new Error("the helper origin must be an origin"); }
  if (origin !== u.origin && origin !== `${u.origin}/`) throw new Error("the helper origin must be an origin only");
  return `${u.origin}${HELPER_V1_PREFIX}/rpc/${chain}`;
}

// ---------- Solana ----------
type Slotted<T> = { slot: number; value: T };
function slotted(a: unknown, what: string, min: number | undefined): Slotted<unknown> {
  const slot = (a as { context?: { slot?: unknown } } | null)?.context?.slot;
  if (!Number.isSafeInteger(slot) || (slot as number) < 0 || (min !== undefined && (slot as number) < min)) throw new Error(`${what}: no context slot at or past the one asked`);
  return { slot: slot as number, value: (a as { value?: unknown }).value };
}

/** One Solana provider's reader (production: solanaHelperHoldings). */
export function solanaHoldingsReader(rpc: SolanaRpc, o: ReaderOpts = {}): HoldingsReader {
  const wait429 = o.wait429 ?? (() => RETRY_AFTER_DEFAULT_MS), sleep = o.sleep ?? sleepMs;
  const cfg = (min?: number) => ({ commitment: "finalized", ...(min === undefined ? {} : { minContextSlot: min }) });
  const balance = async (owner: string, min?: number): Promise<Slotted<bigint>> => {
    const r = slotted(await call(rpc, "getBalance", [owner, cfg(min)]), "getBalance", min);
    if (!Number.isSafeInteger(r.value) || (r.value as number) < 0) throw new Error("getBalance: not a whole number in range");
    return { slot: r.slot, value: BigInt(r.value as number) };
  };
  type Acct = { pubkey: string; mint: string; amount: bigint; frozen: boolean };
  const accounts = async (owner: string, program: string, min?: number): Promise<Slotted<Acct[]>> => {
    const r = slotted(await call(rpc, "getTokenAccountsByOwner", [owner, { programId: program }, { ...cfg(min), encoding: "base64" }]), "getTokenAccountsByOwner", min);
    if (!Array.isArray(r.value)) throw new Error("getTokenAccountsByOwner: not a list");
    return {
      slot: r.slot,
      value: (r.value as { pubkey?: unknown; account?: { owner?: unknown; data?: unknown } }[]).map((x) => {
        const d = x?.account?.data;
        if (typeof x?.pubkey !== "string" || x.account?.owner !== program || !Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new Error("getTokenAccountsByOwner: not an account of the program asked");
        const t = solanaDecodeTokenAccount({ owner: program, data: base64.decode(d[0]) });
        if (t.owner !== owner) throw new Error("getTokenAccountsByOwner: an account of another owner");
        return { pubkey: x.pubkey, mint: t.mint, amount: t.amount, frozen: t.state === 2 };
      }),
    };
  };
  return {
    chain: "sol",
    async read(address, signal) {
      const once = (min?: number) => Promise.all([balance(address, min), accounts(address, SOLANA_TOKEN_PROGRAM, min), accounts(address, SOLANA_TOKEN_2022_PROGRAM, min)] as const);
      // Each round reads all three at the highest slot seen (none in the first). A round fails when they answer at
      // different slots, or on the helper's 429 (after its wait); the next round asks again, and SOL_HOLDINGS_ROUNDS
      // failed rounds are a refusal. A backend behind the slot asked (-32016) is asked again a slot later, SOL_LAG_SLOTS
      // waits at most, as every Solana read of the wallet (./solana.ts solanaLagRetry): it waits for the chain.
      let r: Awaited<ReturnType<typeof once>> | undefined;
      let min: number | undefined;
      for (let round = 1, lags = 0; ; ) {
        signal?.throwIfAborted();
        let why = "met at no one slot";
        try {
          r = await once(min);
          const slots = [r[0].slot, r[1].slot, r[2].slot];
          const top = Math.max(...slots);
          if (slots.every((s) => s === top)) break;
          min = top;
        } catch (e) {
          if (min !== undefined && e instanceof RpcFailed && e.code === MIN_CONTEXT_SLOT_NOT_REACHED) {
            if (++lags > SOL_LAG_SLOTS) throw e;
            await sleep(SOL_LAG_WAIT_MS);
            continue;
          }
          if (!is429(e)) throw e;
          why = "drew the helper's 429";
        }
        if (round++ >= SOL_HOLDINGS_ROUNDS) throw new Error(`its reads ${why} in ${SOL_HOLDINGS_ROUNDS} rounds`);
        if (why !== "met at no one slot") await sleep(wait429());
      }
      if (r === undefined) throw new Error("no read");
      const keys = new Set<string>();
      const tokens = new Map<string, TokenHolding>();
      for (const a of [...r[1].value, ...r[2].value]) {
        if (keys.has(a.pubkey)) throw new Error("getTokenAccountsByOwner: an account twice");
        keys.add(a.pubkey);
        const h = tokens.get(a.mint);
        tokens.set(a.mint, { amount: (h?.amount ?? 0n) + a.amount, frozen: (h?.frozen ?? false) || a.frozen });
      }
      return { native: r[0].value, tokens, unreadable: [] };
    },
  };
}

/** The Solana reader on the helper (POST /v1/rpc/solana), paced in the kit's provider queue (solanaPacedRpc) at
 * HOLDINGS_RPC_LIMIT on the readers' own queue for the route; a 429 waits the answer's Retry-After. */
export function solanaHelperHoldings(origin: string): HoldingsReader {
  const r = holdingsRoute((fetch) => solanaHelperRpc(origin, { fetch }));
  return solanaHoldingsReader(r.rpc, { wait429: r.wait429 });
}

/** A Solana pool's restored notes to its buys' Ws: its spends must be exactly its SPENT notes, each at jOf(ref). */
export function solanaSpentNotes(r: { notes: readonly SolanaRestoredNote[]; spends: readonly SolanaRestoredSpend[] }): SpentNote[] {
  const spent = r.notes.filter((n) => n.state === "SPENT");
  if (spent.length !== r.spends.length) throw new Error("solana restore: its spends are not its spent notes");
  return spent.map((n, k) => {
    const s = r.spends[k]!;
    if (s.note !== refKey(n.ref) || s.l !== n.leaf.label || s.j !== jOf(n.ref)) throw new Error(`solana restore: spend ${k} is not its note's (l, j)`);
    return { ref: n.ref, label: n.leaf.label };
  });
}

/** Restore of the Solana pool (./solana-restore.ts on its two RPCs), then the Ws its buys used, read on `holdings`. */
export async function solanaRestoreWallets(a: { seed64: Uint8Array; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; lister: SolanaRpc; holdings: HoldingsReader; signal?: AbortSignal; gap?: number }) {
  const r = await solanaRestoreNotes(a);
  const w = await buyWallets(a.seed64, [{ id: a.program, chain: "sol", spent: solanaSpentNotes(r), reader: a.holdings }], a.signal ? { signal: a.signal } : {});
  return { ...r, ...w };
}

// ---------- EVM ----------
// every hex an RPC gives is read through evmRpcHex (./evm.ts): "0x", then hex digits in either case, lower-cased
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const WORD = /^0x[0-9a-f]{64}$/;
const BALANCE_OF = "0x70a08231"; // balanceOf(address)

/** One EVM provider's reader (production: evmHelperHoldings): one block, then every call at its hash. */
export function evmHoldingsReader(rpc: JsonRpc, tokens: readonly string[], o: ReaderOpts = {}): HoldingsReader {
  const wait429 = o.wait429 ?? (() => RETRY_AFTER_DEFAULT_MS), sleep = o.sleep ?? sleepMs;
  const list = tokens.map((t) => toChecksum(t).toLowerCase());
  if (new Set(list).size !== list.length) throw new Error("evm tokens: a token twice");
  return {
    chain: "evm",
    async read(address, signal) {
      // the helper's 429 fails the round (after its wait): the next reads again from a new block, and
      // EVM_HOLDINGS_ROUNDS failed rounds are a refusal
      for (let round = 1; ; round++) {
        try {
          return await once(address, signal);
        } catch (e) {
          if (!is429(e)) throw e;
        }
        if (round >= EVM_HOLDINGS_ROUNDS) throw new Error(`its reads drew the helper's 429 in ${EVM_HOLDINGS_ROUNDS} rounds`);
        await sleep(wait429());
      }
    },
  };
  async function once(address: string, signal?: AbortSignal): Promise<Holdings> {
    const w = toChecksum(address).toLowerCase();
    signal?.throwIfAborted();
    const blk = (await call(rpc, "eth_getBlockByNumber", ["latest", false])) as { hash?: unknown; number?: unknown } | null;
    const hash = evmRpcHex(blk?.hash), number = evmRpcHex(blk?.number);
    if (hash === null || !WORD.test(hash) || number === null || !QUANTITY.test(number)) throw new Error("eth_getBlockByNumber: not a block");
    const at = { blockHash: hash };
    const b = evmRpcHex(await call(rpc, "eth_getBalance", [w, at]));
    if (b === null || !QUANTITY.test(b)) throw new Error("eth_getBalance: not a quantity");
    const out = new Map<string, TokenHolding>();
    const unreadable: string[] = [];
    for (const t of list) {
      signal?.throwIfAborted();
      let r: unknown;
      try {
        r = await call(rpc, "eth_call", [{ to: t, data: BALANCE_OF + w.slice(2).padStart(64, "0") }, at]);
      } catch (e) {
        // reverted: the token's own answer. Any other error (a block a lagging backend lacks, a limit, an internal
        // error) is the provider's, and fails the pool so it is read again.
        if (e instanceof RpcFailed && e.code === EXECUTION_REVERTED) { unreadable.push(t); continue; }
        throw e;
      }
      const word = evmRpcHex(r);
      if (word === "0x") { unreadable.push(t); continue; } // no code at this address on this chain
      if (word === null || !WORD.test(word)) throw new Error(`eth_call: token ${list.indexOf(t)}: not one 32-byte word`);
      out.set(t, { amount: BigInt(word), frozen: false });
    }
    return { native: BigInt(b), tokens: out, unreadable };
  }
}

/** The EVM reader on the helper (POST /v1/rpc/base or /v1/rpc/robinhood), over the kit's JSON-RPC client
 * (solanaJsonRpc: plain JSON-RPC over POST, whatever the chain) with the helper's fetch settings, paced in the kit's
 * provider queue (any (method, params) call) at HOLDINGS_RPC_LIMIT on the readers' own queue for the route; a 429
 * waits the answer's Retry-After. */
export function evmHelperHoldings(origin: string, chain: "base" | "robinhood", tokens: readonly string[]): HoldingsReader {
  const r = evmHelperRoute(origin, chain);
  return evmHoldingsReader(r.rpc, tokens, { wait429: r.wait429 });
}
function evmHelperRoute(origin: string, chain: "base" | "robinhood"): { rpc: SolanaRpc; wait429: () => number } {
  const url = helperUrl(origin, chain);
  return holdingsRoute((fetch) => solanaJsonRpc(url, { init: HELPER_FETCH_INIT, fetch }));
}
/** The helper's route for a mainnet W's other reads (./evm-restore.ts, the Transfer logs a restore reads for each W):
 * the holdings readers' one paced transport on POST /v1/rpc/{chain}, the same queue, so a restore's reads and the
 * holdings reads together stay at HOLDINGS_RPC_LIMIT. */
export function evmHelperRpc(origin: string, chain: "base" | "robinhood"): SolanaRpc {
  return evmHelperRoute(origin, chain).rpc;
}
/** The helper's route in its keyed-only mode (POST /v1/rpc/{chain}?keyed=only, card evm-pool-leaves-any-source, review
 *  of 0b379bf4 P1-1): answered by the helper's keyed providers alone, never its public fallback (which holds the device's
 *  own providers), else an error. Its `operator` is "helper", one operator for the pool sync's sources (evm.ts
 *  evmSourceOperator); paced on the holdings readers' queue for its URL. One reader per origin and chain. */
const keyedRoutes = new Map<string, SolanaRpc>();
export function evmHelperKeyedRpc(origin: string, chain: "base" | "robinhood"): SolanaRpc {
  const url = `${helperUrl(origin, chain)}?keyed=only`;
  let r = keyedRoutes.get(url);
  if (r === undefined) {
    const route = holdingsRoute((fetch) => solanaJsonRpc(url, { init: HELPER_FETCH_INIT, fetch }));
    r = Object.assign((method: string, params: readonly unknown[]) => route.rpc(method, params), { url, operator: "helper" }) as SolanaRpc;
    keyedRoutes.set(url, r);
  }
  return r;
}
