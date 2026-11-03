// The framed page's state, read from the wallet store on SIGN_HOST's origin (card signpage-frame-state; wallet.md §2.2
// "Storage and unlock" :151-160, §2.3 the note store table :197-204, §7 item 4; the shapes are
// packages/kit/src/signpage/messages.ts, api 1). src/main.ts hands it to the postMessage API (src/api.ts) in the frame.
//
// - The frame never opens the seed record, nor any record that holds a secret. SIGN_HOST and APP_HOST are one site, so
//   the frame may share APP_HOST's renderer process, and decoded seed JSON in its heap would sit beside APP_HOST's code.
//   It reads four things: keys("meta"), get("meta", "status"), keys/get on "ops" and, for deposit.quote,
//   get("meta", "deposit/<scope>") (U's public record, which SIGN_HOST's top-level page writes; src/deposit-name.ts). APP_HOST and SIGN_HOST being one
//   site is also why the frame opens the same database as SIGN_HOST's top-level tabs.
// - The frame opens the store read-only (openWalletStoreReader): it makes no database, writes no record (no K_wrap, no
//   lane, no counter) and takes no lock. No database, or one with no K_wrap yet, reads as signed out.
// - The status record, meta/"status" = { v: 1, source, code_saved }: the seed's public facts, with no secret in it. The
//   store writes it itself, in the seed's own transaction (insertSeed, setCodeSaved), so the two never disagree; a
//   database from before it gets it from syncStatus on SIGN_HOST's next top-level load. Sign out deletes the database.
// - signed_in: the seed's key is in keys("meta"). code_saved and way come from the status record. way is how the account
//   came in, from its source: "prf" and "random" (Create passkey, with and without PRF) are "passkey", "code" (typed 12
//   words) is "words", "wallet" is "wallet".
// - A seed with no status (a database from before it, or a status the frame cannot read) is signed in with code_saved
//   false, so the Backup dot shows, and no `way`, which the kit's state type leaves optional: the frame does not know it
//   and says nothing. A status with no seed is signed out: signed_in comes from the seed's key alone.
// - ops: every record of the store's "ops", keyed by its op id, as { id, kind, stage, txs, code? } (the op contract is
//   at readOps). Only those fields are copied (a tx as { chain, hash }), and only when the op passes the kit's own state
//   schema, the one the client checks every answer against: a record of another shape is left out, never sent, so one
//   bad record cannot make the client refuse the whole state. Oldest first by created_ms; past the kit's
//   SIGNPAGE_MAX_ARRAY, the newest that many, then the oldest dropped until the answer's UTF-8 JSON fits
//   SIGNPAGE_MAX_ANSWER_BYTES with ANSWER_ROOM to spare for its envelope: a longer one fails the client's checks and
//   would leave the frame down.
// - Nothing secret enters the state built here: no words, key, seed, entropy, note value or passkey data. The top-level
//   page's state adds per-chain pool totals (src/pools.ts), never a note; read on each change of the store, the step
//   between two totals can show a single note's value. Every field is built here
//   from a checked value; nothing is spread from a record.
// - A store the frame cannot open or read (IndexedDB blocked or missing) answers signed out, with no error text, and the
//   next read tries again.
// - Watch: the frame's own BroadcastChannel "ct-wallet" (the store's two-tab signal; main.ts) reports another tab's
//   change or sign out, also when no database exists yet, and the reader reports its own connection closed by a delete
//   (versionchange). Each one calls the watchers, and the API posts a state event when the state read then differs. A
//   sign out or a closed connection drops the reader; the next read opens a new one.
import type { Operation, SigninWay, SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_MAX_ARRAY, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { depositKey, depositRecordOf, type WalletEvent, type WalletStoreReader } from "@blindfill/wallet/store";
import type { DepositPublic } from "./deposit-wire.ts";
import { SEED_SOURCES, type SeedSource } from "@blindfill/wallet/signin/words";
import { API, RELEASE, signedOutState } from "./api.ts";

const WAY: Record<SeedSource, SigninWay> = { prf: "passkey", random: "passkey", code: "words", wallet: "wallet" };

/** The seed's public facts: the status record's two fields. */
export interface Status {
  source: SeedSource;
  code_saved: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A status record read back, or undefined when there is none or it is not one. */
export function statusOf(rec: unknown): Status | undefined {
  if (!isRecord(rec) || rec.v !== 1 || !(SEED_SOURCES as readonly unknown[]).includes(rec.source) || typeof rec.code_saved !== "boolean") return undefined;
  return { source: rec.source as SeedSource, code_saved: rec.code_saved };
}

/** The state: signed out, or signed in with the status read (none: code_saved false and no way) and the ops. */
export function stateOf(signedIn: boolean, status: Status | undefined, ops: Operation[]): SignpageState {
  if (!signedIn) return signedOutState();
  const empty = { vault_balance: "0", wallets: [], positions: [], orders: [], held: [] };
  const base = { release: RELEASE, api: API, signed_in: true } as const;
  if (!status) return { ...base, code_saved: false, ...empty, ops };
  return { ...base, way: WAY[status.source], code_saved: status.code_saved, ...empty, ops };
}

/** The op the API may send for the ops record under `id`, or null when the record is not one. */
export function opOf(id: string, rec: unknown): Operation | null {
  if (!isRecord(rec)) return null;
  const txs = Array.isArray(rec.txs) ? rec.txs.map((t: unknown) => (isRecord(t) ? { chain: t.chain, hash: t.hash } : t)) : rec.txs;
  const op: Record<string, unknown> = { id, kind: rec.kind, stage: rec.stage, txs };
  if ((rec.kind === "buy" || rec.kind === "sell") && rec.code !== undefined) op.code = rec.code;
  const probe = stateOf(true, undefined, [op as Operation]);
  return SIGNPAGE_RESULT_SCHEMAS.state(probe) ? (op as Operation) : null;
}

/** Bytes kept free under SIGNPAGE_MAX_ANSWER_BYTES for the envelope around the state (an answer's v, id and ok). */
export const ANSWER_ROOM = 256;
const utf8 = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** One op read, with its record's created_ms (-Infinity when it has none: oldest). */
export type OpRow = { op: Operation; t: number };

/**
 * The ops to send, oldest first: by created_ms (then id), the newest SIGNPAGE_MAX_ARRAY, then the oldest dropped until
 * `base` (the state with no ops) holding them is, as UTF-8 JSON, at most SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM.
 */
export function pickOps(base: SignpageState, rows: OpRow[]): Operation[] {
  const ops = [...rows]
    .sort((a, b) => a.t - b.t || (a.op.id < b.op.id ? -1 : a.op.id > b.op.id ? 1 : 0))
    .slice(-SIGNPAGE_MAX_ARRAY)
    .map((r) => r.op);
  // JSON of an array: "[" + items joined by "," + "]"; base already holds the "[]"
  let left = SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM - utf8({ ...base, ops: [] });
  let keep = 0;
  for (let i = ops.length - 1; i >= 0; i--) {
    const cost = utf8(ops[i]) + (keep > 0 ? 1 : 0);
    if (cost > left) break;
    left -= cost;
    keep++;
  }
  return ops.slice(ops.length - keep);
}

const createdMs = (rec: unknown): number =>
  isRecord(rec) && typeof rec.created_ms === "number" && Number.isFinite(rec.created_ms) ? rec.created_ms : -Infinity;

// The op contract (for every card that writes "ops"): an ops record is keyed by its request's id and holds
// { kind, stage, txs: [{ chain, hash }], code?, created_ms } and nothing secret: no key, seed, words, note secret,
// nullifier, context, proof or signed-but-unsent payload. The frame may open these records only because they hold no
// secret (the frame's rule above); a field that is secret goes in another store, which the frame never reads. The frame
// copies only the fields above, so a stray field is never sent, but it is still decrypted in the frame's heap.
async function readOps(s: WalletStoreReader): Promise<OpRow[]> {
  const keys = await s.keys("ops");
  const rows = await Promise.all(
    keys.map(async (k) => {
      // one record that fails to open leaves the others shown
      const rec = await s.get("ops", k).catch(() => undefined);
      const op = opOf(k, rec);
      return op ? { op, t: createdMs(rec) } : null;
    }),
  );
  return rows.filter((r) => r !== null);
}

/** Opens the store read-only with this listener for its own connection's close (main.ts: openWalletStoreReader). */
export type ReaderOpener = (onEvent: (e: WalletEvent) => void) => Promise<WalletStoreReader | null>;
/** Adds a listener to the frame's own BroadcastChannel "ct-wallet" (main.ts). */
export type ChannelListen = (fn: (e: unknown) => void) => void;

export interface FrameState {
  /** The state read now from the store; signed out when it cannot be read. Never throws. */
  state(): Promise<SignpageState>;
  /** Calls `fn` on every change another tab makes to the store, a sign out included. */
  watch(fn: () => void): void;
  /**
   * The deposit.quote kind's public records (src/deposit-wire.ts): the status and meta/"deposit/<scope>", which
   * SIGN_HOST's top-level page writes ahead (src/deposit-name.ts); null when no seed is stored or the store cannot be
   * read. Never the seed. Never throws.
   */
  depositRead(scope: bigint): Promise<DepositPublic | null>;
  close(): void;
}

export function frameState(open: ReaderOpener, listen: ChannelListen): FrameState {
  type Held = { store: WalletStoreReader; dead: boolean };
  let held: Held | null = null;
  let opening: Promise<Held | null> | null = null;
  let closed = false;
  const watchers = new Set<() => void>();
  const changed = (): void => {
    for (const f of watchers) f();
  };
  listen((e) => {
    if (isRecord(e) && e.kind === "signout" && held) held.dead = true;
    changed();
  });

  const fresh = async (): Promise<Held | null> => {
    const h = { dead: false } as Held;
    const store = await open((e) => {
      if (e.kind === "closed" || e.kind === "signout") h.dead = true;
      changed();
    });
    held?.store.close();
    held = null;
    if (!store) return null;
    h.store = store;
    held = h;
    if (closed) store.close();
    return h;
  };
  const live = (): Promise<Held | null> => {
    if (held && !held.dead) return Promise.resolve(held);
    return (opening ??= fresh().finally(() => (opening = null)));
  };

  return {
    async state() {
      let h: Held | null = null;
      try {
        h = await live();
        // no database or no K_wrap yet: nothing is stored, so signed out
        if (!h) return signedOutState();
        // the seed's key only: the seed record is never opened here
        if (!(await h.store.keys("meta")).includes("seed")) return signedOutState();
        // a status that fails to open reads as none: signed in, the Backup dot, no way
        const status = statusOf(await h.store.get("meta", "status").catch(() => undefined));
        return stateOf(true, status, pickOps(stateOf(true, status, []), await readOps(h.store)));
      } catch {
        // the next read opens the store again
        if (h) h.dead = true;
        return signedOutState();
      }
    },
    watch(fn) {
      watchers.add(fn);
    },
    async depositRead(scope) {
      let h: Held | null = null;
      try {
        h = await live();
        if (!h || !(await h.store.keys("meta")).includes("seed")) return null;
        const status = statusOf(await h.store.get("meta", "status").catch(() => undefined));
        const deposit = depositRecordOf(await h.store.get("meta", depositKey(scope)).catch(() => undefined));
        return { status, deposit };
      } catch {
        if (h) h.dead = true;
        return null;
      }
    },
    close() {
      closed = true;
      held?.store.close();
    },
  };
}
