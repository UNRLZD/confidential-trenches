// The device's rent-back spacing (RentBackSpacing), in its own IndexedDB database on SIGN_HOST, apart from the wallet's
// (card round-trip-costs-less, the delta review of P3-e). Sign out deletes the wallet's database and never this one, so
// a sign out and in, or another account signing in on this device, still waits out the gap: the network sees the
// device's one address, whoever is signed in. It holds two times and nothing else: no address, no account, no W. Only
// read and written, never a reason for a request; the frame never opens it (only a rent back's pass does).

/** When this device last sent a transaction from a W for a rent back (a close or a sweep, in a sale's own run or a
 *  leftover pass), ms, and the gap drawn for it (review 2 P3-e of c0dd55d02): no other leftover W's pass sends before
 *  at + gap, so no two of the device's Ws close or sweep within a gap of each other and their timing never groups them
 *  as one user. */
export type RentBackSpacing = { at: number; gap: number };
/** The gap after a rent back's transaction before a leftover W's pass: drawn at random from [MIN, MAX] each send. */
export const POOL_RENT_BACK_SPACE_MIN_MS = 10 * 60_000;
export const POOL_RENT_BACK_SPACE_MAX_MS = 60 * 60_000;

export const DEVICE_DB = "ct-device";
const STORE = "space";
const KEY = "rentback-sol";

/** A gap open at `now`: one ending past now + the largest gap is from a clock set ahead and reads as none, so a stamp
 *  this database keeps across sign-ins never holds the device's Ws for longer than one gap; `own`, W's own last send
 *  (OwedRentBack.spaced), never holds W itself. */
export const spaceOpen = (s: RentBackSpacing | undefined, now: number, own?: number): boolean =>
  s !== undefined && s.at !== own && now < s.at + s.gap && s.at + s.gap <= now + POOL_RENT_BACK_SPACE_MAX_MS;

export type DeviceSpacing = {
  spacing(): Promise<RentBackSpacing | undefined>;
  space(v: RentBackSpacing): Promise<void>;
  /** The slot of a leftover pass, taken in one readwrite transaction (one at a time across the device's tabs): true when
   *  no gap is open at `v.at` but `own`'s (v is then the last send), false when one is. */
  claim(v: RentBackSpacing, own?: number): Promise<boolean>;
};

const shaped = (v: unknown): RentBackSpacing | undefined => {
  const w = v as Partial<RentBackSpacing> | undefined;
  return Number.isSafeInteger(w?.at) && Number.isSafeInteger(w?.gap) ? { at: w!.at!, gap: w!.gap! } : undefined;
};

/** Opened for each call and closed after it: no connection is held between a page's rare passes. */
export function deviceSpacing(idb: IDBFactory | undefined = globalThis.indexedDB, name = DEVICE_DB): DeviceSpacing {
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore, done: (v: T) => void) => void): Promise<T> => {
    if (!idb) throw new Error("no IndexedDB on this page");
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => void r.result.createObjectStore(STORE);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
      r.onblocked = () => no(new Error("the device's spacing database is blocked"));
    });
    try {
      return await new Promise<T>((ok, no) => {
        const tx = db.transaction(STORE, mode);
        let out!: T;
        f(tx.objectStore(STORE), (v) => (out = v));
        tx.oncomplete = () => ok(out);
        tx.onerror = () => no(tx.error);
        tx.onabort = () => no(tx.error ?? new Error("transaction aborted"));
      });
    } finally {
      db.close();
    }
  };
  return {
    spacing: () => run<RentBackSpacing | undefined>("readonly", (s, done) => {
      const r = s.get(KEY);
      r.onsuccess = () => done(shaped(r.result));
    }),
    space: (v) => run<void>("readwrite", (s, done) => {
      s.put({ at: v.at, gap: v.gap }, KEY);
      done();
    }),
    claim: (v, own) => run<boolean>("readwrite", (s, done) => {
      const r = s.get(KEY);
      r.onsuccess = () => {
        if (spaceOpen(shaped(r.result), v.at, own)) return done(false);
        s.put({ at: v.at, gap: v.gap }, KEY);
        done(true);
      };
    }),
  };
}
