// The framed page's state from the wallet store (src/state.ts), card signpage-frame-state, through the postMessage API
// (src/api.ts) as main.ts starts it in the frame.
//   node --test test/state.test.ts      (from packages/signpage)
// IndexedDB is fake-indexeddb (one IDBFactory and one database name per test); WebCrypto, Web Locks and BroadcastChannel
// are Node's own, so "another tab" is a second store opened on the same database, as the wallet's store tests do.
// The seed is BIP-39's published vector 7f x 16 ("legal winner thank year ..."), never a real account.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { APP_ORIGIN, RELEASE, signedOutState, startApi, type IncomingMessage } from "../src/api.ts";
import { frameState, opOf, type FrameState } from "../src/state.ts";

const ENTROPY = () => new Uint8Array(16).fill(0x7f);
const WORDS = entropyToWords(ENTROPY());
const ENTROPY_HEX = "7f".repeat(16);

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

let n = 0;
/** One database, a tab on it, and the frame's page on it. */
async function setup() {
  const idb = new IDBFactory();
  const name = `frame-state-${process.pid}-${n++}`;
  const tab = (): Promise<WalletStore> =>
    openWalletStore({ indexedDB: idb, name }).then((s) => (closers.push(() => s.close()), s));
  const fs: FrameState = frameState((onEvent) => openWalletStore({ indexedDB: idb, name, onEvent }));
  closers.push(() => fs.close());
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void (to === APP_ORIGIN && posted.push(msg)) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: fs.state, watch: fs.watch });
  /** Asks `state` as the app does and returns the answer's result. */
  const ask = async () => {
    const id = crypto.randomUUID();
    listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id, type: "state" } });
    await api.idle();
    const a = posted.find((m) => (m as { id?: string }).id === id) as { ok: boolean; result: Record<string, unknown> };
    assert.equal(a.ok, true);
    return a.result;
  };
  const events = () => posted.filter((m) => (m as { type?: string }).type === "state").map((m) => (m as { state: Record<string, unknown> }).state);
  /** Waits until the newest state event meets `want`. */
  const event = async (want: (s: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      await api.idle();
      const e = events().at(-1);
      if (e && want(e)) return e;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    assert.fail(`no state event met the check; events: ${JSON.stringify(events())}`);
  };
  return { tab, fs, ask, events, event, posted };
}

const seed = (source: string, code_saved: boolean) => ({ v: 1, entropy: ENTROPY(), source, code_saved, created_ms: 1_767_225_600_000 });

test("a stored seed gives signed_in true with its way: prf and random are passkey, code is words, wallet is wallet", async () => {
  for (const [source, way, saved] of [["prf", "passkey", false], ["random", "passkey", false], ["code", "words", true], ["wallet", "wallet", false]] as const) {
    const p = await setup();
    const t = await p.tab();
    await t.insertSeed(seed(source, saved));
    const s = await p.ask();
    assert.equal(s.signed_in, true, source);
    assert.equal(s.way, way, source);
    assert.equal(s.code_saved, saved, source);
  }
});

test("with no seed stored the frame answers signed out, exactly signedOutState()", async () => {
  const p = await setup();
  assert.deepEqual(await p.ask(), signedOutState());
});

test("a sign-in in another tab posts signed_in true; saving the words there posts code_saved true", async () => {
  const p = await setup();
  const t = await p.tab();
  assert.equal((await p.ask()).signed_in, false);
  await t.insertSeed(seed("random", false));
  const e1 = await p.event((s) => s.signed_in === true);
  assert.equal(e1.code_saved, false);
  assert.equal(e1.way, "passkey");
  await t.setCodeSaved();
  const e2 = await p.event((s) => s.code_saved === true);
  assert.equal(e2.signed_in, true);
});

test("a sign-out in another tab posts signed_in false, and a later sign-in is still heard", async () => {
  const p = await setup();
  const t = await p.tab();
  await t.insertSeed(seed("prf", false));
  assert.equal((await p.ask()).signed_in, true);
  await t.signOut();
  assert.deepEqual(await p.event((s) => s.signed_in === false), signedOutState());
  // the frame's store was closed by the sign out; it opens a new one and keeps listening
  const t2 = await p.tab();
  await t2.insertSeed(seed("code", true));
  const e = await p.event((s) => s.signed_in === true);
  assert.equal(e.way, "words");
});

test("an op written to the store appears in ops with its stage, and each stage change posts again", async () => {
  const p = await setup();
  const t = await p.tab();
  await t.insertSeed(seed("code", true));
  assert.deepEqual((await p.ask()).ops, []);
  const id = crypto.randomUUID();
  const tx = { chain: "near", hash: "9xQ1" };
  await t.put("ops", id, { kind: "deposit", stage: "waiting", txs: [], created_ms: 2 });
  assert.deepEqual((await p.event((s) => (s.ops as unknown[]).length === 1)).ops, [{ id, kind: "deposit", stage: "waiting", txs: [] }]);
  await t.put("ops", id, { kind: "deposit", stage: "into_vault", txs: [tx], created_ms: 2 });
  assert.deepEqual((await p.event((s) => JSON.stringify(s.ops).includes("into_vault"))).ops, [{ id, kind: "deposit", stage: "into_vault", txs: [tx] }]);
  // oldest first by created_ms; a buy keeps its code
  const older = crypto.randomUUID();
  await t.put("ops", older, { kind: "buy", stage: "refused", txs: [], code: "quote_check_failed", created_ms: 1 });
  const e = await p.event((s) => (s.ops as unknown[]).length === 2);
  assert.deepEqual(e.ops, [
    { id: older, kind: "buy", stage: "refused", txs: [], code: "quote_check_failed" },
    { id, kind: "deposit", stage: "into_vault", txs: [tx] },
  ]);
});

test("an ops record of another shape is left out, never sent; the others still show", async () => {
  const ok = crypto.randomUUID();
  assert.deepEqual(opOf(ok, { kind: "restore", stage: "reading", txs: [] }), { id: ok, kind: "restore", stage: "reading", txs: [] });
  for (const bad of [
    undefined, null, "deposit", [], {},
    { kind: "deposit", stage: "filled", txs: [] }, // a trade's stage on a deposit
    { kind: "mint", stage: "done", txs: [] },
    { kind: "deposit", stage: "done" },
    { kind: "deposit", stage: "done", txs: [{ chain: "doge", hash: "x" }] },
    { kind: "deposit", stage: "done", txs: [{ chain: "near" }] },
    { kind: "deposit", stage: "done", txs: "x" },
    { kind: "buy", stage: "refused", txs: [], code: "Error: secret at 0x1" },
  ]) assert.equal(opOf(ok, bad), null, JSON.stringify(bad) ?? String(bad));
  const p = await setup();
  const t = await p.tab();
  await t.insertSeed(seed("code", true));
  await t.put("ops", "bad", { kind: "deposit", stage: "filled", txs: [] });
  await t.put("ops", ok, { kind: "withdraw", stage: "proving", txs: [] });
  assert.deepEqual((await p.ask()).ops, [{ id: ok, kind: "withdraw", stage: "proving", txs: [] }]);
});

test("exact keys: the state's keys and value types, and nothing secret in it", async () => {
  const p = await setup();
  const t = await p.tab();
  const out = await p.ask();
  assert.deepEqual(Object.keys(out), ["release", "api", "signed_in", "code_saved", "vault_balance", "wallets", "positions", "orders", "held", "ops"]);
  await t.insertSeed(seed("random", false));
  // an op record that holds what must never leave: every field but the allowed ones is dropped
  const id = crypto.randomUUID();
  await t.put("ops", id, {
    kind: "withdraw", stage: "submitted", txs: [{ chain: "near", hash: "4Hc", secret: ENTROPY_HEX }], created_ms: 1,
    words: WORDS, entropy: ENTROPY(), note_value: 5_000_000n, nullifier: 123n, context: "0xabc", key: ENTROPY_HEX,
  });
  const s = await p.ask();
  assert.deepEqual(Object.keys(s), ["release", "api", "signed_in", "way", "code_saved", "vault_balance", "wallets", "positions", "orders", "held", "ops"]);
  const types = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? "array" : typeof v]));
  assert.deepEqual(types, {
    release: "string", api: "number", signed_in: "boolean", way: "string", code_saved: "boolean", vault_balance: "string",
    wallets: "array", positions: "array", orders: "array", held: "array", ops: "array",
  });
  assert.deepEqual(s, {
    release: RELEASE, api: 1, signed_in: true, way: "passkey", code_saved: false, vault_balance: "0",
    wallets: [], positions: [], orders: [], held: [], ops: [{ id, kind: "withdraw", stage: "submitted", txs: [{ chain: "near", hash: "4Hc" }] }],
  });
  const json = JSON.stringify(s);
  for (const secret of [ENTROPY_HEX, WORDS, WORDS.split(" ")[0]!, "5000000", "0xabc"]) assert.ok(!json.includes(secret), secret);
  // only plain JSON values: no bytes, no bigint, no prototype but Object's and Array's
  const plain = (v: unknown): boolean =>
    v === null || ["string", "number", "boolean"].includes(typeof v) ||
    (Array.isArray(v) ? v.every(plain) : typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype && Object.values(v as object).every(plain));
  assert.ok(plain(s));
});

test("a store the frame cannot open or read answers signed out, with no error text", async () => {
  // IndexedDB refused (a blocked store, a private window): open throws
  const blocked = frameState(() => Promise.reject(new DOMException("The user denied permission to access the database.", "SecurityError")));
  assert.deepEqual(await blocked.state(), signedOutState());
  // no IndexedDB at all
  const none = frameState((onEvent) => openWalletStore({ indexedDB: undefined as unknown as IDBFactory, onEvent }));
  assert.deepEqual(await none.state(), signedOutState());
  // a broken seed record: signed out, and the reads go on
  const p = await setup();
  const t = await p.tab();
  await t.insertSeed({ v: 1, entropy: new Uint8Array(3), source: "prf", code_saved: false, created_ms: 1 });
  assert.deepEqual(await p.ask(), signedOutState());
  assert.deepEqual(await p.fs.state(), signedOutState());
});

test("the seed's entropy the frame reads is zeroed once read", async () => {
  const idb = new IDBFactory();
  const name = `frame-state-zero-${process.pid}`;
  const t = await openWalletStore({ indexedDB: idb, name });
  closers.push(() => t.close());
  await t.insertSeed(seed("prf", false));
  const seen: Uint8Array[] = [];
  const fs = frameState(async (onEvent) => {
    const s = await openWalletStore({ indexedDB: idb, name, onEvent });
    closers.push(() => s.close());
    return {
      ...s,
      get: async (store, key) => {
        const v = await s.get(store, key);
        const e = (v as { entropy?: unknown } | undefined)?.entropy;
        if (e instanceof Uint8Array) seen.push(e);
        return v;
      },
    } as WalletStore;
  });
  closers.push(() => fs.close());
  assert.equal((await fs.state()).signed_in, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.every((b) => b === 0));
});
