// The note store: notes, their states and the deposit index, in the wrapped store on SIGN_HOST (card wallet-note-store,
// lane W2.1; docs/plan1/wallet.md at research 7838dbe, which the card cites at ffcba5e as W:193-203, W:1051, W:1089):
// the `notes` row of the note store table :198, Secrets :176-192, the deposit index rule :346-353, the held note
// :385-391, deposit step 9 :418, a stopped arm :363-365 and a stopped piece :748-749, the other device :230-231, the
// change :744-746, P-01 :1060; the send margin is markets.md H3.4 check 9 (:1376-1377).
//
// What callers must do (the store cannot see the outside world):
// - A withdrawal's spend is recorded only through add(child, parent): the change note (and the refund note) is born
//   UNSPENT naming its parent, and the parent goes to SPENT with it. No caller moves a parent to SPENT by hand.
// - Await move(HELD -> RESERVED) before anything of that proof leaves the device: no keepalive fetch, no service-worker
//   send, no beacon started before the write has resolved. Await planDeposit before the precommitment leaves.
// - Every block time handed in (blockTimeMs) is the chain's, read on two RPCs, never the device clock.
// - Mark a deposit note TAKEN only before its index's first quote leaves the device. History on that index after that is
//   our own (the user's send), so the note moves to INCOMING instead.
// - The wallet store's own put/delete on "notes" stay open to callers today; only this module writes notes.
//
// - Every record goes through the wallet store's put, one IndexedDB transaction with strict durability, wrapped under
//   K_wrap (../store). A note never holds its nullifier or its secret: they come back from the seed by its ref
//   (./secrets.ts), so the record holds only what the paper's row names, and an unknown field is refused.
// - States and the only edges between them, read from the row; any other move is refused before anything is written,
//   and a move names the state it expects (a compare-and-set), so a tab acting on a stale read changes nothing.
// - A state is written before the act it names. RESERVED is written before the proof leaves the device, so a page killed
//   mid-send leaves RESERVED, never a HELD note that could be picked again while its proof lands. RESERVED goes back to
//   UNSPENT only once block time is past its deadline_ms: a proof the relayer calls refused can still land before then.
// - HELD names its attempt (a random token the move to HELD returns) and its tab. Only that attempt sends the proof or
//   drops it; a dropped or replaced proof finishing late is refused. Another tab frees a HELD note only once block time
//   is past deadline_ms less the 30 s send margin, when no request can pass check 9 any more, or once the holding tab
//   is dead: each note store holds the Web Lock "ct-wallet/tab/<id>" for its life (the browser lets it go when the
//   page dies), and every open, get, list and move reads navigator.locks.query() and frees a dead tab's HELD notes at
//   once (the coordinator's call on 09af69f, :389-390). Safe because a HELD note's proof was never sent.
// - A child is written first, then its parent goes to SPENT. A page killed between the two leaves a parent not yet
//   SPENT; every open, get, list and move finishes it first, and a move of such a parent to anything but SPENT is
//   refused. The parent is derived from the child's (l, j): change note j of label l is made by spending the note of
//   label l with change index j (j = 0: the label's first note; else change note j - 1), :116-124, keys.ts changeIndex.
// - Deposit index: one unfunded index per scope (:349-353). planDeposit hands back the scope's PLANNED deposit note
//   while there is one; else it reads the counter, makes the precommitment for that index, and only then reserves it
//   (written before it is returned, ../store) and writes the note PLANNED. A page killed between the two skips an index
//   nothing outside ever saw. An index that shows history this store did not record is "marked taken and skipped"
//   (:347-348): PLANNED -> TAKEN, terminal, and the next planDeposit names a new index.
// - Second arrivals: n counts from 0 per id with no gap, and n + 1 is planned only once n has landed (:191-192), so
//   restore's walk "until the first miss" finds every one.
// - Every note write runs under the Web Lock "ct-wallet/notes", so two tabs never both act on one read. With no Web
//   Locks the note store does not open, as the seed is never written without them (../store). A closed note store
//   writes nothing more, also for a move already inside the lock.
// - Bind calls (card wallet-deposit-bind, R2-2): every deposit call U signs for a note is written with the note before
//   it is sent, one write under the notes lock (addCall), and the relayer's tx hash for it once heard (addCallTx). The
//   bind sends nothing whose write failed. addCall is a compare-and-set on the number of calls the caller last read,
//   so of two binds of one note (two tabs, a reload) only the first to write sends; the other follows that call. A
//   note holds its calls from INCOMING on (a call is signed only for an INCOMING note) and keeps them once landed, so
//   the clean-up gate reads every call U signed after a reload. Nothing in a call is secret: its signed bytes go to
//   the relayer and the rest is on chain.
// - Attempt contexts (card wallet-withdraw-request; wallet.md l.214-217): the move UNSPENT -> HELD takes the attempt's
//   withdrawal context (a decimal below p) and appends { context, deadlineMs } to the note's contexts in the same
//   compare-and-set, so the context is stored before its proof starts. Only the move HELD -> UNSPENT removes an entry,
//   the freed attempt's own: a HELD proof was never sent (RESERVED is written first), so it can never land. Every
//   sent attempt's entry stays: it can still land before its own deadline, and the device may read its spend only
//   later. So a note proved again every epoch keeps a short list. A spends record whose
//   context is in the list is this device's own (the check itself is the sync and arming cards'). The list stays
//   small, as each new attempt needs the note freed or expired first. Nothing in it is secret: the context goes on
//   chain with the proof, and the ops records, which the frame reads, never hold it.
import { VAULT_FIELD_P } from "@blindfill/kit";
import { CHAINS } from "../derive/index.ts";
import type { WalletStore } from "../store/index.ts";
import { noteCommitment, type NoteRef } from "./secrets.ts";

export const NOTES_LOCK = "ct-wallet/notes";
export const TAB_LOCK = "ct-wallet/tab/"; // + the tab's id
// markets.md H3.4 check 9 (:1376-1377): a request is sent only with deadline_ms at least 30 s (120 s when it funds A)
// past the newest final block, so past deadline_ms - 30 s no proof of this device can be sent
export const SEND_MARGIN_MS = 30_000n;

export const NOTE_STATES = ["PLANNED", "INCOMING", "UNSPENT", "HELD", "RESERVED", "SPENT", "TAKEN"] as const;
export type NoteState = (typeof NOTE_STATES)[number];

// The legal edges (wallet.md:198 unless named).
export const NOTE_EDGES: Readonly<Record<NoteState, readonly NoteState[]>> = Object.freeze({
  // INCOMING: money on its way. TAKEN: a deposit index with history this store did not record (:347-348)
  PLANNED: Object.freeze(["INCOMING", "TAKEN"] as const),
  INCOMING: Object.freeze(["UNSPENT"] as const), // its leaf read on two RPCs (:418)
  // HELD: a proof of this device has started. SPENT: another device's withdrawal spent it (:230-231)
  UNSPENT: Object.freeze(["HELD", "SPENT"] as const),
  // UNSPENT: the proof dropped or too late to send (:389-390); RESERVED: written before the proof is sent
  HELD: Object.freeze(["UNSPENT", "RESERVED", "SPENT"] as const),
  // UNSPENT: block time past its deadline_ms with nothing landed (:363-365, :748-749)
  RESERVED: Object.freeze(["SPENT", "UNSPENT"] as const),
  SPENT: Object.freeze([] as const),
  TAKEN: Object.freeze([] as const),
});
const LANDED: readonly NoteState[] = ["UNSPENT", "HELD", "RESERVED", "SPENT"];

/** What the vault's `deposits` pages give a note, read on two RPCs. */
export type Leaf = { value: bigint; label: bigint; commitment: bigint; leafIndex: bigint };

export type NoteRecord = {
  id: string;
  ref: NoteRef; // kind and the index i, j or n its secrets come from
  scope: bigint;
  precommitment: bigint;
  state: NoteState;
  parent?: string; // a change or refund note: the note whose withdrawal made it
  leaf?: Leaf; // from UNSPENT on, never changed
  deadlineMs?: bigint; // HELD and RESERVED: the attempt's deadline_ms (block time)
  attempt?: string; // HELD and RESERVED: the attempt whose proof holds it (not a secret)
  tab?: string; // HELD: the id of the tab whose proof holds it (not a secret)
  calls?: BindCall[]; // from INCOMING on: the deposit calls U signed for it, in the order written
  contexts?: AttemptContext[]; // from its first HELD on: every attempt's context and deadline_ms, in the order written
};

/** A withdrawal attempt's context (a canonical decimal below p) and its deadline_ms, written with the move to HELD. */
export type AttemptContext = { context: string; deadlineMs: bigint };

/** A deposit call U signed for a note (../deposit/delegate.ts SignedDepositDelegate), and the tx hashes heard for it. */
export type BindCall = {
  signed_delegate: string; // borsh(SignedDelegateAction), standard base64
  sender_id: string; // U
  receiver_id: string;
  nonce: bigint;
  max_block_height: bigint;
  public_key: string;
  balance: bigint; // U's USDC in the read the call was signed from
  tx_hashes: string[]; // the relayer's 200 {tx_hash} answers for these bytes, as heard
};
export type NewBindCall = Omit<BindCall, "tx_hashes">;

/** A note born PLANNED (a return, move or second-arrival note) or UNSPENT (a change or refund note, or one restore found). */
export type NewNote = {
  ref: NoteRef;
  scope: bigint;
  precommitment: bigint;
  state: "PLANNED" | "UNSPENT";
  parent?: string;
  leaf?: Leaf;
};

// leaf: INCOMING -> UNSPENT. deadlineMs and context: UNSPENT -> HELD. attempt: the holder's HELD -> RESERVED or
// HELD -> UNSPENT. blockTimeMs: RESERVED -> UNSPENT (past deadline_ms), or another tab's HELD -> UNSPENT (past
// deadline_ms - margin).
export type MoveFields = { leaf?: Leaf; deadlineMs?: bigint; context?: string; attempt?: string; blockTimeMs?: bigint };

export interface NoteStore {
  get(id: string): Promise<NoteRecord | undefined>;
  list(): Promise<NoteRecord[]>;
  planDeposit(scope: bigint, precommitmentOf: (ref: NoteRef) => bigint): Promise<NoteRecord>;
  add(note: NewNote): Promise<NoteRecord>;
  move(id: string, from: NoteState, to: NoteState, fields?: MoveFields): Promise<NoteRecord>;
  /**
   * Writes a call U signed for an INCOMING note, before it is sent, when the note still holds `seen` calls (else
   * nothing is written: another bind's call came first). Returns the note as stored.
   */
  addCall(id: string, call: NewBindCall, seen: number): Promise<NoteRecord>;
  /** Writes a tx hash the relayer gave for one of the note's calls (named by its nonce and max_block_height). */
  addCallTx(id: string, call: Pick<BindCall, "nonce" | "max_block_height">, txHash: string): Promise<NoteRecord>;
  /** Lets this tab's lock go, as the page's death does (tests; a page need not call it). */
  close(): void;
}

export interface NoteStoreOptions {
  locks?: LockManager | null; // null: no Web Locks, and the note store refuses to open
  lockName?: string; // tests only
}

// ---------- checks ----------
const U32 = 0xffffffff;
const HEX32 = /^[0-9a-f]{32}$/;
const fieldOk = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n && x < VAULT_FIELD_P;
function field(x: unknown, what: string): bigint {
  if (!fieldOk(x)) throw new Error(`${what} is not a field element in [0, p)`);
  return x;
}
function u32(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > U32) throw new Error(`${what} is not an index in [0, 2^32)`);
  return x;
}
function onlyKeys(o: object, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${what} may not hold ${k}`);
}
function chain(c: unknown): void {
  if (typeof c !== "string" || !Object.hasOwn(CHAINS, c)) throw new Error(`unknown chain tag ${String(c)}`);
}

// One string per ref, so no index repeats (P-01).
export function refKey(ref: NoteRef): string {
  if (ref === null || typeof ref !== "object") throw new Error("a note ref is an object");
  switch (ref.kind) {
    case "deposit":
      onlyKeys(ref, ["kind", "s", "i"], "a deposit ref");
      return `deposit/${field(ref.s, "s")}/${u32(ref.i, "i")}`;
    case "change":
    case "move":
    case "refund":
      onlyKeys(ref, ["kind", "l", "j"], `a ${ref.kind} ref`);
      return `${ref.kind}/${field(ref.l, "l")}/${u32(ref.j, "j")}`;
    case "return":
      onlyKeys(ref, ["kind", "c", "l", "j"], "a return ref");
      chain(ref.c);
      return `return/${ref.c}/${field(ref.l, "l")}/${u32(ref.j, "j")}`;
    case "second":
      onlyKeys(ref, ["kind", "id", "n"], "a second-arrival ref");
      return `second/${secondIdKey(ref.id)}/${u32(ref.n, "n")}`;
    default:
      throw new Error("unknown note kind");
  }
}
type SecondId = Extract<NoteRef, { kind: "second" }>["id"];
function secondIdKey(id: SecondId): string {
  if (id === null || typeof id !== "object") throw new Error("a second-arrival id is an object");
  switch (id.id) {
    case "U":
      onlyKeys(id, ["id", "s", "i"], "id U");
      return `U/${field(id.s, "s")}/${u32(id.i, "i")}`;
    case "V":
    case "A":
      onlyKeys(id, ["id", "l", "j"], `id ${id.id}`);
      return `${id.id}/${field(id.l, "l")}/${u32(id.j, "j")}`;
    case "R":
      onlyKeys(id, ["id", "c", "l", "j"], "id R");
      chain(id.c);
      return `R/${id.c}/${field(id.l, "l")}/${u32(id.j, "j")}`;
    default:
      throw new Error("unknown second-arrival id");
  }
}
// The id's first note, which second arrival 0 follows (:186-192); an arming account A has none.
function firstOf(id: SecondId): NoteRef | null {
  switch (id.id) {
    case "U": return { kind: "deposit", s: id.s, i: id.i };
    case "R": return { kind: "return", c: id.c, l: id.l, j: id.j };
    case "V": return { kind: "move", l: id.l, j: id.j };
    case "A": return null;
  }
}

function checkLeaf(leaf: unknown, precommitment: bigint): Leaf {
  if (leaf === null || typeof leaf !== "object") throw new Error("a leaf is { value, label, commitment, leafIndex }");
  onlyKeys(leaf, ["value", "label", "commitment", "leafIndex"], "a leaf");
  const { value, label, commitment, leafIndex } = leaf as Leaf;
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 128n) throw new Error("a note's value is a u128 bigint");
  field(label, "label");
  field(commitment, "commitment");
  if (typeof leafIndex !== "bigint" || leafIndex < 0n || leafIndex >= 1n << 64n) throw new Error("leafIndex is a u64 bigint");
  // a leaf that does not hash to its commitment is not this note's (the vault computes it, D29)
  if (noteCommitment(value, label, precommitment) !== commitment) throw new Error("the leaf's commitment is not this note's");
  return { value, label, commitment, leafIndex };
}
function u64(d: unknown, what: string): bigint {
  if (typeof d !== "bigint" || d <= 0n || d >= 1n << 64n) throw new Error(`${what} is a u64 bigint above 0`);
  return d;
}
// A context as the vault and the relayer read it: one canonical decimal below p.
function context(c: unknown, what: string): string {
  if (typeof c !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(c) || BigInt(c) >= VAULT_FIELD_P) throw new Error(`${what}: a context is a canonical decimal below p`);
  return c;
}
// The attempt contexts of a note: at least one, each its own context with a deadline, none written twice.
function checkContexts(cs: unknown, id: string): AttemptContext[] {
  if (!Array.isArray(cs) || cs.length === 0) throw new Error(`note ${id}: contexts is a list of attempts`);
  cs.forEach((c, k) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) throw new Error(`note ${id}: contexts[${k}] is not an attempt`);
    onlyKeys(c, ["context", "deadlineMs"], `note ${id}: contexts[${k}]`);
    context(c.context, `note ${id}: contexts[${k}]`);
    u64(c.deadlineMs, `note ${id}: contexts[${k}].deadlineMs`);
    if (cs.some((d: AttemptContext, j) => j < k && d.context === c.context)) throw new Error(`note ${id}: context ${k} is written twice`);
  });
  return cs;
}
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const U_ID = /^[0-9a-f]{64}$/;
// A bind call's shape: the signed bytes (at most the relayer's 4,096-byte body), U's implicit id, the fields the bind
// follows it by, and the hashes heard, each a 32-byte base58 hash at most once.
function checkCall(c: unknown, what: string, hashes: boolean): BindCall {
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw new Error(`${what} is not a call`);
  const keys = ["signed_delegate", "sender_id", "receiver_id", "nonce", "max_block_height", "public_key", "balance"];
  onlyKeys(c, hashes ? [...keys, "tx_hashes"] : keys, what);
  const x = c as BindCall;
  if (typeof x.signed_delegate !== "string" || x.signed_delegate.length > 5_464 || !B64.test(x.signed_delegate)) throw new Error(`${what}: signed_delegate is base64`);
  if (typeof x.sender_id !== "string" || !U_ID.test(x.sender_id)) throw new Error(`${what}: sender_id is an implicit id`);
  if (typeof x.receiver_id !== "string" || x.receiver_id.length === 0 || x.receiver_id.length > 64) throw new Error(`${what}: receiver_id is an account`);
  if (typeof x.public_key !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.public_key)) throw new Error(`${what}: public_key is ed25519`);
  u64(x.nonce, `${what}: nonce`);
  u64(x.max_block_height, `${what}: max_block_height`);
  if (typeof x.balance !== "bigint" || x.balance < 0n || x.balance >= 1n << 128n) throw new Error(`${what}: balance is a u128 bigint`);
  if (hashes) {
    if (!Array.isArray(x.tx_hashes) || x.tx_hashes.some((h) => typeof h !== "string" || h.length > 44 || !B58.test(h)) || new Set(x.tx_hashes).size !== x.tx_hashes.length)
      throw new Error(`${what}: tx_hashes are base58 hashes, each once`);
  }
  return x;
}
// The calls of a note: one sender, nonces never going back, (nonce, max_block_height) naming one call.
function checkCalls(calls: unknown, id: string): BindCall[] {
  if (!Array.isArray(calls) || calls.length === 0) throw new Error(`note ${id}: calls is a list of calls`);
  calls.forEach((c, k) => {
    checkCall(c, `note ${id} call ${k}`, true);
    const prev = k === 0 ? undefined : (calls[k - 1] as BindCall);
    if (prev !== undefined && (c.sender_id !== prev.sender_id || c.nonce < prev.nonce)) throw new Error(`note ${id}: call ${k} is not U's next`);
    if (calls.some((d: BindCall, j) => j < k && d.nonce === c.nonce && d.max_block_height === c.max_block_height)) throw new Error(`note ${id}: call ${k} is written twice`);
  });
  return calls;
}

// A record read back: the whole shape, so a broken record stops the caller instead of being acted on.
function checkRecord(id: string, r: unknown): NoteRecord {
  if (r === null || typeof r !== "object") throw new Error(`note ${id} is not a record`);
  const n = r as NoteRecord;
  onlyKeys(n, ["id", "ref", "scope", "precommitment", "state", "parent", "leaf", "deadlineMs", "attempt", "tab", "calls", "contexts"], `note ${id}`);
  if (n.id !== id) throw new Error(`note ${id} names another id`);
  refKey(n.ref);
  field(n.scope, "scope");
  if (n.ref.kind === "deposit" && n.ref.s !== n.scope) throw new Error(`note ${id}: a deposit note's scope is its s`);
  field(n.precommitment, "precommitment");
  if (!NOTE_STATES.includes(n.state)) throw new Error(`note ${id} has no state`);
  if (n.state === "TAKEN" && n.ref.kind !== "deposit") throw new Error(`note ${id}: only a deposit index is taken`);
  if (LANDED.includes(n.state) !== (n.leaf !== undefined)) throw new Error(`note ${id}: a leaf from UNSPENT on, and only then`);
  if (n.leaf !== undefined) checkLeaf(n.leaf, n.precommitment);
  const proving = n.state === "HELD" || n.state === "RESERVED";
  if (proving !== (n.deadlineMs !== undefined)) throw new Error(`note ${id}: deadlineMs in HELD and RESERVED only`);
  if (n.deadlineMs !== undefined) u64(n.deadlineMs, "deadlineMs");
  if (proving !== (typeof n.attempt === "string" && HEX32.test(n.attempt))) throw new Error(`note ${id}: an attempt in HELD and RESERVED only`);
  if ((n.state === "HELD") !== (typeof n.tab === "string" && HEX32.test(n.tab))) throw new Error(`note ${id}: a tab id in HELD only`);
  if (n.parent !== undefined && (typeof n.parent !== "string" || (n.ref.kind !== "change" && n.ref.kind !== "refund"))) throw new Error(`note ${id}: only a change or refund note has a parent`);
  if (n.calls !== undefined) {
    if (n.ref.kind !== "deposit" && n.ref.kind !== "second") throw new Error(`note ${id}: only a deposit or second-arrival note has calls`);
    if (n.state === "PLANNED" || n.state === "TAKEN") throw new Error(`note ${id}: calls from INCOMING on`);
    checkCalls(n.calls, id);
  }
  // contexts: only on a note that has been HELD (a landed note), always while HELD or RESERVED, the last one this attempt's
  if (n.contexts !== undefined) {
    if (!LANDED.includes(n.state)) throw new Error(`note ${id}: contexts only on a note that has been HELD`);
    checkContexts(n.contexts, id);
  }
  if (proving && (n.contexts === undefined || n.contexts[n.contexts.length - 1]!.deadlineMs !== n.deadlineMs))
    throw new Error(`note ${id}: HELD and RESERVED hold their attempt's contexts entry last`);
  return n;
}

// A record with no undefined field (the wallet store refuses undefined).
function record(n: NoteRecord): NoteRecord {
  const out: NoteRecord = { id: n.id, ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: n.state };
  if (n.parent !== undefined) out.parent = n.parent;
  if (n.leaf !== undefined) out.leaf = n.leaf;
  if (n.deadlineMs !== undefined) out.deadlineMs = n.deadlineMs;
  if (n.attempt !== undefined) out.attempt = n.attempt;
  if (n.tab !== undefined) out.tab = n.tab;
  if (n.calls !== undefined) out.calls = n.calls;
  if (n.contexts !== undefined) out.contexts = n.contexts;
  return out;
}

const newId = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// The note a change or refund note (l, j) comes from: the one of label l with change index j (keys.ts changeIndex:
// a label's first note makes change 0, change note k makes change k + 1). Undefined when the store holds none.
function parentOf(child: NoteRef, scope: bigint, all: NoteRecord[]): NoteRecord | undefined {
  if (child.kind !== "change" && child.kind !== "refund") return undefined;
  const hits = all.filter(
    (p) =>
      p.leaf !== undefined &&
      p.leaf.label === child.l &&
      p.scope === scope &&
      (child.j === 0 ? p.ref.kind !== "change" : p.ref.kind === "change" && p.ref.j === child.j - 1),
  );
  if (hits.length > 1) throw new Error(`label ${child.l} has ${hits.length} notes with change index ${child.j}`);
  return hits[0];
}

// ---------- the store ----------
export async function openNoteStore(store: WalletStore, opts: NoteStoreOptions = {}): Promise<NoteStore> {
  const locks = opts.locks === undefined ? (globalThis.navigator?.locks ?? null) : opts.locks;
  if (!locks) throw new Error("no Web Locks: notes change only under the notes lock");
  const lockName = opts.lockName ?? NOTES_LOCK;
  let closed = false; // a closed tab's lock is gone, so it may not hold or change a note any more
  // async, so a refusal rejects the callback's promise and the lock goes back (Node keeps a lock whose callback throws)
  const locked = <T>(fn: () => Promise<T>): Promise<T> =>
    locks.request(lockName, { mode: "exclusive" }, async () => {
      if (closed) throw new Error("the note store is closed");
      return fn();
    }) as Promise<T>;
  // this tab's lock, held until close() or the page's death
  const tab = newId();
  let letGo = (): void => {};
  await new Promise<void>((held, no) => {
    locks
      .request(TAB_LOCK + tab, { mode: "exclusive" }, () => {
        held();
        return new Promise<void>((ok) => (letGo = ok));
      })
      .catch(no);
  });

  const read = async (id: string): Promise<NoteRecord | undefined> => {
    const r = await store.get("notes", id);
    return r === undefined ? undefined : checkRecord(id, r);
  };
  const readAll = async (): Promise<NoteRecord[]> => Promise.all((await store.keys("notes")).map(async (k) => (await read(k))!));
  const write = (n: NoteRecord): Promise<void> => {
    if (closed) throw new Error("the note store is closed"); // also a call that entered the lock before close()
    return store.put("notes", n.id, record(n));
  };

  // The one write of a state change: shape and fields checked, then one put. The callers check edge and ownership.
  async function put(cur: NoteRecord, to: NoteState, fields: MoveFields = {}): Promise<NoteRecord> {
    const next: NoteRecord = { ...cur, state: to };
    if (cur.state === "INCOMING") next.leaf = checkLeaf(fields.leaf, cur.precommitment);
    else if (fields.leaf !== undefined) throw new Error("a leaf is set once, when the note lands");
    if (to === "HELD") {
      next.deadlineMs = u64(fields.deadlineMs, "deadlineMs");
      const c = context(fields.context, "context");
      next.contexts = checkContexts([...(cur.contexts ?? []), { context: c, deadlineMs: next.deadlineMs }], cur.id);
      next.attempt = newId();
      next.tab = tab;
    } else {
      if (fields.deadlineMs !== undefined) throw new Error("deadlineMs is set when the proof starts (HELD)");
      if (fields.context !== undefined) throw new Error("a context is written when the proof starts (HELD)");
      delete next.tab;
      // the freed attempt was never sent: its context goes (it is the last entry, checkRecord)
      if (cur.state === "HELD" && to === "UNSPENT") {
        const kept = (cur.contexts ?? []).slice(0, -1);
        if (kept.length > 0) next.contexts = kept;
        else delete next.contexts;
      }
      if (to !== "RESERVED") {
        delete next.deadlineMs;
        delete next.attempt;
      }
    }
    await write(next);
    return next;
  }

  // Finish what a killed page or tab left: parents of stored children go to SPENT, dead tabs' HELD notes to UNSPENT.
  async function settle(): Promise<NoteRecord[]> {
    const all = await readAll();
    const byId = new Map(all.map((n) => [n.id, n]));
    for (const n of all) {
      const p = n.parent === undefined ? undefined : byId.get(n.parent);
      if (p !== undefined && p.state !== "SPENT") byId.set(p.id, await put(p, "SPENT"));
    }
    if ([...byId.values()].some((n) => n.state === "HELD")) {
      const live = new Set(((await locks!.query()).held ?? []).map((l) => l.name));
      for (const n of byId.values()) if (n.state === "HELD" && !live.has(TAB_LOCK + n.tab)) byId.set(n.id, await put(n, "UNSPENT"));
    }
    return [...byId.values()];
  }

  async function moveLocked(id: string, from: NoteState, to: NoteState, fields: MoveFields = {}): Promise<NoteRecord> {
    if (!NOTE_STATES.includes(from) || !NOTE_STATES.includes(to)) throw new Error("unknown note state");
    if (fields === null || typeof fields !== "object") throw new Error("fields is an object");
    onlyKeys(fields, ["leaf", "deadlineMs", "context", "attempt", "blockTimeMs"], "a move");
    const all = await settle();
    const cur = all.find((n) => n.id === id);
    if (cur === undefined) throw new Error(`no note ${id}`);
    // a parent the settle above just finished: the move to SPENT it asked for is done
    if (to === "SPENT" && cur.state === "SPENT" && from !== "SPENT" && all.some((c) => c.parent === id)) return cur;
    if (cur.state !== from) throw new Error(`note ${id} is ${cur.state}, not ${from}`);
    if (!(NOTE_EDGES[from] as readonly NoteState[]).includes(to)) throw new Error(`a note never goes from ${from} to ${to}`);
    if (to === "TAKEN" && cur.ref.kind !== "deposit") throw new Error("only a deposit index is marked taken");
    const time = fields.blockTimeMs === undefined ? undefined : u64(fields.blockTimeMs, "blockTimeMs");
    const own = fields.attempt !== undefined && fields.attempt === cur.attempt && cur.tab === tab;
    if (from === "HELD" && to === "RESERVED" && !own) throw new Error(`note ${id} is held by another attempt: only the attempt that holds it sends it`);
    if (from === "HELD" && to === "UNSPENT" && !own && !(time !== undefined && time > cur.deadlineMs! - SEND_MARGIN_MS))
      throw new Error(`note ${id} is held by another attempt: freed only by that attempt, or once block time is past deadline_ms - ${SEND_MARGIN_MS} ms`);
    if (from === "RESERVED" && to === "UNSPENT" && !(time !== undefined && time > cur.deadlineMs!))
      throw new Error(`note ${id} is RESERVED until block time is past its deadline_ms: its proof can still land`);
    return put(cur, to, { leaf: fields.leaf, deadlineMs: fields.deadlineMs, context: fields.context });
  }

  async function addLocked(note: NewNote): Promise<NoteRecord> {
    if (note === null || typeof note !== "object") throw new Error("a note is an object");
    onlyKeys(note, ["ref", "scope", "precommitment", "state", "parent", "leaf"], "a new note");
    const key = refKey(note.ref);
    const scope = field(note.scope, "scope");
    const precommitment = field(note.precommitment, "precommitment");
    const kind = note.ref.kind;
    if (note.ref.kind === "deposit" && note.ref.s !== scope) throw new Error("a deposit note's scope is its s");
    const all = await settle();
    const n: NoteRecord = { id: newId(), ref: note.ref, scope, precommitment, state: note.state };
    let parent: NoteRecord | undefined;
    if (note.state === "PLANNED") {
      if (note.leaf !== undefined || note.parent !== undefined) throw new Error("a PLANNED note has no leaf and no parent");
      if (kind === "deposit") throw new Error("a deposit note is planned by planDeposit (one unfunded index per scope)");
      if (kind === "change" || kind === "refund") throw new Error(`a ${kind} note is born UNSPENT with its withdrawal`);
      if (note.ref.kind === "second") {
        const id = note.ref.id;
        const idKey = secondIdKey(id);
        const before = note.ref.n === 0 ? firstOf(id) : { kind: "second" as const, id, n: note.ref.n - 1 };
        const prev = before === null ? undefined : all.find((x) => refKey(x.ref) === refKey(before));
        if (before !== null && (prev === undefined || !LANDED.includes(prev.state))) throw new Error(`second arrival ${note.ref.n} of ${idKey} waits until the note before it has landed`);
      }
    } else if (note.state === "UNSPENT") {
      n.leaf = checkLeaf(note.leaf, precommitment);
      // a change note keeps the label it is named by, parent in the store or not (restore), so its own change finds it
      if (note.ref.kind === "change" && n.leaf.label !== note.ref.l) throw new Error("a change note keeps its label: its leaf's label is its l");
      if (note.parent !== undefined && kind !== "change" && kind !== "refund") throw new Error("only a change or refund note has a parent");
      // the parent comes from the child's (l, j); a named parent must be that note
      parent = parentOf(note.ref, scope, all);
      if (note.parent !== undefined && parent?.id !== note.parent) throw new Error(`parent ${String(note.parent)} is not the note change index ${(note.ref as { j: number }).j} of label ${(note.ref as { l: bigint }).l} comes from`);
      if (parent !== undefined) {
        if (!LANDED.includes(parent.state)) throw new Error(`parent ${parent.id} is not a landed note`);
        // a change note's label is its l (checked above), the label its parent was found by
        n.parent = parent.id;
      }
    } else throw new Error("a note is born PLANNED or UNSPENT");
    if (all.some((x) => refKey(x.ref) === key)) throw new Error(`note ${key} is already in the store`);
    if (all.some((x) => x.precommitment === precommitment)) throw new Error("that precommitment is already in the store");
    await write(n); // the child first ...
    if (parent !== undefined && parent.state !== "SPENT") await put(parent, "SPENT"); // ... then its parent
    return n;
  }

  async function addCallLocked(id: string, call: NewBindCall, seen: number): Promise<NoteRecord> {
    const c = checkCall(call, "a new call", false);
    if (!Number.isSafeInteger(seen) || seen < 0) throw new Error("seen is a count of calls");
    const cur = (await settle()).find((n) => n.id === id);
    if (cur === undefined) throw new Error(`no note ${id}`);
    if (cur.state !== "INCOMING") throw new Error(`note ${id} is ${cur.state}: a call is signed only for an INCOMING note`);
    const calls = cur.calls ?? [];
    if (calls.length !== seen) return cur; // another bind's call came first: this one is not written, so never sent
    const next: NoteRecord = { ...cur, calls: checkCalls([...calls, { ...c, tx_hashes: [] }], id) };
    await write(next);
    return next;
  }
  async function addCallTxLocked(id: string, call: Pick<BindCall, "nonce" | "max_block_height">, txHash: string): Promise<NoteRecord> {
    if (typeof txHash !== "string" || txHash.length > 44 || !B58.test(txHash)) throw new Error("a tx hash is base58");
    const cur = (await settle()).find((n) => n.id === id);
    if (cur === undefined) throw new Error(`no note ${id}`);
    const calls = cur.calls ?? [];
    const k = calls.findIndex((c) => c.nonce === call?.nonce && c.max_block_height === call?.max_block_height);
    if (k < 0) throw new Error(`note ${id} has no such call`);
    if (calls[k]!.tx_hashes.includes(txHash)) return cur;
    const next: NoteRecord = { ...cur, calls: calls.map((c, j) => (j === k ? { ...c, tx_hashes: [...c.tx_hashes, txHash] } : c)) };
    await write(next);
    return next;
  }

  // finish what a killed page left before anyone reads
  try {
    await locked(async () => void (await settle()));
  } catch (e) {
    letGo();
    throw e;
  }

  return {
    get: (id) => locked(async () => (await settle()).find((n) => n.id === id)),
    list: () => locked(settle),
    add: (note) => locked(() => addLocked(note)),
    move: (id, from, to, fields) => locked(() => moveLocked(id, from, to, fields)),
    addCall: (id, call, seen) => locked(() => addCallLocked(id, call, seen)),
    addCallTx: (id, call, txHash) => locked(() => addCallTxLocked(id, call, txHash)),
    close: () => {
      closed = true;
      letGo();
    },
    planDeposit(scope, precommitmentOf) {
      field(scope, "scope");
      return locked(async () => {
        const all = await settle();
        const open = all.filter((n) => n.ref.kind === "deposit" && n.scope === scope && n.state === "PLANNED");
        if (open.length > 1) throw new Error(`scope ${scope} has ${open.length} unfunded deposit indices`);
        if (open[0] !== undefined) return open[0];
        // the next index, read without moving the counter (../store: key i/<scope>, { next }; lane d when absent), so a
        // precommitmentOf that throws burns nothing
        const c = (await store.get("counters", `i/${scope.toString()}`)) as { next: number } | undefined;
        const want = c === undefined ? store.lane : c.next;
        const make = (i: number): NoteRecord => {
          const ref: NoteRef = { kind: "deposit", s: scope, i };
          if (all.some((n) => refKey(n.ref) === refKey(ref))) throw new Error(`deposit index ${i} of scope ${scope} is already a note`);
          const precommitment = field(precommitmentOf(ref), "precommitment");
          if (all.some((n) => n.precommitment === precommitment)) throw new Error("that precommitment is already in the store");
          return { id: newId(), ref, scope, precommitment, state: "PLANNED" };
        };
        let n = make(want);
        const i = await store.reserveDepositIndex(scope); // durable before it is returned (../store)
        if (i !== want) n = make(i); // the counter moved outside the notes lock (restore's raise): name what was reserved
        await write(n);
        return n;
      });
    },
  };
}
