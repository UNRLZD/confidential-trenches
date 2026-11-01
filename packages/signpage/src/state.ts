// The framed page's state, read from the wallet store on SIGN_HOST's origin (card signpage-frame-state; wallet.md §2.2
// "Storage and unlock" :151-160, §2.3 the note store table :197-204, §7 item 4; the shapes are
// packages/kit/src/signpage/messages.ts, api 1). src/main.ts hands it to the postMessage API (src/api.ts) in the frame.
//
// - The frame never opens the seed record, nor any record that holds a secret. SIGN_HOST and APP_HOST are one site, so
//   the frame may share APP_HOST's renderer process, and decoded seed JSON in its heap would sit beside APP_HOST's code.
//   It reads three things through the store's own API: keys("meta"), get("meta", "status") and keys/get on "ops". APP_HOST
//   and SIGN_HOST being one site is also why the frame opens the same database as SIGN_HOST's top-level tabs.
// - The status record, meta/"status" = { v: 1, source, code_saved }: the seed's public facts, with no secret in it.
//   SIGN_HOST's top-level page writes it (markStatus) after every seed landing (Create passkey with and without PRF, the
//   typed 12 words, a sign-in that finds another tab's seed) and after Saved, and syncs it from the seed on every
//   top-level load. Sign out deletes the database, the status with it.
// - signed_in: the seed's key is in keys("meta"). code_saved and way come from the status record. way is how the account
//   came in, from its source: "prf" and "random" (Create passkey, with and without PRF) are "passkey", "code" (typed 12
//   words) is "words", "wallet" is "wallet".
// - Crash order: the seed is written first, then the status. A seed with no status (a crash between the two, or a
//   status the frame cannot read) is signed in with code_saved false, so the Backup dot shows, and no `way`, which the
//   kit's state type leaves optional: the frame does not know it and says nothing. The next top-level load writes the
//   status. A status with no seed is signed out: signed_in comes from the seed alone. Saved writes the seed, then the
//   status; between the two the status still says false, so the dot shows a moment longer, never shorter. code_saved
//   only goes up in the status, as in the seed, so two tabs writing it cannot take it back down.
// - ops: every record of the store's "ops", keyed by its op id, as { id, kind, stage, txs, code? }. Only those fields
//   are copied (a tx as { chain, hash }), and only when the op passes the kit's own state schema, the one the client
//   checks every answer against: a record of another shape is left out, never sent, so one bad record cannot make the
//   client refuse the whole state. Oldest first by the record's created_ms; past the kit's SIGNPAGE_MAX_ARRAY, the
//   newest that many, since a longer list fails the client's schema and would leave the frame down.
// - Nothing secret enters state: no words, key, seed, entropy, note value or passkey data. Every field is built here
//   from a checked value; nothing is spread from a record.
// - A store the frame cannot open or read (IndexedDB blocked or missing) answers signed out, with
//   no error text, and the next read tries again.
// - Watch: the store's onEvent (BroadcastChannel "ct-wallet", the store's two-tab signal) reports another tab's change
//   or sign out; each one calls the watchers, and the API posts a state event when the state read then differs. After
//   another tab's sign out the store is closed; the next read opens a new one, and the old one, which still hears the
//   channel, is closed only once the new one is open, so no change goes unheard in between.
import type { Operation, SigninWay, SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ARRAY, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { WalletEvent, WalletStore } from "@blindfill/wallet/store";
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

/**
 * Writes meta/"status" from the stored seed's facts; SIGN_HOST's top-level page only (main.ts). code_saved only goes up:
 * a status that already says saved for this source stays saved. Nothing is written when it already says the same.
 */
export async function markStatus(store: WalletStore, seed: Status): Promise<void> {
  const cur = statusOf(await store.get("meta", "status"));
  const code_saved = seed.code_saved === true || (cur?.source === seed.source && cur.code_saved);
  if (cur?.source === seed.source && cur.code_saved === code_saved) return;
  await store.put("meta", "status", { v: 1, source: seed.source, code_saved });
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

const createdMs = (rec: unknown): number =>
  isRecord(rec) && typeof rec.created_ms === "number" && Number.isFinite(rec.created_ms) ? rec.created_ms : -Infinity;

// The op contract (for every card that writes "ops"): an ops record is keyed by its request's id and holds
// { kind, stage, txs: [{ chain, hash }], code?, created_ms } and nothing secret: no key, seed, words, note secret,
// nullifier, context, proof or signed-but-unsent payload. The frame may open these records only because they hold no
// secret (the frame's rule above); a field that is secret goes in another store, which the frame never reads. The frame
// copies only the fields above, so a stray field is never sent, but it is still decrypted in the frame's heap.
async function readOps(s: WalletStore): Promise<Operation[]> {
  const keys = await s.keys("ops");
  const rows = await Promise.all(
    keys.map(async (k) => {
      // one record that fails to open leaves the others shown
      const rec = await s.get("ops", k).catch(() => undefined);
      const op = opOf(k, rec);
      return op ? { op, t: createdMs(rec) } : null;
    }),
  );
  const ops = rows.filter((r) => r !== null).sort((a, b) => a.t - b.t || (a.op.id < b.op.id ? -1 : a.op.id > b.op.id ? 1 : 0));
  return ops.slice(-SIGNPAGE_MAX_ARRAY).map((r) => r.op);
}

/** Opens the wallet store with this event listener (main.ts: openWalletStore({ onEvent })). */
export type StoreOpener = (onEvent: (e: WalletEvent) => void) => Promise<WalletStore>;

export interface FrameState {
  /** The state read now from the store; signed out when it cannot be read. Never throws. */
  state(): Promise<SignpageState>;
  /** Calls `fn` on every change another tab makes to the store, a sign out included. */
  watch(fn: () => void): void;
  close(): void;
}

export function frameState(open: StoreOpener): FrameState {
  type Held = { store: WalletStore; dead: boolean };
  let held: Held | null = null;
  let opening: Promise<Held> | null = null;
  let closed = false;
  const watchers = new Set<() => void>();
  const changed = (): void => {
    for (const f of watchers) f();
  };

  const fresh = async (): Promise<Held> => {
    const h = { dead: false } as Held;
    h.store = await open((e) => {
      if (e.kind === "signout") h.dead = true;
      changed();
    });
    const old = held;
    held = h;
    old?.store.close();
    if (closed) h.store.close();
    return h;
  };
  const live = (): Promise<Held> => {
    if (held && !held.dead) return Promise.resolve(held);
    return (opening ??= fresh().finally(() => (opening = null)));
  };

  return {
    async state() {
      let h: Held | null = null;
      try {
        h = await live();
        // the seed's key only: the seed record is never opened here
        if (!(await h.store.keys("meta")).includes("seed")) return signedOutState();
        // a status that fails to open reads as none: signed in, the Backup dot, no way
        const status = statusOf(await h.store.get("meta", "status").catch(() => undefined));
        return stateOf(true, status, await readOps(h.store));
      } catch {
        // the next read opens the store again
        if (h) h.dead = true;
        return signedOutState();
      }
    },
    watch(fn) {
      watchers.add(fn);
    },
    close() {
      closed = true;
      held?.store.close();
    },
  };
}
