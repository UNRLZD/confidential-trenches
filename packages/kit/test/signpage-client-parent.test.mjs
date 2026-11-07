// The signing-page client's parent mode (card app-in-shell): the app runs framed inside SIGN_HOST's shell, so the
// client talks to host.parent and mounts no iframe. Same fakes as signpage-client.test.mjs: a fake window, document and
// iframe, Node's fake clock; every dropped message is checked for "no state change".
//   node --test test/signpage-client-parent.test.mjs
// SIGNPAGE_SRC=<abs path to a copy of src/> runs the same tests against that copy (the red-before proofs).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { pathToFileURL } from "node:url";
import { SIGNPAGE_KINDS } from "../src/signpage/messages.ts";
import { FIXTURES, STATE } from "./signpage-fixtures.ts";

const SRC = process.env.SIGNPAGE_SRC ? pathToFileURL(`${process.env.SIGNPAGE_SRC}/`).href : new URL("../src/", import.meta.url).href;
const C = await import(`${SRC}signpage/client.ts`);
const MSG = await import(`${SRC}signpage/messages.ts`);

const URL_ = "https://confidential.unrealized.trade/";
const ORIGIN = "https://confidential.unrealized.trade";
const APP_ORIGIN = "https://ct-app.unrealized.trade";
const DOWN = { ok: false, error: { code: "signpage_down" } };
const TIMEOUT = { ok: false, error: { code: "client_timeout" } };
const READY = { v: 1, type: "ready", release: "sp-1", api: 1 };

// ------------------------------------------------------------------------------------------------ fakes
class FakeWin {
  /** the requests posted, in order (the kit-version hellos are in `log` only) */
  sent = [];
  /** every message posted, hellos included, in order */
  log = [];
  postMessage(msg, origin) {
    const m = { msg: structuredClone(msg), origin };
    this.log.push(m);
    if (msg?.type !== "hello") this.sent.push(m);
  }
}
class FakeFrame {
  attrs = {};
  style = {};
  src = "";
  removed = false;
  contentWindow = new FakeWin();
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  remove() {
    this.removed = true;
  }
}

/** A host for `mode`: in parent mode `host.parent` is the shell's window; the iframe mode's frames are made as today. */
function makeHost(mode = "parent") {
  const frames = [];
  const on = new Map();
  const calls = { createElement: 0, appendChild: 0 };
  const shell = new FakeWin();
  const self = new FakeWin();
  const host = {
    window: Object.assign(self, {
      addEventListener: (t, f) => void on.set(t, f),
      removeEventListener: (t, f) => void (on.get(t) === f && on.delete(t)),
    }),
    document: {
      createElement: () => {
        calls.createElement++;
        const f = new FakeFrame();
        frames.push(f);
        return f;
      },
    },
    mount: { appendChild: (f) => (calls.appendChild++, f) },
  };
  if (mode === "parent") host.parent = shell;
  /** the window the signing page answers from: the shell, or the current iframe's */
  const peer = () => (mode === "parent" ? shell : frames.at(-1).contentWindow);
  const post = (data, origin = ORIGIN, source = peer()) => on.get("message")?.({ data, origin, source });
  const fireWindow = (type, visibilityState = "visible") => on.get(type)?.({ type, target: { visibilityState } });
  /** every message the client posted to the signing page, in order */
  const sent = () => (mode === "parent" ? shell.sent : frames.flatMap((f) => f.contentWindow.sent));
  return { host, shell, self, frames, calls, peer, post, fireWindow, sent, listening: () => on.size > 0 };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const answer = (id, result) => ({ v: 1, id, ok: true, result });
const lastState = (h) => h.sent().findLast((x) => x.msg.type === "state");

/** The shell's ready, then the answer to the state request the client sends for it. */
async function handshake(h, state = STATE) {
  h.post(READY);
  await flush();
  const s = lastState(h);
  assert.ok(s, "the client asks state after the ready");
  h.post(answer(s.msg.id, state));
  await flush();
}

async function readyClient(opts = {}) {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, mode: "parent", ...opts });
  await handshake(h);
  assert.equal(c.snapshot().status, "ready");
  return { h, c };
}

/** Sends `kind` and returns its handle, what was posted and whether it has settled. */
async function open(h, c, kind) {
  let settled = false;
  const handle = c.request(kind, FIXTURES[kind].params);
  const p = handle.outcome.then((o) => ((settled = true), o));
  await flush();
  return { id: handle.id, sent: h.sent().at(-1), p, settled: () => settled };
}

const noFrame = (h) => assert.deepEqual(h.calls, { createElement: 0, appendChild: 0 }, "no iframe is made or mounted");

test.beforeEach(() => enableTimers(mock.timers, { apis: ["setTimeout"] }));
test.afterEach(() => resetTimers(mock.timers));

// ------------------------------------------------------------------------------------------------ a. where it posts
test("parent mode posts every request to host.parent at SIGN_HOST's origin exactly, never *, and makes no iframe", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, mode: "parent" });
  assert.equal(c.snapshot().status, "connecting");
  noFrame(h);
  // the start asks the shell state at once: its ready may have gone out before this client listened
  assert.deepEqual(h.shell.sent.map((s) => [s.msg.type, s.origin]), [["state", ORIGIN]], "the handshake's state goes to the shell");
  h.post(answer(h.shell.sent[0].msg.id, STATE));
  await flush();
  assert.equal(c.snapshot().status, "ready");
  for (const kind of SIGNPAGE_KINDS) {
    const { id, sent, p } = await open(h, c, kind);
    assert.deepEqual(sent, { msg: { ...FIXTURES[kind].params, v: 1, id, type: kind }, origin: ORIGIN }, kind);
    h.post(answer(id, FIXTURES[kind].result));
    assert.deepEqual(await p, { ok: true, result: FIXTURES[kind].result }, kind);
  }
  assert.equal(h.shell.sent.length, 1 + SIGNPAGE_KINDS.length);
  assert.ok(h.shell.sent.every((s) => s.origin === ORIGIN), "never *");
  assert.equal(h.self.sent.length, 0, "nothing is posted to the app's own window");
  noFrame(h);
});

// ------------------------------------------------------------------------------------------------ b. what counts
test("parent mode drops, with no state change, a message from another origin or from any window but the shell", async () => {
  const { h, c } = await readyClient();
  const { id, p, settled } = await open(h, c, "buy");
  const n = h.shell.sent.length;
  const good = answer(id, FIXTURES.buy.result);
  const before = c.snapshot();
  const cases = [
    ["APP_HOST's origin", APP_ORIGIN, h.shell, "origin"],
    ["a same-site sibling", "https://evil.unrealized.trade", h.shell, "origin"],
    ["SIGN_HOST over http", "http://confidential.unrealized.trade", h.shell, "origin"],
    ["SIGN_HOST's origin from another window", ORIGIN, new FakeWin(), "source"],
    ["SIGN_HOST's origin with no source", ORIGIN, null, "source"],
    ["SIGN_HOST's origin from the app's own window", ORIGIN, h.self, "source"],
  ];
  for (const [name, origin, source, reason] of cases) {
    for (const data of [good, { v: 1, type: "state", state: { ...STATE, vault_balance: "1" } }, READY]) {
      const d0 = c.dropped()[reason];
      h.post(data, origin, source);
      await flush();
      assert.equal(c.dropped()[reason], d0 + 1, `${name}: dropped as ${reason}`);
      assert.equal(c.snapshot(), before, `${name}: no state change`);
      assert.equal(settled(), false, `${name}: the request is still open`);
    }
  }
  assert.equal(h.shell.sent.length, n, "no state asked on a dropped ready");
  h.post(good);
  assert.deepEqual(await p, { ok: true, result: FIXTURES.buy.result });
});

// ------------------------------------------------------------------------------------------------ c. same answers
/** One scripted exchange; returns what an app sees: snapshots, outcomes, progress stages and drops. */
async function exchange(mode) {
  const h = makeHost(mode);
  const c = C.createSignpageClient({ url: URL_, host: h.host, mode });
  const snaps = [];
  const outcomes = [];
  const stages = [];
  c.subscribe((s) => snaps.push(s));
  c.onProgress((_id, stage) => stages.push(stage));
  const ask = async (kind) => {
    const handle = c.request(kind, FIXTURES[kind].params);
    void handle.outcome.then((o) => outcomes.push([kind, o]));
    await flush();
    return handle.id;
  };
  await handshake(h);
  for (const kind of SIGNPAGE_KINDS) {
    const id = await ask(kind);
    h.post(answer(id, FIXTURES[kind].result));
    await flush();
  }
  const refused = await ask("export.open");
  h.post({ v: 1, id: refused, ok: false, error: { code: "not_allowed" } });
  const buy = await ask("buy");
  h.post({ v: 1, type: "progress", id: buy, stage: "filled" });
  h.post({ v: 1, type: "state", state: { ...STATE, vault_balance: "1" } });
  await ask("restore");
  await ask("backup.open");
  mock.timers.tick(C.SIGNPAGE_TIMEOUT_MS["backup.open"]);
  await flush();
  await ask("arm"); // while down: unsent
  // the way back differs by design (a fresh iframe posts a ready; the shell does not post one again): test e
  return { snaps, outcomes, stages, dropped: c.dropped(), status: c.snapshot().status };
}

test("parent mode gives an app the same snapshots and outcomes as the iframe mode for the same exchange", async () => {
  const framed = await exchange("iframe");
  resetTimers(mock.timers);
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  const shelled = await exchange("parent");
  assert.equal(framed.status, "down");
  assert.equal(framed.outcomes.length, SIGNPAGE_KINDS.length + 5);
  assert.ok(framed.outcomes.some(([k, o]) => k === "backup.open" && o.error?.code === "client_timeout"), "the script reached the down state");
  assert.ok(framed.outcomes.some(([k, o]) => k === "arm" && o.error?.code === "signpage_down"));
  assert.deepEqual(framed.stages, ["filled"]);
  assert.deepEqual(shelled.outcomes, framed.outcomes);
  assert.deepEqual(shelled.snaps, framed.snaps);
  assert.deepEqual(shelled.stages, framed.stages);
  assert.deepEqual(shelled.dropped, framed.dropped);
  assert.equal(shelled.status, framed.status);
});

// ------------------------------------------------------------------------------------------------ d. refusals
test("parent mode refuses a host with no parent or whose parent is its own window; an unknown mode is refused", () => {
  const none = makeHost("iframe").host;
  assert.throws(() => C.createSignpageClient({ url: URL_, host: none, mode: "parent" }), TypeError, "no parent");
  const top = makeHost().host;
  top.parent = top.window;
  assert.throws(() => C.createSignpageClient({ url: URL_, host: top, mode: "parent" }), TypeError, "a top-level app has no shell");
  for (const mode of ["shell", "", "PARENT", 1, null]) {
    assert.throws(() => C.createSignpageClient({ url: URL_, host: makeHost().host, mode }), TypeError, String(mode));
  }
});

// ------------------------------------------------------------------------------------------------ e. down and back
test("parent mode: the start asks state; no answer in 5 s is down; each retry asks again; a later ready brings READY, with no iframe ever made", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, mode: "parent" });
  const seen = [];
  c.subscribe((s) => seen.push(s.status));
  assert.deepEqual(h.shell.sent.map((s) => s.msg.type), ["state"], "the start asks state, with no ready");
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS - 1);
  await flush();
  assert.equal(c.snapshot().status, "connecting");
  mock.timers.tick(1);
  await flush();
  assert.equal(c.snapshot().status, "down");
  mock.timers.tick(1_000); // the first retry asks state again
  assert.deepEqual(h.shell.sent.map((s) => s.msg.type), ["state", "state"], "the retry asks state");
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS); // no answer
  await flush();
  assert.equal(c.snapshot().status, "down");
  await handshake(h);
  assert.equal(c.snapshot().status, "ready");
  assert.deepEqual([...new Set(seen)], ["down", "ready"], "the client's own retry keeps the down state until READY");
  noFrame(h);
});

test("parent mode: after an open kind's timeout, the backoff retry asks the shell state, and READY returns on its answer", async () => {
  const { h, c } = await readyClient();
  const seen = [];
  c.subscribe((s) => seen.push(s.status));
  const buy = await open(h, c, "buy");
  await open(h, c, "backup.open");
  mock.timers.tick(C.SIGNPAGE_TIMEOUT_MS["backup.open"]);
  await flush();
  assert.equal(c.snapshot().status, "down");
  assert.equal(c.snapshot().stale, true);
  assert.deepEqual(await buy.p, TIMEOUT, "a posted request ends client_timeout, never unsent");
  const n = h.shell.sent.length;
  mock.timers.tick(1_000);
  assert.deepEqual(h.shell.sent.slice(n).map((s) => [s.msg.type, s.origin]), [["state", ORIGIN]], "the retry is a state request to the shell");
  assert.equal(c.snapshot().status, "down");
  // no answer within 5 s: down again, and the backoff goes on (2 s)
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS);
  await flush();
  mock.timers.tick(1_999);
  assert.equal(h.shell.sent.length, n + 1);
  mock.timers.tick(1);
  assert.equal(h.shell.sent.length, n + 2, "the next retry 2 s later");
  h.post(answer(lastState(h).msg.id, { ...STATE, vault_balance: "7" }));
  await flush();
  assert.equal(c.snapshot().status, "ready");
  assert.equal(c.snapshot().stale, false);
  assert.equal(c.snapshot().state.vault_balance, "7");
  assert.deepEqual([...new Set(seen)], ["down", "ready"]);
  // the backoff starts again from 1 s after READY; retry() shows connecting, online wakes at once
  await open(h, c, "signout");
  mock.timers.tick(C.SIGNPAGE_TIMEOUT_MS.signout);
  await flush();
  assert.equal(c.snapshot().status, "down");
  const m = h.shell.sent.length;
  h.fireWindow("online");
  assert.equal(h.shell.sent.length, m + 1, "online: a state request at once");
  c.retry();
  assert.equal(c.snapshot().status, "connecting");
  assert.equal(h.shell.sent.at(-1).msg.type, "state");
  noFrame(h);
});

test("parent mode: destroy removes the listeners and posts nothing after", async () => {
  const { h, c } = await readyClient();
  const n = h.shell.sent.length;
  c.destroy();
  assert.equal(h.listening(), false);
  assert.deepEqual(await c.request("state", {}).outcome, DOWN);
  mock.timers.tick(C.SIGNPAGE_RETRY_MS * 2);
  assert.equal(h.shell.sent.length, n);
  noFrame(h);
});

// ------------------------------------------------------------------------------------------------ f. the update state
test("parent mode: a ready with another api is the update state, as in the iframe mode", async () => {
  const run = async (mode) => {
    const h = makeHost(mode);
    const c = C.createSignpageClient({ url: URL_, host: h.host, mode });
    const snaps = [];
    c.subscribe((s) => snaps.push(s));
    h.post({ ...READY, api: 2 });
    await flush();
    assert.equal(c.snapshot().status, "update", mode);
    assert.deepEqual(await c.request("buy", FIXTURES.buy.params).outcome, DOWN, mode);
    mock.timers.tick(C.SIGNPAGE_RETRY_MS * 6);
    await flush();
    c.retry();
    h.fireWindow("online");
    assert.equal(c.snapshot().status, "update", mode);
    // parent mode: only the start's state request, before the ready; nothing after the update state
    assert.equal(h.sent().length, mode === "parent" ? 1 : 0, `${mode}: nothing posted after the update state`);
    return { h, snaps };
  };
  const framed = await run("iframe");
  const shelled = await run("parent");
  assert.equal(framed.h.frames.length, 1, "the iframe mode makes no fresh iframe");
  noFrame(shelled.h);
  assert.deepEqual(shelled.snaps, framed.snaps);
});

// ------------------------------------------------------------------------------------------------ g. reload in update
test("parent mode: in the update state `reload` still goes to the shell (it reloads the top window), every other kind is DOWN; the iframe mode posts nothing", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, mode: "parent" });
  h.post({ ...READY, api: 2 });
  await flush();
  assert.equal(c.snapshot().status, "update");
  const n = h.shell.sent.length;
  assert.deepEqual(await c.request("buy", FIXTURES.buy.params).outcome, DOWN);
  assert.deepEqual(await c.request("nav", FIXTURES.nav.params).outcome, DOWN);
  const r = c.request("reload", {});
  await flush();
  assert.deepEqual(h.shell.sent.slice(n), [{ msg: { v: 1, id: r.id, type: "reload" }, origin: ORIGIN }], "only reload is posted, to the shell");
  h.post(answer(r.id, {}));
  assert.deepEqual(await r.outcome, { ok: true, result: {} });
  assert.equal(c.snapshot().status, "update", "the update state stays until the reload");
  noFrame(h);

  const f = makeHost("iframe");
  const ci = C.createSignpageClient({ url: URL_, host: f.host });
  f.post({ ...READY, api: 2 });
  await flush();
  assert.deepEqual(await ci.request("reload", {}).outcome, DOWN, "iframe mode: unchanged");
  assert.equal(f.sent().length, 0);
});

// ------------------------------------------------------------------------------------------------ card kit-frame-version
test("kit-frame-version, parent mode: a hello to the shell before each state ask, at the start, on a retry and on a ready", async () => {
  const hello = { v: 1, type: "hello", kit: MSG.SIGNPAGE_KIT_VERSION };
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, mode: "parent", retryMs: 0 });
  assert.deepEqual(h.shell.log.map((s) => [s.msg, s.origin]).slice(0, 1), [[hello, ORIGIN]]);
  assert.deepEqual(h.shell.log.map((s) => s.msg.type), ["hello", "state"], "the start: hello, then state");
  c.retry();
  assert.deepEqual(h.shell.log.map((s) => s.msg.type), ["hello", "state", "hello", "state"], "a retry: hello, then state");
  h.post(READY);
  await flush();
  assert.deepEqual(h.shell.log.slice(4).map((s) => s.msg.type), ["hello", "state"], "the shell's ready: hello, then state");
  assert.equal(h.self.log.length, 0, "nothing to the app's own window");
});
