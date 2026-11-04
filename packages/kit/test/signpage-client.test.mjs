// The signing-page client's unit tests (APU-02, APU-03, app.md:1327-1328; the client half of AX-05, AX-06; BAR-09):
// a fake window, document and iframe, Node's fake clock. Every kind of the twenty-one has its fixture (a kind with no
// fixture fails the suite, matching "a kind with no row is refused", W:894). Every dropped message is checked for "no
// state change": the snapshot is the same object and the request it targets is still open.
//   node --test test/signpage-client.test.mjs
// SIGNPAGE_SRC=<abs path to a copy of src/> runs the same tests against that copy (the red-before proofs).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { OPEN_KINDS, SIGNPAGE_KINDS } from "../src/signpage/messages.ts";
import { FIXTURES, STATE } from "./signpage-fixtures.ts";

const SRC = process.env.SIGNPAGE_SRC ? pathToFileURL(`${process.env.SIGNPAGE_SRC}/`).href : new URL("../src/", import.meta.url).href;
const C = await import(`${SRC}signpage/client.ts`);
const S = await import(`${SRC}signpage/schema.ts`);
const MSG = await import(`${SRC}signpage/messages.ts`);

const URL_ = "https://sign.confidential.unrealized.trade/";
const ORIGIN = "https://sign.confidential.unrealized.trade";
const DOWN = { ok: false, error: { code: "signpage_down" } };
const TIMEOUT = { ok: false, error: { code: "client_timeout" } };

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
  /** the window's listeners, by event type */
  const on = new Map();
  const host = {
    window: {
      addEventListener: (t, f) => void on.set(t, f),
      removeEventListener: (t, f) => void (on.get(t) === f && on.delete(t)),
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
  const post = (data, origin = ORIGIN, source = frame().contentWindow) => on.get("message")?.({ data, origin, source });
  /** a window event of `type`; a visibilitychange's target is the document, with its visibilityState */
  const fireWindow = (type, visibilityState = "visible") => on.get(type)?.({ type, target: { visibilityState } });
  /** every message posted to every frame, in order */
  const sent = () => frames.flatMap((f) => f.contentWindow.sent);
  return { host, frames, frame, post, fireWindow, sent, listening: () => on.size > 0 };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const answer = (id, result) => ({ v: 1, id, ok: true, result });
const READY = { v: 1, type: "ready", release: "sp-1", api: 1 };

/** The current frame's handshake: its ready, then the answer to the state request the client sends for it. */
async function handshake(h, state = STATE) {
  h.post(READY);
  await flush();
  const s = h.frame().contentWindow.sent.findLast((x) => x.msg.type === "state");
  assert.ok(s, "the client asks state after the ready");
  h.post(answer(s.msg.id, state));
  await flush();
}

/** A client that has had its handshake. */
async function readyClient(opts = {}) {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, ...opts });
  await handshake(h);
  assert.equal(c.snapshot().status, "ready");
  h.frame().contentWindow.sent.length = 0;
  return { h, c };
}

/** Sends `kind` and returns its handle, what was posted and whether it has settled. */
async function open(h, c, kind) {
  let settled = false;
  const handle = c.request(kind, FIXTURES[kind].params);
  const p = handle.outcome.then((o) => ((settled = true), o));
  await flush();
  const sent = h.frame().contentWindow.sent.at(-1);
  return { id: handle.id, sent, p, settled: () => settled };
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
test("READY is the frame's first state answer: a ready alone is not READY, and requests wait for the state", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  assert.equal(c.snapshot().status, "connecting");
  const early = c.request("restore", {});
  await flush();
  assert.equal(h.sent().length, 0, "nothing is sent before the ready");
  h.post(READY);
  await flush();
  assert.equal(c.snapshot().status, "connecting", "a ready without its state answer is not READY");
  assert.deepEqual(h.sent().map((s) => [s.msg.type, s.origin]), [["state", ORIGIN]], "only the handshake's state is sent");
  h.post(answer(h.sent()[0].msg.id, STATE));
  await flush();
  assert.equal(c.snapshot().status, "ready");
  assert.equal(c.snapshot().release, "sp-1");
  assert.deepEqual(c.snapshot().state, STATE);
  assert.equal(c.snapshot().stale, false);
  const r = h.sent()[1];
  assert.equal(r.msg.type, "restore", "the waiting request is posted after READY");
  assert.equal(r.msg.id, early.id);
  h.post(answer(early.id, { stage: "started" }));
  assert.deepEqual(await early.outcome, { ok: true, result: { stage: "started" } });
});

test("no state answer within 5 s of the ready: down (AE-08's \"no state answer ever\")", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
  mock.timers.tick(4_000);
  h.post(READY);
  await flush();
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS - 1);
  await flush();
  assert.equal(c.snapshot().status, "connecting");
  mock.timers.tick(1);
  await flush();
  assert.equal(c.snapshot().status, "down");
});

test("a page that refuses the handshake's state is down", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
  h.post(READY);
  await flush();
  h.post({ v: 1, id: h.sent()[0].msg.id, ok: false, error: { code: "not_allowed" } });
  await flush();
  assert.equal(c.snapshot().status, "down");
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
  assert.deepEqual(await p.outcome, DOWN);
  assert.deepEqual(await c.request("state", {}).outcome, DOWN);
  assert.equal(h.sent().length, 0, "nothing was sent to the page");
});

test("a ready the client cannot trust is not READY", async () => {
  const cases = [
    ["wrong origin", READY, "https://evil.confidential.unrealized.trade"],
    ["wrong source", READY, ORIGIN, new FakeChild()],
    ["extra field", { ...READY, route: "x" }],
  ];
  for (const [name, data, origin, source] of cases) {
    const h = makeHost();
    const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
    h.post(data, origin, source === undefined ? h.frame().contentWindow : source);
    await flush();
    assert.equal(h.sent().length, 0, `${name}: no state asked`);
    mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS);
    await flush();
    assert.equal(c.snapshot().status, "down", name);
  }
});

test("a ready with an api this client does not speak: the update state until a reload, with no retry", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  h.post({ ...READY, api: 2 });
  await flush();
  assert.equal(c.snapshot().status, "update");
  assert.equal(h.sent().length, 0);
  assert.deepEqual(await c.request("buy", FIXTURES.buy.params).outcome, DOWN);
  mock.timers.tick(C.SIGNPAGE_RETRY_MS * 6);
  await flush();
  c.retry();
  assert.equal(h.frames.length, 1, "no fresh iframe, by timer or by retry()");
  assert.equal(c.snapshot().status, "update");
});

test("an iframe error event is the down state at once", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
  h.frame().fire("error");
  assert.equal(c.snapshot().status, "down");
});

test("down clears with no reload: a fresh iframe on the retry, and a late handshake from the live frame", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS);
  assert.equal(c.snapshot().status, "down");
  mock.timers.tick(1_000);
  assert.equal(h.frames.length, 2, "a fresh iframe 1 s after the down");
  assert.equal(h.frames[0].removed, true, "the old one is gone");
  assert.equal(c.snapshot().status, "down", "the client's own retry keeps the down state until READY");
  h.post(READY, ORIGIN, h.frames[0].contentWindow); // the removed frame's ready is not this frame's
  await flush();
  assert.equal(h.sent().length, 0);
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS);
  assert.equal(c.snapshot().status, "down");
  await handshake(h); // slow, but from the live frame
  assert.equal(c.snapshot().status, "ready");
  mock.timers.tick(C.SIGNPAGE_RETRY_MS * 3);
  assert.equal(h.frames.length, 2, "no retry once ready");
});

// ------------------------------------------------------------------------------------------------ timing (AE-08)
// A refused, failed or blocked load shows the browser's error page, which fires the iframe's load, not its error. The
// live check on a loaded machine (08:47Z and 08:55Z Nov 1) caught the down state 7,748 ms after the page's start and
// READY 15,198 ms after SIGN_HOST came back: the 5 s handshake ran from the iframe's mount, after the app's start, and
// one retry every 10 s.

/** Runs the fake clock in 100 ms steps; each new iframe loads an error page while `blocked()`, else has its handshake. */
function simulate(h, blocked) {
  let handled = 0;
  let t = 0;
  const mounts = [];
  const serve = async () => {
    while (handled < h.frames.length) {
      const f = h.frames[handled++];
      mounts.push(t);
      if (blocked()) f.fire("load");
      else await handshake(h);
    }
  };
  return {
    mounts,
    now: () => t,
    serve,
    async run(ms, until = () => false) {
      for (let i = 0; i < ms && !until(); i += 100) {
        mock.timers.tick(100);
        t += 100;
        await flush();
        await serve();
      }
    },
  };
}

test("an iframe load with no ready is the down state within 1 s, not 5 s", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
  mock.timers.tick(200);
  h.frame().fire("load");
  mock.timers.tick(999);
  assert.equal(c.snapshot().status, "connecting");
  mock.timers.tick(1);
  assert.equal(c.snapshot().status, "down");
});

test("a ready before the load, or within 1 s after it, is never down: the handshake goes on to READY", async () => {
  for (const order of ["ready, then load", "load, then ready 900 ms later"]) {
    const h = makeHost();
    const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
    if (order === "ready, then load") {
      h.post(READY);
      await flush();
      h.frame().fire("load");
    } else {
      h.frame().fire("load");
      mock.timers.tick(900);
      h.post(READY);
      await flush();
    }
    mock.timers.tick(2_000);
    await flush();
    assert.equal(c.snapshot().status, "connecting", order);
    const s = h.frame().contentWindow.sent.findLast((x) => x.msg.type === "state");
    h.post(answer(s.msg.id, STATE));
    await flush();
    assert.equal(c.snapshot().status, "ready", order);
  }
});

test("SIGN_HOST blocked: down 1 s after the load; back: READY within 3 s, with no blink of the down state", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  const seen = [];
  c.subscribe((s) => seen.push(s.status));
  let blocked = true;
  const sim = simulate(h, () => blocked);
  await sim.serve();
  await sim.run(10_000, () => c.snapshot().status === "down");
  assert.equal(sim.now(), 1_000, "down 1 s after the error page's load");
  await sim.run(1_300); // the live check's unblock: 300 ms, then its screenshot
  blocked = false;
  const unblocked = sim.now();
  await sim.run(20_000, () => c.snapshot().status === "ready");
  assert.equal(c.snapshot().status, "ready");
  assert.ok(sim.now() - unblocked <= 3_000, `READY ${sim.now() - unblocked} ms after SIGN_HOST came back`);
  const after = seen.slice(seen.indexOf("down"));
  assert.deepEqual([...new Set(after)], ["down", "ready"], "from the first down to READY, no other status");
});

test("while down the retries wait 1, 2, 4 and 8 s, then SIGNPAGE_RETRY_MS, and start again after READY", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  let blocked = true;
  const sim = simulate(h, () => blocked);
  await sim.serve();
  await sim.run(50_000);
  // each blocked frame is down 1 s after its load, then waits the backoff
  const waits = sim.mounts.slice(1).map((t, i) => t - sim.mounts[i] - 1_000);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, C.SIGNPAGE_RETRY_MS, C.SIGNPAGE_RETRY_MS]);
  blocked = false;
  await sim.run(20_000, () => c.snapshot().status === "ready");
  assert.equal(c.snapshot().status, "ready");
  blocked = true;
  const n = h.frames.length;
  c.retry();
  await sim.serve();
  await sim.run(2_100);
  assert.equal(h.frames.length, n + 2, "after READY the backoff starts again at 1 s");
});

test("back online, or the page shown again, while down: a fresh iframe at once; never while ready or hidden", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  h.frame().fire("load");
  mock.timers.tick(1_000);
  assert.equal(c.snapshot().status, "down");
  h.fireWindow("online");
  assert.equal(h.frames.length, 2, "online: a fresh iframe at once");
  assert.equal(c.snapshot().status, "down");
  h.fireWindow("visibilitychange", "hidden");
  assert.equal(h.frames.length, 2, "hidden: no fresh iframe");
  h.fireWindow("visibilitychange", "visible");
  assert.equal(h.frames.length, 3, "shown again: a fresh iframe at once");
  await handshake(h);
  assert.equal(c.snapshot().status, "ready");
  h.fireWindow("online");
  h.fireWindow("visibilitychange", "visible");
  assert.equal(h.frames.length, 3, "while ready: none");
});

test("an old frame's state never shows as fresh: a re-mount marks it stale until the new frame's state", async () => {
  const { h, c } = await readyClient();
  assert.equal(c.snapshot().stale, false);
  c.retry();
  assert.equal(c.snapshot().status, "connecting");
  assert.equal(c.snapshot().stale, true);
  mock.timers.tick(C.SIGNPAGE_HANDSHAKE_MS);
  assert.equal(c.snapshot().status, "down");
  assert.equal(c.snapshot().stale, true);
  mock.timers.tick(C.SIGNPAGE_RETRY_MS);
  await handshake(h, { ...STATE, vault_balance: "7" });
  assert.equal(c.snapshot().status, "ready");
  assert.equal(c.snapshot().stale, false);
  assert.equal(c.snapshot().state.vault_balance, "7");
});

// ------------------------------------------------------------------------------------------------ posted, never "unsent"
test("the double-buy path: a posted buy ends client_timeout when an open kind's timeout takes the client down", async () => {
  const { h, c } = await readyClient();
  const buy = await open(h, c, "buy");
  const backup = await open(h, c, "backup.open");
  mock.timers.tick(C.SIGNPAGE_TIMEOUT_MS["backup.open"]);
  await flush();
  assert.equal(c.snapshot().status, "down");
  assert.deepEqual(await backup.p, TIMEOUT);
  assert.deepEqual(await buy.p, TIMEOUT, "the page has the buy: never reported unsent");
  assert.deepEqual(await c.request("buy", FIXTURES.buy.params).outcome, DOWN, "a request made while down is unsent");
  assert.equal(h.sent().filter((s) => s.msg.type === "buy").length, 1);
  mock.timers.tick(C.SIGNPAGE_RETRY_MS);
  h.post(READY);
  await flush();
  assert.equal(h.frame().contentWindow.sent.at(-1).msg.type, "state", "the next READY asks state, where the buy's outcome is");
});

test("a posted request ends client_timeout on every other way down: api change, iframe error, retry while ready, destroy", async () => {
  const ways = {
    "a ready with another api": (h) => h.post({ ...READY, api: 2 }),
    "an iframe error": (h) => h.frame().fire("error"),
    "retry() while ready": (_h, c) => c.retry(),
    "destroy()": (_h, c) => c.destroy(),
  };
  for (const [name, go] of Object.entries(ways)) {
    const { h, c } = await readyClient();
    const buy = await open(h, c, "buy");
    const restore = await open(h, c, "restore");
    go(h, c);
    await flush();
    assert.deepEqual(await buy.p, TIMEOUT, name);
    assert.deepEqual(await restore.p, TIMEOUT, name);
    assert.equal(h.sent().filter((s) => s.msg.type === "buy").length, 1, `${name}: the buy is never re-sent`);
  }
});

test("a request's id is known at once and is the id posted, so progress events can be matched to it", async () => {
  const { h, c } = await readyClient();
  const seen = [];
  c.onProgress((id, stage) => seen.push([id, stage]));
  const { id, sent } = await open(h, c, "buy");
  assert.equal(sent.msg.id, id);
  h.post({ v: 1, type: "progress", id, stage: "filled" });
  assert.deepEqual(seen, [[id, "filled"]]);
});

// ---------------------------------------------------------------------------------------------- the twenty-one kinds
test("every kind of the twenty-one has a fixture, and only the twenty-one do", () => {
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
    assert.throws(() => c.request(kind, bad), TypeError);
  });

  test(`${kind}: an answer whose result is not ${kind}'s shape is dropped`, async () => {
    const { h, c } = await readyClient();
    const { id, p, settled } = await open(h, c, kind);
    const before = c.snapshot();
    h.post(answer(id, { ...FIXTURES[kind].result, extra: "x" }));
    // {} is nav's and reload's own result: for them only the extra field is another shape
    const empty = Object.keys(FIXTURES[kind].result).length === 0;
    if (!empty) h.post(answer(id, {}));
    await flush();
    assert.equal(settled(), false);
    assert.equal(c.snapshot(), before);
    assert.equal(c.dropped().shape, empty ? 1 : 2);
    h.post(answer(id, FIXTURES[kind].result));
    assert.equal((await p).ok, true);
  });
}

test("the pool kinds (card signpage-pool-kinds): each builds from its own fields on a pool chain only; NEAR, another chain, a field it does not take, an amount that is not a decimal, a slippage over 10,000, a missing field and an address from the app cannot be built", () => {
  const T = "0xF111111111111111111111111111111111111111";
  for (const [kind, good] of [
    ["pool.deposit", { chain: "solana", amount: "1.5" }],
    ["pool.buy", { chain: "base", token: T, amount: "0.01", slippage_bps: 300 }],
    ["pool.sell", { chain: "robinhood", token: T, amount: "2", slippage_bps: 0 }],
    ["pool.withdraw", { return_key: "withdraw", chain: "solana" }],
  ]) {
    assert.deepEqual(C.signpageBuildRequest(kind, good, "id"), { ...good, v: 1, id: "id", type: kind }, kind);
    const bad = [
      { ...good, chain: "near" },
      { ...good, chain: "ethereum" },
      { ...good, extra: "x" },
      ...(kind === "pool.withdraw"
        ? [{ ...good, address: "0xattacker" }, { ...good, to: "0xattacker" }, { chain: "solana" }]
        : [{ ...good, amount: "1e5" }, { ...good, amount: "-1" }, { ...good, amount: 5 }, { chain: good.chain }]),
      ...(kind === "pool.buy" || kind === "pool.sell" ? [{ ...good, slippage_bps: 10_001 }, { ...good, slippage_bps: 1.5 }, { ...good, token: 7 }] : []),
    ];
    for (const b of bad) assert.throws(() => C.signpageBuildRequest(kind, b, "id"), TypeError, `${kind} ${JSON.stringify(b)}`);
  }
});

test("a kind not in the twenty-one cannot be built", () => {
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

test("state.pools: the private balance per chain's pool is optional; each entry exact, its asset from the kit's table, amounts decimal, one entry per chain", () => {
  const ok = S.SIGNPAGE_RESULT_SCHEMAS.state;
  const pools = [
    { chain: "solana", asset: "SOL", balance: "12.5", ready: "10" },
    { chain: "base", asset: "ETH", balance: "0.25" },
    { chain: "near", asset: "USDC", balance: "0" },
  ];
  assert.equal(ok(STATE), true, "a state without pools passes");
  assert.equal(ok({ ...STATE, pools }), true, "a valid pools answer passes");
  assert.equal(ok({ ...STATE, pools: [] }), true, "an empty pool table passes");
  assert.equal(S.signpageStateEventSchema({ v: 1, type: "state", state: { ...STATE, pools } }), true, "and as a state event");
  for (const [chain, asset] of [["solana", "SOL"], ["base", "ETH"], ["robinhood", "ETH"], ["near", "USDC"]]) assert.equal(ok({ ...STATE, pools: [{ chain, asset, balance: "1" }] }), true, `${asset} on ${chain}`);
  // amounts at the asset's full decimals pass, and a ready equal to the balance
  assert.equal(ok({ ...STATE, pools: [{ chain: "solana", asset: "SOL", balance: "0.000000001", ready: "0.000000001" }] }), true, "SOL at 9 decimals");
  assert.equal(ok({ ...STATE, pools: [{ chain: "base", asset: "ETH", balance: "0.000000000000000001" }] }), true, "ETH at 18 decimals");
  assert.equal(ok({ ...STATE, pools: [{ chain: "near", asset: "USDC", balance: "12.000001", ready: "12" }] }), true, "USDC at 6 decimals");
  assert.deepEqual([...MSG.POOL_ASSETS], ["SOL", "ETH", "USDC"]);
  assert.deepEqual({ ...MSG.POOL_ASSET_DECIMALS }, { SOL: 9, ETH: 18, USDC: 6 });
  assert.equal(Object.isFrozen(MSG.POOL_ASSETS) && Object.isFrozen(MSG.POOL_ASSET_DECIMALS), true, "the asset table is frozen");
  const bad = {
    "an unknown asset BTC": [{ chain: "solana", asset: "BTC", balance: "1" }],
    "ETH on solana": [{ chain: "solana", asset: "ETH", balance: "1" }],
    "USDC on solana": [{ chain: "solana", asset: "USDC", balance: "1" }],
    "SOL on base": [{ chain: "base", asset: "SOL", balance: "1" }],
    "USDC on robinhood": [{ chain: "robinhood", asset: "USDC", balance: "1" }],
    "ETH on near": [{ chain: "near", asset: "ETH", balance: "1" }],
    "a SOL balance past 9 decimals": [{ chain: "solana", asset: "SOL", balance: "0.0000000001" }],
    "a USDC balance past 6 decimals": [{ chain: "near", asset: "USDC", balance: "1.0000001" }],
    "an ETH ready past 18 decimals": [{ chain: "base", asset: "ETH", balance: "1", ready: "0.0000000000000000001" }],
    "a ready over the balance": [{ chain: "solana", asset: "SOL", balance: "12.5", ready: "12.500000001" }],
    "a ready over a zero balance": [{ chain: "near", asset: "USDC", balance: "0", ready: "1" }],
    "an asset in lower case": [{ chain: "solana", asset: "sol", balance: "1" }],
    "an empty asset": [{ chain: "solana", asset: "", balance: "1" }],
    "no asset": [{ chain: "solana", balance: "1" }],
    "an asset that is not a string": [{ chain: "solana", asset: 9, balance: "1" }],
    "a decimals key": [{ chain: "solana", asset: "SOL", balance: "1", decimals: 9 }],
    "an entry with an extra key": [{ chain: "solana", asset: "SOL", balance: "1", note: "x" }],
    "an entry with no balance": [{ chain: "solana", asset: "SOL" }],
    "a bad chain": [{ chain: "ethereum", asset: "ETH", balance: "1" }],
    "a negative balance": [{ chain: "solana", asset: "SOL", balance: "-1" }],
    "a negative ready": [{ chain: "solana", asset: "SOL", balance: "1", ready: "-1" }],
    "an exponent": [{ chain: "solana", asset: "SOL", balance: "1e3" }],
    "an empty amount": [{ chain: "solana", asset: "SOL", balance: "" }],
    "a bare point": [{ chain: "solana", asset: "SOL", balance: "1." }],
    "a non-decimal ready": [{ chain: "solana", asset: "SOL", balance: "1", ready: "1e3" }],
    "a number, not a string": [{ chain: "solana", asset: "SOL", balance: 1 }],
    "a chain twice": [
      { chain: "solana", asset: "SOL", balance: "1" },
      { chain: "base", asset: "ETH", balance: "2" },
      { chain: "solana", asset: "SOL", balance: "3" },
    ],
    "not an array": { chain: "solana", asset: "SOL", balance: "1" },
  };
  for (const [name, v] of Object.entries(bad)) assert.equal(ok({ ...STATE, pools: v }), false, name);
});

test("state.pools tap_max: the most one tap can spend, optional next to ready, exact at the asset's decimals, never over ready", () => {
  const ok = S.SIGNPAGE_RESULT_SCHEMAS.state;
  const at = (e) => ok({ ...STATE, pools: [e] });
  // present
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "8" }), true, "a tap_max under ready");
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "10" }), true, "a tap_max equal to ready");
  assert.equal(at({ chain: "base", asset: "ETH", balance: "1", ready: "0.001", tap_max: "0.000000000000000001" }), true, "ETH at 18 decimals");
  assert.equal(at({ chain: "near", asset: "USDC", balance: "1", ready: "0", tap_max: "0" }), true, "\"0\" with a ready of \"0\"");
  // absent: an older page's entry with a ready and no tap_max, and an entry with neither
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5", ready: "10" }), true, "ready, no tap_max");
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5" }), true, "neither");
  // malformed: refused
  const bad = {
    "a tap_max with no ready": { chain: "solana", asset: "SOL", balance: "12.5", tap_max: "1" },
    "a tap_max over ready": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "10.000000001" },
    "a tap_max of 0 with a ready above 0": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "0" },
    "a tap_max above 0 with a ready of 0": { chain: "solana", asset: "SOL", balance: "12.5", ready: "0", tap_max: "1" },
    "a SOL tap_max past 9 decimals": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "0.0000000001" },
    "a USDC tap_max past 6 decimals": { chain: "near", asset: "USDC", balance: "12", ready: "10", tap_max: "1.0000001" },
    "a negative tap_max": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "-1" },
    "an exponent": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "1e1" },
    "an empty tap_max": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "" },
    "a bare point": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "1." },
    "a number, not a string": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: 1 },
    "null": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: null },
  };
  for (const [name, e] of Object.entries(bad)) assert.equal(at(e), false, name);
});

// ------------------------------------------------------------------------------------------------ refusals
test("answers dropped with no state change: wrong origin, wrong source, wrong id, bad keys, bad arrays, over 4 MiB, not plain", async () => {
  const { h, c } = await readyClient();
  const { id, p, settled } = await open(h, c, "buy");
  const good = answer(id, FIXTURES.buy.result);
  const before = c.snapshot();
  const win = h.frame().contentWindow;
  const txsWith = (f) => {
    const txs = [{ chain: "solana", hash: "5ig" }];
    f(txs);
    return answer(id, { stage: "sent", txs });
  };
  const sparse = [];
  sparse.length = 2 ** 32 - 1;
  const cases = [
    ["a same-site sibling", good, "https://evil.ct.test", win, "origin"],
    ["APP_HOST itself", good, "https://confidential.unrealized.trade", win, "origin"],
    ["SIGN_HOST over http", good, "http://sign.confidential.unrealized.trade", win, "origin"],
    ["SIGN_HOST with a port", good, "https://sign.confidential.unrealized.trade:8443", win, "origin"],
    ["a cross-site host", good, "https://app.other.test", win, "origin"],
    ["SIGN_HOST's origin from another window", good, ORIGIN, new FakeChild(), "source"],
    ["SIGN_HOST's origin with no source", good, ORIGIN, null, "source"],
    ["a wrong id", answer("00000000-0000-4000-8000-000000000000", FIXTURES.buy.result), ORIGIN, win, "id"],
    ["a __proto__ key", JSON.parse(`{"v":1,"id":"${id}","ok":true,"result":{"stage":"sent","txs":[],"__proto__":{"x":1}}}`), ORIGIN, win, "shape"],
    ["a constructor key", { ...good, result: { ...FIXTURES.buy.result, constructor: "x" } }, ORIGIN, win, "shape"],
    ["a 5 MB named key on an array", txsWith((t) => (t.big = "x".repeat(5_000_000))), ORIGIN, win, "shape"],
    ["an own __proto__ on an array", txsWith((t) => Object.defineProperty(t, "__proto__", { value: 1, enumerable: true, configurable: true, writable: true })), ORIGIN, win, "shape"],
    ["a hole in an array", txsWith((t) => (t.length = 2)), ORIGIN, win, "shape"],
    ["a sparse array of length 2^32-1", answer(id, { stage: "sent", txs: sparse }), ORIGIN, win, "shape"],
    ["an array over the bound", answer(id, { stage: "sent", txs: Array.from({ length: S.SIGNPAGE_MAX_ARRAY + 1 }, () => ({ chain: "solana", hash: "h" })) }), ORIGIN, win, "shape"],
    ["a body over 4 MiB", answer(id, { stage: "sent", txs: Array.from({ length: 10_000 }, () => ({ chain: "solana", hash: "x".repeat(420) })) }), ORIGIN, win, "shape"],
    ["not a plain object", Object.assign(new (class X {})(), good), ORIGIN, win, "shape"],
    ["a string", JSON.stringify(good), ORIGIN, win, "shape"],
    ["a v other than 1", { ...good, v: 2 }, ORIGIN, win, "shape"],
    ["an extra envelope field", { ...good, route: "x" }, ORIGIN, win, "shape"],
    ["an unknown event", { v: 1, type: "sign", id }, ORIGIN, win, "shape"],
  ];
  for (const [name, data, origin, source, reason] of cases) {
    const d0 = c.dropped()[reason];
    const t0 = performance.now();
    h.post(data, origin, source);
    await flush();
    assert.ok(performance.now() - t0 < 1_000, `${name}: refused at once`);
    assert.equal(c.dropped()[reason], d0 + 1, `${name}: dropped as ${reason}`);
    assert.equal(c.snapshot(), before, `${name}: no state change`);
    assert.equal(settled(), false, `${name}: the request is still open`);
  }
  // just under the cap is read
  h.post(answer(id, { stage: "sent", txs: Array.from({ length: 150 }, () => ({ chain: "solana", hash: "x".repeat(400) })) }));
  assert.equal((await p).ok, true);
});

test("the plain-message walk: forbidden keys at any depth, the depth bound, the 4 MiB bound", () => {
  const nest = (n) => {
    let x = { a: 1 };
    for (let i = 0; i < n; i++) x = { a: x };
    return x;
  };
  assert.equal(S.signpageIsPlainMessage({ a: [{ b: 1 }] }), true);
  for (const k of ["__proto__", "constructor", "prototype"]) {
    assert.equal(S.signpageIsPlainMessage(JSON.parse(`{"a":[{"b":{"${k}":1}}]}`)), false, k);
  }
  assert.equal(S.signpageIsPlainMessage(nest(S.SIGNPAGE_MAX_DEPTH - 1)), true, "at the depth bound");
  assert.equal(S.signpageIsPlainMessage(nest(S.SIGNPAGE_MAX_DEPTH)), false, "past the depth bound");
  const CAP = S.SIGNPAGE_MAX_ANSWER_BYTES;
  assert.equal(CAP, 4_194_304);
  assert.equal(S.signpageIsPlainMessage({ s: "x".repeat(CAP - 8) }), true, "exactly 4 MiB of JSON");
  assert.equal(S.signpageIsPlainMessage({ s: "x".repeat(CAP - 7) }), false, "4 MiB + 1");
  assert.equal(S.signpageIsPlainMessage({ s: "é".repeat(CAP / 2) }), false, "counted in UTF-8 bytes");
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

test("state and progress events before READY are dropped", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  const seen = [];
  c.onProgress((id, stage) => seen.push([id, stage]));
  h.post({ v: 1, type: "state", state: STATE });
  h.post({ v: 1, type: "progress", id: "x", stage: "filled" });
  assert.equal(c.snapshot().state, null);
  assert.deepEqual(seen, []);
  assert.equal(c.dropped().shape, 2);
});

// ------------------------------------------------------------------------------------------------ the two caps
/** A state with `n` orders, each about 350 bytes of JSON. */
const bigState = (n) => ({
  ...STATE,
  orders: Array.from({ length: n }, (_, i) => ({ ...STATE.orders[0], order_id: `o${i}`, token: `tok-${i}-${"t".repeat(120)}` })),
});
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;

test("the caps are named: requests 64 KiB (the signing page's), answers 4 MiB, arrays 10,000; all on the kit's entry", async () => {
  assert.equal(C.SIGNPAGE_MAX_REQUEST_BYTES, 65_536);
  assert.equal(C.SIGNPAGE_MAX_ANSWER_BYTES, 4_194_304);
  assert.equal(C.SIGNPAGE_MAX_ARRAY, 10_000);
  const kit = await import("../src/index.ts");
  for (const k of ["SIGNPAGE_MAX_REQUEST_BYTES", "SIGNPAGE_MAX_ANSWER_BYTES", "SIGNPAGE_MAX_ARRAY"]) assert.ok(k in kit, k);
});

test("a 3 MiB state with 9,000 orders is read, as the handshake's answer and as a state event", async () => {
  const s = bigState(9_000);
  const n = bytes(answer("00000000-0000-4000-8000-000000000000", s));
  assert.ok(n > 3 * 1_048_576 && n < 4 * 1_048_576, `${n} bytes`);
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  await handshake(h, s);
  assert.equal(c.snapshot().status, "ready");
  assert.equal(c.snapshot().state.orders.length, 9_000);
  h.post({ v: 1, type: "state", state: { ...s, vault_balance: "9" } });
  assert.equal(c.snapshot().state.vault_balance, "9");
});

test("a state of 10,000 orders is read; 10,001 orders, or a state over 4 MiB, is dropped", async () => {
  const { h, c } = await readyClient();
  h.post({ v: 1, type: "state", state: bigState(10_000) });
  assert.equal(c.snapshot().state.orders.length, 10_000);
  const before = c.snapshot();
  h.post({ v: 1, type: "state", state: bigState(10_001) });
  const over = { ...bigState(9_000), held: Array.from({ length: 3_000 }, (_, i) => ({ id: `h${i}`, asset: "a".repeat(400), amount: "1" })) };
  assert.ok(bytes({ v: 1, type: "state", state: over }) > 4_194_304);
  h.post({ v: 1, type: "state", state: over });
  assert.equal(c.snapshot(), before);
  assert.equal(c.dropped().shape, 2);
});

// The bound is proved by counting, never by the clock (a slow runner took 1134 ms for the same walk: main's CI run
// 41272481724). schema.ts:67 counts one visit per value (`++chars`) and refuses at visit SIGNPAGE_MAX_ANSWER_BYTES + 1,
// before any JSON is made. Every value is at least one byte of JSON, so a message that needs exactly that many visits
// still fails the JSON size check after the walk: the walk's verdict shows as whether JSON.stringify ran.
const CAP = 4_194_304;
/** The visits the walk counts for `v`: one per value, plus the characters of every string and key (schema.ts:67-77). */
const visitsOf = (v) => {
  if (v === null || typeof v !== "object") return 1 + (typeof v === "string" ? v.length : 0);
  if (Array.isArray(v)) return 1 + v.reduce((n, e) => n + visitsOf(e), 0);
  return 1 + Object.keys(v).reduce((n, k) => n + k.length + visitsOf(v[k]), 0);
};
const message = (bomb) => ({ v: 1, type: "progress", id: "x", stage: "filled", bomb });
/** A message whose walk needs exactly `visits` visits, built from arrays shared `depth` levels deep, plus a few nulls. */
function withVisits(depth, visits) {
  const inner = new Array(10_000).fill(null); // 10,001 visits per path
  const mid = new Array(100).fill(inner); // depth 2: 1,000,101 visits per path
  const bomb = [];
  const unit = depth === 1 ? inner : mid;
  const per = visitsOf(unit);
  const fixed = visitsOf(message([]));
  const n = Math.floor((visits - fixed) / per);
  for (let i = 0; i < n; i++) bomb.push(unit);
  if (depth === 2) for (let i = 0; i < Math.floor((visits - fixed - n * per) / 10_001); i++) bomb.push(inner);
  const msg = message(bomb);
  const pad = visits - visitsOf(msg);
  assert.ok(pad >= 0 && bomb.length + pad <= 10_000, `${depth}: ${pad} nulls to add`);
  for (let i = 0; i < pad; i++) bomb.push(null);
  assert.equal(visitsOf(msg), visits);
  return msg;
}
/** Whether the walk got past its count, seen as a JSON.stringify call. */
function walkedThenJson(msg) {
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = (...a) => (calls++, stringify(...a));
  try {
    return { accepted: S.signpageIsPlainMessage(msg), json: calls };
  } finally {
    JSON.stringify = stringify;
  }
}

test("the walk's bound is exact: visit 4,194,304 passes the count, visit 4,194,305 is refused by it, at depth 1 and depth 2", () => {
  assert.equal(S.SIGNPAGE_MAX_ANSWER_BYTES, CAP);
  for (const depth of [1, 2]) {
    const at = walkedThenJson(withVisits(depth, CAP));
    // The count let it through; the JSON (at least one byte per value) is over the cap, so it is refused there.
    assert.deepEqual(at, { accepted: false, json: 1 }, `depth ${depth}: exactly ${CAP} visits get past the count`);
    const over = walkedThenJson(withVisits(depth, CAP + 1));
    assert.deepEqual(over, { accepted: false, json: 0 }, `depth ${depth}: ${CAP + 1} visits are refused by the count, before any JSON`);
  }
});

test("a message whose JSON is exactly 4 MiB is read; one byte more is refused", () => {
  const exact = [("x").repeat(CAP - 4)]; // ["xxx..."] is the string plus 4 bytes
  assert.equal(bytes(exact), CAP);
  assert.equal(S.signpageIsPlainMessage(exact), true);
  assert.equal(S.signpageIsPlainMessage([("x").repeat(CAP - 3)]), false);
});

test("a shared-array bomb is dropped by the client, at depth 1 and depth 2: the state is the same, the clock is only an outer limit", async () => {
  const { h, c } = await readyClient();
  const inner = new Array(10_000).fill(null);
  const d1 = new Array(10_000).fill(inner); // 10^8 leaves in about 30 KB of references
  const d2 = new Array(10_000).fill(d1); // 10^12 leaves
  const bombs = [["depth 1", message(d1)], ["depth 2", message(d2)], ["depth 1, at the bound + 1", withVisits(1, CAP + 1)], ["depth 2, at the bound + 1", withVisits(2, CAP + 1)]];
  for (const [name, msg] of bombs) {
    let t0 = performance.now();
    assert.equal(S.signpageIsPlainMessage(msg), false, name);
    assert.ok(performance.now() - t0 < 10_000, `${name}: the walk took over 10 s`);
    const before = c.snapshot();
    const d0 = c.dropped().shape;
    t0 = performance.now();
    h.post(msg);
    assert.ok(performance.now() - t0 < 10_000, `${name}: the client took over 10 s`);
    assert.equal(c.dropped().shape, d0 + 1, name);
    assert.equal(c.snapshot(), before, name);
  }
});

test("4.2M unshared nulls are refused by the walk, before any JSON is made", () => {
  const nulls = Array.from({ length: 420 }, () => new Array(10_000).fill(null));
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = (...a) => (calls++, stringify(...a));
  try {
    assert.equal(S.signpageIsPlainMessage({ nulls }), false);
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(calls, 0, "refused by the count, not the JSON");
});

test("the request cap stays 64 KiB: a bigger request cannot be built", () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `order-${i}-${"x".repeat(30)}`);
  assert.ok(bytes(C.signpageBuildRequest("orders.cancel", { order_ids: ids(1_000) }, "id")) <= 65_536);
  assert.throws(() => C.signpageBuildRequest("orders.cancel", { order_ids: ids(2_000) }, "id"), /over 65536 bytes/);
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  assert.throws(() => c.request("orders.cancel", { order_ids: ids(2_000) }), TypeError);
});

// ------------------------------------------------------------------------------------------------ timeouts
test("each kind's timeout is the table's (app.md §2.1 item 3); restore has none", () => {
  assert.deepEqual(C.SIGNPAGE_TIMEOUT_MS, {
    "deposit.quote": 15_000, "deposit.confirm": 15_000, arm: 5_000, buy: 10_000, hop: 10_000, "orders.set": 15_000,
    "orders.cancel": 15_000, return: 15_000, "withdraw.open": 5_000, "signin.open": 5_000, "backup.open": 5_000,
    "export.open": 5_000, signout: 5_000, restore: null, state: 5_000, nav: 5_000, reload: 5_000,
    // the pool kinds (card signpage-pool-kinds): a trade's time, the withdraw screen an open's
    "pool.deposit": 10_000, "pool.buy": 10_000, "pool.sell": 10_000, "pool.withdraw": 5_000,
  });
});

test("restore never times out on the client", async () => {
  const { h, c } = await readyClient();
  const { p, settled, id } = await open(h, c, "restore");
  mock.timers.tick(3_600_000);
  await flush();
  assert.equal(settled(), false);
  assert.equal(c.snapshot().status, "ready");
  h.post(answer(id, { stage: "started" }));
  assert.equal((await p).ok, true);
});

for (const kind of SIGNPAGE_KINDS.filter((k) => C.SIGNPAGE_TIMEOUT_MS[k] !== null)) {
  test(`${kind}: with no answer it ends as client_timeout at its timeout, and a late answer is dropped`, async () => {
    const { h, c } = await readyClient();
    const { id, p, settled } = await open(h, c, kind);
    mock.timers.tick(C.SIGNPAGE_TIMEOUT_MS[kind] - 1);
    await flush();
    assert.equal(settled(), false);
    mock.timers.tick(1);
    assert.deepEqual(await p, TIMEOUT);
    const isOpen = OPEN_KINDS.includes(kind);
    assert.equal(c.snapshot().status, isOpen ? "down" : "ready", "an open kind's timeout is the down state");
    if (kind === "state") assert.equal(c.snapshot().stale, true, "a state timeout keeps the last state, stale");
    h.post(answer(id, FIXTURES[kind].result));
    assert.equal(c.dropped().id, 1);
  });
}

test("a money kind's timeout asks state again and never re-sends the kind", async () => {
  for (const kind of ["deposit.confirm", "arm", "buy", "hop", "orders.set", "orders.cancel", "return"]) {
    const { h, c } = await readyClient();
    await open(h, c, kind);
    mock.timers.tick(C.SIGNPAGE_TIMEOUT_MS[kind]);
    await flush();
    const types = h.frame().contentWindow.sent.map((s) => s.msg.type);
    assert.deepEqual(types, [kind, "state"], kind);
  }
});

test("APU-03: over 1,000 fake-clock runs no money or navigation kind is ever re-sent by the client", async () => {
  const NEVER_RESENT = ["deposit.confirm", "arm", "buy", "hop", "orders.set", "orders.cancel", "return", "withdraw.open", "signin.open", "backup.open", "export.open", "signout"];
  const { h, c } = await readyClient();
  const asked = new Map();
  let seed = 7;
  for (let run = 0; run < 1_000; run++) {
    if (c.snapshot().status !== "ready") {
      c.retry();
      await handshake(h);
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
  for (const s of h.sent()) sent.set(s.msg.type, (sent.get(s.msg.type) ?? 0) + 1);
  for (const k of NEVER_RESENT) assert.equal(sent.get(k) ?? 0, asked.get(k) ?? 0, `${k} sent exactly as often as asked`);
  const ids = h.sent().map((s) => s.msg.id);
  assert.equal(new Set(ids).size, ids.length, "no id is ever sent twice");
});

test("destroy: the listener and the iframe go, and nothing is sent after", async () => {
  const { h, c } = await readyClient();
  c.destroy();
  assert.equal(h.listening(), false);
  assert.equal(h.frame().removed, true);
  assert.deepEqual(await c.request("state", {}).outcome, DOWN);
  mock.timers.tick(C.SIGNPAGE_RETRY_MS * 2);
  assert.equal(h.frames.length, 1, "no retry after destroy");
  assert.equal(h.sent().length, 0);
});

// card signpage-shell: the shell's two kinds, nav (where the app is) and reload (the top window)
test("nav takes APP_HOST's own path and query only, at most 2,048 bytes; reload takes nothing", async () => {
  assert.ok(SIGNPAGE_KINDS.includes("nav") && SIGNPAGE_KINDS.includes("reload"));
  assert.ok(!OPEN_KINDS.includes("nav") && !OPEN_KINDS.includes("reload"));
  const nav = (path) => C.signpageBuildRequest("nav", { path }, "id");
  assert.deepEqual(nav("/token/solana/x?tab=trades"), { v: 1, id: "id", type: "nav", path: "/token/solana/x?tab=trades" });
  assert.deepEqual(nav("/"), { v: 1, id: "id", type: "nav", path: "/" });
  assert.ok(nav(`/${"a".repeat(2_047)}`));
  for (const path of ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "x", "", "/a\nb", "/a\u007fb", `/${"a".repeat(2_048)}`, `/${"é".repeat(1_024)}`, 1, null]) {
    assert.throws(() => nav(path), TypeError, JSON.stringify(path));
  }
  assert.throws(() => C.signpageBuildRequest("nav", { path: "/", extra: 1 }, "id"), TypeError);
  assert.throws(() => C.signpageBuildRequest("nav", {}, "id"), TypeError);
  assert.deepEqual(C.signpageBuildRequest("reload", {}, "id"), { v: 1, id: "id", type: "reload" });
  assert.throws(() => C.signpageBuildRequest("reload", { x: 1 }, "id"), TypeError);
  const { SIGNPAGE_RESULT_SCHEMAS: R } = await import(`${SRC}signpage/schema.ts`);
  for (const k of ["nav", "reload"]) {
    assert.equal(R[k]({}), true, k);
    assert.equal(R[k]({ ok: 1 }), false, k);
  }
});
