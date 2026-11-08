// The signing-page client's unit tests (APU-02, APU-03, app.md:1327-1328; the client half of AX-05, AX-06; BAR-09):
// a fake window, document and iframe, Node's fake clock. Every kind of the twenty-one has its fixture (a kind with no
// fixture fails the suite, matching "a kind with no row is refused", W:894). Every dropped message is checked for "no
// state change": the snapshot is the same object and the request it targets is still open.
//   node --test test/signpage-client.test.mjs
// SIGNPAGE_SRC=<abs path to a copy of src/> runs the same tests against that copy (the red-before proofs).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { pathToFileURL } from "node:url";
import { OPEN_KINDS, SIGNPAGE_KINDS } from "../src/signpage/messages.ts";
import { FIXTURES, STATE } from "./signpage-fixtures.ts";

const SRC = process.env.SIGNPAGE_SRC ? pathToFileURL(`${process.env.SIGNPAGE_SRC}/`).href : new URL("../src/", import.meta.url).href;
const C = await import(`${SRC}signpage/client.ts`);
const S = await import(`${SRC}signpage/schema.ts`);
const MSG = await import(`${SRC}signpage/messages.ts`);

const URL_ = "https://confidential.unrealized.trade/";
const ORIGIN = "https://confidential.unrealized.trade";
const DOWN = { ok: false, error: { code: "signpage_down" } };
const TIMEOUT = { ok: false, error: { code: "client_timeout" } };

// ------------------------------------------------------------------------------------------------ fakes
class FakeChild {
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
  /** every message posted to every frame, hellos included, in order */
  const log = () => frames.flatMap((f) => f.contentWindow.log);
  return { host, frames, frame, post, fireWindow, sent, log, listening: () => on.size > 0 };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};


/** "No state change" now that every snapshot is a copy (card oneclick-fee-path-own-key): no listener has heard a change
 *  since this call, which is what one object kept the same meant (the client's set() always calls every listener), and
 *  the snapshot reads the same. */
function unchanged(c) {
  let changes = 0;
  c.subscribe(() => void changes++);
  const snap = c.snapshot();
  return { check(msg = "no state change") { assert.equal(changes, 0, msg); assert.deepEqual(c.snapshot(), snap, msg); } };
}

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

test.beforeEach(() => enableTimers(mock.timers, { apis: ["setTimeout"] }));
test.afterEach(() => resetTimers(mock.timers));

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
  for (const bad of ["http://confidential.unrealized.trade/", `${URL_}?flow=x`, `${URL_}#x`, "https://u:p@confidential.unrealized.trade/", "https://confidential.unrealized.trade"]) {
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

// -------------------------------------------------------------------------------------------- the twenty-four kinds
test("every kind of the twenty-four has a fixture, and only the twenty-four do", () => {
  assert.equal(SIGNPAGE_KINDS.length, 24);
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
    const before = unchanged(c);
    h.post(answer(id, FIXTURES[kind].result));
    before.check();
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
    const before = unchanged(c);
    h.post(answer(id, { ...FIXTURES[kind].result, extra: "x" }));
    // {} is nav's and reload's own result: for them only the extra field is another shape
    const empty = Object.keys(FIXTURES[kind].result).length === 0;
    if (!empty) h.post(answer(id, {}));
    await flush();
    assert.equal(settled(), false);
    before.check();
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

test("the deposit sheet's reads (card kit-deposit-assets-dry): deposit.assets takes no field, deposit.dry an asset and a decimal amount only, never an address", () => {
  assert.deepEqual(C.signpageBuildRequest("deposit.assets", {}, "id"), { v: 1, id: "id", type: "deposit.assets" });
  assert.deepEqual(C.signpageBuildRequest("deposit.dry", { origin_asset: "nep141:usdc", amount: "25" }, "id"), { origin_asset: "nep141:usdc", amount: "25", v: 1, id: "id", type: "deposit.dry" });
  for (const b of [{ recipient: "x" }, { origin_asset: "nep141:usdc" }]) assert.throws(() => C.signpageBuildRequest("deposit.assets", b, "id"), TypeError, JSON.stringify(b));
  for (const b of [{ origin_asset: "nep141:usdc" }, { amount: "25" }, { origin_asset: "nep141:usdc", amount: "1e5" }, { origin_asset: "nep141:usdc", amount: 25 },
    { origin_asset: "nep141:usdc", amount: "25", recipient: "x" }, { origin_asset: "nep141:usdc", amount: "25", refundTo: "x" }])
    assert.throws(() => C.signpageBuildRequest("deposit.dry", b, "id"), TypeError, JSON.stringify(b));
});

test("the deposit sheet's reads: an asset list or dry quote the device cannot have made is dropped, each check on its own", async () => {
  const A = FIXTURES["deposit.assets"].result.assets[0];
  const D = FIXTURES["deposit.dry"].result;
  const bad = [
    ["deposit.assets", { assets: [{ ...A, min: "0" }] }, "a minimum of 0"],
    ["deposit.assets", { assets: [{ ...A, min: "1.0000001" }] }, "a minimum finer than the asset's decimals"],
    ["deposit.assets", { assets: [{ ...A, decimals: 37 }] }, "decimals over 36"],
    ["deposit.assets", { assets: [{ ...A, decimals: 1.5 }] }, "decimals not whole"],
    ["deposit.assets", { assets: [{ ...A, chain: "ethereum" }] }, "a chain the kit does not have"],
    ["deposit.assets", { assets: [{ ...A, max_usd: "-1" }] }, "a max that is not a decimal"],
    ["deposit.assets", { assets: [{ ...A, max_usd: "0" }] }, "a max of 0"],
    ["deposit.assets", { assets: [{ ...A, max_usd: "0.000" }] }, "a max of 0.000"],
    ["deposit.assets", { assets: [A, { ...A, chain: "base" }] }, "one asset twice"],
    ["deposit.assets", { assets: [{ ...A, deposit_address: "dep1" }] }, "an address on an asset"],
    ["deposit.dry", { ...D, min_amount_out_usd: "24.9400001" }, "a min out above the amount out"],
    ["deposit.dry", { ...D, time_estimate_s: -1 }, "a negative time"],
    ["deposit.dry", { ...D, time_estimate_s: 1.5 }, "a time not whole"],
    ["deposit.dry", { ...D, fee_usd: "-0.06" }, "a fee that is not a decimal"],
    ["deposit.dry", { ...D, deposit_address: "dep1" }, "an address on a dry quote"],
  ];
  for (const [kind, result, why] of bad) {
    const { h, c } = await readyClient();
    const { id, settled } = await open(h, c, kind);
    h.post(answer(id, result));
    await flush();
    assert.equal(settled(), false, why);
    assert.equal(c.dropped().shape, 1, why);
  }
  // the edges that are the device's own: a min out equal to the amount out, no asset at all, a time of 0
  for (const [kind, result] of [["deposit.dry", { ...D, min_amount_out_usd: D.amount_out_usd, time_estimate_s: 0 }], ["deposit.assets", { assets: [] }]]) {
    const { h, c } = await readyClient();
    const { id, p } = await open(h, c, kind);
    h.post(answer(id, result));
    assert.deepEqual(await p, { ok: true, result });
  }
});

test("pool.address (card pool-deposit-address): a pool chain alone, or with an origin asset and a decimal amount both, never an address", () => {
  assert.deepEqual(C.signpageBuildRequest("pool.address", { chain: "solana" }, "id"), { chain: "solana", v: 1, id: "id", type: "pool.address" });
  assert.deepEqual(C.signpageBuildRequest("pool.address", { chain: "base", origin_asset: "nep141:usdc", amount: "25" }, "id"),
    { chain: "base", origin_asset: "nep141:usdc", amount: "25", v: 1, id: "id", type: "pool.address" });
  for (const b of [{}, { chain: "near" }, { chain: "ethereum" }, { chain: "solana", origin_asset: "nep141:usdc" }, { chain: "solana", amount: "25" },
    { chain: "solana", origin_asset: "nep141:usdc", amount: "1e5" }, { chain: "solana", origin_asset: "nep141:usdc", amount: 25 },
    { chain: "solana", recipient: "x" }, { chain: "solana", origin_asset: "nep141:usdc", amount: "25", refundTo: "x" }, { chain: "solana", origin_asset: 7, amount: "25" }])
    assert.throws(() => C.signpageBuildRequest("pool.address", b, "id"), TypeError, JSON.stringify(b));
});

test("pool.address: an answer the device cannot have made is dropped, each check on its own", async () => {
  const S = FIXTURES["pool.address"].result;
  const SOL = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
  const Q = { deposit_address: "dep1", origin_asset: "nep141:usdc", amount_in: "25", min_amount_out: "0.16", deadline: "2026-11-11T00:00:00.000Z", time_estimate_s: 20 };
  const bad = [
    [{ ...S, asset: "ETH" }, "the Solana pool's asset as ETH"],
    [{ chain: "base", address: EVM, asset: "SOL" }, "the Base pool's asset as SOL"],
    [{ ...S, asset: "USDC" }, "USDC, the vault's, on a pool"],
    [{ ...S, chain: "near" }, "a chain with no pool"],
    [{ ...S, address: EVM }, "an EVM address on Solana"],
    [{ chain: "base", address: SOL, asset: "ETH" }, "a Solana address on Base"],
    [{ chain: "base", address: EVM.toLowerCase().replace("0x", "0X"), asset: "ETH" }, "an EVM address not 0x"],
    [{ ...S, address: "1111" }, "a Solana address not of 32 bytes"],
    [{ ...S, quote: { ...Q, min_amount_out: "0.1234567891" } }, "a min out finer than SOL's 9 decimals"],
    [{ ...S, quote: { ...Q, time_estimate_s: -1 } }, "a negative time"],
    [{ ...S, quote: { ...Q, deadline: "soon" } }, "a deadline not ISO"],
    [{ ...S, quote: { ...Q, recipient: SOL } }, "a field the quote does not have"],
    [{ ...S, refund_to: SOL }, "a field the answer does not have"],
  ];
  for (const [result, why] of bad) {
    const { h, c } = await readyClient();
    const { id, settled } = await open(h, c, "pool.address");
    h.post(answer(id, result));
    await flush();
    assert.equal(settled(), false, why);
    assert.equal(c.dropped().shape, 1, why);
  }
  for (const result of [{ ...S, quote: Q }, { chain: "base", address: EVM, asset: "ETH" }, { chain: "robinhood", address: EVM, asset: "ETH", quote: { ...Q, min_amount_out: "0.000000000000000001" } }]) {
    const { h, c } = await readyClient();
    const { id, p } = await open(h, c, "pool.address");
    h.post(answer(id, result));
    assert.deepEqual(await p, { ok: true, result });
  }
});

test("a kind not in the twenty-four cannot be built", () => {
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

test("state.pools tap_max: the most one ready proof can spend at the tap, optional next to ready, exact at the asset's decimals, never over ready", () => {
  const ok = S.SIGNPAGE_RESULT_SCHEMAS.state;
  const at = (e) => ok({ ...STATE, pools: [e] });
  // present
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "8" }), true, "a tap_max under ready");
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "10" }), true, "a tap_max equal to ready");
  assert.equal(at({ chain: "base", asset: "ETH", balance: "1", ready: "0.001", tap_max: "0.000000000000000001" }), true, "ETH at 18 decimals");
  assert.equal(at({ chain: "near", asset: "USDC", balance: "1", ready: "0", tap_max: "0" }), true, "\"0\" with a ready of \"0\"");
  // a ready proof whose fee and W's new accounts eat its chunk spends 0: the chain's tap_max is "0" with a ready above 0
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5", ready: "0.001", tap_max: "0" }), true, "\"0\" with a ready above 0");
  // absent: an older page's entry with a ready and no tap_max, and an entry with neither
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5", ready: "10" }), true, "ready, no tap_max");
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "12.5" }), true, "neither");
  // malformed: refused
  const bad = {
    "a tap_max with no ready": { chain: "solana", asset: "SOL", balance: "12.5", tap_max: "1" },
    "a tap_max over ready": { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "10.000000001" },
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

test("state.pools price: the pool asset's USD price as the page read it, optional, exact, on a chain with a feed only (card signpage-pool-price)", () => {
  const ok = S.SIGNPAGE_RESULT_SCHEMAS.state;
  const at = (e) => ok({ ...STATE, pools: [e] });
  const P = { price: "9301048308", expo: -8, published_s: 1793802229, read_ms: 1793802231000 };
  const sol = { chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00173608" };
  // present: with or without the proof fields, on each chain with a feed
  assert.equal(at({ ...sol, price: P }), true, "a price on Solana");
  assert.equal(at({ chain: "solana", asset: "SOL", balance: "0.01", price: P }), true, "a price with no ready");
  assert.equal(at({ chain: "base", asset: "ETH", balance: "1", price: { ...P, price: "350012345678" } }), true, "a price on Base");
  assert.equal(at({ chain: "robinhood", asset: "ETH", balance: "1", price: { ...P, expo: 0, price: "3500" } }), true, "a price on Robinhood, exponent 0");
  assert.equal(at({ ...sol, price: { ...P, expo: -18 } }), true, "exponent -18");
  // malformed: refused
  const bad = {
    "a price on NEAR (no feed)": { chain: "near", asset: "USDC", balance: "1", price: P },
    "a price of 0": { ...sol, price: { ...P, price: "0" } },
    "a leading zero": { ...sol, price: { ...P, price: "09301048308" } },
    "a decimal price": { ...sol, price: { ...P, price: "93.01" } },
    "a negative price": { ...sol, price: { ...P, price: "-9301048308" } },
    "a number price": { ...sol, price: { ...P, price: 9301048308 } },
    "a price past 78 digits": { ...sol, price: { ...P, price: "1".repeat(79) } },
    "exponent above 0": { ...sol, price: { ...P, expo: 1 } },
    "exponent below -18": { ...sol, price: { ...P, expo: -19 } },
    "a fractional exponent": { ...sol, price: { ...P, expo: -8.5 } },
    "no published_s": { ...sol, price: { price: P.price, expo: P.expo, read_ms: P.read_ms } },
    "no read_ms": { ...sol, price: { price: P.price, expo: P.expo, published_s: P.published_s } },
    "a negative read_ms": { ...sol, price: { ...P, read_ms: -1 } },
    "an extra key": { ...sol, price: { ...P, source: "server" } },
    "null": { ...sol, price: null },
  };
  for (const [name, e] of Object.entries(bad)) assert.equal(at(e), false, name);
});

// ------------------------------------------------------------------------------------------------ refusals
test("answers dropped with no state change: wrong origin, wrong source, wrong id, bad keys, bad arrays, over 4 MiB, not plain", async () => {
  const { h, c } = await readyClient();
  const { id, p, settled } = await open(h, c, "buy");
  const good = answer(id, FIXTURES.buy.result);
  const before = unchanged(c);
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
    ["APP_HOST itself", good, "https://ct-app.unrealized.trade", win, "origin"],
    ["SIGN_HOST over http", good, "http://confidential.unrealized.trade", win, "origin"],
    ["SIGN_HOST with a port", good, "https://confidential.unrealized.trade:8443", win, "origin"],
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
    before.check(`${name}: no state change`);
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

// card oneclick-fee-path-own-key (the delta review of kit-oneclick-pins-frozen, then its review): the snapshot is one
// deep-frozen copy per change, handed to snapshot() and to every listener alike. Same object while nothing changes (an
// app may wire useSyncExternalStore(client.subscribe, client.snapshot), which compares with Object.is), a write throws,
// and nothing a caller holds is the client's own state. Red at c13c2451 (one shared, writable object: a write of
// "ready" let a request go while connecting) and at e93dea74 (a new copy per call, so snapshot() !== snapshot()).
test("the snapshot is one frozen copy per change: stable identity between changes, a write throws, a change gives a new one", async () => {
  const { h, c } = await readyClient();
  const a = c.snapshot();
  assert.equal(c.snapshot(), a, "snapshot() === snapshot() with no change");
  for (const v of [a, a.state, a.state.orders, a.state.wallets]) assert.ok(Object.isFrozen(v));
  assert.throws(() => { a.status = "connecting"; }, TypeError);
  assert.throws(() => { a.state.vault_balance = "999999"; }, TypeError);
  assert.throws(() => a.state.orders.push({ forged: 1 }), TypeError);
  assert.equal(c.snapshot().state.vault_balance, STATE.vault_balance);
  const heard = [];
  c.subscribe((s) => heard.push(s));
  c.subscribe((s) => heard.push(s));
  h.post({ v: 1, type: "state", state: { ...STATE, vault_balance: "1" } });
  const b = c.snapshot();
  assert.notEqual(b, a, "a change gives a new object");
  assert.equal(b.state.vault_balance, "1");
  assert.deepEqual(heard.map((s) => s === b), [true, true], "every listener gets the object snapshot() returns");
  assert.equal(a.state.vault_balance, STATE.vault_balance, "an earlier snapshot keeps what it was");
  // a client still connecting stays connecting, whatever a caller tries on its snapshot: the request waits
  const h2 = makeHost();
  const c2 = C.createSignpageClient({ url: URL_, host: h2.host });
  assert.throws(() => { c2.snapshot().status = "ready"; }, TypeError);
  assert.equal(c2.snapshot().status, "connecting");
  let settled = false;
  void c2.request("state", {}).outcome.then(() => (settled = true));
  await flush();
  assert.equal(settled, false);
  assert.equal(h2.sent().length, 0, "nothing posted before the handshake");
});

// review 2: a state request's answer is the snapshot's own frozen state, never the client's working object; red at
// e93dea74, when a write into the answer's result changed every later snapshot
test("a state request's answer is the snapshot's frozen state: a write into it throws and changes no later snapshot", async () => {
  const { h, c } = await readyClient();
  const handle = c.request("state", {});
  await flush();
  const sent = h.frame().contentWindow.sent.at(-1);
  h.post(answer(sent.msg.id, { ...STATE, vault_balance: "3" }));
  const o = await handle.outcome;
  assert.equal(o.ok, true);
  assert.equal(o.result, c.snapshot().state);
  assert.ok(Object.isFrozen(o.result));
  assert.throws(() => { o.result.vault_balance = "999999"; }, TypeError);
  h.post({ v: 1, type: "progress", id: "x", stage: "filled" }); // no state change
  h.post({ v: 1, type: "state", state: { ...STATE, vault_balance: "3", orders: [] } });
  assert.equal(c.snapshot().state.vault_balance, "3");
});

// review 3: a request's params are checked and posted as the client's own copy, taken before the check; red at
// e93dea74, when a caller who changed its params while the client was connecting had the changed, unchecked ones posted
test("params changed by the caller after request() are never posted: the client checks and posts its own copy", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  const params = { order_ids: ["o1"] };
  const handle = c.request("orders.cancel", params);
  params.order_ids.push("o2", "x".repeat(70_000)); // over the 64 KiB cap, and an order the caller never asked for
  params.order_ids[0] = { forged: 1 };
  await handshake(h);
  await flush();
  const sent = h.frame().contentWindow.sent.find((x) => x.msg.type === "orders.cancel");
  assert.ok(sent, "posted after the handshake");
  assert.deepEqual(sent.msg.order_ids, ["o1"]);
  assert.equal(sent.msg.id, handle.id);
  // a param the structured clone cannot copy is refused like any other bad param, at once
  assert.throws(() => c.request("orders.cancel", { order_ids: ["o1"], f: () => 1 }), TypeError);
  assert.throws(() => C.signpageBuildRequest("orders.cancel", { order_ids: [() => "o1"] }, "id"), TypeError);
});

// card oneclick-fee-path-own-key (delta review L1): a listener's throw, a write into its frozen snapshot among them, never
// stops the client's own steps (the handshake's state ask, a settle, the down state's retry, destroy) or another
// listener; it is reported after, on its own microtask. Red at c88a3eeb: the write threw inside set(), so the ready never
// asked state and the client never reached READY.
test("a listener that throws, writing into its frozen snapshot, stops none of the client's steps and no other listener", async (t) => {
  const reported = [];
  t.mock.method(globalThis, "queueMicrotask", (f) => { try { f(); } catch (e) { reported.push(e); } });
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  c.subscribe((s) => { s.seenAt = 1; }); // throws: the snapshot is frozen
  const heard = [];
  c.subscribe((s) => heard.push(s.status));
  c.onProgress(() => { throw new Error("progress listener"); });
  const seen = [];
  c.onProgress((id, stage) => seen.push(stage));
  // review r3 L3: a throwing route listener ahead of a second; mutant t1 (route through a plain loop) lived
  c.onRoute((id, r) => { r.out = "999999"; }); // throws: the route is frozen (review r3 info 4)
  const routes = [];
  c.onRoute((id, r) => routes.push(r.out));
  await handshake(h);
  assert.equal(c.snapshot().status, "ready", "the handshake reached READY");
  assert.ok(heard.includes("ready"), "the second listener still hears");
  // a state answer is still settled
  const handle = c.request("state", {});
  await flush();
  h.post(answer(h.frame().contentWindow.sent.at(-1).msg.id, { ...STATE, vault_balance: "5" }));
  assert.equal((await handle.outcome).ok, true);
  assert.equal(c.snapshot().state.vault_balance, "5");
  h.post({ v: 1, type: "progress", id: "x", stage: "filled" });
  assert.deepEqual(seen, ["filled"], "a progress listener after a throwing one still hears");
  h.post({ v: 1, type: "progress", id: "x", out: "1234.5" });
  assert.deepEqual(routes, ["1234.5"], "a route listener after a throwing one still hears, and reads the route unchanged");
  // down still schedules its retry
  h.frame().fire("error");
  assert.equal(c.snapshot().status, "down");
  mock.timers.tick(1_000);
  assert.equal(h.frames.length, 2, "the down state's retry mounted a fresh iframe");
  // destroy is clean
  c.destroy();
  assert.equal(h.listening(), false);
  assert.equal(h.frames.at(-1).removed, true);
  assert.ok(reported.length >= 4 && reported.every((e) => e instanceof Error), "each throw is reported, none lost");
  assert.ok(reported.some((e) => e instanceof TypeError), "the write into the frozen snapshot is among them");
  assert.ok(reported.some((e) => e instanceof TypeError && /out/.test(e.message)), "the write into the frozen route is among them");
});

// review r3 L2: a change calls the listeners as they stood at its start, less any removed during it, as EventTarget
// does. Case (c): A unsubscribes B and subscribes D on its first call; B is not called for that change, D hears from the
// next one. Mutant t8 (a loop over the live Set) calls D in the same change; b3a35fa1 calls B.
test("a listener removed during a change is not called for it, and one added during it hears from the next change", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
  let offB;
  let a = 0;
  let b = 0;
  let d = 0;
  c.subscribe(() => {
    if (a++ === 0) {
      offB();
      c.subscribe(() => void d++);
    }
  });
  offB = c.subscribe(() => void b++);
  await handshake(h);
  assert.ok(a >= 2, "the handshake made more than one change");
  assert.equal(b, 0, "B, removed by A in the change that removed it, is never called");
  assert.equal(d, a - 1, "D, added by A during the first change, hears every change after it and not that one");
  c.destroy();
});

// review r3 L2 case (a): A destroys the client on "ready". The destroy's own "down" reaches B; the outer change's
// "ready", which predates it, does not: destroy removed B. b3a35fa1 told B "ready" after "down".
test("a listener that destroys the client on ready leaves no stale ready for the listeners after it", async () => {
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host, retryMs: 0 });
  const heard = [];
  c.subscribe((s) => { if (s.status === "ready") c.destroy(); });
  c.subscribe((s) => heard.push(s.status));
  await handshake(h);
  assert.equal(c.snapshot().status, "down");
  assert.equal(heard.at(-1), "down", `B's last word is the destroy's down (heard ${JSON.stringify(heard)})`);
  assert.equal(heard.includes("ready"), false, "B never hears the ready the destroy cut short");
  assert.equal(h.listening(), false);
});

// review r3 info 6: destroy() marks the client destroyed before its own leave("down"). Case b1: a "down" listener that
// destroys once leaves no retry timer (b3a35fa1 set one after the destroy). Case b2: a listener that destroys on every
// "down" hears down twice (the drop, then the destroy's own) and recurses no further (b3a35fa1 overflowed the stack).
test("a destroy from a down listener leaves no retry timer and does not recurse", async (t) => {
  const reported = [];
  t.mock.method(globalThis, "queueMicrotask", (f) => { try { f(); } catch (e) { reported.push(e); } });
  {
    const { h, c } = await readyClient();
    let once = false;
    c.subscribe((s) => { if (s.status === "down" && !once) { once = true; c.destroy(); } });
    const timers = t.mock.method(globalThis, "setTimeout");
    h.frame().fire("error");
    assert.equal(timers.mock.callCount(), 0, "b1: no timer is set after the destroy");
    timers.mock.restore();
    mock.timers.tick(60_000);
    assert.equal(h.frames.length, 1, "b1: no fresh iframe");
    assert.equal(h.listening(), false);
  }
  {
    const { h, c } = await readyClient();
    let calls = 0;
    c.subscribe((s) => { if (s.status === "down") { calls++; c.destroy(); } });
    h.frame().fire("error");
    assert.equal(calls, 2, "b2: the drop's down and the destroy's own, then no more");
    assert.equal(c.snapshot().status, "down");
    assert.equal(h.listening(), false);
  }
  assert.deepEqual(reported, [], "no listener threw: no stack overflow");
});

// delta review L2: the schema checks the request's own copy, never the caller's params; mutant k8 (check `params`) lived
// through every test at c88a3eeb. A getter that answers a bad list to the first read and a good one to the second is
// refused: the clone reads it once, and that bad copy is what is checked.
test("params are checked as the client's copy: a getter that answers bad then good is refused", () => {
  let n = 0;
  const params = { get order_ids() { return ++n === 1 ? ["o1", { forged: 1 }] : ["o1"]; } };
  assert.throws(() => C.signpageBuildRequest("orders.cancel", params, "id"), TypeError);
  assert.equal(n, 1, "the getter is read once, by the clone");
});

// delta review info: the client keeps no object from a message: its state is the frozen view's own
test("the client keeps no object from the message it read: a write into the posted state's object changes nothing", async () => {
  const { h, c } = await readyClient();
  const posted = { ...STATE, vault_balance: "8", orders: [] };
  h.post({ v: 1, type: "state", state: posted });
  const before = c.snapshot();
  posted.vault_balance = "999999";
  h.frame().fire("error"); // down: a change that keeps the state, so the next view is cloned from what the client kept
  assert.equal(c.snapshot().status, "down");
  assert.notEqual(c.snapshot(), before);
  assert.equal(c.snapshot().state.vault_balance, "8");
  assert.equal(before.state.vault_balance, "8");
});

// Card signpage-buy-route-events: a running pool.buy's route (messages.ts BuyRoute) comes as progress events with no
// stage, one fact each. A client reads them through onRoute; a client of an earlier kit (an older app) checks progress
// with exact keys, so it drops them and still reads every stage.
const W_ADDR = "85FNbDbCeiYFCcxnNrrH9xWCER4BYokxZf6Hyavuu37j";
const ROUTE = [
  { v: 1, type: "progress", id: "x", wallet: W_ADDR },
  { v: 1, type: "progress", id: "x", venue: "pump-curve", pool: W_ADDR },
  { v: 1, type: "progress", id: "x", out: "1234.5" },
];

test("route events reach onRoute by the buy's id, in order, never onProgress; a malformed one is dropped", async () => {
  const { h, c } = await readyClient();
  const routes = [];
  const stages = [];
  c.onRoute((id, r) => routes.push([id, r]));
  c.onProgress((id, stage) => stages.push([id, stage]));
  const state = unchanged(c);
  for (const m of ROUTE) h.post(m);
  h.post({ v: 1, type: "progress", id: "x", stage: "filled" });
  assert.deepEqual(routes, [["x", { wallet: W_ADDR }], ["x", { venue: "pump-curve", pool: W_ADDR }], ["x", { out: "1234.5" }]]);
  assert.deepEqual(stages, [["x", "filled"]]);
  // a stage and a route field in one event, two shapes in one, half a shape, an amount that is not a decimal, an extra
  // key, a fact with no id: each dropped, no listener called, the state the same object
  const d0 = c.dropped().shape;
  const bad = [
    { v: 1, type: "progress", id: "x", stage: "filled", out: "1" },
    { v: 1, type: "progress", id: "x", wallet: W_ADDR, out: "1" },
    { v: 1, type: "progress", id: "x", venue: "pump-curve" },
    { v: 1, type: "progress", id: "x", out: "-1" },
    { v: 1, type: "progress", id: "x", out: "1e9" },
    { v: 1, type: "progress", id: "x", wallet: W_ADDR, key: "00" },
    { v: 1, type: "progress", wallet: W_ADDR },
    { v: 1, type: "progress", id: "x", wallet: "" },
  ];
  for (const m of bad) h.post(m);
  assert.equal(c.dropped().shape, d0 + bad.length);
  assert.equal(routes.length, 3);
  assert.equal(stages.length, 1);
  state.check();
  // unsubscribed and destroyed: no more calls
  const off = c.onRoute(() => assert.fail("unsubscribed"));
  off();
  h.post(ROUTE[0]);
  assert.equal(routes.length, 4);
});

// fold 1 (L3): `out` an amount above 0 with no leading or trailing zero, at most 78 digits each side; W and the pool
// base58 addresses of 32 bytes; the venue a free string
test("route events: out, wallet and pool are checked as the kit's own shapes; the venue is a free string", async () => {
  const at = (x) => S.signpageProgressRouteSchema({ v: 1, type: "progress", id: "x", ...x });
  for (const out of ["1", "0.5", "1234.5", "10", "1".repeat(78), `0.${"0".repeat(77)}1`, `${"9".repeat(78)}.${"9".repeat(78)}`]) assert.equal(at({ out }), true, out);
  for (const out of ["0", "00", "01", "0.0", "1.50", "1.", ".5", "-1", "+1", "1e9", " 1", "1 ", "1".repeat(79), `0.${"0".repeat(78)}1`, "", 1, null]) assert.equal(at({ out }), false, String(out));
  const short = "1".repeat(31);
  const bytes31 = "2".repeat(43); // base58 that is not 32 bytes
  for (const wallet of ["W1", short, bytes31, "0".repeat(44), "O".repeat(44), "l".repeat(44), `${W_ADDR}x`, "", 1]) {
    assert.equal(at({ wallet }), false, String(wallet));
    assert.equal(at({ venue: "pump-curve", pool: wallet }), false, `pool ${wallet}`);
  }
  assert.equal(at({ wallet: W_ADDR }), true);
  assert.equal(at({ wallet: "11111111111111111111111111111111" }), true, "the system program is 32 zero bytes");
  for (const venue of ["pump-curve", "pumpswap", "Raydium", "a venue"]) assert.equal(at({ venue, pool: W_ADDR }), true, venue);
  assert.equal(at({ venue: "", pool: W_ADDR }), false);
  // the client drops each refused one: no listener called
  const { h, c } = await readyClient();
  const seen = [];
  c.onRoute((id, r) => seen.push(r));
  h.post({ v: 1, type: "progress", id: "x", out: "0" });
  h.post({ v: 1, type: "progress", id: "x", wallet: "W1" });
  h.post({ v: 1, type: "progress", id: "x", venue: "pump-curve", pool: short });
  assert.deepEqual(seen, []);
});

// card pool-buy-send-fast: the buy's transaction as a route fact, so a mainnet bundle that lands past the client's 10 s
// still names its transaction to the app: a base58 signature of exactly 64 bytes, nothing else
const SIG = "48Xv1SNVzuNDAaB6FXW5MNUjCMW5LArZdeqJahVeQ3DrsXzBSPQQxiNjiV2wvuF5v58AXjSECU5LHuYfKb4nNBEv";
test("route events: tx is a Solana signature, base58 of exactly 64 bytes; it reaches onRoute after the buy's answer timed out", async () => {
  const at = (x) => S.signpageProgressRouteSchema({ v: 1, type: "progress", id: "x", ...x });
  assert.equal(at({ tx: SIG }), true);
  assert.equal(at({ tx: "1".repeat(64) }), true, "64 zero bytes");
  for (const tx of [W_ADDR, "1".repeat(63), "z".repeat(88), `${SIG}x`, SIG.replace("4", "0"), SIG.replace("4", "l"), `0x${"ab".repeat(64)}`, "", 1, null, [SIG], { hash: SIG }])
    assert.equal(at({ tx }), false, String(tx));
  assert.equal(at({ tx: SIG, out: "1" }), false, "two shapes in one");
  assert.equal(S.signpageProgressSchema({ v: 1, type: "progress", id: "x", tx: SIG }), false, "an earlier kit's stage schema drops it");
  // the buy's answer dropped at the client's 10 s; its tx and its final stage still reach the app
  const { h, c } = await readyClient();
  const routes = [];
  const stages = [];
  c.onRoute((id, r) => routes.push([id, r]));
  c.onProgress((id, stage) => stages.push([id, stage]));
  const { id, p } = await open(h, c, "pool.buy");
  mock.timers.tick(C.SIGNPAGE_TIMEOUT_MS["pool.buy"]);
  assert.deepEqual(await p, TIMEOUT);
  h.post({ v: 1, type: "progress", id, tx: SIG });
  h.post({ v: 1, type: "progress", id, stage: "filled" });
  assert.deepEqual(routes, [[id, { tx: SIG }]]);
  assert.deepEqual(stages, [[id, "filled"]]);
  h.post({ v: 1, type: "progress", id: "x", tx: "z".repeat(88) });
  assert.equal(routes.length, 1, "a malformed one is dropped");
});

test("an app of an earlier kit drops every route event and still reads every stage around them", async () => {
  // the stage schema is the earlier kit's, exact keys: it refuses each route event and any stage event carrying a route field
  for (const m of ROUTE) assert.equal(S.signpageProgressSchema(m), false);
  assert.equal(S.signpageProgressSchema({ v: 1, type: "progress", id: "x", stage: "filled", wallet: W_ADDR }), false);
  assert.equal(S.signpageProgressSchema({ v: 1, type: "progress", id: "x", stage: "filled" }), true);
  const { h, c } = await readyClient();
  const stages = [];
  c.onProgress((id, stage) => stages.push([id, stage]));
  const state = unchanged(c);
  h.post({ v: 1, type: "progress", id: "x", stage: "signed" });
  for (const m of ROUTE) h.post(m);
  h.post({ v: 1, type: "progress", id: "x", stage: "filled" });
  assert.deepEqual(stages, [["x", "signed"], ["x", "filled"]]);
  state.check();
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
  const before = unchanged(c);
  h.post({ v: 1, type: "state", state: bigState(10_001) });
  const over = { ...bigState(9_000), held: Array.from({ length: 3_000 }, (_, i) => ({ id: `h${i}`, asset: "a".repeat(400), amount: "1" })) };
  assert.ok(bytes({ v: 1, type: "state", state: over }) > 4_194_304);
  h.post({ v: 1, type: "state", state: over });
  before.check();
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
    const before = unchanged(c);
    const d0 = c.dropped().shape;
    t0 = performance.now();
    h.post(msg);
    assert.ok(performance.now() - t0 < 10_000, `${name}: the client took over 10 s`);
    assert.equal(c.dropped().shape, d0 + 1, name);
    before.check(name);
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
    // the deposit sheet's reads (card kit-deposit-assets-dry): the helper's 1Click round trips, as deposit.quote
    "deposit.assets": 15_000, "deposit.dry": 15_000,
    // a pool's deposit address (card pool-deposit-address): the helper's 1Click round trip, as deposit.quote
    "pool.address": 15_000,
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

// card kit-oneclick-pins-frozen (review): a down or timed-out answer is the caller's own object; red before, when every
// caller got the module's one DOWN or TIMEOUT object and a write by one changed what the next one read
test("one caller's write into a down or timed-out answer never reaches another caller's answer", async () => {
  const poison = (o) => { o.ok = true; o.result = { forged: 1 }; delete o.error; };
  const a = await readyClient();
  const b = await readyClient();
  a.c.destroy();
  b.c.destroy();
  const first = await a.c.request("state", {}).outcome;
  poison(first);
  assert.deepEqual(await b.c.request("state", {}).outcome, DOWN, "another client's down answer");
  assert.deepEqual(await a.c.request("state", {}).outcome, DOWN, "the same client's next down answer");
  const t = await readyClient();
  const buy = await open(t.h, t.c, "buy");
  const restore = await open(t.h, t.c, "restore");
  t.c.retry();
  await flush();
  const timedOut = await buy.p;
  poison(timedOut);
  assert.deepEqual(await restore.p, TIMEOUT, "another request's timeout answer");
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

// ------------------------------------------------------------------------------------------------ card kit-deposit-calls
// Every stage a deposit can reach, and the facts the deposit sheet draws with it (apps/terminal/src/screens/deposit/
// model.ts DepositStatus), carried on the deposit op in state.ops (its id the deposit.quote request's id) and on
// deposit.confirm's answer. Each fact only on the stages it belongs to, so the app never draws a stage the device
// cannot have set.
const U = "a".repeat(64);
const DEPOSIT_STAGES = ["quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted", "failed", "short", "expired", "refund_move"];
const depositOp = (facts) => ({ id: "dq-1", kind: "deposit", txs: [], ...facts });
const withOp = (facts) => ({ ...STATE, ops: [depositOp(facts)] });
const GOOD_FACTS = [
  { stage: "waiting", since_ms: 1762400000000 },
  { stage: "failed", since_ms: 1762400000000 },
  { stage: "short", since_ms: 1762400000000 },
  { stage: "expired" },
  { stage: "refunded", held_id: U, since_ms: 1762400000000 },
  { stage: "refund_move", refunded: true, held_id: U, since_ms: 1762400000000 },
  { stage: "in_transit", refunded: true, since_ms: 1762400000000 },
  { stage: "into_vault", since_ms: 1762400000000 },
  { stage: "done", since_ms: 1762400000000, amount_usd: "73.18" },
  { stage: "done", refunded: true, amount_usd: "72.9" },
  { stage: "held", held_id: U },
  { stage: "halted", hold: "halted", held_id: U },
  { stage: "halted", hold: "not_caught_up" },
  { stage: "halted", hold: "vault_blocked", held_id: U, since_ms: 1762400000000 },
];
const BAD_FACTS = [
  [{ stage: "teleported" }, "a stage no deposit reaches"],
  [{ stage: "waiting", hold: "halted" }, "a hold reason on a stage that is not halted"],
  [{ stage: "halted", hold: "frozen" }, "a hold reason the kit does not name"],
  [{ stage: "in_transit", amount_usd: "1" }, "a credited amount before done"],
  [{ stage: "done", amount_usd: "1e3" }, "a credited amount that is not a decimal"],
  [{ stage: "waiting", held_id: U }, "a held id while the money is not held"],
  [{ stage: "quote_checked", since_ms: 1 }, "a send seen on a deposit nothing reached"],
  [{ stage: "expired", since_ms: 1 }, "a send seen on an address that expired with nothing sent"],
  [{ stage: "waiting", refunded: true }, "a refund before the deposit was processed"],
  [{ stage: "done", since_ms: -1 }, "a negative time"],
  [{ stage: "done", refunded: "yes" }, "a refunded flag that is not a boolean"],
  [{ stage: "done", note: "x" }, "a field the deposit op does not have"],
];

test("kit-deposit-calls: the kit names every stage a deposit can reach and the three hold reasons", () => {
  assert.deepEqual([...MSG.DEPOSIT_STAGES], DEPOSIT_STAGES);
  assert.deepEqual([...MSG.DEPOSIT_HOLDS], ["halted", "not_caught_up", "vault_blocked"]);
  assert.ok(Object.isFrozen(MSG.DEPOSIT_STAGES) && Object.isFrozen(MSG.DEPOSIT_HOLDS));
});

test("kit-deposit-calls: a deposit op at every stage, with its facts, reaches the app in a state event; a fact on the wrong stage is dropped", async () => {
  for (const facts of [...DEPOSIT_STAGES.map((stage) => ({ stage })), ...GOOD_FACTS]) {
    const { h, c } = await readyClient();
    h.post({ v: 1, type: "state", state: withOp(facts) });
    assert.deepEqual(c.snapshot().state.ops, [depositOp(facts)], JSON.stringify(facts));
  }
  // the op is dropped and the rest of the state kept (card kit-frame-version)
  for (const [facts, why] of BAD_FACTS) {
    const { h, c } = await readyClient();
    h.post({ v: 1, type: "state", state: { ...withOp(facts), vault_balance: "7" } });
    assert.deepEqual(c.snapshot().state, { ...STATE, vault_balance: "7", ops: [] }, `the op dropped: ${why}`);
  }
  // the facts are the deposit's own: a buy op carrying one is dropped
  const { h, c } = await readyClient();
  h.post({ v: 1, type: "state", state: { ...STATE, vault_balance: "7", ops: [{ id: "b1", kind: "buy", stage: "filled", txs: [], since_ms: 1 }] } });
  assert.deepEqual(c.snapshot().state, { ...STATE, vault_balance: "7", ops: [] }, "a buy op with since_ms is dropped");
});

test("kit-deposit-calls: a running deposit's progress names its new stages", async () => {
  const { h, c } = await readyClient();
  const seen = [];
  c.onProgress((id, stage) => seen.push(stage));
  for (const stage of ["failed", "short", "expired", "refund_move"]) h.post({ v: 1, type: "progress", id: "dq-1", stage });
  assert.deepEqual(seen, ["failed", "short", "expired", "refund_move"]);
});

test("kit-deposit-calls: deposit.confirm answers the stage with its facts through the frame; a fact on the wrong stage leaves the request open", async () => {
  for (const facts of GOOD_FACTS) {
    const { h, c } = await readyClient();
    const r = await open(h, c, "deposit.confirm");
    h.post(answer(r.id, facts));
    await flush();
    assert.equal(r.settled(), true, `answered: ${JSON.stringify(facts)}`);
    assert.deepEqual(await r.p, { ok: true, result: facts }, JSON.stringify(facts));
  }
  for (const [facts, why] of BAD_FACTS) {
    const { h, c } = await readyClient();
    const r = await open(h, c, "deposit.confirm");
    h.post(answer(r.id, facts));
    await flush();
    assert.equal(r.settled(), false, `left open: ${why}`);
  }
});

// ------------------------------------------------------------------------------------------------ card kit-frame-version
const HELLO = { v: 1, type: "hello", kit: MSG.SIGNPAGE_KIT_VERSION };

test("kit-frame-version: the kit names its version in a hello to SIGN_HOST's origin, just before each handshake state request", async () => {
  assert.equal(MSG.SIGNPAGE_KIT_VERSION, "1.5");
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  await flush();
  assert.deepEqual(h.log(), [], "nothing before the ready");
  h.post(READY);
  await flush();
  assert.deepEqual(h.log().map((s) => [s.msg.type, s.origin]), [["hello", ORIGIN], ["state", ORIGIN]]);
  assert.deepEqual(h.log()[0].msg, HELLO, "exactly v, type and kit: no id, so the page answers nothing");
  h.post(answer(h.sent()[0].msg.id, STATE));
  await flush();
  assert.equal(c.snapshot().status, "ready");
  // a ready again (the page started again): the hello again, then the state
  const n = h.log().length;
  h.post(READY);
  await flush();
  assert.deepEqual(h.log().slice(n).map((s) => s.msg.type), ["hello", "state"]);
  // a fresh iframe: its own hello before its state
  c.retry();
  h.post(READY);
  await flush();
  assert.deepEqual(h.frame().contentWindow.log.map((s) => s.msg.type), ["hello", "state"]);
});

test("kit-frame-version: a state with one op this kit cannot read keeps the rest; the answer and the event alike", async () => {
  const later = { id: "dq-9", kind: "deposit", stage: "teleported", txs: [] };
  const other = { id: "zz", kind: "lend", stage: "done", txs: [] };
  const good = depositOp({ stage: "done", amount_usd: "1" });
  const s = { ...STATE, vault_balance: "3", ops: [good, later, other] };
  // the handshake's answer
  const h = makeHost();
  const c = C.createSignpageClient({ url: URL_, host: h.host });
  h.post(READY);
  await flush();
  h.post(answer(h.sent()[0].msg.id, s));
  await flush();
  assert.equal(c.snapshot().status, "ready", "READY on a state with an op it cannot read");
  assert.deepEqual(c.snapshot().state, { ...s, ops: [good] });
  // an event
  h.post({ v: 1, type: "state", state: { ...s, vault_balance: "4", ops: [later, good, later] } });
  assert.deepEqual(c.snapshot().state, { ...s, vault_balance: "4", ops: [good] });
  // a state request's answer
  const r = await open(h, c, "state");
  h.post(answer(r.id, { ...s, ops: [other] }));
  assert.deepEqual(await r.p, { ok: true, result: { ...s, ops: [] } });
  // the rest is still checked whole: an unknown field, or ops that are not an array, refuses the state
  const before = unchanged(c);
  for (const bad of [{ ...s, teleport: 1 }, { ...s, ops: { 0: good } }, { ...s, ops: [good], vault_balance: "x" }]) {
    h.post({ v: 1, type: "state", state: bad });
    before.check(JSON.stringify(bad));
  }
});
