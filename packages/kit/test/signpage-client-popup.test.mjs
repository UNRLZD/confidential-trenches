// The signing-page client's popup mode (card signpage-answers-outside-apps): an outside app opens SIGN_HOST's /connect
// in a popup from the user's tap (host.open, window.open in a browser), mounts no iframe, reads only that popup's
// messages at SIGN_HOST's origin, and posts only to it with targetOrigin SIGN_HOST's origin; it knocks with its hello
// until the page's ready, which comes only once the user allows it there.
//   node --test test/signpage-client-popup.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { createSignpageClient, SIGNPAGE_KNOCK_MS } from "../src/signpage/client.ts";
import { STATE } from "./signpage-fixtures.ts";

const URL_ = "https://confidential.unrealized.trade/";
const ORIGIN = "https://confidential.unrealized.trade";
const READY = { v: 1, type: "ready", release: "sp-1", api: 1 };

class FakeWin {
  log = [];
  closed = false;
  postMessage(msg, origin) {
    this.log.push({ msg: structuredClone(msg), origin });
  }
  close() {
    this.closed = true;
  }
}

function makeHost() {
  const on = new Map();
  const opened = [];
  const calls = { createElement: 0 };
  const host = {
    window: { addEventListener: (t, f) => void on.set(t, f), removeEventListener: (t, f) => void (on.get(t) === f && on.delete(t)) },
    document: { createElement: () => (calls.createElement++, assert.fail("popup mode mounts no iframe")) },
    mount: { appendChild: () => assert.fail("popup mode mounts nothing") },
    open: (url) => {
      const w = new FakeWin();
      opened.push({ url, w });
      return w;
    },
  };
  const popup = () => opened[0].w;
  const post = (data, origin = ORIGIN, source = popup()) => on.get("message")?.({ data, origin, source });
  return { host, opened, popup, post, calls };
}

test("popup mode opens SIGN_HOST's /connect once, at creation, and mounts no iframe", () => {
  enableTimers(mock.timers, { apis: ["setTimeout", "setInterval"] });
  try {
    const h = makeHost();
    const c = createSignpageClient({ url: URL_, host: h.host, mode: "popup" });
    assert.deepEqual(h.opened.map((o) => o.url), [`${ORIGIN}/connect`]);
    assert.equal(h.calls.createElement, 0);
    c.destroy();
    assert.equal(h.popup().closed, true, "destroy closes the popup");
  } finally {
    resetTimers(mock.timers);
  }
});

test("popup mode needs host.open, and a popup that did not open (no tap) is an error, not a silent down", () => {
  const h = makeHost();
  assert.throws(() => createSignpageClient({ url: URL_, host: { ...h.host, open: undefined }, mode: "popup" }), /popup mode needs host.open/);
  assert.throws(() => createSignpageClient({ url: URL_, host: { ...h.host, open: () => null }, mode: "popup" }), /did not open/);
});

test("it knocks with its hello every SIGNPAGE_KNOCK_MS, to the popup at SIGN_HOST's origin only, until the page's ready", () => {
  enableTimers(mock.timers, { apis: ["setTimeout", "setInterval"] });
  try {
    const h = makeHost();
    const c = createSignpageClient({ url: URL_, host: h.host, mode: "popup" });
    const hellos = () => h.popup().log.filter((m) => m.msg.type === "hello").length;
    const first = hellos();
    mock.timers.tick(SIGNPAGE_KNOCK_MS * 4);
    assert.ok(hellos() >= first + 4, `${hellos()} hellos`);
    assert.ok(h.popup().log.every((m) => m.origin === ORIGIN), "never *, never another origin");
    h.post(READY);
    const after = hellos();
    mock.timers.tick(SIGNPAGE_KNOCK_MS * 4);
    // after the ready only the handshake's own hello goes (one per state ask), no more knocks
    assert.ok(hellos() <= after + 1, `${hellos() - after} hellos after the ready`);
    c.destroy();
  } finally {
    resetTimers(mock.timers);
  }
});

test("READY once the page (after the user's Allow) posts its ready and answers state; a request then goes to the popup", async () => {
  enableTimers(mock.timers, { apis: ["setTimeout", "setInterval"] });
  try {
    const h = makeHost();
    const c = createSignpageClient({ url: URL_, host: h.host, mode: "popup" });
    h.post(READY);
    const ask = h.popup().log.filter((m) => m.msg.type === "state").at(-1).msg;
    h.post({ v: 1, id: ask.id, ok: true, result: STATE });
    await Promise.resolve();
    assert.equal(c.snapshot().status, "ready");
    const r = c.request("state", {});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.popup().log.at(-1).msg.id, r.id);
    assert.equal(h.popup().log.at(-1).origin, ORIGIN);
    c.destroy();
  } finally {
    resetTimers(mock.timers);
  }
});

test("a ready or an answer from another origin or another window is dropped", async () => {
  enableTimers(mock.timers, { apis: ["setTimeout", "setInterval"] });
  try {
    const h = makeHost();
    const c = createSignpageClient({ url: URL_, host: h.host, mode: "popup" });
    h.post(READY, "https://evil.example");
    h.post(READY, ORIGIN, new FakeWin());
    h.post(READY, ORIGIN, null);
    assert.deepEqual(c.dropped(), { origin: 1, source: 2, shape: 0, id: 0 });
    assert.equal(c.snapshot().status, "connecting");
    c.destroy();
  } finally {
    resetTimers(mock.timers);
  }
});
