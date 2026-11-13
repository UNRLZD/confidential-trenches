// The device's rent-back spacing (RentBackSpacing), in its own IndexedDB database on SIGN_HOST, apart from the wallet's
// (card round-trip-costs-less, the delta review of P3-e). Sign out deletes the wallet's database and never this one, so
// a sign out and in, or another account signing in on this device, still waits out the gap: the network sees the
// device's one address, whoever is signed in. It holds two times and nothing else: no address, no account, no W. Only
// read and written, never a reason for a request; the frame never opens it (only a pool sale and a rent back's pass do).

import { TRADE_STORE_MS, within } from "./trade.ts";

/** When this device last sent a transaction from a W into the pool (a sale, with its deposit back in the same
 *  transaction, or a rent back's close or sweep), ms, and the gap drawn for it (review 2 P3-e of c0dd55d02, review P2-1
 *  of 024e8a89d). What holds: every leftover pass waits out the gap after every W's sale, close and sweep but its own
 *  W's last send; no leftover pass starts while a pool buy or sell runs in any tab (POOL_TRADE_LOCK, trade.ts); a load's
 *  first leftover pass waits a start drawn from 15 to 60 s (pool-testnet.ts BACKS_LOAD_MIN_MS). What does not: a sale
 *  and its own rent back are never held (that W's sale is already on chain, so holding its rent back hides nothing and
 *  only keeps the user's SOL on W), and the legs of one sale go together. */
export type RentBackSpacing = { at: number; gap: number };
/** The gap after a rent back's transaction before a leftover W's pass: drawn at random from [MIN, MAX] each send. */
export const POOL_RENT_BACK_SPACE_MIN_MS = 10 * 60_000;
export const POOL_RENT_BACK_SPACE_MAX_MS = 60 * 60_000;

export const DEVICE_DB = "ct-device";
const STORE = "space";
const KEY = "rentback-sol";

/** A stamp the clock can trust: one up to the largest gap ahead of `now` (the clock set back since it was written) holds
 *  to its at + gap; one further ahead is from a clock that was set ahead, reads as none and is replaced by the next
 *  stamp, so a stamp this database keeps across sign-ins never holds the device's Ws for longer than one gap. */
const trusted = (s: RentBackSpacing, now: number): boolean => s.at <= now + POOL_RENT_BACK_SPACE_MAX_MS;
/** A gap open at `now` (a trusted stamp's); `own`, W's own last send (OwedRentBack.spaced), never holds W itself. */
export const spaceOpen = (s: RentBackSpacing | undefined, now: number, own?: number): boolean =>
  s !== undefined && s.at !== own && trusted(s, now) && now < s.at + s.gap;

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

/** Opened for each call and closed after it: no connection is held between a page's rare passes. Each call is raced
 *  against `ms` (the trade store's bound): an open that never answers (WebKit under storage pressure, some private
 *  windows: only onerror and onblocked reject) rejects past it, so a claim or a read is held and a stamp dropped; an open
 *  that answers after that is closed unused, and a transaction still running then is aborted. */
export function deviceSpacing(idb: IDBFactory | undefined = globalThis.indexedDB, name = DEVICE_DB, ms = TRADE_STORE_MS): DeviceSpacing {
  const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore, done: (v: T) => void) => void): Promise<T> => {
    let late = false;
    let tx: IDBTransaction | undefined;
    const go = async (): Promise<T> => {
      if (!idb) throw new Error("no IndexedDB on this page");
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const r = idb.open(name, 1);
        r.onupgradeneeded = () => void r.result.createObjectStore(STORE);
        r.onsuccess = () => (late ? r.result.close() : ok(r.result));
        r.onerror = () => no(r.error);
        r.onblocked = () => no(new Error("the device's spacing database is blocked"));
      });
      try {
        return await new Promise<T>((ok, no) => {
          tx = db.transaction(STORE, mode);
          let out!: T;
          f(tx.objectStore(STORE), (v) => (out = v));
          tx.oncomplete = () => ok(out);
          tx.onerror = () => no(tx!.error);
          tx.onabort = () => no(tx!.error ?? new Error("transaction aborted"));
        });
      } finally {
        db.close();
      }
    };
    return within(go(), ms, "the device's spacing").catch((e: unknown) => {
      late = true;
      try {
        tx?.abort();
      } catch {
        // already ended
      }
      throw e;
    });
  };
  return {
    spacing: () => run<RentBackSpacing | undefined>("readonly", (s, done) => {
      const r = s.get(KEY);
      r.onsuccess = () => done(shaped(r.result));
    }),
    // only a newer stamp, or one over a stamp the clock does not trust, in one readwrite transaction as the claim: a
    // stamp that lands late never puts back an older time over a newer one
    space: (v) => run<void>("readwrite", (s, done) => {
      const r = s.get(KEY);
      r.onsuccess = () => {
        const was = shaped(r.result);
        if (was === undefined || v.at > was.at || !trusted(was, v.at)) s.put({ at: v.at, gap: v.gap }, KEY);
        done();
      };
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
