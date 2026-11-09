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
import { openWalletStore, openWalletStoreReader, WALLET_CHANNEL, type WalletStore, type WalletStoreReader } from "@blindfill/wallet/store";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_MAX_ARRAY, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { APP_ORIGIN, RELEASE, signedOutState, startApi, type IncomingMessage } from "../src/api.ts";
import { ANSWER_ROOM, frameState, opOf, pickOps, stateOf, type ChannelListen, type FrameState, type OpRow } from "../src/state.ts";

const ENTROPY = () => new Uint8Array(16).fill(0x7f);
const WORDS = entropyToWords(ENTROPY());
const ENTROPY_HEX = "7f".repeat(16);

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

/** The frame's own BroadcastChannel on the store's channel for database `name`, as main.ts opens it. */
const channelOf = (name: string): ChannelListen => (fn) => {
  const ch = new BroadcastChannel(`${WALLET_CHANNEL}/${name}`);
  ch.onmessage = (m) => fn(m.data);
  closers.push(() => ch.close());
};
/** A raw IndexedDB delete, as a crash or an older release would leave the database. */
function rawDelete(idb: IDBFactory, name: string, store: string, key: string): Promise<void> {
  return new Promise((ok, no) => {
    const o = idb.open(name);
    o.onerror = () => no(o.error);
    o.onsuccess = () => {
      const tx = o.result.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => (o.result.close(), ok());
      tx.onerror = () => no(tx.error);
    };
  });
}

let n = 0;
/** One database, a tab on it, and the frame's page on it (the read-only open and its own channel, as main.ts). */
async function setup() {
  const idb = new IDBFactory();
  const name = `frame-state-${process.pid}-${n++}`;
  const tab = (): Promise<WalletStore> =>
    openWalletStore({ indexedDB: idb, name }).then((s) => (closers.push(() => s.close()), s));
  const fs: FrameState = frameState((onEvent) => openWalletStoreReader({ indexedDB: idb, name, onEvent }), channelOf(name));
  closers.push(() => fs.close());
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void (to === APP_ORIGIN && posted.push(msg)) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: fs.state, watch: fs.watch });
  // the app on this kit names its version first, as the kit's client does (card kit-frame-version)
  listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION } });
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
  return { tab, fs, ask, events, event, posted, idb, name };
}

const seed = (source: string, code_saved: boolean) => ({ v: 1, entropy: ENTROPY(), source, code_saved, created_ms: 1_767_225_600_000 });
type Source = "prf" | "random" | "code" | "wallet";
/** A sign-in as SIGN_HOST's top-level page makes it: insertSeed, which writes the status in the seed's transaction. */
async function signIn(t: WalletStore, source: Source, code_saved: boolean): Promise<void> {
  await t.insertSeed(seed(source, code_saved));
}

test("a stored seed gives signed_in true with its way: prf and random are passkey, code is words, wallet is wallet", async () => {
  for (const [source, way, saved] of [["prf", "passkey", false], ["random", "passkey", false], ["code", "words", true], ["wallet", "wallet", false]] as const) {
    const p = await setup();
    const t = await p.tab();
    await signIn(t, source, saved);
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

test("crash order: a seed with no status is signed in, code_saved false, no way; a status with no seed is signed out", async () => {
  const p = await setup();
  const t = await p.tab();
  // a database from before the status record: the seed alone
  await signIn(t, "code", true);
  await rawDelete(p.idb, p.name, "meta", "status");
  const s = await p.ask();
  assert.deepEqual(s, { ...signedOutState(), signed_in: true });
  assert.ok(!Object.hasOwn(s, "way"));
  // the top-level load's backfill writes it
  await t.syncStatus();
  assert.deepEqual(await p.ask(), { ...signedOutState(), signed_in: true, way: "words", code_saved: true });
  // a status with no seed: signed out
  await rawDelete(p.idb, p.name, "meta", "seed");
  assert.deepEqual(await p.ask(), signedOutState());
});

test("no database: the frame reads signed out, makes no database, and hears the first sign-in on its own channel", async () => {
  const p = await setup();
  assert.deepEqual(await p.ask(), signedOutState());
  assert.deepEqual(await p.idb.databases(), [], "the frame made no database");
  const t = await p.tab();
  await signIn(t, "prf", false);
  const e = await p.event((s) => s.signed_in === true);
  assert.equal(e.way, "passkey");
});

test("a sign-in in another tab posts signed_in true; saving the words there posts code_saved true", async () => {
  const p = await setup();
  const t = await p.tab();
  assert.equal((await p.ask()).signed_in, false);
  await signIn(t, "random", false);
  const e1 = await p.event((s) => s.signed_in === true);
  assert.equal(e1.code_saved, false);
  assert.equal(e1.way, "passkey");
  await t.setCodeSaved({ entropy: ENTROPY() });
  const e2 = await p.event((s) => s.code_saved === true);
  assert.equal(e2.signed_in, true);
});

test("a sign-out in another tab posts signed_in false, and a later sign-in is still heard", async () => {
  const p = await setup();
  const t = await p.tab();
  await signIn(t, "prf", false);
  assert.equal((await p.ask()).signed_in, true);
  await t.signOut();
  assert.deepEqual(await p.event((s) => s.signed_in === false), signedOutState());
  // the frame's store was closed by the sign out; it opens a new one and keeps listening
  const t2 = await p.tab();
  await signIn(t2, "code", true);
  const e = await p.event((s) => s.signed_in === true);
  assert.equal(e.way, "words");
});

test("an op written to the store appears in ops with its stage, and each stage change posts again", async () => {
  const p = await setup();
  const t = await p.tab();
  await signIn(t, "code", true);
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
  await signIn(t, "code", true);
  await t.put("ops", "bad", { kind: "deposit", stage: "filled", txs: [] });
  await t.put("ops", ok, { kind: "withdraw", stage: "proving", txs: [] });
  assert.deepEqual((await p.ask()).ops, [{ id: ok, kind: "withdraw", stage: "proving", txs: [] }]);
});

test("exact keys: the state's keys and value types, and nothing secret in it", async () => {
  const p = await setup();
  const t = await p.tab();
  const out = await p.ask();
  assert.deepEqual(Object.keys(out), ["release", "api", "signed_in", "code_saved", "vault_balance", "wallets", "positions", "orders", "held", "ops"]);
  await signIn(t, "random", false);
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
  const quiet: ChannelListen = () => {};
  // IndexedDB refused (a blocked store, a private window): open throws
  const blocked = frameState(() => Promise.reject(new DOMException("The user denied permission to access the database.", "SecurityError")), quiet);
  assert.deepEqual(await blocked.state(), signedOutState());
  // no IndexedDB at all
  const none = frameState((onEvent) => openWalletStoreReader({ indexedDB: undefined as unknown as IDBFactory, onEvent }), quiet);
  assert.deepEqual(await none.state(), signedOutState());
  // a store whose reads fail after it opened: signed out, and the next read opens it again
  const idb = new IDBFactory();
  const t = await openWalletStore({ indexedDB: idb, name: "frame-state-fail" });
  closers.push(() => t.close());
  await t.insertSeed(seed("prf", false));
  let opens = 0;
  const failing = frameState(async (onEvent) => {
    opens++;
    const s = await openWalletStoreReader({ indexedDB: idb, name: "frame-state-fail", onEvent });
    closers.push(() => s?.close());
    return { ...s!, keys: () => Promise.reject(new Error("internal: read failed at 0x1")) } as WalletStoreReader;
  }, quiet);
  closers.push(() => failing.close());
  assert.deepEqual(await failing.state(), signedOutState());
  assert.deepEqual(await failing.state(), signedOutState());
  assert.equal(opens, 2);
});

// pickOps: the count cap, then the byte cap, each at its boundary
const row = (i: number, txs = 0): OpRow => ({
  op: { id: `op-${String(i).padStart(6, "0")}`, kind: "buy", stage: "filled", txs: Array.from({ length: txs }, () => ({ chain: "solana" as const, hash: "5".repeat(512) })) },
  t: i,
});
const answerBytes = (st: unknown) => new TextEncoder().encode(JSON.stringify({ v: 1, id: crypto.randomUUID(), ok: true, result: st })).length;

test("pickOps: past SIGNPAGE_MAX_ARRAY ops the newest that many are kept, oldest first", () => {
  const base = stateOf(true, { source: "prf", code_saved: true }, []);
  const rows = Array.from({ length: SIGNPAGE_MAX_ARRAY + 1 }, (_, i) => row(i)).reverse();
  const ops = pickOps(base, rows);
  assert.equal(ops.length, SIGNPAGE_MAX_ARRAY);
  assert.equal(ops[0]!.id, "op-000001", "the oldest is the one dropped");
  assert.equal(ops.at(-1)!.id, `op-${String(SIGNPAGE_MAX_ARRAY).padStart(6, "0")}`);
  assert.equal(pickOps(base, rows.slice(1)).length, SIGNPAGE_MAX_ARRAY, "exactly the cap: all kept");
});

test("pickOps: the oldest are dropped until the answer fits SIGNPAGE_MAX_ANSWER_BYTES with ANSWER_ROOM to spare", () => {
  const base = stateOf(true, { source: "prf", code_saved: true }, []);
  const rows = Array.from({ length: 100 }, (_, i) => row(i, 100)); // about 54 KB each, 5.4 MB in all
  const ops = pickOps(base, rows);
  const kept = { ...base, ops };
  const limit = SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM;
  assert.ok(ops.length > 0 && ops.length < 100, String(ops.length));
  assert.equal(ops.at(-1)!.id, "op-000099", "the newest stay");
  const size = new TextEncoder().encode(JSON.stringify(kept)).length;
  assert.ok(size <= limit, `${size} > ${limit}`);
  // one more (the next older) would not fit: the boundary
  const older = rows[100 - ops.length - 1]!.op;
  assert.ok(new TextEncoder().encode(JSON.stringify({ ...base, ops: [older, ...ops] })).length > limit);
  assert.ok(answerBytes(kept) <= SIGNPAGE_MAX_ANSWER_BYTES);
  // the limit met to the byte: an older op that takes exactly the bytes left is kept; one byte more and it is dropped
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  const slack = limit - size;
  const filler = (idLen: number, txs: { chain: "solana"; hash: string }[]) => ({ id: "f".repeat(idLen), kind: "buy" as const, stage: "filled" as const, txs });
  const full = { chain: "solana" as const, hash: "5".repeat(512) };
  const fit = (() => {
    const txs: (typeof full)[] = [];
    while (enc(filler(1, [...txs, full, full])) + 1 <= slack) txs.push(full);
    for (let h = 512; h >= 0; h--) {
      const t = h ? [...txs, { chain: "solana" as const, hash: "5".repeat(h) }] : txs;
      const need = slack - (enc(filler(0, t)) + 1);
      if (need >= 1 && need <= 512) return filler(need, t);
    }
    return null;
  })();
  assert.ok(fit, `no filler for ${slack} bytes`);
  const kept2 = pickOps(base, [{ op: fit, t: -1 }, ...rows.slice(100 - ops.length)]);
  assert.equal(kept2.length, ops.length + 1, "exactly at the limit: kept");
  assert.equal(enc({ ...base, ops: kept2 }), limit);
  // the answer around it (v, id, ok) still fits the client's limit: ANSWER_ROOM is the envelope's room
  assert.ok(answerBytes({ ...base, ops: kept2 }) <= SIGNPAGE_MAX_ANSWER_BYTES, String(answerBytes({ ...base, ops: kept2 })));
  const over = { ...fit, id: `${fit.id}f` };
  assert.equal(pickOps(base, [{ op: over, t: -1 }, ...rows.slice(100 - ops.length)]).length, ops.length, "one byte over: dropped");
});

// Card kit-deposit-calls: the deposit op carries its facts (kit messages.ts DepositFacts) through the frame, only those
// fields and only on their stages, under the deposit.quote request's id.
test("kit-deposit-calls: a deposit op's stage and facts reach the app through the frame, under its quote's request id", async () => {
  const p = await setup();
  const t = await p.tab();
  await signIn(t, "code", true);
  assert.deepEqual((await p.ask()).ops, []);
  const id = crypto.randomUUID();
  const U = "b".repeat(64);
  const steps: Record<string, unknown>[] = [
    { stage: "quote_checked" },
    { stage: "waiting", since_ms: 1762400000000 },
    { stage: "short", since_ms: 1762400000000 },
    { stage: "failed", since_ms: 1762400000000 },
    { stage: "refunded", held_id: U, since_ms: 1762400000000 },
    { stage: "refund_move", refunded: true, held_id: U, since_ms: 1762400000000 },
    { stage: "halted", hold: "not_caught_up", held_id: U, since_ms: 1762400000000 },
    { stage: "done", refunded: true, since_ms: 1762400000000, amount_usd: "73.18" },
  ];
  for (const facts of steps) {
    // a stray field in the record is never copied
    await t.put("ops", id, { kind: "deposit", txs: [], created_ms: 3, note: "x", ...facts });
    const s = await p.event((st) => JSON.stringify(st.ops).includes(`"stage":"${facts.stage}"`));
    assert.deepEqual(s.ops, [{ id, kind: "deposit", txs: [], ...facts }], JSON.stringify(facts));
    assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(s), true, `the kit's client takes it: ${JSON.stringify(facts)}`);
  }
  await t.put("ops", "x2", { kind: "deposit", stage: "expired", txs: [], created_ms: 4 });
  assert.deepEqual(((await p.event((st) => (st.ops as unknown[]).length === 2)).ops as unknown[]).at(-1), { id: "x2", kind: "deposit", stage: "expired", txs: [] });
});

test("kit-deposit-calls: a deposit record with a fact on the wrong stage, or a fact on another kind, is left out", () => {
  const id = crypto.randomUUID();
  for (const bad of [
    { kind: "deposit", stage: "waiting", txs: [], hold: "halted" },
    { kind: "deposit", stage: "in_transit", txs: [], amount_usd: "1" },
    { kind: "deposit", stage: "quote_checked", txs: [], since_ms: 1 },
    { kind: "deposit", stage: "waiting", txs: [], held_id: "u" },
    { kind: "deposit", stage: "waiting", txs: [], refunded: true },
    { kind: "deposit", stage: "halted", txs: [], hold: "frozen" },
  ]) assert.equal(opOf(id, bad), null, JSON.stringify(bad));
  // a buy record's since_ms is not copied (no kind but a deposit has facts)
  assert.deepEqual(opOf(id, { kind: "buy", stage: "filled", txs: [], since_ms: 1 }), { id, kind: "buy", stage: "filled", txs: [] });
});

test("held-move-forgotten-tx: a held deposit whose move out landed (follow.why moved_out) is sent with moved_out, and only that one", () => {
  const id = crypto.randomUUID();
  const held = { kind: "deposit", stage: "held", txs: [], held_id: "u.near", since_ms: 1 };
  const out = { to: "alice.near", amount: "1", nonce: "8", height: 1, register: false, hash: "h", signed: "s" };
  const moved = opOf(id, { ...held, follow: { why: "moved_out", u: "u.near", out } });
  assert.deepEqual(moved, { id, kind: "deposit", stage: "held", txs: [], held_id: "u.near", since_ms: 1, moved_out: true });
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(stateOf(true, undefined, [moved!])), true, "the kit's client takes it");
  // follow.ts's moved_out with no move of this op's own (review M2: a withdraw.open took the money, its USDC may still
  // reach U): still Held, its Withdraw kept
  assert.deepEqual(opOf(id, { ...held, follow: { why: "moved_out", u: "u.near" } }), { id, kind: "deposit", stage: "held", txs: [], held_id: "u.near", since_ms: 1 });
  assert.deepEqual(opOf(id, { ...held, follow: { why: "moved_out", u: "u.near", out: "h" } }), { id, kind: "deposit", stage: "held", txs: [], held_id: "u.near", since_ms: 1 }, "an out that is no record");
  // still held (why under_min, or no follow): no moved_out; a record's own moved_out field is never copied
  assert.deepEqual(opOf(id, { ...held, follow: { why: "under_min" } }), { id, kind: "deposit", stage: "held", txs: [], held_id: "u.near", since_ms: 1 });
  assert.deepEqual(opOf(id, { ...held, moved_out: true }), { id, kind: "deposit", stage: "held", txs: [], held_id: "u.near", since_ms: 1 });
  // moved_out on another stage is no op the kit reads
  assert.deepEqual(opOf(id, { kind: "deposit", stage: "done", txs: [], since_ms: 1, follow: { why: "moved_out", out } }), { id, kind: "deposit", stage: "done", txs: [], since_ms: 1 });
  for (const stage of ["halted", "done", "refunded", "waiting"]) assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(stateOf(true, undefined, [{ id, kind: "deposit", stage, txs: [], moved_out: true } as never])), false, stage);
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(stateOf(true, undefined, [{ id, kind: "deposit", stage: "held", txs: [], moved_out: false } as never])), false, "moved_out is true or absent");
});

test("pool-deposit-stages: a pool deposit's op reaches the app at every stage, with its pool's chain and each fact on its stages only", () => {
  const id = crypto.randomUUID();
  const follow = { chain: "solana", s: "777", i: 3, u: "U_X", refund_id: "ab".repeat(32), address: "DEPOSIT", deadline_ms: 1, origin: "nep141:base-usdc", min_out: "20000000" };
  // the record as the pool follow keeps it (pool-deposit-follow.ts PoolDepositOp): since_ms once a send was seen, refunded from the refund on
  const rec = (stage: string, more: Record<string, unknown> = {}) => ({ kind: "pool_deposit", stage, txs: [], created_ms: 1, follow, ...more });
  const want = (stage: string, more: Record<string, unknown> = {}) => ({ id, kind: "pool_deposit", stage, txs: [], chain: "solana", ...more });
  for (const [r, w] of [
    [rec("quote_checked"), want("quote_checked")],
    [rec("expired"), want("expired")],
    [rec("waiting", { since_ms: 7 }), want("waiting", { since_ms: 7 })],
    [rec("in_transit", { since_ms: 7 }), want("in_transit", { since_ms: 7 })],
    [rec("failed", { since_ms: 7 }), want("failed", { since_ms: 7 })],
    [rec("short", { since_ms: 7 }), want("short", { since_ms: 7 })],
    [rec("in_pool", { since_ms: 7, final: true }), want("in_pool", { since_ms: 7 })],
    // the record keeps refunded from the refunded stage on; the app is sent it only on the refund's later legs
    [rec("refunded", { since_ms: 7, refunded: true }), want("refunded", { since_ms: 7 })],
    [rec("refund_move", { since_ms: 7, refunded: true }), want("refund_move", { since_ms: 7, refunded: true })],
    // review P3 1: a refund_move record of release-94 to 107 (no refunded fact) is still sent as a refund's leg
    [rec("refund_move"), want("refund_move", { refunded: true })],
    [rec("in_pool", { since_ms: 7, refunded: true, final: true }), want("in_pool", { since_ms: 7, refunded: true })],
    // delta review P2: a refunded record of release-94 to 107 (the helper's word alone, no refunded fact) is sent as the
    // follow reads it again, quote_checked with no send time, on the framed page that runs no follow too
    [rec("refunded"), want("quote_checked")],
    [rec("refunded", { since_ms: 7 }), want("quote_checked")],
    // a send time on a stage where nothing was sent is not sent
    [rec("expired", { since_ms: 7 }), want("expired")],
    [rec("in_pool", { txs: [{ chain: "solana", hash: "5sig", extra: 1 }] }), want("in_pool", { txs: [{ chain: "solana", hash: "5sig" }] })],
  ] as const) {
    const op = opOf(id, r);
    assert.deepEqual(op, w, JSON.stringify(r));
    assert.ok(SIGNPAGE_RESULT_SCHEMAS.state(stateOf(true, undefined, [op!])), `the kit reads ${r.stage}`);
    for (const k of ["follow", "created_ms", "final"]) assert.ok(!(k in op!), `${k} never sent`);
  }
  // a record that is not one: left out, never sent
  for (const bad of [
    { kind: "pool_deposit", stage: "in_pool", txs: [] },
    rec("in_pool", { follow: { ...follow, chain: "near" } }),
    rec("done"),
    rec("held"),
    rec("in_pool", { since_ms: -1 }),
  ]) assert.equal(opOf(id, bad), null, JSON.stringify(bad));
});
