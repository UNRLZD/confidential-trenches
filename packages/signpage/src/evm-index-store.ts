// The device's EVM pool index across reloads (kit checks/evm/pool-index.ts EvmPoolIndexData: every pool of a chain's
// PoolManager to block N, public chain data and nothing of the user's), in an IndexedDB database of its own, never the
// wallet's store: a sign out leaves it, and no seed or note is near it. One record a chain, the index as plain data
// (structured clone). Every call is held to EVM_INDEX_STORE_MS: a store that hangs or fails answers null (a read) or
// nothing (a write), and the page syncs from memory as before; no tap ever waits on it.

import type { EvmPoolIndexData } from "../../kit/src/checks/evm/pool-index.ts";

export const EVM_INDEX_DB = "ct-evm-pool-index";
const STORE = "index";
/** The bound on one open, read or write, ms. */
export const EVM_INDEX_STORE_MS = 3_000;

export type EvmIndexStore = {
  get(chain: string): Promise<EvmPoolIndexData | null>;
  put(chain: string, index: EvmPoolIndexData): Promise<void>;
};

/** `p`, or a rejection once `ms` have passed without it. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, no) => (t = setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((ok, no) => ((r.onsuccess = () => ok(r.result)), (r.onerror = () => no(r.error))));

/** The index store on `idb` (globalThis.indexedDB when none; a page with none gets a store that holds nothing). */
export function evmIndexStore(idb: IDBFactory | undefined = globalThis.indexedDB, ms = EVM_INDEX_STORE_MS): EvmIndexStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> =>
    (db ??= within(
      new Promise<IDBDatabase>((ok, no) => {
        if (idb === undefined) return no(new Error("no IndexedDB"));
        const r = idb.open(EVM_INDEX_DB, 1);
        r.onupgradeneeded = () => void r.result.createObjectStore(STORE);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
        r.onblocked = () => no(new Error("blocked"));
      }),
      ms,
    ).catch((e) => ((db = null), Promise.reject(e))));
  return {
    get: async (chain) => {
      try {
        const d = await open();
        const v = await within(req(d.transaction(STORE, "readonly").objectStore(STORE).get(chain)), ms);
        return typeof v === "object" && v !== null && (v as { v?: unknown }).v === 1 ? (v as EvmPoolIndexData) : null;
      } catch {
        return null;
      }
    },
    put: async (chain, index) => {
      try {
        const d = await open();
        const tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(index, chain);
        await within(new Promise<void>((ok, no) => ((tx.oncomplete = () => ok()), (tx.onerror = () => no(tx.error)), (tx.onabort = () => no(tx.error)))), ms);
      } catch {
        // nothing kept: the next load syncs cold
      }
    },
  };
}
