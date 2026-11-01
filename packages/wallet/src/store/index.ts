// The wallet's store on SIGN_HOST's origin (docs/plan1/wallet.md §2.2 "Storage and unlock" :151-160 and §2.3 "The note
// store" :193-207 at research ffcba5e; old paper docs/spec/06b-wallet-webapp.md §1.2 :454-471, §2 :536-545, §4.1
// :741-751, §4.18 :1231-1238 where wallet.md cites it). One IndexedDB database; nothing in localStorage, cookies or
// the Cache API (wallet.md:154).
//
// - K_wrap: a non-extractable AES-256-GCM CryptoKey made by crypto.subtle.generateKey and kept as a CryptoKey in the
//   database (wallet.md:152, 06b:456-457). It is random, never derived from the seed: the seed record itself sits
//   under it, and the store opens with no passkey sheet (wallet.md:155).
// - Every other record is stored as { iv, ct }: AES-256-GCM under K_wrap with aad = store ‖ "/" ‖ key (wallet.md:153,
//   06b:538-540); the seed record keeps 06b's aad "ct/v1/seed" (06b:458). A record moved to another key, or changed by
//   one bit, fails to open.
// - The deposit counter i per scope only grows and is written, durably, before the caller gets the index, so a tab
//   killed between "reserved" and "used" never hands the same index out again (wallet.md:133-134, :203, :344-345;
//   06b:487-489). Indices keep to the device's lane d of 8, drawn once when the store is first opened (wallet.md:247-248).
// - Two tabs: every counter move runs under the store's own Web Lock "ct-wallet/counters" (06b:743-744, wallet.md:206)
//   and lands only by a compare-and-set inside one IndexedDB transaction, so two tabs never get one value, also where
//   Web Locks are missing (06b:749, TAB-03). The store owns that lock and nothing outside it takes it: Web Locks are not
//   re-entrant, so a caller holding it around a reservation would hang (decided in review round 2; 06b:743 told callers to
//   hold "ct-wallet", which no longer guards anything here).
// - Sign out: broadcast "signout" on BroadcastChannel "ct-wallet", then delete the database (06b:1235, wallet.md:156);
//   other tabs close their connection on the delete's versionchange, so the delete is not blocked. A store that is
//   already closed refuses to sign out, so a stale tab never deletes a newer account's database.
// - The seed lock: sign out (from reading the seed until its delete has succeeded or failed), insertSeed and
//   setCodeSaved each run under the store's exclusive Web Lock "ct-wallet/seed". An earlier tab's sign out holds it until
//   its database is gone, so a stale tab's sign out then fails its liveness check and never deletes, and no seed insert
//   can run between a sign out's check and its delete. The lock is not given back when the delete reports blocked:
//   Chromium fires blocked as soon as one connection reports it ignored the versionchange
//   (connection_coordinator.cc:102-105, :700-705), which a tab our own "signout" broadcast closed mid-transaction reports
//   at once (idb_database.cc:301-305), so blocked does not mean every other tab has closed; the spec, Firefox and WebKit
//   fire it later (IDB 3.0 §5.3 steps 6-8), and the lock may not rest on either order. Holding it through a blocked
//   delete blocks nothing IndexedDB does not already block: every seed operation needs an open store, and every open
//   waits behind the queued delete. With no Web Locks (opts.locks null) sign out, insertSeed and setCodeSaved refuse:
//   they never run unlocked.
// - restore step 7 (wallet.md:319-322) moves a counter up with raiseDepositIndex, under the same lock and
//   compare-and-set; nothing ever lowers a counter.

export const WALLET_DB = "ct-wallet"; // 06b:538
export const WALLET_LOCK = "ct-wallet/counters"; // the store's own; 06b:743 named "ct-wallet"
export const WALLET_SEED_LOCK = "ct-wallet/seed"; // the store's own: sign out and every seed write
export const WALLET_CHANNEL = "ct-wallet"; // 06b:746
export const WALLET_LANES = 8; // wallet.md:247
// wallet.md:197-204, the note store table.
export const WALLET_STORES = ["notes", "wallets", "quotes", "orders", "ops", "counters", "meta"] as const;
export type WalletStoreName = (typeof WALLET_STORES)[number];
// The meta keys a caller may write: the seed record and the settings (wallet.md:204, 06b:585-634). K_wrap and the lane
// are the store's own.
export type WalletMetaKey = "seed" | "settings";
export type WalletEvent = { kind: "changed"; stores: WalletStoreName[] } | { kind: "signout" };

export interface WalletStoreOptions {
  name?: string; // tests only: the database name
  indexedDB?: IDBFactory;
  locks?: LockManager | null; // null: run with no Web Locks, as a browser without them (06b:749)
  onEvent?: (e: WalletEvent) => void; // another tab changed a store or signed out
}

export interface WalletStore {
  readonly lane: number;
  get(store: WalletStoreName, key: string): Promise<unknown>;
  put(store: WalletStoreName, key: string, value: unknown): Promise<void>;
  delete(store: WalletStoreName, key: string): Promise<void>;
  keys(store: WalletStoreName): Promise<string[]>;
  reserveDepositIndex(scope: bigint): Promise<number>;
  raiseDepositIndex(scope: bigint, min: number): Promise<number>;
  // Writes the seed record only if none is stored, in one transaction (a compare-and-set on "absent"), so two tabs
  // that both read "no seed" never write one over the other. Resolves to the record that is stored afterwards: this
  // one when inserted, the other tab's when it lost.
  insertSeed(seed: unknown): Promise<{ inserted: boolean; seed: unknown }>;
  // Sets the stored seed's code_saved to true (the backup's "Saved", 06b ses.5) and nothing else.
  setCodeSaved(): Promise<void>;
  // Deletes the database. Refuses while the stored seed's 12 words are its only copy and not saved (backupFirst).
  signOut(): Promise<void>;
  close(): void;
}

type Bytes = Uint8Array<ArrayBuffer>;
type Wrapped = { iv: Bytes; ct: ArrayBuffer };
const K_WRAP = "k_wrap";
const LANE = "lane";
const MAX_INDEX = 0xffffffff; // derive/keys.ts counter(): an index is a u32

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((ok, no) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => no(tx.error);
    tx.onabort = () => no(tx.error ?? new Error("transaction aborted"));
  });

// Records are JSON with two tagged forms, so notes keep their field elements and bytes exact.
const TAG_N = "$bigint";
const TAG_B = "$bytes";
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Error("bad bytes in a record");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};
// Only values that come back exactly as they went in: null, boolean, string, finite number (not -0), bigint, a plain
// Uint8Array, a plain dense array and a plain object with string keys. Anything else (Date, Map, Set, ArrayBuffer,
// other typed arrays, Buffer, class instances, functions, symbols, undefined, NaN, Infinity, holes) is refused.
function toPlain(v: unknown, at: string): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || Object.is(v, -0)) throw new Error(`record field ${at} is ${String(v)}`);
    return v;
  }
  if (typeof v === "bigint") return { [TAG_N]: v.toString() };
  if (typeof v !== "object") throw new Error(`record field ${at} is a ${typeof v}`);
  const proto = Object.getPrototypeOf(v);
  if (proto === Uint8Array.prototype) return { [TAG_B]: hex(v as Uint8Array) };
  if (Object.getOwnPropertySymbols(v).length > 0) throw new Error(`record field ${at} has a symbol key`);
  if (Array.isArray(v) && proto === Array.prototype) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) {
      if (!Object.hasOwn(v, i)) throw new Error(`record field ${at}[${i}] is a hole`);
      out.push(toPlain(v[i], `${at}[${i}]`));
    }
    return out;
  }
  if (proto !== Object.prototype && proto !== null) throw new Error(`record field ${at} is not a plain object`);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    // "__proto__" would set out's prototype instead of a key, so it is refused; "constructor" and "prototype" are
    // assigned as plain own keys and come back unchanged, so they stay
    if (k === TAG_N || k === TAG_B || k === "__proto__") throw new Error(`a record may not hold the key ${k}`);
    out[k] = toPlain((v as Record<string, unknown>)[k], `${at}.${k}`);
  }
  return out;
}
function encode(value: unknown): Bytes {
  return new TextEncoder().encode(JSON.stringify(toPlain(value, "$")));
}
function decode(bytes: ArrayBuffer): unknown {
  return JSON.parse(new TextDecoder().decode(bytes), (_k, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const o = v as Record<string, unknown>;
      if (keys.length === 1 && typeof o[TAG_N] === "string") return BigInt(o[TAG_N]);
      if (keys.length === 1 && typeof o[TAG_B] === "string") return unhex(o[TAG_B]);
    }
    return v;
  });
}

const aadFor = (store: WalletStoreName, key: string): Bytes =>
  new TextEncoder().encode(store === "meta" && key === "seed" ? "ct/v1/seed" : `${store}/${key}`);

const sameRaw = (a: unknown, b: unknown): boolean => {
  if (a === undefined || b === undefined) return a === b;
  const x = (a as Wrapped).iv;
  const y = (b as Wrapped).iv;
  return x instanceof Uint8Array && y instanceof Uint8Array && x.length === y.length && x.every((v, i) => v === y[i]);
};

function checkKey(store: WalletStoreName, key: string): void {
  if (!(WALLET_STORES as readonly string[]).includes(store)) throw new Error(`unknown store ${String(store)}`);
  if (typeof key !== "string" || key.length === 0 || key.length > 256) throw new Error("a record key is 1-256 chars");
}
// counters move only by reserveDepositIndex and raiseDepositIndex; K_wrap and the lane are the store's own
function checkCallerKey(store: WalletStoreName, key: string): void {
  checkKey(store, key);
  if (store === "counters") throw new Error("counters only grow, through reserveDepositIndex");
  if (store === "meta" && key !== "seed" && key !== "settings") throw new Error(`meta key ${key} is the store's own`);
  // the seed record holds the only copy of a no-PRF account's 12 words: it is written by insertSeed only, changed by
  // setCodeSaved only, and goes only with signOut
  if (store === "meta" && key === "seed") throw new Error("the seed record is written by insertSeed and setCodeSaved only");
}
// A seed whose 12 words are its only copy and not saved yet: no source but the passkey's PRF gives them back
// (wallet.md:922, 06b:776-781). Sign out refuses it until the backup has set code_saved.
export function backupFirst(seed: unknown): boolean {
  if (seed === undefined) return false;
  const s = seed as { source?: unknown; code_saved?: unknown };
  return s?.source !== "prf" && s?.code_saved !== true;
}

// zeroes a decrypted seed's entropy once it has been read (the store's own copy; a caller's copy is the caller's)
function wipe(seed: unknown): void {
  const e = (seed as { entropy?: unknown } | undefined)?.entropy;
  if (e instanceof Uint8Array) e.fill(0);
}

function openDb(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  const r = idb.open(name, 1);
  r.onupgradeneeded = () => {
    for (const s of WALLET_STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
  };
  return req(r);
}

export async function openWalletStore(opts: WalletStoreOptions = {}): Promise<WalletStore> {
  const idb = opts.indexedDB ?? globalThis.indexedDB;
  const name = opts.name ?? WALLET_DB;
  const locks = opts.locks === undefined ? (globalThis.navigator?.locks ?? null) : opts.locks;
  const subtle = globalThis.crypto.subtle;
  let db: IDBDatabase | null = await openDb(idb, name);
  db.onversionchange = () => shut();
  function shut(): void {
    db?.close();
    db = null;
  }
  const live = (): IDBDatabase => {
    if (db === null) throw new Error("the wallet store is closed (signed out or closed)");
    return db;
  };
  const locked = <T>(fn: () => Promise<T>): Promise<T> =>
    locks ? (locks.request(WALLET_LOCK, { mode: "exclusive" }, fn) as Promise<T>) : fn();
  const seedLock = name === WALLET_DB ? WALLET_SEED_LOCK : `${WALLET_SEED_LOCK}/${name}`;
  const seedLocked = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!locks) throw new Error("no Web Locks: the seed is written and signed out only under the seed lock");
    return locks.request(seedLock, { mode: "exclusive" }, fn) as Promise<T>;
  };

  async function getRaw(store: WalletStoreName, key: string): Promise<unknown> {
    const tx = live().transaction(store, "readonly");
    return req(tx.objectStore(store).get(key));
  }
  // Writes `next` only if the record still holds `before` (same iv, or both absent), in one transaction with strict
  // durability; resolves after the commit. false: another tab wrote first.
  async function casPut(store: WalletStoreName, key: string, before: unknown, next: unknown): Promise<boolean> {
    const tx = live().transaction(store, "readwrite", { durability: "strict" });
    const os = tx.objectStore(store);
    const finished = done(tx);
    finished.catch(() => {}); // handled below; a get that fails first must not leave it unhandled
    const now = await req(os.get(key));
    if (!sameRaw(now, before)) {
      tx.abort();
      await finished.catch(() => {});
      return false;
    }
    os.put(next, key);
    await finished;
    return true;
  }

  // an open that fails part way closes its connection, so nothing is left holding the database
  const fail = (e: unknown): never => {
    shut();
    throw e;
  };

  // K_wrap: made once; a tab that loses the race takes the stored one.
  async function loadKey(): Promise<CryptoKey> {
    const fresh = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await casPut("meta", K_WRAP, undefined, fresh);
    const k = (await getRaw("meta", K_WRAP)) as CryptoKey;
    if (!k || k.extractable || k.algorithm.name !== "AES-GCM") throw new Error("K_wrap is not a wrapping key");
    return k;
  }
  const kWrap = await loadKey().catch(fail);

  // The plaintext bytes (a seed record's are its entropy as hex) are zeroed once used, on every path. What stays is in JS
  // strings, which cannot be zeroed: encode's JSON text and hex() of each byte field, and decode's JSON text and the hex
  // strings it parses back; they are left to the garbage collector.
  async function wrap(store: WalletStoreName, key: string, value: unknown): Promise<Wrapped> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = encode(value);
    try {
      const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadFor(store, key) }, kWrap, plain);
      return { iv, ct };
    } finally {
      plain.fill(0);
    }
  }
  async function unwrap(store: WalletStoreName, key: string, raw: unknown): Promise<unknown> {
    if (raw === undefined) return undefined;
    const { iv, ct } = raw as Wrapped;
    if (!(iv instanceof Uint8Array) || !(ct instanceof ArrayBuffer)) throw new Error(`${store}/${key} is not wrapped`);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aadFor(store, key) }, kWrap, ct);
    try {
      return decode(plain);
    } finally {
      new Uint8Array(plain).fill(0);
    }
  }
  const notify = (stores: WalletStoreName[]): void => channel.postMessage({ kind: "changed", stores });

  // The device's lane, drawn once (wallet.md:247): 8 divides 256, so one random byte mod 8 is uniform.
  async function readLane(): Promise<number> {
    for (;;) {
      const raw = await getRaw("meta", LANE);
      if (raw !== undefined) return (await unwrap("meta", LANE, raw)) as number;
      const d = (globalThis.crypto.getRandomValues(new Uint8Array(1))[0] as number) % WALLET_LANES;
      if (await casPut("meta", LANE, undefined, await wrap("meta", LANE, d))) return d;
    }
  }
  const lane = await locked(readLane).catch(fail);
  if (!Number.isInteger(lane) || lane < 0 || lane >= WALLET_LANES) fail(new Error("the stored lane is not 0-7"));

  // the channel opens last, once the store is usable
  const channel = new BroadcastChannel(name === WALLET_DB ? WALLET_CHANNEL : `${WALLET_CHANNEL}/${name}`);
  channel.onmessage = (m: MessageEvent<WalletEvent>) => {
    if (m.data?.kind === "signout") shut();
    opts.onEvent?.(m.data);
  };

  // The one way a counter changes: under the lock, read n, write step(n) (never lower, same lane) by compare-and-set,
  // and resolve to n only after that write has committed.
  async function moveCounter(scope: bigint, step: (n: number) => number): Promise<number> {
    if (typeof scope !== "bigint" || scope < 0n) throw new Error("a scope is a field element");
    const key = `i/${scope.toString()}`;
    return locked(async () => {
      for (;;) {
        const before = await getRaw("counters", key);
        const n = before === undefined ? lane : ((await unwrap("counters", key, before)) as { next: number }).next;
        if (!Number.isSafeInteger(n) || n < 0 || n % WALLET_LANES !== lane) throw new Error(`counter ${key} is broken`);
        const next = step(n);
        if (next < n || next % WALLET_LANES !== lane) throw new Error(`counter ${key} may only grow, in its lane`);
        if (next === n) return n;
        if (await casPut("counters", key, before, await wrap("counters", key, { next }))) {
          notify(["counters"]);
          return n;
        }
      }
    });
  }

  return {
    lane,
    async get(store, key) {
      checkKey(store, key);
      if (store === "meta" && key === K_WRAP) throw new Error("K_wrap is never read out");
      return unwrap(store, key, await getRaw(store, key));
    },
    async put(store, key, value) {
      checkCallerKey(store, key);
      const w = await wrap(store, key, value);
      const tx = live().transaction(store, "readwrite", { durability: "strict" });
      tx.objectStore(store).put(w, key);
      await done(tx);
      notify([store]);
    },
    insertSeed(seed) {
      return seedLocked(async () => {
        const inserted = await casPut("meta", "seed", undefined, await wrap("meta", "seed", seed));
        if (inserted) notify(["meta"]);
        return { inserted, seed: await unwrap("meta", "seed", await getRaw("meta", "seed")) };
      });
    },
    setCodeSaved() {
      return seedLocked(async () => {
      for (;;) {
        const before = await getRaw("meta", "seed");
        if (before === undefined) throw new Error("no seed is stored");
        const seed = (await unwrap("meta", "seed", before)) as Record<string, unknown>;
        try {
          if (seed.code_saved === true) return;
          if (await casPut("meta", "seed", before, await wrap("meta", "seed", { ...seed, code_saved: true }))) {
            notify(["meta"]);
            return;
          }
        } finally {
          wipe(seed);
        }
      }
      });
    },
    async delete(store, key) {
      checkCallerKey(store, key);
      const tx = live().transaction(store, "readwrite", { durability: "strict" });
      tx.objectStore(store).delete(key);
      await done(tx);
      notify([store]);
    },
    async keys(store) {
      checkKey(store, "x");
      const tx = live().transaction(store, "readonly");
      const all = await req(tx.objectStore(store).getAllKeys());
      return all.map(String).filter((k) => !(store === "meta" && (k === K_WRAP || k === LANE)));
    },
    // The next deposit index of this scope in the device's lane, written before it is returned (wallet.md:344-345).
    // An index once returned is never returned again, whether or not its key was used: a skipped index is skipped.
    async reserveDepositIndex(scope) {
      return moveCounter(scope, (n) => {
        if (n > MAX_INDEX) throw new Error(`deposit index for scope ${scope} is past 2^32`);
        return n + WALLET_LANES;
      });
    },
    // Restore step 7 (wallet.md:319-322): the counter goes to the lane's first index at or past `min`, or stays where
    // it is if that is already further. Resolves to the index the next reservation returns.
    async raiseDepositIndex(scope, min) {
      if (!Number.isSafeInteger(min) || min < 0 || min > MAX_INDEX) throw new Error("min is an index in [0, 2^32)");
      const up = min + ((((lane - min) % WALLET_LANES) + WALLET_LANES) % WALLET_LANES);
      if (up > MAX_INDEX) throw new Error(`min ${min} has no index in lane ${lane} at or below 2^32 - 1: past 2^32 - 1`);
      let next = 0;
      await moveCounter(scope, (n) => (next = Math.max(n, up)));
      return next;
    },
    async signOut() {
      await seedLocked(async () => {
        // the backup comes first while the 12 words are the only copy (wallet.md:922)
        const seed = await unwrap("meta", "seed", await getRaw("meta", "seed"));
        const refuse = backupFirst(seed);
        wipe(seed);
        if (refuse) throw new Error("back up the 12 words before signing out: they are the only copy");
        // a closed store never deletes the database: it may be a newer account's. Checked here, after the last await and
        // with none between it and deleteDatabase, so a store closed while the backup check ran refuses too.
        live();
        channel.postMessage({ kind: "signout" });
        shut();
        channel.close();
        // held until the delete succeeds or fails, through any blocked (see the top)
        await new Promise<void>((ok, no) => {
          const r = idb.deleteDatabase(name);
          r.onsuccess = () => ok();
          r.onerror = () => no(r.error);
        });
      });
    },
    close() {
      shut();
      channel.close();
    },
  };
}
