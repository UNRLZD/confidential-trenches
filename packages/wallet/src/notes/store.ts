// The note store: notes, their states and the deposit index, in the wrapped store on SIGN_HOST (card wallet-note-store,
// lane W2.1; docs/plan1/wallet.md at research 7838dbe, which the card cites at ffcba5e as W:193-203, W:1051, W:1089):
// the `notes` row of the note store table :198, Secrets :176-192, the deposit index rule :346-353, the held note
// :385-391, deposit step 9 :418, a stopped arm :363-365 and a stopped piece :748-749, the other device :230-231, the
// change :744-746, P-01 :1060.
//
// - Every record goes through the wallet store's put, one IndexedDB transaction with strict durability, wrapped under
//   K_wrap (../store). A note never holds its nullifier or its secret: they come back from the seed by its ref
//   (./secrets.ts), so the record holds only what the paper's row names, and an unknown field is refused.
// - States and the only edges between them, read from the row; any other move is refused before anything is written,
//   and a move names the state it expects (a compare-and-set), so a tab acting on a stale read changes nothing.
// - Order against the outside world: a state is written before the act it names. RESERVED is written before the proof
//   leaves the device, so a page killed mid-send leaves RESERVED (resolved by reading the vault), never a HELD note that
//   could be picked again while its proof lands; PLANNED is written before the precommitment leaves the device.
// - A withdrawal's change note (and its refund note) is born UNSPENT naming its parent; the child is written first, then
//   the parent goes to SPENT. A page killed between the two leaves a child whose parent is not SPENT yet, and every
//   open and every list() finishes that parent first, so no reader counts both.
// - Deposit index: one unfunded index per scope (:349-353). planDeposit hands back the scope's PLANNED deposit note
//   while there is one; only then does it take the store's next index (written before it is returned, ../store) and
//   write the note PLANNED. A page killed between the two skips that index, which nothing outside ever saw.
// - Second arrivals: n counts from 0 per id with no gap, and n + 1 is planned only once n has landed (:191-192), so
//   restore's walk "until the first miss" finds every one.
// - Every note write runs under the Web Lock "ct-wallet/notes", so two tabs never both act on one read. With no Web
//   Locks the note store does not open, as the seed is never written without them (../store).
// - A tab that dies while it holds a note frees it at once (the coordinator's call on 09af69f; :389-390): each note store
//   holds the Web Lock "ct-wallet/tab/<id>" for its life (the browser lets it go when the page dies), and a HELD record
//   names that id, which is not a secret. Every open and every list() reads navigator.locks.query() and moves a HELD
//   note whose tab lock is not held back to UNSPENT. Safe because RESERVED is written before a proof leaves the device,
//   so a HELD note's proof was never sent. Only the holding tab moves its note to RESERVED; a live tab's note still goes
//   back once too late to send.
import { VAULT_FIELD_P } from "@blindfill/kit";
import { CHAINS } from "../derive/index.ts";
import type { WalletStore } from "../store/index.ts";
import { noteCommitment, type NoteRef } from "./secrets.ts";

export const NOTES_LOCK = "ct-wallet/notes";
export const TAB_LOCK = "ct-wallet/tab/"; // + the tab's id

export const NOTE_STATES = ["PLANNED", "INCOMING", "UNSPENT", "HELD", "RESERVED", "SPENT"] as const;
export type NoteState = (typeof NOTE_STATES)[number];

// The legal edges (wallet.md:198 unless named).
export const NOTE_EDGES: Readonly<Record<NoteState, readonly NoteState[]>> = Object.freeze({
  PLANNED: Object.freeze(["INCOMING"] as const), // money on its way
  INCOMING: Object.freeze(["UNSPENT"] as const), // its leaf read on two RPCs (:418)
  // HELD: a proof of this device has started. SPENT: another device's withdrawal spent it (:230-231)
  UNSPENT: Object.freeze(["HELD", "SPENT"] as const),
  // UNSPENT: the proof dropped or too late to send (:389-390); RESERVED: written before the proof is sent
  HELD: Object.freeze(["UNSPENT", "RESERVED", "SPENT"] as const),
  // UNSPENT: refused, or past its deadline_ms with nothing landed (:363-365, :748-749)
  RESERVED: Object.freeze(["SPENT", "UNSPENT"] as const),
  SPENT: Object.freeze([] as const),
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
  tab?: string; // HELD: the id of the tab whose proof holds it
};

/** A note born PLANNED (a return, move or second-arrival note) or UNSPENT (a change or refund note, or one restore found). */
export type NewNote = {
  ref: NoteRef;
  scope: bigint;
  precommitment: bigint;
  state: "PLANNED" | "UNSPENT";
  parent?: string;
  leaf?: Leaf;
};

export type MoveFields = { leaf?: Leaf; deadlineMs?: bigint };

export interface NoteStore {
  get(id: string): Promise<NoteRecord | undefined>;
  list(): Promise<NoteRecord[]>;
  planDeposit(scope: bigint, precommitmentOf: (ref: NoteRef) => bigint): Promise<NoteRecord>;
  add(note: NewNote): Promise<NoteRecord>;
  move(id: string, from: NoteState, to: NoteState, fields?: MoveFields): Promise<NoteRecord>;
  /** Lets this tab's lock go, as the page's death does (tests; a page need not call it). */
  close(): void;
}

export interface NoteStoreOptions {
  locks?: LockManager | null; // null: no Web Locks, and the note store refuses to open
  lockName?: string; // tests only
}

// ---------- checks ----------
const U32 = 0xffffffff;
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
function checkDeadline(d: unknown): bigint {
  if (typeof d !== "bigint" || d <= 0n || d >= 1n << 64n) throw new Error("deadlineMs is a u64 bigint above 0");
  return d;
}

// A record read back: the whole shape, so a broken record stops the caller instead of being acted on.
function checkRecord(id: string, r: unknown): NoteRecord {
  if (r === null || typeof r !== "object") throw new Error(`note ${id} is not a record`);
  const n = r as NoteRecord;
  onlyKeys(n, ["id", "ref", "scope", "precommitment", "state", "parent", "leaf", "deadlineMs", "tab"], `note ${id}`);
  if (n.id !== id) throw new Error(`note ${id} names another id`);
  refKey(n.ref);
  field(n.scope, "scope");
  if (n.ref.kind === "deposit" && n.ref.s !== n.scope) throw new Error(`note ${id}: a deposit note's scope is its s`);
  field(n.precommitment, "precommitment");
  if (!NOTE_STATES.includes(n.state)) throw new Error(`note ${id} has no state`);
  if (LANDED.includes(n.state) !== (n.leaf !== undefined)) throw new Error(`note ${id}: a leaf from UNSPENT on, and only then`);
  if (n.leaf !== undefined) checkLeaf(n.leaf, n.precommitment);
  if ((n.state === "HELD" || n.state === "RESERVED") !== (n.deadlineMs !== undefined)) throw new Error(`note ${id}: deadlineMs in HELD and RESERVED only`);
  if (n.deadlineMs !== undefined) checkDeadline(n.deadlineMs);
  if ((n.state === "HELD") !== (typeof n.tab === "string" && /^[0-9a-f]{32}$/.test(n.tab))) throw new Error(`note ${id}: a tab id in HELD only`);
  if (n.parent !== undefined && (typeof n.parent !== "string" || (n.ref.kind !== "change" && n.ref.kind !== "refund"))) throw new Error(`note ${id}: only a change or refund note has a parent`);
  return n;
}

// A record with no undefined field (the wallet store refuses undefined).
function record(n: NoteRecord): NoteRecord {
  const out: NoteRecord = { id: n.id, ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: n.state };
  if (n.parent !== undefined) out.parent = n.parent;
  if (n.leaf !== undefined) out.leaf = n.leaf;
  if (n.deadlineMs !== undefined) out.deadlineMs = n.deadlineMs;
  if (n.tab !== undefined) out.tab = n.tab;
  return out;
}

const newId = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// ---------- the store ----------
export async function openNoteStore(store: WalletStore, opts: NoteStoreOptions = {}): Promise<NoteStore> {
  const locks = opts.locks === undefined ? (globalThis.navigator?.locks ?? null) : opts.locks;
  if (!locks) throw new Error("no Web Locks: notes change only under the notes lock");
  const lockName = opts.lockName ?? NOTES_LOCK;
  let closed = false; // a closed tab's lock is gone, so it may not hold or change a note any more
  const locked = <T>(fn: () => Promise<T>): Promise<T> =>
    // async, so a refusal rejects the callback's promise and the lock goes back (Node keeps a lock whose callback throws)
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
  const write = (n: NoteRecord): Promise<void> => store.put("notes", n.id, record(n));

  // The one way a state changes, inside the lock: check everything, then one put.
  async function moveLocked(id: string, from: NoteState, to: NoteState, fields: MoveFields = {}): Promise<NoteRecord> {
    if (!NOTE_STATES.includes(from) || !NOTE_STATES.includes(to)) throw new Error("unknown note state");
    if (fields === null || typeof fields !== "object") throw new Error("fields is an object");
    onlyKeys(fields, ["leaf", "deadlineMs"], "a move");
    const cur = await read(id);
    if (cur === undefined) throw new Error(`no note ${id}`);
    if (cur.state !== from) throw new Error(`note ${id} is ${cur.state}, not ${from}`);
    if (!(NOTE_EDGES[from] as readonly NoteState[]).includes(to)) throw new Error(`a note never goes from ${from} to ${to}`);
    const next: NoteRecord = { ...cur, state: to };
    if (from === "INCOMING") next.leaf = checkLeaf(fields.leaf, cur.precommitment);
    else if (fields.leaf !== undefined) throw new Error("a leaf is set once, when the note lands");
    if (to === "RESERVED" && cur.tab !== tab) throw new Error(`note ${id} is held by another tab: only the tab that made its proof sends it`);
    if (to === "HELD") next.deadlineMs = checkDeadline(fields.deadlineMs);
    else if (fields.deadlineMs !== undefined) throw new Error("deadlineMs is set when the proof starts (HELD)");
    else if (to !== "RESERVED") delete next.deadlineMs;
    if (to === "HELD") next.tab = tab;
    else delete next.tab;
    await write(next);
    return next;
  }

  // A child written, its parent not yet SPENT (a page killed between the two writes): finish the parent.
  async function finishParents(all: NoteRecord[]): Promise<NoteRecord[]> {
    const byId = new Map(all.map((n) => [n.id, n]));
    for (const n of all) {
      const p = n.parent === undefined ? undefined : byId.get(n.parent);
      if (p !== undefined && p.state !== "SPENT") byId.set(p.id, await moveLocked(p.id, p.state, "SPENT"));
    }
    return [...byId.values()];
  }

  // A HELD note whose tab is gone: its proof died with that page and was never sent, so it goes back to UNSPENT now.
  async function freeDeadTabs(all: NoteRecord[]): Promise<NoteRecord[]> {
    if (!all.some((n) => n.state === "HELD")) return all;
    const live = new Set(((await locks!.query()).held ?? []).map((l) => l.name));
    const out: NoteRecord[] = [];
    for (const n of all) out.push(n.state === "HELD" && !live.has(TAB_LOCK + n.tab) ? await moveLocked(n.id, "HELD", "UNSPENT") : n);
    return out;
  }
  const settle = async (): Promise<NoteRecord[]> => freeDeadTabs(await finishParents(await readAll()));

  async function addLocked(note: NewNote): Promise<NoteRecord> {
    if (note === null || typeof note !== "object") throw new Error("a note is an object");
    onlyKeys(note, ["ref", "scope", "precommitment", "state", "parent", "leaf"], "a new note");
    const key = refKey(note.ref);
    const scope = field(note.scope, "scope");
    const precommitment = field(note.precommitment, "precommitment");
    const kind = note.ref.kind;
    if (note.ref.kind === "deposit" && note.ref.s !== scope) throw new Error("a deposit note's scope is its s");
    const all = await finishParents(await readAll());
    const n: NoteRecord = { id: newId(), ref: note.ref, scope, precommitment, state: note.state };
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
      if (note.parent !== undefined) {
        if (kind !== "change" && kind !== "refund") throw new Error("only a change or refund note has a parent");
        const p = all.find((x) => x.id === note.parent);
        if (p === undefined || !LANDED.includes(p.state)) throw new Error(`parent ${String(note.parent)} is not a landed note`);
        n.parent = p.id;
      }
    } else throw new Error("a note is born PLANNED or UNSPENT");
    if (all.some((x) => refKey(x.ref) === key)) throw new Error(`note ${key} is already in the store`);
    if (all.some((x) => x.precommitment === precommitment)) throw new Error("that precommitment is already in the store");
    await write(n); // the child first ...
    const p = n.parent === undefined ? undefined : all.find((x) => x.id === n.parent);
    if (p !== undefined && p.state !== "SPENT") await moveLocked(p.id, p.state, "SPENT"); // ... then its parent
    return n;
  }

  // finish what a killed page left before anyone reads
  try {
    await locked(async () => void (await settle()));
  } catch (e) {
    letGo();
    throw e;
  }

  return {
    get: (id) => read(id),
    list: () => locked(settle),
    close: () => {
      closed = true;
      letGo();
    },
    add: (note) => locked(() => addLocked(note)),
    move: (id, from, to, fields) => locked(() => moveLocked(id, from, to, fields)),
    planDeposit(scope, precommitmentOf) {
      field(scope, "scope");
      return locked(async () => {
        const all = await readAll();
        const open = all.filter((n) => n.ref.kind === "deposit" && n.scope === scope && n.state === "PLANNED");
        if (open.length > 1) throw new Error(`scope ${scope} has ${open.length} unfunded deposit indices`);
        if (open[0] !== undefined) return open[0];
        const i = await store.reserveDepositIndex(scope); // durable before it is returned (../store)
        const ref: NoteRef = { kind: "deposit", s: scope, i };
        if (all.some((n) => refKey(n.ref) === refKey(ref))) throw new Error(`deposit index ${i} of scope ${scope} is already a note`);
        const precommitment = field(precommitmentOf(ref), "precommitment");
        if (all.some((n) => n.precommitment === precommitment)) throw new Error("that precommitment is already in the store");
        const n: NoteRecord = { id: newId(), ref, scope, precommitment, state: "PLANNED" };
        await write(n);
        return n;
      });
    },
  };
}
