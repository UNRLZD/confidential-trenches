// The kit client's closed notice (card signing-layer-says-when-it-closes, kit 1.13), each pairing of an app's kit and
// a signing page's release as deploys may leave them, days apart and the signing page first: this client or kit-v1.12's
// (test/fixtures/kit-v1.12, main's at e42f81694, the last commit at kit 1.12), against this page's own API
// (packages/signpage/src/api.ts, which reads the hello and shapes every answer) or main's page, whose open kinds answer
// { pending: true } and which posts no notice (e42f81694 packages/signpage/src/main.ts decide). The two talk through
// fake windows that deliver each post as its own task, with the origin and source the browser gives:
//   new app, new page: the open's ok carries closes, onClosed hears the page's one notice, once;
//   new app, old page: no closes, onClosed is null (the app's lock keeps its own fallback); a stray notice is dropped;
//   old app, new page: the page reads kit 1.12, sends the open's ok with no closes (which that client reads) and no notice;
//   old app, old page: as today.
// Then the client's own guards: an id it did not open, a second notice, another origin, another window, an extra key,
// a notice before the subscribe (heard in a microtask), the unsubscribe, a kind that is no open.
//   node --test test/signpage-client-closed.test.mjs
// Red before this card: the client had no onClosed, and main's page no closes and no notice.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NEW from "../src/signpage/client.ts";
import * as OLD from "./fixtures/kit-v1.12/signpage/client.ts";
import { startApi, APP_ORIGIN } from "../../signpage/src/api.ts";
import { OPEN_KINDS } from "../src/signpage/messages.ts";
import * as SCHEMA from "../src/signpage/schema.ts";
import { FIXTURES, STATE } from "./signpage-fixtures.ts";

const URL_ = "https://confidential.unrealized.trade/";
const SIGN_ORIGIN = "https://confidential.unrealized.trade";
const tick = () => new Promise((ok) => setImmediate(ok));
const until = async (ok, what) => {
  for (let i = 0; i < 400; i++) {
    if (ok()) return;
    await tick();
  }
  assert.fail(`never: ${what}`);
};

/** The app's window (the client's host.window), the shell's window (the client's host.parent) and the app's frame
 *  window as the page sees it (its post target); every message a separate task, as postMessage delivers it. */
function wires() {
  const appListeners = [];
  const toApp = [];
  let pageListener = null;
  const shellWin = {
    postMessage(msg, to) {
      assert.equal(to, SIGN_ORIGIN, "the client posts only to SIGN_HOST's origin");
      const data = structuredClone(msg);
      setImmediate(() => pageListener?.({ origin: APP_ORIGIN, source: frameWin, data }));
    },
  };
  const frameWin = {
    postMessage(msg, to) {
      assert.equal(to, APP_ORIGIN, "the page posts only to APP_HOST's origin");
      const data = structuredClone(msg);
      toApp.push(data);
      setImmediate(() => deliver(data));
    },
  };
  const deliver = (data, from = {}) => {
    for (const fn of appListeners) fn({ origin: from.origin ?? SIGN_ORIGIN, source: "source" in from ? from.source : shellWin, data });
  };
  const appWin = {
    addEventListener: (t, fn) => void (t === "message" && appListeners.push(fn)),
    removeEventListener: () => {},
  };
  const host = { window: appWin, document: { createElement: () => assert.fail("no iframe in parent mode") }, mount: { appendChild: () => assert.fail("no iframe in parent mode") }, parent: shellWin };
  return { host, frameWin, toApp, deliver, listen: (fn) => (pageListener = fn) };
}

/** This page's API: signin.open answered as src/main.ts decide answers it (closes), the notice by api.closed. */
function newPage(w) {
  return startApi({
    parent: w.frameWin,
    listen: w.listen,
    readyOnLoad: true,
    state: () => STATE,
    kinds: { "signin.open": () => ({ result: { pending: true, closes: true } }) },
  });
}
/** Main's page as e42f81694 has it: a ready-less shell that answers state and signin.open { pending: true }, no notice. */
function oldPage(w) {
  w.listen((e) => {
    const m = e.data;
    if (!m || typeof m.id !== "string") return;
    const result = m.type === "state" ? STATE : m.type === "signin.open" ? { pending: true } : null;
    w.frameWin.postMessage(result ? { v: 1, id: m.id, ok: true, result } : { v: 1, id: m.id, ok: false, error: { code: "not_allowed" } }, APP_ORIGIN);
  });
  return { closed() {} };
}
async function pair(C, makePage) {
  const w = wires();
  const page = makePage(w);
  const client = C.createSignpageClient({ url: URL_, host: w.host, mode: "parent", retryMs: 0 });
  await until(() => client.snapshot().status === "ready", "READY");
  const h = client.request("signin.open", FIXTURES["signin.open"].params);
  const o = await h.outcome;
  return { w, page, client, h, o };
}
const closedTo = (w) => w.toApp.filter((m) => m.type === "closed");

test("new app, new page: the open's ok says closes, onClosed hears the page's one notice once, the type and the id only", async () => {
  const { w, page, client, h, o } = await pair(NEW, newPage);
  assert.deepEqual(o, { ok: true, result: { pending: true, closes: true } });
  let heard = 0;
  const off = client.onClosed(h.id, () => void heard++);
  assert.equal(typeof off, "function");
  page.closed(h.id);
  await until(() => heard === 1, "the notice heard");
  assert.deepEqual(closedTo(w), [{ v: 1, type: "closed", id: h.id }]);
  page.closed(h.id);
  await until(() => closedTo(w).length === 2, "a second notice delivered");
  await tick();
  assert.equal(heard, 1, "a second notice for the id is not heard again");
  assert.equal(client.dropped().id, 1, "and counted as dropped by its id");
  client.destroy();
});

test("new app, old page: no closes, onClosed is null; a notice that comes anyway is dropped", async () => {
  const { w, client, h, o } = await pair(NEW, oldPage);
  assert.deepEqual(o, { ok: true, result: { pending: true } });
  assert.equal(client.onClosed(h.id, () => assert.fail("heard")), null);
  w.deliver({ v: 1, type: "closed", id: h.id });
  await tick();
  assert.equal(client.dropped().id, 1);
  client.destroy();
});

test("old app (kit 1.12), new page: the page reads kit 1.12, answers the open with no closes, which that client reads, and posts no notice", async () => {
  const { w, page, client, h, o } = await pair(OLD, newPage);
  assert.deepEqual(o, { ok: true, result: { pending: true } }, "kit-v1.12's client reads the answer: closes is not in it");
  assert.equal(client.onClosed, undefined, "kit-v1.12 has no onClosed");
  page.closed(h.id);
  await tick();
  await tick();
  assert.deepEqual(closedTo(w), [], "no notice to a kit-v1.12 app");
  assert.equal(client.snapshot().status, "ready");
  client.destroy();
});

test("old app (kit 1.12), old page: the open's answer and the state as today, no notice", async () => {
  const { w, client, o } = await pair(OLD, oldPage);
  assert.deepEqual(o, { ok: true, result: { pending: true } });
  assert.deepEqual(closedTo(w), []);
  assert.deepEqual(client.snapshot().state, STATE);
  client.destroy();
});

test("onClosed's guards: another origin or window, an extra key, an id it did not open; a notice before the subscribe is heard in a microtask; the unsubscribe; destroy", async () => {
  const { w, client, h } = await pair(NEW, newPage);
  let heard = 0;
  const drops = () => client.dropped();
  w.deliver({ v: 1, type: "closed", id: h.id }, { origin: "https://ct-app.unrealized.trade" });
  w.deliver({ v: 1, type: "closed", id: h.id }, { source: {} });
  w.deliver({ v: 1, type: "closed", id: h.id, kind: "signin.open" });
  w.deliver({ v: 1, type: "closed", id: crypto.randomUUID() });
  assert.deepEqual([drops().origin, drops().source, drops().shape, drops().id], [1, 1, 1, 1]);
  assert.equal(client.onClosed(crypto.randomUUID(), () => {}), null, "an id it did not send");
  // the notice before anyone listens: a later onClosed hears it in a microtask, and not if unsubscribed first
  w.deliver({ v: 1, type: "closed", id: h.id });
  const off = client.onClosed(h.id, () => void heard++);
  assert.equal(heard, 0, "never inside the call");
  await Promise.resolve();
  assert.equal(heard, 1);
  const off2 = client.onClosed(h.id, () => assert.fail("heard after its unsubscribe"));
  off2();
  await tick();
  off();
  // a subscriber unsubscribed before the notice hears nothing; two others each hear it once
  const h2 = client.request("signin.open", FIXTURES["signin.open"].params);
  await h2.outcome;
  let other = 0;
  client.onClosed(h2.id, () => assert.fail("unsubscribed"))();
  client.onClosed(h2.id, () => void other++);
  client.onClosed(h2.id, () => void other++);
  w.deliver({ v: 1, type: "closed", id: h2.id });
  await tick();
  assert.equal(other, 2);
  client.destroy();
  assert.equal(client.onClosed(h2.id, () => {}), null, "a destroyed client hears nothing");
});

test("closes is read only on an open kind's ok answer, and only as true", () => {
  for (const k of OPEN_KINDS) {
    assert.ok(SCHEMA.SIGNPAGE_RESULT_SCHEMAS[k]({ pending: true, closes: true }), k);
    assert.equal(SCHEMA.SIGNPAGE_RESULT_SCHEMAS[k]({ pending: true, closes: false }), false, k);
  }
  for (const k of ["state", "nav", "reload", "pool.buy"]) assert.equal(SCHEMA.SIGNPAGE_RESULT_SCHEMAS[k]({ ...FIXTURES[k].result, closes: true }), false, k);
  assert.ok(SCHEMA.signpageClosedSchema({ v: 1, type: "closed", id: "x" }));
  for (const m of [{ v: 1, type: "closed" }, { v: 2, type: "closed", id: "x" }, { v: 1, type: "closed", id: "" }, { v: 1, type: "closed", id: "x", ok: true }]) assert.equal(SCHEMA.signpageClosedSchema(m), false, JSON.stringify(m));
});

test("the client keeps the last 64 open ids whose answer said closes (CLOSING_MAX), the oldest let go first", async () => {
  // review P3-3: the map stays bounded whatever the page sends or leaves unsent
  const { w, page, client, h } = await pair(NEW, newPage);
  const ids = [h.id];
  for (let i = 0; i < 64; i++) {
    const r = client.request("signin.open", FIXTURES["signin.open"].params);
    await r.outcome;
    ids.push(r.id);
  }
  assert.equal(client.onClosed(ids[0], () => assert.fail("heard")), null, "the oldest of 65 is let go");
  let heard = 0;
  assert.equal(typeof client.onClosed(ids[1], () => void heard++), "function", "the 64 newest are kept");
  page.closed(ids[0]);
  page.closed(ids[1]);
  await until(() => closedTo(w).length === 2, "both notices delivered");
  await until(() => heard === 1, "the kept id heard");
  assert.equal(client.dropped().id, 1, "the let-go id's notice is dropped by its id");
  client.destroy();
});
