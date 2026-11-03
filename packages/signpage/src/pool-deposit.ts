// pool.deposit on the Solana pool (card signpage-pool-notes): the device's one-time wallet U puts SOL into the pinned
// pool, and each note is stored only once its deposit reads back on two RPCs.
//
// - W is U_{scope,i} (derive/keys.ts depositId), with i the index the note store plans for the pool's scope
//   (planDeposit: one unfunded index per scope, so the same U is named until money reaches it). The amount is split on
//   the pool's ladder (../../wallet/src/pool/ladder.ts ladderSplit, the refs as poolDepositPlan names them): the first
//   rung is the deposit note, each next rung that id's second arrival, each its own deposit, the next planned only once
//   the one before has landed. What is
//   left below the smallest rung stays on U.
// - Before anything is signed: U's balance on both RPCs (the lower) must cover the rung, else the note stays PLANNED and
//   the answer is not_funded; the pool account on both RPCs, byte for byte, gives the two tree sizes the deposit's pages
//   come from. The tx is built here, then checked by the rule (rules/pool.ts checkSolanaDeposit: one tag 1 into the
//   pinned pool, by U, of the rung, with the note's own precommitment) and signed only on the bytes that check passed.
// - A state is written before the act it names: PLANNED -> INCOMING before the tx leaves the device. INCOMING goes to
//   UNSPENT only when its precommitment mark reads back on both RPCs at finalized commitment, the same 17 bytes on each
//   (value the rung, a nonce, the program's tag), its label is the label tree's leaf nonce - 1 and its commitment
//   Poseidon(value, label, precommitment) a leaf of the state tree, both trees as both RPCs agree at or past the marks'
//   slots (../../wallet/src/pool/solana.ts solanaTreeSync). A mark that never reads back answers not_landed and a leaf
//   the trees do not hold answers failed; either way the note stays INCOMING, never stored as money.
// - An INCOMING note of the pool's scope (a run a reload cut short) is settled first: landed, it goes UNSPENT; else the
//   move carries on from it, its deposit signed and sent again with the move's first rung on its own U. The program makes the mark at the deposit, so the same precommitment can never
//   land twice: a second send of a deposit that landed fails on chain and moves nothing.
// - Each note that lands starts the proof queue's pass (`landed`), so the next buy's proof is made ahead.
// - Every read names a public account (the pool, its pages, U, the mark the deposit itself named); no request carries a
//   key, the words, or which note is whose. U's secret key and the seed are zeroed when the run ends. Nothing here logs.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { solanaPoolPage } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { depositId } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { Leaf, NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
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
  /** Mark reads before not_landed, and the wait between them. */
  reads?: number;
  wait?(ms: number): Promise<void>;
  now?(): bigint;
  /** Called by poolDepositKind once the run ends: the note store opened for it is closed. */
  end?(): void;
};

/** What a run answers: the trade stage with the deposits sent, or a code. */
export type PoolDepositAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "failed" };

/** About a finalized slot's depth of reads, a second apart. */
export const POOL_DEPOSIT_READS = 60;
export const POOL_DEPOSIT_WAIT_MS = 1_000;

const POOL_LEN = 2179;
const POOL_DISC = /* @__PURE__ */ new TextEncoder().encode("bfpool01");
const TREE_LEN = 8 + 1 + 33 * 32;
const OFF_TREES = 49;
const PRE_MARK_LEN = 17;
const MARK_TAG = 1;
const enc = /* @__PURE__ */ new TextEncoder();

class Refused extends Error {
  readonly code: "not_allowed" | "not_funded" | "failed" | "not_landed";
  constructor(code: Refused["code"]) {
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

/** One account as an RPC gives it (base64), with the slot it answered at; null when there is none. */
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
  const [a, b] = await Promise.all(h.rpcs.map((r) => account(r, pool, "confirmed")));
  if ("none" in a! || "none" in b!) throw new Refused("not_allowed");
  if (a.owner !== h.pin.program || b.owner !== h.pin.program || !sameBytes(a.data, b.data)) throw new Refused("failed");
  const d = a.data;
  if (d.length !== POOL_LEN || !sameBytes(d.subarray(0, 8), POOL_DISC)) throw new Refused("failed");
  const size = (at: number): number => int(Number(new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true)));
  return { stateSize: size(OFF_TREES), labelSize: size(OFF_TREES + TREE_LEN) };
}

/** U's lamports: the lower of the two RPCs'. */
async function balanceOf(h: PoolDepositHost, address: string): Promise<bigint> {
  const got = await Promise.all(
    h.rpcs.map(async (r) => {
      const a = await account(r, address, "confirmed");
      return "none" in a ? 0n : a.lamports;
    }),
  );
  return got[0]! < got[1]! ? got[0]! : got[1]!;
}

/** The precommitment mark on both RPCs at finalized: the deposit's value and nonce, and the higher slot; null until both hold it. */
async function markOf(h: PoolDepositHost, precommitment: bigint): Promise<{ value: bigint; nonce: bigint; slot: number } | null> {
  const address = solanaProgramAddress([enc.encode("pre"), be32(precommitment)], h.pin.program);
  const [a, b] = await Promise.all(h.rpcs.map((r) => account(r, address, "finalized")));
  if ("none" in a! || "none" in b!) return null;
  if (a.owner !== h.pin.program || b.owner !== h.pin.program || !sameBytes(a.data, b.data)) throw new Refused("failed");
  const d = a.data;
  if (d.length !== PRE_MARK_LEN || d[16] !== MARK_TAG) throw new Refused("failed");
  const v = new DataView(d.buffer, d.byteOffset, 16);
  return { value: v.getBigUint64(0, true), nonce: v.getBigUint64(8, true), slot: Math.max(a.slot, b.slot) };
}

/** U's id (deposit or second arrival of U): its scope and index. */
function uOf(ref: NoteRef): { s: bigint; i: number } | null {
  if (ref.kind === "deposit") return { s: ref.s, i: ref.i };
  if (ref.kind === "second" && ref.id.id === "U") return { s: ref.id.s, i: ref.id.i };
  return null;
}

/** The note after `ref` on U's id: its second arrival 0 after the deposit note, n + 1 after n. */
function nextOf(ref: NoteRef): NoteRef {
  if (ref.kind === "deposit") return { kind: "second", id: { id: "U", s: ref.s, i: ref.i }, n: 0 };
  if (ref.kind === "second" && ref.id.id === "U") return { kind: "second", id: ref.id, n: ref.n + 1 };
  throw new Refused("not_allowed");
}

/** The run of one pool.deposit; `ask` already passed checkPoolRequest. */
export async function runPoolDeposit(h: PoolDepositHost, ask: PoolAsk): Promise<PoolDepositAnswer> {
  if (ask.kind !== "pool.deposit" || ask.chain !== "solana") return { error: "not_allowed" };
  const { pool, scope } = solanaPoolOf(h.pin.program);
  const store = await h.notes();
  const seed64 = await h.seed64();
  const sync = solanaTreeSync(h.rpcs, h.pin.program);
  const txs: TxRef[] = [];
  const keys: Uint8Array[] = [];
  const wait = h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    // U's signer for a note of U_{s,i}: derived once, zeroed at the end
    const uKey = (ref: NoteRef): { address: string; secretKey: Uint8Array } => {
      const u = uOf(ref);
      if (!u || u.s !== scope) throw new Refused("not_allowed");
      const id = depositId(seed64, u.s, u.i);
      keys.push(id.secretKey);
      return { address: base58.encode(id.publicKey), secretKey: id.secretKey };
    };

    // the deposit of one INCOMING note: built, checked, signed and sent; null when no RPC took it
    const send = async (note: NoteRecord, value: bigint): Promise<string | null> => {
      const u = uKey(note.ref);
      const sizes = await treeSizes(h, pool);
      const bh = (await h.rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value?: { blockhash?: unknown } };
      const blockhash = bh?.value?.blockhash;
      if (typeof blockhash !== "string") throw new Refused("failed");
      const pre = be32(note.precommitment);
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
        { ...ask, amount: value },
        { nowMs: (h.now ?? (() => BigInt(Date.now())))(), wallet: u.address, feeCap: 0n, solana: h.pin, precommitment: note.precommitment },
        { blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize },
      );
      const signature = signSolana(u.secretKey, wire);
      const signed = wire.slice();
      signed.set(signature, 1);
      const sig = base58.encode(signature);
      const tx = base64.encode(signed);
      const sent = await Promise.allSettled(h.rpcs.map((r) => r("sendTransaction", [tx, { encoding: "base64", preflightCommitment: "confirmed" }])));
      if (!sent.some((s) => s.status === "fulfilled" && s.value === sig)) return null;
      txs.push({ chain: "solana", hash: sig });
      return sig;
    };

    // INCOMING -> UNSPENT once its mark and both leaves read back on both RPCs; null while the mark is not there
    const settle = async (note: NoteRecord, value: bigint | null): Promise<NoteRecord | null> => {
      const m = await markOf(h, note.precommitment);
      if (m === null) return null;
      if (m.value === 0n || m.nonce === 0n || (value !== null && m.value !== value)) throw new Refused("failed");
      const leaves = await sync.leaves(m.slot);
      const label = vaultLabelOf(keccak_256, scope, m.nonce);
      if (leaves.label[Number(m.nonce - 1n)] !== label) throw new Refused("failed");
      const commitment = noteCommitment(m.value, label, note.precommitment);
      const at = leaves.state.indexOf(commitment);
      if (at < 0 || leaves.state.indexOf(commitment, at + 1) >= 0) throw new Refused("failed");
      const leaf: Leaf = { value: m.value, label, commitment, leafIndex: BigInt(at) };
      const done = await store.move(note.id, "INCOMING", "UNSPENT", { leaf });
      h.landed?.(done);
      return done;
    };

    // the mark read until both RPCs hold it at finalized; `value` null for a resumed note (the mark's value is the truth)
    const landing = async (note: NoteRecord, value: bigint | null): Promise<NoteRecord> => {
      for (let k = 0; k < (h.reads ?? POOL_DEPOSIT_READS); k++) {
        const done = await settle(note, value);
        if (done) return done;
        await wait(POOL_DEPOSIT_WAIT_MS);
      }
      throw new Refused("not_landed");
    };

    // the pinned pool, on both RPCs, before any note is planned for its scope
    await treeSizes(h, pool);

    // a run a reload cut short: each INCOMING note of the pool's scope that landed goes UNSPENT; the first one that has
    // not carries this move on, on its own U (its deposit sent again with this move's first rung)
    let stuck: NoteRecord | null = null;
    for (const n of await store.list()) {
      if (n.state !== "INCOMING" || n.scope !== scope || !uOf(n.ref)) continue;
      if (!(await settle(n, null)) && stuck === null) stuck = n;
    }

    // the move: its rungs on U's id, the first on the stuck note or the planned deposit note, then the id's second
    // arrivals in order (poolDepositPlan's refs), each landed before the next is planned
    const rungs = ladderSplit(SOL_LADDER, ask.amount).notes;
    if (rungs.length === 0) return { error: "not_allowed" };
    const first = stuck ?? (await store.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment));
    const u = uKey(first.ref);
    const total = rungs.reduce((s, v) => s + v, 0n);
    if ((await balanceOf(h, u.address)) < total) return { error: "not_funded" };
    let ref = first.ref;
    for (const [k, value] of rungs.entries()) {
      let incoming: NoteRecord;
      if (k === 0 && stuck) incoming = stuck;
      else {
        if (k > 0) ref = nextOf(ref);
        const precommitment = noteSecrets(seed64, ref).precommitment;
        const planned = k === 0 ? first : await store.add({ ref, scope, precommitment, state: "PLANNED" });
        if (planned.precommitment !== precommitment) throw new Refused("failed");
        // written before the precommitment leaves the device
        incoming = await store.move(planned.id, "PLANNED", "INCOMING");
      }
      if ((await send(incoming, value)) === null) return txs.length ? { stage: "not_landed", txs } : { error: "failed" };
      await landing(incoming, k === 0 && stuck ? null : value);
    }
    return { stage: "filled", txs };
  } catch (e) {
    if (e instanceof Refused) return e.code === "not_landed" ? { stage: "not_landed", txs } : { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "not_allowed" };
    throw e;
  } finally {
    for (const k of keys) k.fill(0);
    seed64.fill(0);
  }
}

/** One deposit at a time on this device, every tab: two runs never plan or send for one note. */
export const POOL_DEPOSIT_LOCK = "ct-pool/deposit";

type Locks = Pick<LockManager, "request">;

/** The pool flow's pool.deposit on Solana: run holding the seed lock shared (a sign out, in any tab, waits for it) and
 *  POOL_DEPOSIT_LOCK, answered once it ends. `host` is made for each run. */
export function poolDepositKind(host: () => PoolDepositHost, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, _ctx: KindContext): HostRefusal | Running<"pool.deposit"> => {
    if (ask.kind !== "pool.deposit" || ask.chain !== "solana" || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.deposit"> | HostRefusal = { error: "failed" };
    const after = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, () =>
        locks.request(POOL_DEPOSIT_LOCK, { mode: "exclusive" }, async () => {
          const h = host();
          try {
            const a = await runPoolDeposit(h, ask);
            answer = "error" in a ? { error: a.error } : { result: a };
          } finally {
            h.end?.();
          }
        }),
      )
      .catch(() => {
        answer = { error: "failed" };
      });
    return { running: true, after, answer: () => answer };
  };
}
