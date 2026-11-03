// pool.deposit on the Solana pool (card signpage-pool-notes): a one-time wallet U of the device puts SOL into the pinned
// pool, and each note is stored only once its own deposit reads back on two RPCs.
//
// - The source: U_{scope,i} (derive/keys.ts depositId). The newest U this scope has used stays the source while its
//   balance covers a rung and its costs; else the U of the index the note store plans (planDeposit: one unfunded index
//   per scope, so the same U is named until money reaches it). The amount is split on the pool's ladder
//   (../../wallet/src/pool/ladder.ts ladderSplit): on a new U the first rung is its deposit note, every other rung that
//   U's next second arrival (n = 0, 1, ...), each its own deposit, the next planned only once the one before is done.
// - The cost of a rung, read on both RPCs: the rung, the precommitment mark's rent (17 bytes), each tree's page growth (a
//   72-byte entry, or a new page's rent) and the tx fee (getFeeForMessage, the same on both). U after the deposit holds 0
//   or at least the rent of an empty account (the runtime refuses less). Short of that: not_funded, nothing written.
// - Before anything is written: the pool account on both RPCs, byte for byte, gives the tree sizes; the blockhash is read
//   on one RPC and must be valid on the other; the tx is built here, checked by the rule (rules/pool.ts
//   checkSolanaDeposit: one tag 1 into the pinned pool, by U, of the rung, with the note's own precommitment) and its
//   unsigned bytes simulated on both RPCs (sigVerify off, so neither can send it), which must both pass. A simulation
//   that fails while the note's mark exists means another deposit took the precommitment: PLANNED -> TAKEN.
// - A state and its send are written before the act: PLANNED -> INCOMING carries the send (signature, value, the
//   blockhash's last valid height), written before the signed tx leaves the device; a send again is written first too
//   (addSend, at the note's recorded value).
// - A note's verdict is the precommitment's mark at finalized on both RPCs, never an RPC's tx history: the mark at the
//   note's recorded value, its label the label tree's leaf nonce - 1 and the commitment Poseidon(value, label,
//   precommitment) a leaf of the state tree (../../wallet/src/pool/solana.ts solanaTreeSync): INCOMING -> UNSPENT,
//   whoever sent it (a same-value deposit by another only funds the user's note). A mark of any other value: another
//   deposit took the precommitment, INCOMING -> TAKEN, and the source U's money moves on its next note. No mark with
//   both RPCs' finalized height past every send's last valid height: sent again at its own value. Anything else is
//   pending: read again, then not_landed with the note left INCOMING, never stored as money. Signature statuses only
//   name the tx that landed, in the answer. A send's last valid height is the lower of the blockhash's on one RPC and
//   the other RPC's height + 151, so no one RPC sets it.
// - An INCOMING note of the pool's scope (a run a reload cut short) is read once at the start of every run, as its own
//   move, never waited on: settled, taken, sent again, or left INCOMING with its U not a source this run (a resend U
//   cannot pay leaves it so, and `short` names the top-up). settlePoolDeposits does that pass with no ask, on page load.
// - Each note that lands starts the proof queue's pass (`landed`), so the next buy's proof is made ahead; `sent` and
//   `progress` tell the app of the ask's own sends and landed rungs, never an earlier note's.
// - Every read names a public account or tx (the pool, its pages, U, the mark the deposit itself named, U's own
//   signatures), one wallet of the user's per request; no request carries a key, the words, or which note is whose. U's
//   secret key and the seed are zeroed when the run ends. Nothing here logs.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { readSolanaRent, solanaPoolPage, solanaRentMin, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { depositId } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { Leaf, NoteRecord, NoteStore, PoolSend } from "../../wallet/src/notes/store.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";
import { SOL_LADDER, solanaPoolOf, solanaTreeSync, type SolanaPoolPin } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { checkSolanaDeposit, PoolRuleRefused, signSolana, type PoolAsk } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

export type PoolDepositHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** Two RPCs of different operators. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The note store, opened top-level. */
  notes(): Promise<NoteStore>;
  /** The 64-byte seed; zeroed here when the run ends. */
  seed64(): Promise<Uint8Array>;
  /** A note landed: the proof queue's pass, which makes the next buy's proof ahead. */
  landed?(note: NoteRecord): void;
  /** A deposit tx was sent (its signature), and each rung's stage as it comes: "sent", "filled" (landed). */
  sent?(signature: string): void;
  progress?(stage: TradeStage): void;
  /** U cannot pay a note's send: the lamports it is short (a top-up to its address lets the note go). */
  short?(address: string, lamports: bigint): void;
  /** Verdict reads before not_landed, and the wait between them. */
  reads?: number;
  wait?(ms: number): Promise<void>;
  now?(): bigint;
  /** Called by poolDepositKind once the run ends: the note store opened for it is closed. */
  end?(): void;
};

/** What a run answers: the trade stage with the deposits that landed (or, not landed, were sent), or a code. */
export type PoolDepositAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "failed" };

/** Verdict reads a note gets in one run, a second apart: about two finalizations and a blockhash's life (~60 to 90 s). */
export const POOL_DEPOSIT_READS = 120;
export const POOL_DEPOSIT_WAIT_MS = 1_000;

const POOL_LEN = 2179;
const POOL_DISC = /* @__PURE__ */ new TextEncoder().encode("bfpool01");
const TREE_LEN = 8 + 1 + 33 * 32;
const OFF_TREES = 49;
const PRE_MARK_LEN = 17;
const MARK_TAG = 1;
const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_ENTRIES = 1024;
/** A blockhash is valid for 150 blocks after the one it names (Solana's MAX_PROCESSING_AGE), so at most height + 151. */
const BLOCKHASH_LIFE = 151n;
const enc = /* @__PURE__ */ new TextEncoder();

type Code = "not_allowed" | "not_funded" | "failed" | "not_landed";
class Refused extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}
const int = (x: unknown): number => {
  if (!Number.isSafeInteger(x) || (x as number) < 0) throw new Refused("failed");
  return x as number;
};
const be32 = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const u64le = (x: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
};
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const both = <T>(h: PoolDepositHost, f: (rpc: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(h.rpcs[0]), f(h.rpcs[1])]);

/** One account as an RPC gives it (base64), with the slot it answered at; none when there is no account. */
async function account(rpc: SolanaRpc, address: string, commitment: "confirmed" | "finalized"): Promise<{ slot: number; owner: string; data: Uint8Array; lamports: bigint } | { slot: number; none: true }> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment }])) as { context?: { slot?: unknown }; value?: unknown };
  const slot = int(r?.context?.slot);
  const v = r?.value as { owner?: unknown; data?: unknown; lamports?: unknown } | null | undefined;
  if (v === null) return { slot, none: true };
  if (typeof v?.owner !== "string" || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") throw new Refused("failed");
  return { slot, owner: v.owner, data: base64.decode(v.data[0]), lamports: BigInt(int(v.lamports)) };
}

/** The pool account on both RPCs, the same bytes: its two tree sizes. */
async function treeSizes(h: PoolDepositHost, pool: string): Promise<{ stateSize: number; labelSize: number }> {
  const [a, b] = await both(h, (r) => account(r, pool, "confirmed"));
  if ("none" in a || "none" in b) throw new Refused("not_allowed");
  if (a.owner !== h.pin.program || b.owner !== h.pin.program || !sameBytes(a.data, b.data)) throw new Refused("failed");
  const d = a.data;
  if (d.length !== POOL_LEN || !sameBytes(d.subarray(0, 8), POOL_DISC)) throw new Refused("failed");
  const size = (at: number): number => int(Number(new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true)));
  return { stateSize: size(OFF_TREES), labelSize: size(OFF_TREES + TREE_LEN) };
}

/** A wallet's lamports: the lower of the two RPCs'. */
async function balanceOf(h: PoolDepositHost, address: string): Promise<bigint> {
  const [a, b] = await both(h, async (r) => {
    const x = await account(r, address, "confirmed");
    return "none" in x ? 0n : x.lamports;
  });
  return a < b ? a : b;
}

/** The precommitment mark on both RPCs at finalized: the deposit's value and nonce, and the higher slot; null unless both hold it. */
async function markOf(h: PoolDepositHost, precommitment: bigint): Promise<{ value: bigint; nonce: bigint; slot: number } | null> {
  const address = solanaProgramAddress([enc.encode("pre"), be32(precommitment)], h.pin.program);
  const [a, b] = await both(h, (r) => account(r, address, "finalized"));
  if ("none" in a || "none" in b) return null;
  if (a.owner !== h.pin.program || b.owner !== h.pin.program || !sameBytes(a.data, b.data)) throw new Refused("failed");
  const d = a.data;
  if (d.length !== PRE_MARK_LEN || d[16] !== MARK_TAG) throw new Refused("failed");
  const v = new DataView(d.buffer, d.byteOffset, 16);
  return { value: v.getBigUint64(0, true), nonce: v.getBigUint64(8, true), slot: Math.max(a.slot, b.slot) };
}

/** Both RPCs' finalized block height. */
async function heights(h: PoolDepositHost): Promise<[bigint, bigint]> {
  return both(h, async (r) => BigInt(int(await r("getBlockHeight", [{ commitment: "finalized" }]))));
}

/** The send that landed, for the answer only: one finalized with no error on either RPC, else none (a history an RPC no
 *  longer holds never changes a verdict). */
async function landedSend(h: PoolDepositHost, sends: readonly PoolSend[]): Promise<string | null> {
  const sigs = sends.map((s) => s.signature);
  const reads = await Promise.allSettled(h.rpcs.map((r) => r("getSignatureStatuses", [sigs, { searchTransactionHistory: true }])));
  for (const x of reads) {
    const v = x.status === "fulfilled" ? (x.value as { value?: unknown })?.value : null;
    if (!Array.isArray(v) || v.length !== sigs.length) continue;
    const k = v.findIndex((st) => (st as { confirmationStatus?: unknown; err?: unknown } | null)?.confirmationStatus === "finalized" && (st as { err?: unknown }).err === null);
    if (k >= 0) return sigs[k]!;
  }
  return null;
}

/** U's id (deposit or second arrival of U): its scope and index. */
function uOf(ref: NoteRef): { s: bigint; i: number } | null {
  if (ref.kind === "deposit") return { s: ref.s, i: ref.i };
  if (ref.kind === "second" && ref.id.id === "U") return { s: ref.id.s, i: ref.id.i };
  return null;
}

/** The run of one pool.deposit (`ask` already passed checkPoolRequest), or, with no ask, the INCOMING notes finished. */
export async function runPoolDeposit(h: PoolDepositHost, ask: PoolAsk | null): Promise<PoolDepositAnswer> {
  if (ask !== null && (ask.kind !== "pool.deposit" || ask.chain !== "solana")) return { error: "not_allowed" };
  const { pool, scope } = solanaPoolOf(h.pin.program);
  const store = await h.notes();
  const seed64 = await h.seed64();
  const sync = solanaTreeSync(h.rpcs, h.pin.program);
  const landedTxs: TxRef[] = [];
  const sentTxs: TxRef[] = [];
  const keys: Uint8Array[] = [];
  const wait = h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let rent: SolanaRent | null = null;
  try {
    const uKey = (u: { s: bigint; i: number }): { address: string; secretKey: Uint8Array } => {
      if (u.s !== scope) throw new Refused("not_allowed");
      const id = depositId(seed64, u.s, u.i);
      keys.push(id.secretKey);
      return { address: base58.encode(id.publicKey), secretKey: id.secretKey };
    };

    // a note's deposit of `value` by U: built, checked by the rule, simulated unsigned on both RPCs, then signed; its cost
    type Built = { tx: string; send: PoolSend; cost: bigint };
    type Unbuilt = { short: bigint } | { simulation: "failed" };
    const build = async (u: { address: string; secretKey: Uint8Array }, precommitment: bigint, value: bigint): Promise<Built | Unbuilt> => {
      const sizes = await treeSizes(h, pool);
      const bh = (await h.rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } };
      const blockhash = bh?.value?.blockhash;
      if (typeof blockhash !== "string") throw new Refused("failed");
      // the other RPC must know the blockhash too, and caps its life: one RPC never picks the tx's life alone
      const valid = (await h.rpcs[1]("isBlockhashValid", [blockhash, { commitment: "confirmed" }])) as { value?: unknown };
      if (valid?.value !== true) throw new Refused("failed");
      const said = BigInt(int(bh.value!.lastValidBlockHeight));
      const cap = BigInt(int(await h.rpcs[1]("getBlockHeight", [{ commitment: "confirmed" }]))) + BLOCKHASH_LIFE;
      const lastValid = said < cap ? said : cap;
      const pre = be32(precommitment);
      const ix = {
        program: h.pin.program,
        accounts: [
          { key: pool, signer: false, writable: true },
          { key: u.address, signer: true, writable: true },
          { key: solanaPoolPage(h.pin.program, 0, sizes.stateSize), signer: false, writable: true },
          { key: solanaPoolPage(h.pin.program, 1, sizes.labelSize), signer: false, writable: true },
          { key: solanaProgramAddress([enc.encode("pre"), pre], h.pin.program), signer: false, writable: true },
          { key: SOLANA_SYSTEM_PROGRAM, signer: false, writable: false },
        ],
        data: Uint8Array.of(1, ...u64le(value), ...pre),
      };
      const { message } = solanaCompileV0(u.address, [ix], blockhash, []);
      const wire = new Uint8Array(1 + 64 + message.length);
      wire[0] = 1;
      wire.set(message, 65);
      checkSolanaDeposit(
        wire,
        { ...(ask ?? { kind: "pool.deposit", chain: "solana", token: null, slippageBps: 0, decimals: 9 }), amount: value } as PoolAsk,
        { nowMs: (h.now ?? (() => BigInt(Date.now())))(), wallet: u.address, feeCap: 0n, solana: h.pin, precommitment },
        { blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize },
      );
      // the cost: the fee both RPCs price this message at, the mark's rent and each page's growth
      const [fa, fb] = await both(h, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
      if (fa !== fb) throw new Refused("failed");
      rent ??= await readSolanaRent(h.rpcs);
      const grow = (size: number): bigint => (size % PAGE_ENTRIES === 0 ? solanaRentMin(rent!, PAGE_HEADER + PAGE_ENTRY) : BigInt(PAGE_ENTRY) * rent!.lamportsPerByte * rent!.factor);
      const cost = fa + solanaRentMin(rent, PRE_MARK_LEN) + grow(sizes.stateSize) + grow(sizes.labelSize);
      const balance = await balanceOf(h, u.address);
      const left = balance - value - cost;
      if (left < 0n) return { short: -left };
      if (left > 0n && left < solanaRentMin(rent, 0)) return { short: solanaRentMin(rent, 0) - left };
      // unsigned: an RPC cannot send what it simulates
      const sims = await both(h, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } })?.value);
      if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) return { simulation: "failed" };
      const signature = signSolana(u.secretKey, wire);
      const signed = wire.slice();
      signed.set(signature, 1);
      return { tx: base64.encode(signed), send: { signature: base58.encode(signature), value, last_valid_block_height: lastValid }, cost };
    };

    // `own`: a send of this run's ask (or, with no ask, of the notes it settles), the only sends it tells the app of
    const send = async (b: Built, own: boolean): Promise<void> => {
      const out = await Promise.allSettled(h.rpcs.map((r) => r("sendTransaction", [b.tx, { encoding: "base64", preflightCommitment: "confirmed" }])));
      if (!own) return;
      // written before it left: whether an RPC took it or not, its verdict reads it
      sentTxs.push({ chain: "solana", hash: b.send.signature });
      if (out.some((s) => s.status === "fulfilled" && s.value === b.send.signature)) {
        h.sent?.(b.send.signature);
        h.progress?.("sent");
      }
    };

    // one INCOMING note, read up to `reads` times: landed (UNSPENT), taken (TAKEN), pending (INCOMING, maybe sent
    // again), or stuck (INCOMING: U cannot pay its send again)
    const finish = async (note: NoteRecord, own: boolean, reads: number): Promise<"landed" | "taken" | "pending" | "stuck"> => {
      let n = note;
      for (let k = 0; ; k++) {
        const sends = n.sends ?? [];
        if (sends.length === 0) throw new Refused("failed"); // a pool note goes INCOMING with its send, never without
        const value = sends[0]!.value; // every send of a note is at its recorded value (store addSend)
        const m = await markOf(h, n.precommitment);
        if (m !== null) {
          // a mark of another value is another deposit's: this precommitment is taken
          if (m.value !== value) {
            await store.move(n.id, "INCOMING", "TAKEN");
            return "taken";
          }
          if (m.nonce === 0n) throw new Refused("failed");
          const leaves = await sync.leaves(m.slot);
          const label = vaultLabelOf(keccak_256, scope, m.nonce);
          if (leaves.label[Number(m.nonce - 1n)] !== label) throw new Refused("failed");
          const commitment = noteCommitment(m.value, label, n.precommitment);
          const at = leaves.state.indexOf(commitment);
          if (at < 0 || leaves.state.indexOf(commitment, at + 1) >= 0) throw new Refused("failed");
          const leaf: Leaf = { value: m.value, label, commitment, leafIndex: BigInt(at) };
          const done = await store.move(n.id, "INCOMING", "UNSPENT", { leaf });
          const sig = own ? await landedSend(h, sends) : null;
          if (sig !== null) landedTxs.push({ chain: "solana", hash: sig });
          h.landed?.(done);
          if (own) h.progress?.("filled");
          return "landed";
        }
        // no mark: sent again at its own value only once no send of it can land, on both RPCs
        const last = sends.reduce((a, x) => (x.last_valid_block_height > a ? x.last_valid_block_height : a), 0n);
        if ((await heights(h)).every((x) => x > last)) {
          const u = uOf(n.ref);
          if (!u) throw new Refused("not_allowed");
          const key = uKey(u);
          const b = await build(key, n.precommitment, value);
          if (!("tx" in b)) {
            if ("short" in b) h.short?.(key.address, b.short);
            return "stuck";
          }
          const after = await store.addSend(n.id, b.send, sends.length);
          if ((after.sends ?? []).length === sends.length + 1 && after.sends!.at(-1)!.signature === b.send.signature) await send(b, own);
          n = after;
        }
        if (k + 1 >= reads) return "pending";
        await wait(POOL_DEPOSIT_WAIT_MS);
      }
    };

    // the pinned pool, on both RPCs, before any note is planned for its scope
    await treeSizes(h, pool);

    // a run a reload cut short: each INCOMING note of the pool's scope read once, as its own move, never waited on; a U
    // with a note still open is no source this run
    const busy = new Set<number>();
    let stuck = false;
    for (const n of await store.list()) {
      const u = n.state === "INCOMING" && n.scope === scope ? uOf(n.ref) : null;
      if (!u) continue;
      const end = await finish(n, ask === null, 1);
      if (end === "pending" || end === "stuck") busy.add(u.i);
      stuck ||= end === "stuck";
    }
    if (ask === null) return busy.size === 0 ? { stage: "filled", txs: landedTxs } : stuck && sentTxs.length === 0 && landedTxs.length === 0 ? { error: "not_funded" } : { stage: "not_landed", txs: sentTxs };

    const rungs = ladderSplit(SOL_LADDER, ask.amount).notes;
    if (rungs.length === 0) return { error: "not_allowed" };

    // the source: the newest U this scope used while it covers a rung and its costs, else the planned index's U. Its
    // notes: a new U's deposit note first, then that U's second arrivals in order (a PLANNED one is taken up again)
    const all = (await store.list()).filter((n) => n.scope === scope);
    const used = all.filter((n) => n.ref.kind === "deposit" && n.state !== "PLANNED").map((n) => (n.ref as { i: number }).i);
    const onU = (i: number): NoteRef => {
      const ns = all.filter((n) => n.ref.kind === "second" && n.ref.id.id === "U" && n.ref.id.i === i);
      const open = ns.find((n) => n.state === "PLANNED");
      if (open) return open.ref;
      const top = ns.map((n) => (n.ref as { n: number }).n);
      return { kind: "second", id: { id: "U", s: scope, i }, n: top.length ? Math.max(...top) + 1 : 0 };
    };
    const after = (r: NoteRef): NoteRef => (r.kind === "deposit" ? { kind: "second", id: { id: "U", s: r.s, i: r.i }, n: 0 } : { ...(r as Extract<NoteRef, { kind: "second" }>), n: (r as { n: number }).n + 1 });
    const free = used.filter((i) => !busy.has(i));
    const newest = free.length ? Math.max(...free) : null;
    let source: { s: bigint; i: number } | null = newest === null ? null : { s: scope, i: newest };
    let ref: NoteRef | null = source === null ? null : onU(source.i);

    for (let k = 0; k < rungs.length; ) {
      if (source === null || ref === null) {
        const first = await store.planDeposit(scope, (r) => noteSecrets(seed64, r).precommitment);
        source = uOf(first.ref)!;
        ref = first.ref;
      }
      const value = rungs[k]!;
      const precommitment = noteSecrets(seed64, ref).precommitment;
      const key = JSON.stringify(ref, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      const held = (await store.list()).find((n) => n.scope === scope && JSON.stringify(n.ref, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === key);
      const planned = held ?? (await store.add({ ref, scope, precommitment, state: "PLANNED" }));
      if (planned.state !== "PLANNED" || planned.precommitment !== precommitment) throw new Refused("failed");
      const from = uKey(source);
      const b = await build(from, precommitment, value);
      if (!("tx" in b)) {
        // another deposit took this precommitment while it was planned: marked taken, the next note planned
        if ((await markOf(h, precommitment)) !== null) {
          await store.move(planned.id, "PLANNED", "TAKEN");
          ref = after(ref);
          continue;
        }
        // the used U no longer covers a rung: the move starts on the planned index's U (its PLANNED note waits for it)
        if (k === 0 && source.i === newest && planned.ref.kind === "second") {
          source = null;
          ref = null;
          continue;
        }
        if (landedTxs.length) return { stage: "part_filled", txs: landedTxs };
        // an earlier note still landing holds its U: try again once it has
        if (busy.size > 0 && !stuck) return { stage: "not_landed", txs: [] };
        if ("short" in b) h.short?.(from.address, b.short);
        return { error: "not_funded" };
      }
      // written before the signed tx leaves the device: INCOMING with its send
      const incoming = await store.move(planned.id, "PLANNED", "INCOMING", { send: b.send });
      await send(b, true);
      const end = await finish(incoming, true, h.reads ?? POOL_DEPOSIT_READS);
      if (end === "pending") throw new Refused("not_landed");
      if (end === "stuck") throw new Refused("not_funded");
      if (end === "landed") k++;
      ref = after(ref);
    }
    return { stage: "filled", txs: landedTxs };
  } catch (e) {
    if (e instanceof Refused) return e.code === "not_landed" ? { stage: "not_landed", txs: sentTxs } : landedTxs.length ? { stage: "part_filled", txs: landedTxs } : { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "not_allowed" };
    throw e;
  } finally {
    for (const k of keys) k.fill(0);
    seed64.fill(0);
  }
}

/** The INCOMING notes of the pool's scope finished with no new ask: on page load and before each run. */
export const settlePoolDeposits = (h: PoolDepositHost): Promise<PoolDepositAnswer> => runPoolDeposit(h, null);

/** One deposit at a time on this device, every tab: two runs never plan or send for one note. */
export const POOL_DEPOSIT_LOCK = "ct-pool/deposit";

type Locks = Pick<LockManager, "request">;

/** The pool flow's pool.deposit on Solana, run holding the seed lock shared (a sign out, in any tab, waits for it) and
 *  POOL_DEPOSIT_LOCK. Answered at its first send (stage "sent" with that tx), or at its end when nothing was sent; each
 *  rung's landing then goes to the app as a `progress` event ("filled"), and a run that ends short as its stage. */
export function poolDepositKind(host: () => PoolDepositHost, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk | null, ctx: KindContext | null): HostRefusal | Running<"pool.deposit"> => {
    if ((ask !== null && (ask.kind !== "pool.deposit" || ask.chain !== "solana")) || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.deposit"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, () =>
        locks.request(POOL_DEPOSIT_LOCK, { mode: "exclusive" }, async () => {
          const h = host();
          let first = true;
          const run = {
            ...h,
            sent: (signature: string) => {
              if (!answer) answer = { result: { stage: "sent", txs: [{ chain: "solana", hash: signature }] } };
              give();
            },
            progress: (stage: TradeStage) => {
              if (stage === "sent" && first) return void (first = false);
              ctx?.progress(stage);
            },
          };
          try {
            const a = await runPoolDeposit(run, ask);
            if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
            else if ("stage" in a && a.stage !== "filled") ctx?.progress(a.stage);
          } finally {
            h.end?.();
          }
        }),
      )
      .catch(() => {
        if (!answer) answer = { error: "failed" };
      })
      .finally(give);
    void run;
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
