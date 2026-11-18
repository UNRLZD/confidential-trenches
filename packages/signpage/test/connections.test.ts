// The origins the user connected on SIGN_HOST (src/connections.ts) and the API's gate on them (src/api.ts admit), card
// signpage-other-apps-connect.
//   node --test test/connections.test.ts      (from packages/signpage)
// The store keeps one approval per origin on the device, seen by every tab, removable, failing closed. The API asks it
// before each request is read further and before each state push: an origin with no approval, or one removed since, is
// refused not_allowed with no state read and no kind run, and gets no state event. APP_HOST's terminal sets no gate
// and is answered as before (test/api.test.ts, test/shell.test.ts). The popup shell's half is test/shell.test.ts's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { bareOrigin, clearConnections, connections } from "../src/connections.ts";
import { signedOutState, startApi, type ApiHost, type IncomingMessage } from "../src/api.ts";

const OUT = "https://app.example";
const OTHER = "http://localhost:5173";

test("the store: an origin added is approved in every tab, listed, and removed or cleared for every tab", async () => {
  const idb = new IDBFactory();
  const a = connections(idb);
  const b = connections(idb); // another tab of SIGN_HOST
  assert.equal(await a.has(OUT), false);
  await a.add(OUT);
  await a.add(OTHER);
  assert.equal(await b.has(OUT), true);
  assert.deepEqual(await b.list(), [OTHER, OUT].sort());
  await b.remove(OUT);
  assert.equal(await a.has(OUT), false, "a removal in another tab holds for the next read");
  assert.equal(await a.has(OTHER), true);
  await a.clear();
  assert.deepEqual(await b.list(), []);
});

test("the store keeps a bare origin only: a path, credentials, the opaque origin or a non-string is refused and never approved", async () => {
  const s = connections(new IDBFactory());
  for (const bad of [`${OUT}/`, `${OUT}/x`, "https://u@app.example", "null", "", "app.example", "javascript:alert(1)"]) {
    await assert.rejects(s.add(bad), TypeError, bad);
    assert.equal(await s.has(bad), false, bad);
  }
  assert.equal(bareOrigin(OUT), true);
  assert.equal(bareOrigin(42), false);
  assert.deepEqual(await s.list(), []);
});

test("the store fails closed: no IndexedDB, or an open that never answers, approves nothing and refuses a write", async () => {
  const none = connections(undefined);
  assert.equal(await none.has(OUT), false);
  await assert.rejects(none.add(OUT));
  const hung = { open: () => ({}) } as unknown as IDBFactory;
  const h = connections(hung, 20);
  assert.equal(await h.has(OUT), false);
  await assert.rejects(h.add(OUT));
});

/** The API as the popup runs it: bound to `origin`, gated by `admit`; the reads, runs and posts it made. */
function popupApi(admit: ApiHost["admit"], origin = OUT) {
  let reads = 0;
  let runs = 0;
  let changed: (() => void) | null = null;
  const posted: { msg: unknown; to: string }[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void posted.push({ msg, to }) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  let n = 0;
  const api = startApi({
    parent,
    origin,
    admit,
    listen: (fn) => (listener = fn),
    // each read differs, so a change after it would push a state event
    state: () => (reads++, { ...signedOutState(), vault_balance: String(++n) }),
    watch: (fn) => (changed = fn),
    kinds: { "pool.buy.dry": () => (runs++, { result: {} as never }) },
  });
  const send = (data: unknown) => listener!({ origin, source: parent, data });
  return { posted, send, idle: () => api.idle(), reads: () => reads, runs: () => runs, change: () => changed!() };
}
const state = () => ({ v: 1, id: crypto.randomUUID(), type: "state" });
const dry = () => ({ v: 1, id: crypto.randomUUID(), type: "pool.buy.dry", chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "0.1", slippage_bps: 300 });
const refused = (id: string) => ({ v: 1, id, ok: false, error: { code: "not_allowed" } });
const answers = (p: ReturnType<typeof popupApi>) => p.posted.slice(1).map((x) => x.msg);

test("an origin with no approval: every request refused not_allowed, to that origin only, with no state read and no kind run", async () => {
  const store = connections(new IDBFactory());
  const p = popupApi((o) => store.has(o));
  const s = state();
  const d = dry();
  p.send(s);
  p.send(d);
  await p.idle();
  assert.deepEqual(answers(p), [refused(s.id), refused(d.id)]);
  assert.ok(p.posted.every((x) => x.to === OUT));
  assert.equal(p.reads(), 0, "no wallet read for an origin with no approval");
  assert.equal(p.runs(), 0);
  // the refusal says nothing of the wallet: it is the same with a wallet signed in or not (no read decides it)
});

test("an approved origin is answered; once its approval is removed, its next request is refused with no read and no state event follows", async () => {
  const store = connections(new IDBFactory());
  await store.add(OUT);
  const p = popupApi((o) => store.has(o));
  const s1 = state();
  p.send(s1);
  await p.idle();
  assert.equal(p.reads(), 1);
  assert.deepEqual((answers(p)[0] as { ok: boolean }).ok, true);
  await connections(new IDBFactory()).add(OTHER); // another device's store: no bearing
  await store.remove(OUT);
  p.change();
  await p.idle();
  const s2 = state();
  const d = dry();
  p.send(s2);
  p.send(d);
  await p.idle();
  assert.equal(p.reads(), 1, "no read after the removal: no state answer and no state event");
  assert.equal(p.runs(), 0);
  assert.deepEqual(answers(p).slice(1), [refused(s2.id), refused(d.id)]);
});

test("a gate that throws, rejects or answers anything but true refuses", async () => {
  for (const admit of [() => { throw new Error("x"); }, () => Promise.reject(new Error("x")), () => "yes" as unknown as boolean, () => 1 as unknown as boolean]) {
    const p = popupApi(admit);
    const s = state();
    p.send(s);
    await p.idle();
    assert.deepEqual(answers(p), [refused(s.id)]);
    assert.equal(p.reads(), 0);
  }
});

test("the gate is asked with the bound origin, the one the browser checked, never a field of the message", async () => {
  const asked: string[] = [];
  const p = popupApi((o) => (asked.push(o), false));
  p.send({ ...state(), origin: "https://ct-app.unrealized.trade" });
  await p.idle();
  assert.deepEqual(asked, [OUT]);
});

// card signpage-other-apps-connect slice 2: the approvals go with the account at a sign out, in every tab
test("a sign out clears every approval: an open popup's store reads none next, and its bound origin's next request is refused with no read and no state event", async () => {
  const idb = new IDBFactory();
  const popup = connections(idb); // the /connect popup's own store, its connection open
  await popup.add(OUT);
  await popup.add(OTHER);
  const p = popupApi((o) => popup.has(o));
  const s1 = state();
  p.send(s1);
  await p.idle();
  assert.equal(p.reads(), 1);
  await clearConnections(idb); // the tab that signed out (APP_HOST's shell): completes though the popup holds a connection
  p.change();
  await p.idle();
  const s2 = state();
  p.send(s2);
  await p.idle();
  assert.deepEqual(answers(p).slice(1), [refused(s2.id)]);
  assert.equal(p.reads(), 1, "no wallet read after the sign out: no state answer and no state event");
  assert.deepEqual(await popup.list(), []);
  assert.deepEqual(await connections(idb).list(), [], "the next account on this device starts with none");
});

test("the clear is bounded: a delete that never answers rejects in time, so a sign out never waits on it", async () => {
  const hung = { deleteDatabase: () => ({}) } as unknown as IDBFactory;
  const t = Date.now();
  await assert.rejects(clearConnections(hung, 20));
  assert.ok(Date.now() - t < 1_000);
  await clearConnections(undefined); // no IndexedDB: nothing to clear
});

test("main.ts clears the approvals at its own sign out, once the store signed out, and at another tab's", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const own = /async function signOut\(\): Promise<void> \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  assert.ok(/store = null;[\s\S]{0,400}?await clearConnections\(\)\.catch\(/.test(own), "this tab's sign out clears them after the store signed out");
  const elsewhere = /function signedOutElsewhere\(\): void \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  assert.ok(/clearConnections\(\)\.catch\(/.test(elsewhere), "another tab's sign out clears them here too");
});

test("main.ts: the gate is the approvals store's, on /connect only; Connect keeps the approval before it binds the session", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(/const connected = outside \? connections\(\) : null;/.test(src), "the store is made on /connect only");
  assert.ok(/\.\.\.\(connected \? \{ admit: \(o: string\) => connected\.has\(o\) \} : \{\}\),/.test(src), "the shell's gate is the store's has");
  // the session is bound (shell.allow) only once the approval's write completed; a failed write binds nothing
  assert.ok(/connected!\s*\.add\(origin\)\s*\.then\(\s*\(\) => \{[\s\S]{0,400}?shell!\.allow\(origin\);[\s\S]{0,200}?\},\s*notConnected,?\s*\)/.test(src), "Connect writes the approval, then binds");
  assert.equal((src.match(/shell!\.allow\(/g) ?? []).length, 1, "one place binds a session");
});
