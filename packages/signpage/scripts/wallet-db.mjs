#!/usr/bin/env node
// Does a wallet store module open a database at a given version (card signpage-withdraw-own-spend fold 2, review
// MEDIUM 3)? deploy.mjs runs it on the store the build carries, at the highest version a served release can have made
// a database (WALLET_DB_SERVED): a store that opens at a fixed lower version meets a VersionError there, and every
// signing on SIGN_HOST stops until a newer deploy. The database is an in-memory one (fake-indexeddb) holding every store
// the module names; nothing on disk or on the network is touched.
//   node packages/signpage/scripts/wallet-db.mjs <store module> <version>     exit 0 it opens, 1 it does not, 2 usage
import { pathToFileURL } from "node:url";
import { IDBFactory } from "fake-indexeddb";

const [file, v] = process.argv.slice(2);
const version = Number(v);
if (!file || !Number.isSafeInteger(version) || version < 1) {
  console.error("usage: node packages/signpage/scripts/wallet-db.mjs <store module> <version>");
  process.exit(2);
}
const { openWalletStore, WALLET_STORES } = await import(pathToFileURL(file).href);
const idb = new IDBFactory();
await new Promise((ok, no) => {
  const r = idb.open("ct-wallet", version);
  r.onupgradeneeded = () => {
    for (const s of WALLET_STORES) r.result.createObjectStore(s);
  };
  r.onsuccess = () => (r.result.close(), ok());
  r.onerror = () => no(r.error);
});
try {
  (await openWalletStore({ indexedDB: idb, locks: null })).close();
} catch (e) {
  console.log(`the wallet store cannot open a version ${version} database (${e?.name ?? String(e)})`);
  process.exit(1);
}
