// The origins the user connected on SIGN_HOST (card signpage-other-apps-connect): the per-origin approvals of the
// wallet-connect pattern, kept on this device in an IndexedDB database of its own, never the wallet's store (which holds
// the seed). One record an origin, keyed by the origin as the browser serialized it (MessageEvent.origin), its value
// {v: 1}. Only this page writes it: the connect sheet's Connect adds one (src/main.ts); a removal removes one.
// It is read fresh on every request and every state push from an outside app (src/api.ts admit), so a removal in any
// tab of SIGN_HOST refuses that origin's next request. It fails closed: a read that fails, or hangs past
// CONNECTIONS_STORE_MS, reads as not approved; a write that fails rejects, so Connect never binds a session that the next
// read would refuse. APP_HOST's terminal never reads it.

export const CONNECTIONS_DB = "ct-connections";
const STORE = "origins";
/** The bound on one open, read or write, ms. */
export const CONNECTIONS_STORE_MS = 3_000;

export type Connections = {
  /** True only when `origin` was added and not removed since; false on any failure. */
  has(origin: string): Promise<boolean>;
  /** Keeps `origin`'s approval; rejects for anything but a bare origin, and when the write does not complete. */
  add(origin: string): Promise<void>;
  /** Drops `origin`'s approval; rejects when the write does not complete. */
  remove(origin: string): Promise<void>;
  /** Every origin kept, sorted. */
  list(): Promise<string[]>;
  /** Drops every approval. */
  clear(): Promise<void>;
};

/** True when `o` is an origin and nothing else, in the browser's serialization; never the opaque "null". */
export function bareOrigin(o: unknown): o is string {
  if (typeof o !== "string" || o === "null") return false;
  try {
    return new URL(o).origin === o;
  } catch {
    return false;
  }
}

/** `p`, or a rejection once `ms` have passed without it. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, no) => (t = setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((ok, no) => ((r.onsuccess = () => ok(r.result)), (r.onerror = () => no(r.error))));
const done = (tx: IDBTransaction): Promise<void> => new Promise((ok, no) => ((tx.oncomplete = () => ok()), (tx.onerror = () => no(tx.error)), (tx.onabort = () => no(tx.error))));

/**
 * Drops every approval on this device at a sign out: the database itself is deleted, so a tab that never opened it
 * (APP_HOST's shell, where a sign out runs) makes none. A store open in another tab (a /connect popup) closes its
 * connection on the delete's versionchange and reads a new, empty one next: its origin's next request is refused.
 * Rejects when the delete does not complete within `ms` (blocked, failed); the caller's sign out never waits longer.
 */
export function clearConnections(idb: IDBFactory | undefined = globalThis.indexedDB, ms = CONNECTIONS_STORE_MS): Promise<void> {
  return within(
    new Promise<void>((ok, no) => {
      if (idb === undefined) return ok();
      const r = idb.deleteDatabase(CONNECTIONS_DB);
      r.onsuccess = () => ok();
      r.onerror = () => no(r.error);
    }),
    ms,
  );
}

/** The approvals store on `idb` (globalThis.indexedDB when none; a page with none approves nothing). */
export function connections(idb: IDBFactory | undefined = globalThis.indexedDB, ms = CONNECTIONS_STORE_MS): Connections {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> =>
    (db ??= within(
      new Promise<IDBDatabase>((ok, no) => {
        if (idb === undefined) return no(new Error("no IndexedDB"));
        const r = idb.open(CONNECTIONS_DB, 1);
        r.onupgradeneeded = () => void r.result.createObjectStore(STORE);
        r.onsuccess = () => {
          // another tab's upgrade or delete: let it go, and open again on the next call
          r.result.onversionchange = () => ((db = null), r.result.close());
          ok(r.result);
        };
        r.onerror = () => no(r.error);
        r.onblocked = () => no(new Error("blocked"));
      }),
      ms,
    ).catch((e) => ((db = null), Promise.reject(e))));
  const write = async (fn: (s: IDBObjectStore) => void): Promise<void> => {
    const d = await open();
    const tx = d.transaction(STORE, "readwrite");
    fn(tx.objectStore(STORE));
    await within(done(tx), ms);
  };
  return {
    has: async (origin) => {
      if (!bareOrigin(origin)) return false;
      try {
        const d = await open();
        const v: unknown = await within(req(d.transaction(STORE, "readonly").objectStore(STORE).get(origin)), ms);
        return typeof v === "object" && v !== null && (v as { v?: unknown }).v === 1;
      } catch {
        return false;
      }
    },
    add: async (origin) => {
      if (!bareOrigin(origin)) throw new TypeError("not an origin");
      await write((s) => void s.put({ v: 1 }, origin));
    },
    remove: (origin) => write((s) => void s.delete(origin)),
    list: async () => {
      const d = await open();
      const keys = await within(req(d.transaction(STORE, "readonly").objectStore(STORE).getAllKeys()), ms);
      return keys.filter(bareOrigin).sort();
    },
    clear: () => write((s) => void s.clear()),
  };
}
