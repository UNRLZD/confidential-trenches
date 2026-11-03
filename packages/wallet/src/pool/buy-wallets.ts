// Restore of the fresh wallets the buys used, from the 12 words (card wallet-per-buy; plan v2 W3: one fresh Solana and
// one fresh EVM wallet per buy, on standard paths, so a restore finds them).
//
// - One W per buy: every proof the queue makes pays W_{chain, l, j} of the note it spends (./queue.ts prove), with l
//   the note's label and j = jOf(its ref) (./queue.ts, keys.ts changeIndex). So every spent note of a pool names its W,
//   and this file derives it the same way, through freshWallet only (m/44'/coin'/a'/b', every step hardened: BIP-32 for
//   secp256k1, SLIP-10 for ed25519; wallet.md:62). W's secret key is zeroed at once; only its address and path leave.
// - Chain-agnostic: a pool is its chain, its spent notes and two holdings readers. The spent notes come from the
//   pool's restore (Solana: ./solana-restore.ts, called by solanaRestoreWallets below) or from the store (spentNotesOf:
//   the EVM pool's notes, until their restore lands). Two spent notes that give one W stop the restore: a W serves one
//   note, and a W shared would link two buys.
// - Holdings: native plus tokens, read on each of two readers (two providers), compared exactly; any difference stops
//   the restore with nothing returned. Solana: lamports, and every token account W owns under the Token program and
//   under Token-2022, decoded from the account's own bytes (each must be the asked program's and name W as its owner).
//   EVM: wei, and balanceOf(W) for each token on the list the caller passes (the kit has no EVM token list yet), at
//   the "finalized" block tag.
// - Every external answer is hostile: an answer not in the asked shape, an account twice, an account of another
//   program or owner, a balance that is not a whole number in range stops the restore.
// - Privacy: every request names one W and nothing else of the user's: no batch, no getMultipleAccounts, no call
//   carries two Ws. The Ws are read one after another.
// - Nothing here logs; no error names an address or a key.
import { SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaDecodeTokenAccount, type SolanaRpc } from "@blindfill/kit";
import { base64 } from "@scure/base";
import { freshWallet, toChecksum } from "../derive/index.ts";
import type { NoteRef } from "../notes/secrets.ts";
import { refKey, type NoteStore } from "../notes/store.ts";
import { jOf } from "./queue.ts";
import { checkSolanaRpcs } from "./solana.ts";
import { solanaRestoreNotes, type SolanaRestoredNote, type SolanaRestoredSpend } from "./solana-restore.ts";

/** The chains whose pools pay a buy's W today. */
export type BuyChain = "sol" | "evm";

/** What a W holds: the chain's native coin and each token's balance, in base units, keyed by the token's address
 * (Solana: the mint, base58; EVM: the contract, lowercase 0x hex). */
export type Holdings = { native: bigint; tokens: ReadonlyMap<string, bigint> };

/** One provider's read of one W's holdings. */
export interface HoldingsReader {
  readonly chain: BuyChain;
  /** The provider's name or URL; two readers of one pool must differ. Never sent. */
  readonly name: string;
  read(address: string, signal?: AbortSignal): Promise<Holdings>;
}

/** A spent note of a pool: its ref and the label of its leaf. */
export type SpentNote = { ref: NoteRef; label: bigint };

export type BuyPool = {
  /** A name for the pool on the device; never sent. */
  id: string;
  chain: BuyChain;
  spent: readonly SpentNote[];
  readers: readonly [HoldingsReader, HoldingsReader];
};

/** A fresh wallet a buy used, and what it holds now. */
export type BuyWallet = { pool: string; chain: BuyChain; note: string; l: bigint; j: number; path: string; address: string; holdings: Holdings };

/** The store's spent notes of one pool (its scope), in leaf order. */
export async function spentNotesOf(store: NoteStore, scope: bigint): Promise<SpentNote[]> {
  // a note has its leaf from UNSPENT on (../notes/store.ts), so every SPENT note has one
  const spent = (await store.list()).filter((n) => n.scope === scope && n.state === "SPENT");
  spent.sort((x, y) => (x.leaf!.leafIndex < y.leaf!.leafIndex ? -1 : 1));
  return spent.map((n) => ({ ref: n.ref, label: n.leaf!.label }));
}

function checkReaders(p: BuyPool): void {
  const r = p.readers;
  if (!Array.isArray(r) || r.length !== 2) throw new Error(`pool ${p.id}: two readers`);
  for (const x of r) if (x?.chain !== p.chain || typeof x.read !== "function") throw new Error(`pool ${p.id}: a reader not of chain ${p.chain}`);
  if (r[0] === r[1] || r[0].name === r[1].name) throw new Error(`pool ${p.id}: one provider twice is one read`);
}

function sameHoldings(a: Holdings, b: Holdings): boolean {
  if (a.native !== b.native || a.tokens.size !== b.tokens.size) return false;
  for (const [k, v] of a.tokens) if (b.tokens.get(k) !== v) return false;
  return true;
}

/** Every W the pools' spent notes paid, each with its holdings read on both readers; refused when they disagree. */
export async function buyWallets(seed64: Uint8Array, pools: readonly BuyPool[], signal?: AbortSignal): Promise<BuyWallet[]> {
  const out: BuyWallet[] = [];
  const seen = new Set<string>();
  for (const p of pools) {
    checkReaders(p);
    for (const s of p.spent) {
      const note = refKey(s.ref);
      const j = jOf(s.ref);
      const w = freshWallet(seed64, p.chain, s.label, j);
      w.secretKey.fill(0);
      const key = `${p.chain}/${w.address.toLowerCase()}`;
      if (seen.has(key)) throw new Error(`pool ${p.id}: note ${note}: its W is another spent note's`);
      seen.add(key);
      signal?.throwIfAborted();
      const [x, y] = await Promise.all(p.readers.map((r) => r.read(w.address, signal)));
      if (!sameHoldings(x!, y!)) throw new Error(`pool ${p.id}: note ${note}: the two readers' holdings of its W differ`);
      out.push({ pool: p.id, chain: p.chain, note, l: s.label, j, path: w.path, address: w.address, holdings: x! });
    }
  }
  return out;
}

// ---------- Solana ----------
const amount = (x: unknown, what: string): bigint => {
  if (!Number.isSafeInteger(x) || (x as number) < 0) throw new Error(`${what}: not a whole number in range`);
  return BigInt(x as number);
};

/** One Solana provider's reader: getBalance, then getTokenAccountsByOwner under each token program, at finalized. */
export function solanaHoldingsReader(rpc: SolanaRpc, name: string = rpc.url ?? "solana"): HoldingsReader {
  const tokensOf = async (owner: string, program: string, tokens: Map<string, bigint>): Promise<void> => {
    const a = (await rpc("getTokenAccountsByOwner", [owner, { programId: program }, { commitment: "finalized", encoding: "base64" }])) as { value?: unknown };
    if (!Array.isArray(a?.value)) throw new Error(`${name}: getTokenAccountsByOwner: not a list`);
    const keys = new Set<string>();
    for (const x of a.value as { pubkey?: unknown; account?: { owner?: unknown; data?: unknown } }[]) {
      const d = x?.account?.data;
      if (typeof x?.pubkey !== "string" || x.account?.owner !== program || !Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new Error(`${name}: getTokenAccountsByOwner: not an account of the program asked`);
      if (keys.has(x.pubkey)) throw new Error(`${name}: getTokenAccountsByOwner: an account twice`);
      keys.add(x.pubkey);
      const t = solanaDecodeTokenAccount({ owner: program, data: base64.decode(d[0]) });
      if (t.owner !== owner) throw new Error(`${name}: getTokenAccountsByOwner: an account of another owner`);
      tokens.set(t.mint, (tokens.get(t.mint) ?? 0n) + t.amount);
    }
  };
  return {
    chain: "sol",
    name,
    async read(address, signal) {
      signal?.throwIfAborted();
      const b = (await rpc("getBalance", [address, { commitment: "finalized" }])) as { value?: unknown };
      const native = amount(b?.value, `${name}: getBalance`);
      const tokens = new Map<string, bigint>();
      await tokensOf(address, SOLANA_TOKEN_PROGRAM, tokens);
      await tokensOf(address, SOLANA_TOKEN_2022_PROGRAM, tokens);
      return { native, tokens };
    },
  };
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

/** Restore of the Solana pool and the Ws its buys used: ./solana-restore.ts, then each W's holdings on the same two RPCs. */
export async function solanaRestoreWallets(a: { seed64: Uint8Array; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; signal?: AbortSignal; gap?: number }) {
  checkSolanaRpcs(a.rpcs);
  const r = await solanaRestoreNotes(a);
  const readers = [solanaHoldingsReader(a.rpcs[0], a.rpcs[0].url ?? "rpc 0"), solanaHoldingsReader(a.rpcs[1], a.rpcs[1].url ?? "rpc 1")] as const;
  const wallets = await buyWallets(a.seed64, [{ id: a.program, chain: "sol", spent: solanaSpentNotes(r), readers }], a.signal);
  return { ...r, wallets };
}

// ---------- EVM ----------
/** One JSON-RPC call on one EVM provider: resolves the call's `result`. */
export type EvmRpc = ((method: string, params: readonly unknown[]) => Promise<unknown>) & { readonly url?: string };

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BALANCE_OF = "0x70a08231"; // balanceOf(address)

/** One EVM provider's reader: eth_getBalance and balanceOf(W) on each listed token, at the "finalized" block tag. */
export function evmHoldingsReader(rpc: EvmRpc, tokens: readonly string[], name: string = rpc.url ?? "evm"): HoldingsReader {
  const list = tokens.map((t) => toChecksum(t).toLowerCase());
  if (new Set(list).size !== list.length) throw new Error("evm tokens: a token twice");
  return {
    chain: "evm",
    name,
    async read(address, signal) {
      const w = toChecksum(address).toLowerCase();
      signal?.throwIfAborted();
      const b = await rpc("eth_getBalance", [w, "finalized"]);
      if (typeof b !== "string" || !QUANTITY.test(b)) throw new Error(`${name}: eth_getBalance: not a quantity`);
      const out = new Map<string, bigint>();
      for (const t of list) {
        signal?.throwIfAborted();
        const r = await rpc("eth_call", [{ to: t, data: BALANCE_OF + w.slice(2).padStart(64, "0") }, "finalized"]);
        if (typeof r !== "string" || !WORD.test(r)) throw new Error(`${name}: balanceOf on ${t}: not one 32-byte word`);
        out.set(t, BigInt(r));
      }
      return { native: BigInt(b), tokens: out };
    },
  };
}
