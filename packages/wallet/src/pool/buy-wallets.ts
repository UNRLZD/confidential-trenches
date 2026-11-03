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
//   Two notes that give one W stop that pool: a W serves one note, and a W shared would link two buys.
// - Where holdings are read: through the helper's POST /v1/rpc/{chain}, its keyed provider (the kit's solanaHelperRpc;
//   the same route for base and robinhood), on one reader. No read from the device names a W: a public provider would
//   learn the user's whole set of wallets by IP, and the free ones cannot serve these reads anyway (getTokenAccountsByOwner
//   refused, no Solana, no finalized EVM state). Holdings are shown, never signed on, so one reader is enough; every
//   read that gates a signature keeps two providers, as elsewhere.
// - One state per read: on Solana getBalance and both getTokenAccountsByOwner answers must share one context.slot, read
//   again with minContextSlot at the highest until they do, at most SOL_HOLDINGS_ROUNDS times, then refused. On EVM one
//   block is read ("latest": Robinhood serves no finalized state) and every call names its hash (EIP-1898).
// - Holdings: native plus tokens. Solana: lamports, and every account W owns under the Token program and Token-2022,
//   decoded from its own bytes (the asked program's, owned by W, a pubkey seen once across both programs); a frozen
//   account flags its mint. EVM: wei, and balanceOf(W) for each token on the list given; a token whose call reverts or
//   that has no code is listed unreadable. Every other answer not in the asked shape stops that pool.
// - One failure never hides the rest: a pool that fails reports its error and the others still list.
// - Privacy: every request names one W and nothing else of the user's: no batch, no call carries two Ws. The Ws of every
//   pool are read one after another in a random order, never in the notes' order.
// - Errors carry a wallet's index in its pool, never a note's ref, label, W or path; an RPC's error is cut to its code.
// - Not here: a full EVM restore from the 12 words alone (the EVM pool's notes, and W's tokens found from its Transfer
//   logs) is card notes-per-pool-evm; until then the EVM side takes its spent notes as input.
import { HELPER_FETCH_INIT, HELPER_V1_PREFIX, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaDecodeTokenAccount, solanaHelperRpc, solanaJsonRpc, type SolanaRpc } from "@blindfill/kit";
import { base64 } from "@scure/base";
import { freshWallet, toChecksum } from "../derive/index.ts";
import type { NoteRef } from "../notes/secrets.ts";
import { refKey, type NoteStore } from "../notes/store.ts";
import { jOf } from "./queue.ts";
import { solanaRestoreNotes, type SolanaRestoredNote, type SolanaRestoredSpend } from "./solana-restore.ts";

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

/** A Solana W's three reads are made again at the highest slot at most this many times before a refusal. */
export const SOL_HOLDINGS_ROUNDS = 4;

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
  pools.forEach((p, pi) => {
    try {
      if (p.reader?.chain !== p.chain || typeof p.reader.read !== "function") throw new Error(`the reader is not of chain ${p.chain}`);
      const seen = new Map<string, number>();
      p.spent.forEach((s, k) => {
        const j = jOf(s.ref);
        const w = freshWallet(seed64, p.chain, s.label, j);
        w.secretKey.fill(0);
        const key = w.address.toLowerCase();
        if (seen.has(key)) throw new Error(`wallet ${k}: its W is wallet ${seen.get(key)}'s`);
        seen.set(key, k);
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
/** A call whose failure keeps only its JSON-RPC code: the provider's text never reaches an error. */
class RpcFailed extends Error {
  readonly code: string | undefined;
  constructor(method: string, code: string | undefined) {
    super(`${method}: ${code === undefined ? "the call failed" : `rpc error ${code}`}`);
    this.code = code;
  }
}
async function call(rpc: JsonRpc, method: string, params: readonly unknown[]): Promise<unknown> {
  try {
    return await rpc(method, params);
  } catch (e) {
    throw new RpcFailed(method, /RPC error (-?\d+)/.exec(msg(e))?.[1]);
  }
}
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
export function solanaHoldingsReader(rpc: SolanaRpc): HoldingsReader {
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
      signal?.throwIfAborted();
      let r = await once();
      for (let round = 1; ; round++) {
        const slots = [r[0].slot, r[1].slot, r[2].slot];
        const top = Math.max(...slots);
        if (slots.every((s) => s === top)) break;
        if (round >= SOL_HOLDINGS_ROUNDS) throw new Error(`its reads met at no one slot in ${SOL_HOLDINGS_ROUNDS} rounds`);
        signal?.throwIfAborted();
        r = await once(top);
      }
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

/** The Solana reader on the helper's keyed provider (POST /v1/rpc/solana). */
export const solanaHelperHoldings = (origin: string): HoldingsReader => solanaHoldingsReader(solanaHelperRpc(origin));

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
export async function solanaRestoreWallets(a: { seed64: Uint8Array; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; holdings: HoldingsReader; signal?: AbortSignal; gap?: number }) {
  const r = await solanaRestoreNotes(a);
  const w = await buyWallets(a.seed64, [{ id: a.program, chain: "sol", spent: solanaSpentNotes(r), reader: a.holdings }], a.signal ? { signal: a.signal } : {});
  return { ...r, ...w };
}

// ---------- EVM ----------
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BALANCE_OF = "0x70a08231"; // balanceOf(address)

/** One EVM provider's reader (production: evmHelperHoldings): one block, then every call at its hash. */
export function evmHoldingsReader(rpc: JsonRpc, tokens: readonly string[]): HoldingsReader {
  const list = tokens.map((t) => toChecksum(t).toLowerCase());
  if (new Set(list).size !== list.length) throw new Error("evm tokens: a token twice");
  return {
    chain: "evm",
    async read(address, signal) {
      const w = toChecksum(address).toLowerCase();
      signal?.throwIfAborted();
      const blk = (await call(rpc, "eth_getBlockByNumber", ["latest", false])) as { hash?: unknown; number?: unknown } | null;
      if (typeof blk?.hash !== "string" || !WORD.test(blk.hash) || typeof blk.number !== "string" || !QUANTITY.test(blk.number)) throw new Error("eth_getBlockByNumber: not a block");
      const at = { blockHash: blk.hash };
      const b = await call(rpc, "eth_getBalance", [w, at]);
      if (typeof b !== "string" || !QUANTITY.test(b)) throw new Error("eth_getBalance: not a quantity");
      const out = new Map<string, TokenHolding>();
      const unreadable: string[] = [];
      for (const t of list) {
        signal?.throwIfAborted();
        let r: unknown;
        try {
          r = await call(rpc, "eth_call", [{ to: t, data: BALANCE_OF + w.slice(2).padStart(64, "0") }, at]);
        } catch (e) {
          if (e instanceof RpcFailed && e.code !== undefined) { unreadable.push(t); continue; } // reverted: the provider answered
          throw e;
        }
        if (r === "0x") { unreadable.push(t); continue; } // no code at this address on this chain
        if (typeof r !== "string" || !WORD.test(r)) throw new Error(`eth_call: token ${list.indexOf(t)}: not one 32-byte word`);
        out.set(t, { amount: BigInt(r), frozen: false });
      }
      return { native: BigInt(b), tokens: out, unreadable };
    },
  };
}

/** The EVM reader on the helper's keyed provider (POST /v1/rpc/base or /v1/rpc/robinhood), over the kit's JSON-RPC
 * client (solanaJsonRpc: plain JSON-RPC over POST, whatever the chain) with the helper's fetch settings. */
export const evmHelperHoldings = (origin: string, chain: "base" | "robinhood", tokens: readonly string[]): HoldingsReader =>
  evmHoldingsReader(solanaJsonRpc(helperUrl(origin, chain), { init: HELPER_FETCH_INIT }), tokens);
