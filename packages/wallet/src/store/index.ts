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
// - Two tabs: every reservation runs under the Web Lock "ct-wallet" (06b:743-744, wallet.md:206) and lands only by a
//   compare-and-set inside one IndexedDB transaction, so two tabs never get one value, also where Web Locks are
//   missing (06b:749, TAB-03).
// - Sign out: broadcast "signout" on BroadcastChannel "ct-wallet", then delete the database (06b:1235, wallet.md:156);
//   other tabs close their connection on the delete's versionchange, so the delete is not blocked.

export const WALLET_DB = "ct-wallet"; // 06b:538
export const WALLET_LOCK = "ct-wallet"; // 06b:743
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
function encode(value: unknown): Bytes {
  const json = JSON.stringify(value, function (_k, v: unknown) {
    if (typeof v === "bigint") return { [TAG_N]: v.toString() };
    if (v instanceof Uint8Array) return { [TAG_B]: hex(v) };
    if (v !== null && typeof v === "object" && (Object.hasOwn(v, TAG_N) || Object.hasOwn(v, TAG_B)))
      throw new Error(`a record may not hold the key ${TAG_N} or ${TAG_B}`);
    return v;
  });
  if (json === undefined) throw new Error("a record must be a JSON value");
  return new TextEncoder().encode(json);
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
// counters move only by reserveDepositIndex; K_wrap and the lane are the store's own
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
  const channel = new BroadcastChannel(name === WALLET_DB ? WALLET_CHANNEL : `${WALLET_CHANNEL}/${name}`);
  channel.onmessage = (m: MessageEvent<WalletEvent>) => {
    if (m.data?.kind === "signout") shut();
    opts.onEvent?.(m.data);
  };
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

  // K_wrap: made once; a tab that loses the race takes the stored one.
  const fresh = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await casPut("meta", K_WRAP, undefined, fresh);
  const kWrap = (await getRaw("meta", K_WRAP)) as CryptoKey;
  if (!kWrap || kWrap.extractable || kWrap.algorithm.name !== "AES-GCM") throw new Error("K_wrap is not a wrapping key");

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
  const lane = await locked(readLane);
  if (!Number.isInteger(lane) || lane < 0 || lane >= WALLET_LANES) throw new Error("the stored lane is not 0-7");

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
      if (typeof scope !== "bigint" || scope < 0n) throw new Error("a scope is a field element");
      const key = `i/${scope.toString()}`;
      return locked(async () => {
        for (;;) {
          const before = await getRaw("counters", key);
          const n = before === undefined ? lane : ((await unwrap("counters", key, before)) as { next: number }).next;
          if (!Number.isSafeInteger(n) || n < 0 || n % WALLET_LANES !== lane) throw new Error(`counter ${key} is broken`);
          if (n > MAX_INDEX) throw new Error(`deposit index for scope ${key} is past 2^32`);
          const after = await wrap("counters", key, { next: n + WALLET_LANES });
          if (await casPut("counters", key, before, after)) {
            notify(["counters"]);
            return n;
          }
        }
      });
    },
    async signOut() {
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
