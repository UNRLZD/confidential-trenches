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
//   re-entrant, so a caller holding it around a reservation would hang (CO decision, round 2; 06b:743 told callers to
//   hold "ct-wallet", which no longer guards anything here).
// - Sign out: broadcast "signout" on BroadcastChannel "ct-wallet", then delete the database (06b:1235, wallet.md:156);
//   other tabs close their connection on the delete's versionchange, so the delete is not blocked. A store that is
//   already closed refuses to sign out, so a stale tab never deletes a newer account's database.
// - restore step 7 (wallet.md:319-322) moves a counter up with raiseDepositIndex, under the same lock and
//   compare-and-set; nothing ever lowers a counter.

export const WALLET_DB = "ct-wallet"; // 06b:538
export const WALLET_LOCK = "ct-wallet/counters"; // the store's own; 06b:743 named "ct-wallet"
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
    if (k === TAG_N || k === TAG_B) throw new Error(`a record may not hold the key ${k}`);
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

  async function wrap(store: WalletStoreName, key: string, value: unknown): Promise<Wrapped> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = encode(value);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadFor(store, key) }, kWrap, plain);
    return { iv, ct };
  }
  async function unwrap(store: WalletStoreName, key: string, raw: unknown): Promise<unknown> {
    if (raw === undefined) return undefined;
    const { iv, ct } = raw as Wrapped;
    if (!(iv instanceof Uint8Array) || !(ct instanceof ArrayBuffer)) throw new Error(`${store}/${key} is not wrapped`);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aadFor(store, key) }, kWrap, ct);
    return decode(plain);
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
      let next = 0;
      await moveCounter(scope, (n) => (next = Math.max(n, up)));
      return next;
    },
    async signOut() {
      live(); // a closed store never deletes the database: it may be a newer account's
      channel.postMessage({ kind: "signout" });
      shut();
      channel.close();
      await new Promise<void>((ok, no) => {
        const r = idb.deleteDatabase(name);
        r.onsuccess = () => ok();
        r.onerror = () => no(r.error);
      });
    },
    close() {
      shut();
      channel.close();
    },
  };
}
