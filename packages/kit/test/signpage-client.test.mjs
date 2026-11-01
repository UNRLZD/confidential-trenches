// The signing-page client's unit tests (APU-02, APU-03, app.md:1327-1328; the client half of AX-05, AX-06): a fake
// window, document and iframe, Node's fake clock. Every kind of the fifteen has its fixture (a kind with no fixture
// fails the suite, matching "a kind with no row is refused", W:894). Every dropped message is checked for "no state
// change": the snapshot is the same object and the request it targets is still open.
//   node --test test/signpage-client.test.mjs
// SIGNPAGE_CLIENT=<abs path to a client.ts> runs the same tests against another copy (the red-before proofs).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { OPEN_KINDS, SIGNPAGE_KINDS } from "../src/signpage/messages.ts";
import { FIXTURES, STATE } from "./signpage-fixtures.ts";

const C = await import(
  process.env.SIGNPAGE_CLIENT ? pathToFileURL(process.env.SIGNPAGE_CLIENT).href : "../src/signpage/client.ts"
);

const URL_ = "https://sign.confidential.unrealized.trade/";
const ORIGIN = "https://sign.confidential.unrealized.trade";

// ------------------------------------------------------------------------------------------------ fakes
class FakeChild {
  sent = [];
  postMessage(msg, origin) {
    this.sent.push({ msg: structuredClone(msg), origin });
  }
}
class FakeFrame {
  attrs = {};
  style = {};
  src = "";
  removed = false;
  contentWindow = new FakeChild();
  on = {};
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(t, f) {
    (this.on[t] ??= []).push(f);
  }
  fire(t) {
    for (const f of this.on[t] ?? []) f();
  }
  remove() {
    this.removed = true;
  }
}
function makeHost() {
  const frames = [];
  let onMessage = null;
  const host = {
    window: {
      addEventListener: (_t, f) => void (onMessage = f),
      removeEventListener: () => void (onMessage = null),
    },
    document: {
      createElement: () => {
        const f = new FakeFrame();
        frames.push(f);
        return f;
      },
    },
    mount: { appendChild: (f) => f },
  };
  const frame = () => frames[frames.length - 1];
  const post = (data, origin = ORIGIN, source = frame().contentWindow) =>
    onMessage?.({ data, origin, source });
  return { host, frames, frame, post, listening: () => onMessage !== null };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const answer = (id, result) => ({ v: 1, id, ok: true, result });
const READY = { v: 1, type: "ready", release: "sp-1", api: 1 };

/** A client that has had its handshake and its first state. */
async function readyClient() {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  h.post(READY);
  await flush();
  const first = h.frame().contentWindow.sent[0];
  assert.equal(first.msg.type, "state");
  h.post(answer(first.msg.id, STATE));
  await flush();
  assert.equal(c.snapshot().status, "ready");
  h.frame().contentWindow.sent.length = 0;
  return { h, c };
}

/** Sends `kind` and returns its id, its promise and whether it has settled. */
async function open(h, c, kind) {
  let settled = false;
  const p = c.request(kind, FIXTURES[kind].params).then((o) => ((settled = true), o));
  await flush();
  const sent = h.frame().contentWindow.sent.at(-1);
  return { id: sent.msg.id, sent, p, settled: () => settled };
}

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
test.afterEach(() => mock.timers.reset());

// ------------------------------------------------------------------------------------------------ the iframe
test("the hidden iframe: exact attributes, SIGN_HOST's release URL with no query, hidden by CSSOM", () => {
  const h = makeHost();
  C.createSignpageClient({ url: URL_, host: h.host });
  const f = h.frame();
  assert.deepEqual(f.attrs, {
    sandbox: "allow-scripts allow-same-origin",
    allow: "",
    referrerpolicy: "no-referrer",
    "aria-hidden": "true",
    tabindex: "-1",
    width: "0",
    height: "0",
  });
  assert.equal(f.src, URL_);
  assert.deepEqual(f.style, { position: "absolute", width: "0", height: "0", border: "0", visibility: "hidden" });
});

test("only an https release URL with no query, fragment or credentials is taken", () => {
  for (const bad of ["http://sign.confidential.unrealized.trade/", `${URL_}?flow=x`, `${URL_}#x`, "https://u:p@sign.confidential.unrealized.trade/", "https://sign.confidential.unrealized.trade"]) {
    assert.throws(() => C.createSignpageClient({ url: bad, host: makeHost().host }), TypeError, bad);
  }
});

// ------------------------------------------------------------------------------------------------ the handshake
test("READY: a valid ready makes the client ready and asks state once; requests made while connecting wait for it", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  assert.equal(c.snapshot().status, "connecting");
  const early = c.request("restore", {});
  await flush();
  assert.equal(h.frame().contentWindow.sent.length, 0, "nothing is sent before the handshake");
  h.post(READY);
  await flush();
  const sent = h.frame().contentWindow.sent;
  assert.deepEqual(sent.map((s) => [s.msg.type, s.origin]), [["state", ORIGIN], ["restore", ORIGIN]]);
  assert.equal(c.snapshot().status, "ready");
  assert.equal(c.snapshot().release, "sp-1");
  h.post(answer(sent[1].msg.id, { stage: "started" }));
  assert.deepEqual(await early, { ok: true, result: { stage: "started" } });
});

test("no ready in 5 s: down, and every waiting request answers signpage_down unsent", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
  const p = c.request("buy", FIXTURES.buy.params);
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS - 1);
  await flush();
  assert.equal(c.snapshot().status, "connecting");
  mock.timers.tick(1);
  await flush();
  assert.equal(c.snapshot().status, "down");
  assert.deepEqual(await p, { ok: false, error: { code: "signpage_down" } });
  assert.deepEqual(await c.request("state", {}), { ok: false, error: { code: "signpage_down" } });
  assert.equal(h.frame().contentWindow.sent.length, 0, "nothing was sent to the page");
});

test("a ready the client cannot trust or speak is not READY", async () => {
  const cases = [
    ["api 2", { ...READY, api: 2 }],
    ["wrong origin", READY, "https://evil.confidential.unrealized.trade"],
    ["wrong source", READY, ORIGIN, new FakeChild()],
    ["extra field", { ...READY, route: "x" }],
  ];
  for (const [name, data, origin, source] of cases) {
    const h = makeHost();
    const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
    h.post(data, origin, source === undefined ? h.frame().contentWindow : source);
    await flush();
    mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS);
    await flush();
    assert.equal(c.snapshot().status, "down", name);
  }
});

test("an iframe error event is the down state at once", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
  h.frame().fire("error");
  assert.equal(c.snapshot().status, "down");
});

test("down clears with no reload: a fresh iframe every retry, and a late ready from the live frame", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS);
  assert.equal(c.snapshot().status, "down");
  mock.timers.tick(C.SIGNPAGE_RETRY_MS);
  assert.equal(h.frames.length, 2, "a fresh iframe");
  assert.equal(h.frames[0].removed, true, "the old one is gone");
  assert.equal(c.snapshot().status, "connecting");
  h.post(READY, ORIGIN, h.frames[0].contentWindow); // the removed frame's ready is not this frame's
  await flush();
  assert.equal(c.snapshot().status, "connecting");
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS);
  assert.equal(c.snapshot().status, "down");
  h.post(READY); // slow, but from the live frame
  await flush();
  assert.equal(c.snapshot().status, "ready");
  mock.timers.tick(C.SIGNPAGE_RETRY_MS * 3);
  assert.equal(h.frames.length, 2, "no retry once ready");
});

// ------------------------------------------------------------------------------------------------ the fifteen kinds
test("every kind of the fifteen has a fixture, and only the fifteen do", () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...SIGNPAGE_KINDS].sort());
});

for (const kind of SIGNPAGE_KINDS) {
  test(`${kind}: built from exactly its fields, answered when the answer is valid`, async () => {
    const { h, c } = await readyClient();
    const { id, sent, p } = await open(h, c, kind);
    assert.equal(sent.origin, ORIGIN, "posted to SIGN_HOST's origin only, never *");
    assert.deepEqual(sent.msg, { ...FIXTURES[kind].params, v: 1, id, type: kind });
    assert.match(id, /^[0-9a-f-]{36}$/);
    h.post(answer(id, FIXTURES[kind].result));
    assert.deepEqual(await p, { ok: true, result: FIXTURES[kind].result });
    // a second answer to the same id is dropped
    const before = c.snapshot();
    h.post(answer(id, FIXTURES[kind].result));
    assert.equal(c.snapshot(), before);
    assert.equal(c.dropped().id, 1);
  });

  test(`${kind}: a param its kind does not allow cannot be built`, () => {
    const h = makeHost();
    const c = C.createSignpageClient({ url: URL_, host: h.host });
    const bad = { ...FIXTURES[kind].params, recipient: "0xattacker" };
    assert.throws(() => C.signpageBuildRequest(kind, bad, "id"), TypeError);
    return assert.rejects(c.request(kind, bad), TypeError);
  });

  test(`${kind}: an answer whose result is not ${kind}'s shape is dropped`, async () => {
    const { h, c } = await readyClient();
    const { id, p, settled } = await open(h, c, kind);
    const before = c.snapshot();
    h.post(answer(id, { ...FIXTURES[kind].result, extra: "x" }));
    h.post(answer(id, {}));
    await flush();
    assert.equal(settled(), false);
    assert.equal(c.snapshot(), before);
    assert.equal(c.dropped().shape, 2);
    h.post(answer(id, FIXTURES[kind].result));
    assert.equal((await p).ok, true);
  });
}

test("a kind not in the fifteen cannot be built", () => {
  for (const k of ["sign", "eth_sendTransaction", "ready", "", "__proto__"]) {
    assert.throws(() => C.signpageBuildRequest(k, {}, "id"), TypeError, k);
  }
});

test("open kinds take only their return key and their own fields (APU-02)", () => {
  const bad = [
    ["backup.open", { return_key: "settings", way: "passkey" }],
    ["export.open", { return_key: "settings", chain: "near", address: "a", amount: "1" }],
    ["signin.open", { return_key: "deposit", way: "passkey", words: "x" }],
    ["withdraw.open", { return_key: "withdraw", address: "0xattacker" }],
    ["signout", { return_key: "https://evil.example/" }],
    ["deposit.quote", { origin_asset: "a", amount: "1", refundTo: "0xattacker" }],
    ["buy", { chain: "solana", token: "T", side: "buy", amount: "-1", slippage_bps: 100 }],
    ["buy", { chain: "ethereum", token: "T", side: "buy", amount: "1", slippage_bps: 100 }],
    ["buy", { chain: "solana", token: "T", side: "buy", amount: "1", slippage_bps: 10_001 }],
  ];
  for (const [k, params] of bad) assert.throws(() => C.signpageBuildRequest(k, params, "id"), TypeError, `${k} ${JSON.stringify(params)}`);
});

// ------------------------------------------------------------------------------------------------ refusals
test("answers dropped with no state change: wrong origin, wrong source, wrong id, bad keys, oversized, not plain", async () => {
  const { h, c } = await readyClient();
  const { id, p, settled } = await open(h, c, "buy");
  const good = answer(id, FIXTURES.buy.result);
  const before = c.snapshot();
  const big = answer(id, { ...FIXTURES.buy.result, txs: Array.from({ length: 1_900 }, () => ({ chain: "solana", hash: "x".repeat(200) })) });
  const cases = [
    ["a same-site sibling", good, "https://evil.ct.test", h.frame().contentWindow, "origin"],
    ["APP_HOST itself", good, "https://confidential.unrealized.trade", h.frame().contentWindow, "origin"],
    ["SIGN_HOST over http", good, "http://sign.confidential.unrealized.trade", h.frame().contentWindow, "origin"],
    ["SIGN_HOST with a port", good, "https://sign.confidential.unrealized.trade:8443", h.frame().contentWindow, "origin"],
    ["a cross-site host", good, "https://app.other.test", h.frame().contentWindow, "origin"],
    ["SIGN_HOST's origin from another window", good, ORIGIN, new FakeChild(), "source"],
    ["SIGN_HOST's origin with no source", good, ORIGIN, null, "source"],
    ["a wrong id", answer("00000000-0000-4000-8000-000000000000", FIXTURES.buy.result), ORIGIN, h.frame().contentWindow, "id"],
    ["a __proto__ key", JSON.parse(`{"v":1,"id":"${id}","ok":true,"result":{"stage":"sent","txs":[],"__proto__":{"x":1}}}`), ORIGIN, h.frame().contentWindow, "shape"],
    ["a constructor key", { ...good, result: { ...FIXTURES.buy.result, constructor: "x" } }, ORIGIN, h.frame().contentWindow, "shape"],
    ["an oversized body", big, ORIGIN, h.frame().contentWindow, "shape"],
    ["not a plain object", Object.assign(new (class X {})(), good), ORIGIN, h.frame().contentWindow, "shape"],
    ["a string", JSON.stringify(good), ORIGIN, h.frame().contentWindow, "shape"],
    ["a v other than 1", { ...good, v: 2 }, ORIGIN, h.frame().contentWindow, "shape"],
    ["an extra envelope field", { ...good, route: "x" }, ORIGIN, h.frame().contentWindow, "shape"],
    ["an unknown event", { v: 1, type: "sign", id }, ORIGIN, h.frame().contentWindow, "shape"],
  ];
  for (const [name, data, origin, source, reason] of cases) {
    const d0 = c.dropped()[reason];
    h.post(data, origin, source);
    await flush();
    assert.equal(c.dropped()[reason], d0 + 1, `${name}: dropped as ${reason}`);
    assert.equal(c.snapshot(), before, `${name}: no state change`);
    assert.equal(settled(), false, `${name}: the request is still open`);
  }
  h.post(good);
  assert.deepEqual(await p, { ok: true, result: FIXTURES.buy.result });
});

test("a page refusal is passed on as its code", async () => {
  const { h, c } = await readyClient();
  const { id, p } = await open(h, c, "export.open");
  h.post({ v: 1, id, ok: false, error: { code: "not_allowed" } });
  assert.deepEqual(await p, { ok: false, error: { code: "not_allowed" } });
});

test("state and progress events from the frame update the state and reach the listeners; from elsewhere they do not", async () => {
  const { h, c } = await readyClient();
  const seen = [];
  c.onProgress((id, stage) => seen.push([id, stage]));
  const next = { ...STATE, vault_balance: "1" };
  h.post({ v: 1, type: "state", state: next }, "https://evil.ct.test");
  h.post({ v: 1, type: "progress", id: "x", stage: "filled" }, ORIGIN, new FakeChild());
  assert.equal(c.snapshot().state?.vault_balance, "125.5");
  assert.deepEqual(seen, []);
  h.post({ v: 1, type: "state", state: next });
  h.post({ v: 1, type: "progress", id: "x", stage: "filled" });
  h.post({ v: 1, type: "progress", id: "x", stage: "teleported" });
  assert.equal(c.snapshot().state?.vault_balance, "1");
  assert.deepEqual(seen, [["x", "filled"]]);
});

// ------------------------------------------------------------------------------------------------ timeouts
test("each kind's timeout is the table's (app.md §2.1 item 3)", () => {
  assert.deepEqual(C.SIGNPAGE_TIMEOUT_MS, {
    "deposit.quote": 15_000, "deposit.confirm": 15_000, arm: 5_000, buy: 10_000, hop: 10_000, "orders.set": 15_000,
    "orders.cancel": 15_000, return: 15_000, "withdraw.open": 5_000, "signin.open": 5_000, "backup.open": 5_000,
    "export.open": 5_000, signout: 5_000, restore: 10_000, state: 5_000,
  });
});

for (const kind of SIGNPAGE_KINDS) {
  test(`${kind}: with no answer it ends as client_timeout at its timeout, and a late answer is dropped`, async () => {
    const { h, c } = await readyClient();
    const { id, p, settled } = await open(h, c, kind);
    mock.timers.tick(C.SIGNPAGE_TIMEOUT_MS[kind] - 1);
    await flush();
    assert.equal(settled(), false);
    mock.timers.tick(1);
    assert.deepEqual(await p, { ok: false, error: { code: "client_timeout" } });
    const isOpen = OPEN_KINDS.includes(kind);
    assert.equal(c.snapshot().status, isOpen ? "down" : "ready", "an open kind's timeout is the down state");
    if (kind === "state") assert.equal(c.snapshot().stale, true, "a state timeout keeps the last state, stale");
    h.post(answer(id, FIXTURES[kind].result));
    assert.equal(c.dropped().id, 1);
  });
}

test("APU-03: over 1,000 fake-clock runs no money or navigation kind is ever re-sent by the client", async () => {
  const NEVER_RESENT = ["deposit.confirm", "arm", "buy", "hop", "orders.set", "orders.cancel", "return", "withdraw.open", "signin.open", "backup.open", "export.open", "signout"];
  const { h, c } = await readyClient();
  const asked = new Map();
  let seed = 7;
  for (let run = 0; run < 1_000; run++) {
    if (c.snapshot().status !== "ready") {
      c.retry();
      h.post(READY);
      await flush();
    }
    seed = (seed * 48271) % 2147483647;
    const kind = SIGNPAGE_KINDS[seed % SIGNPAGE_KINDS.length];
    asked.set(kind, (asked.get(kind) ?? 0) + 1);
    void c.request(kind, FIXTURES[kind].params);
    await flush();
    mock.timers.tick(20_000);
    await flush();
  }
  const sent = new Map();
  for (const f of h.frames) for (const s of f.contentWindow.sent) sent.set(s.msg.type, (sent.get(s.msg.type) ?? 0) + 1);
  for (const k of NEVER_RESENT) assert.equal(sent.get(k) ?? 0, asked.get(k) ?? 0, `${k} sent exactly as often as asked`);
  for (const f of h.frames) {
    const ids = f.contentWindow.sent.filter((s) => s.msg.type !== "state").map((s) => s.msg.id);
    assert.equal(new Set(ids).size, ids.length, "no id is ever sent twice");
  }
});

test("destroy: the listener and the iframe go, and nothing is sent after", async () => {
  const { h, c } = await readyClient();
  c.destroy();
  assert.equal(h.listening(), false);
  assert.equal(h.frame().removed, true);
  assert.deepEqual(await c.request("state", {}), { ok: false, error: { code: "signpage_down" } });
  mock.timers.tick(C.SIGNPAGE_RETRY_MS * 2);
  assert.equal(h.frames.length, 1, "no retry after destroy");
});
