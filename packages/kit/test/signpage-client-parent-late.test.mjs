// The signing-page client's parent mode against a shell that behaves as SIGN_HOST's does (card signpage-shell): it
// answers `state` at any time and posts `ready` only when its frame loads. A client made after that load (an app that
// makes its client after an await, a lazy route, a remount) or a frame whose load is slow must still reach READY at
// once: parent mode asks `state` at its start and on every retry, and a repeated ready is harmless. (From the joint
// review of card app-in-shell.)
//   node --test test/signpage-client-parent-late.test.mjs
// SIGNPAGE_SRC=<abs path to a copy of src/> runs the same tests against that copy (the red-before proofs).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { STATE } from "./signpage-fixtures.ts";

const SRC = process.env.SIGNPAGE_SRC ? pathToFileURL(`${process.env.SIGNPAGE_SRC}/`).href : new URL("../src/", import.meta.url).href;
const C = await import(`${SRC}signpage/client.ts`);

const URL_ = "https://sign.confidential.unrealized.trade/";
const ORIGIN = "https://sign.confidential.unrealized.trade";
const READY = { v: 1, type: "ready", release: "sp-1", api: 1 };
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** A shell that answers every `state` request while `answering`, as SIGN_HOST's does once its script runs. */
function world({ answering = true } = {}) {
  const on = new Map();
  const self = { addEventListener: (t, f) => void on.set(t, f), removeEventListener: () => {} };
  const shell = {
    answering,
    sent: [],
    postMessage(msg, origin) {
      this.sent.push({ msg, origin });
      if (this.answering && origin === ORIGIN && msg.type === "state") queueMicrotask(() => deliver({ v: 1, id: msg.id, ok: true, result: STATE }));
    },
  };
  const deliver = (data) => on.get("message")?.({ origin: ORIGIN, source: shell, data });
  const host = { window: self, document: { createElement: () => assert.fail("no iframe") }, mount: { appendChild: () => {} }, parent: shell };
  const asked = () => shell.sent.filter((s) => s.msg.type === "state").length;
  return { host, shell, deliver, asked };
}

const run = (ms) => mock.timers.tick(ms);
async function ticks(n, ms = 1_000) {
  for (let i = 0; i < n; i++) {
    run(ms);
    await flush();
  }
}

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
test.afterEach(() => mock.timers.reset());

test("a client made after the frame's load (its ready already sent and lost) reaches READY at once, and after a Retry", async () => {
  const w = world();
  const c = C.createSignpageClient({ url: URL_, host: w.host, mode: "parent" });
  await flush();
  assert.equal(c.snapshot().status, "ready", `status ${c.snapshot().status} with no ready; state requests sent to the shell: ${w.asked()}`);
  assert.deepEqual(c.snapshot().state, STATE);
  await ticks(120);
  c.retry();
  await flush();
  assert.equal(c.snapshot().status, "ready", `status ${c.snapshot().status} after 120 s and a Retry; state requests: ${w.asked()}`);
});

test("a frame whose load (and the shell's ready) comes 6 s after the client starts never shows down; the ready is harmless", async () => {
  const w = world();
  const c = C.createSignpageClient({ url: URL_, host: w.host, mode: "parent" });
  const seen = new Set([c.snapshot().status]);
  c.subscribe((s) => seen.add(s.status));
  await ticks(6);
  w.deliver(READY);
  await flush();
  await ticks(12);
  assert.ok(!seen.has("down"), `statuses seen: ${[...seen].join(", ")}`);
  assert.equal(c.snapshot().status, "ready");
  assert.equal(c.snapshot().release, "sp-1");
});

test("a shell that answers nothing until its ready at 7 s: down at 5 s, READY on the ready, and an older ask's timeout never takes it down", async () => {
  const w = world({ answering: false });
  const c = C.createSignpageClient({ url: URL_, host: w.host, mode: "parent" });
  const seen = [];
  c.subscribe((s) => seen.push(s.status));
  assert.equal(w.asked(), 1, "the start asks state");
  run(C.SIGNPAGE_HANDSHAKE_MS);
  await flush();
  assert.equal(c.snapshot().status, "down");
  run(1_000); // the first retry, at 6 s: another state request the shell does not answer yet
  await flush();
  assert.equal(w.asked(), 2, "the retry asks state");
  run(1_000); // 7 s: the shell's script runs; its ready comes
  w.shell.answering = true;
  w.deliver(READY);
  await flush();
  assert.equal(c.snapshot().status, "ready");
  await ticks(30); // the 6 s retry's request times out at 11 s: it is not the newest ask, so READY stays
  assert.equal(c.snapshot().status, "ready", `statuses seen: ${seen.join(", ")}`);
  assert.deepEqual([...new Set(seen)], ["down", "ready"]);
});

test("the iframe mode is unchanged: nothing is posted before the frame's ready", async () => {
  const frames = [];
  const on = new Map();
  const host = {
    window: { addEventListener: (t, f) => void on.set(t, f), removeEventListener: () => {} },
    document: {
      createElement: () => {
        const f = { sent: [], attrs: {}, style: {}, setAttribute() {}, addEventListener() {}, remove() {}, contentWindow: { sent: [], postMessage(m) { this.sent.push(m); } } };
        frames.push(f);
        return f;
      },
    },
    mount: { appendChild: () => {} },
  };
  const c = C.createSignpageClient({ url: URL_, host });
  await ticks(3);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].contentWindow.sent.length, 0);
  assert.equal(c.snapshot().status, "connecting");
});
