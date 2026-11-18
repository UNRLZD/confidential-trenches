// node --test apps/helper/test/servers.test.ts (card helper-test-servers-never-hang): the shared wait on a test server's
// start and the shared call to it each end inside their bound, naming what they waited on. Red before: a wait on the
// 'listening' event alone, and a request with no bound, never end on these (the runner's timeout below ends them late,
// with no name); on 18 Nov such a wait hung the helper suite 71 min at 0% CPU.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { call, listening, opened, type Timer } from "./servers.ts";

/** A timer the test fires itself: what each wait asked for, and `fire` to end the bound now. */
function heldTimer() {
  const asked: number[] = [];
  let fire: (() => void) | undefined;
  const timer: Timer = (ms, f) => {
    asked.push(ms);
    fire = f;
    return () => (fire = undefined);
  };
  return { timer, asked, fire: () => fire?.() };
}
const close = (s: Server) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok())));
const BACKSTOP = { timeout: 5_000 }; // the runner's own hang bound, so a red run ends

test("a server that never listens fails inside the bound and names itself", BACKSTOP, async () => {
  const t = heldTimer();
  const wait = listening(createServer(), "the unstarted server", { ms: 50, timer: t.timer });
  t.fire();
  await assert.rejects(wait, { message: "the unstarted server was not listening within 50 ms" });
  assert.deepEqual(t.asked, [50]);
});

test("a server that said 'listening' before the wait began is taken at once, never waited on again", BACKSTOP, async () => {
  const s = createServer().listen(0, "127.0.0.1");
  await new Promise<void>((ok) => s.once("listening", () => setImmediate(ok)));
  try {
    const t = heldTimer();
    assert.equal(await listening(s, "the early server", { timer: t.timer }), (s.address() as AddressInfo).port);
    assert.deepEqual(t.asked, [], "no bound was set: the server's own state answered");
  } finally {
    await close(s);
  }
});

test("a server that starts after the wait began is taken on its event, and the bound is cleared", BACKSTOP, async () => {
  const s = createServer();
  const t = heldTimer();
  const wait = listening(s, "the late server", { timer: t.timer });
  s.listen(0, "127.0.0.1");
  try {
    assert.equal(await wait, (s.address() as AddressInfo).port);
    t.fire(); // a cleared bound fires nothing
    assert.deepEqual(t.asked, [30_000]);
  } finally {
    await close(s);
  }
});

test("a server that cannot listen fails at once with its name and the reason", BACKSTOP, async () => {
  const held = createServer().listen(0, "127.0.0.1");
  const port = await listening(held, "the holder");
  const s = createServer().listen(port, "127.0.0.1");
  try {
    await assert.rejects(listening(s, "the second server", { timer: heldTimer().timer }), (e: Error) => {
      assert.match(e.message, /^the second server did not start: listen EADDRINUSE/);
      return true;
    });
  } finally {
    await close(held);
  }
});

test("a stalled handler fails the call inside the bound, names it, and drops the connection", BACKSTOP, async () => {
  let closed!: () => void;
  const gone = new Promise<void>((ok) => (closed = ok));
  const s = createServer((req) => req.socket.on("close", closed)).listen(0, "127.0.0.1");
  const port = await listening(s, "the stalled server");
  try {
    const t = heldTimer();
    const answer = call(port, { path: "/v1/market/token?chain=base" }, "the stalled server", { ms: 50, timer: t.timer });
    await new Promise((ok) => s.once("request", ok));
    t.fire();
    await assert.rejects(answer, { message: "GET /v1/market/token?chain=base on the stalled server: no answer within 50 ms" });
    await gone;
  } finally {
    await close(s);
  }
});

test("a handler that sends its head and stalls the body still fails inside the bound: the bound is the whole answer's", BACKSTOP, async () => {
  const s = createServer((_req, res) => res.writeHead(200).write("a")).listen(0, "127.0.0.1");
  const port = await listening(s, "the half server");
  try {
    const t = heldTimer();
    const answer = call(port, { method: "POST", path: "/v1/bind", body: "{}" }, "the half server", { ms: 50, timer: t.timer });
    await new Promise((ok) => s.once("request", ok));
    await new Promise((ok) => setImmediate(ok));
    t.fire();
    await assert.rejects(answer, { message: "POST /v1/bind on the half server: no answer within 50 ms" });
  } finally {
    await close(s);
  }
});

test("a call that is answered gives the status, the headers and the body, and clears its bound", BACKSTOP, async () => {
  const s = createServer((req, res) => {
    let b = "";
    req.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => res.writeHead(201, { "x-seen": `${req.method} ${req.headers["x-k"]}` }).end(`got ${b}`));
  }).listen(0, "127.0.0.1");
  const port = await listening(s, "the echo");
  try {
    const t = heldTimer();
    const r = await call(port, { method: "POST", path: "/e", headers: { "x-k": "v" }, body: "hi" }, "the echo", { timer: t.timer });
    assert.equal(r.status, 201);
    assert.equal(r.headers["x-seen"], "POST v");
    assert.equal(r.body, "got hi");
    assert.deepEqual(r.raw, Buffer.from("got hi"));
    assert.deepEqual(t.asked, [30_000]);
    t.fire(); // cleared: nothing to end
  } finally {
    await close(s);
  }
});

test("a refused connection fails at once, naming the call", BACKSTOP, async () => {
  const s = createServer().listen(0, "127.0.0.1");
  const port = await listening(s, "the gone server");
  await close(s);
  await assert.rejects(call(port, { path: "/x" }, "the gone server", { timer: heldTimer().timer }), (e: Error) => {
    assert.match(e.message, /^GET \/x on the gone server: connect ECONNREFUSED/);
    return true;
  });
});

test("a test that mocks setTimeout cannot hold the bound: it runs on the timer read at import", BACKSTOP, async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  try {
    await assert.rejects(listening(createServer(), "the unstarted server", { ms: 20 }), { message: "the unstarted server was not listening within 20 ms" });
  } finally {
    resetTimers(t.mock.timers);
  }
});

test("a stalled WebSocket handshake fails inside the bound and names it", BACKSTOP, async () => {
  const s = createServer().listen(0, "127.0.0.1");
  const taken: Duplex[] = [];
  s.on("upgrade", (_req, socket: Duplex) => taken.push(socket)); // takes the upgrade, never answers it
  const port = await listening(s, "the stalled push server");
  try {
    const t = heldTimer();
    const handshake = opened(port, { path: "/v1/market/push" }, "the stalled push server", { ms: 50, timer: t.timer });
    await new Promise((ok) => s.once("upgrade", ok));
    t.fire();
    await assert.rejects(handshake, { message: "/v1/market/push upgrade on the stalled push server: no answer within 50 ms" });
  } finally {
    for (const k of taken) k.destroy(); // an upgraded socket is the taker's: the server's close does not end it
    await close(s);
  }
});

test("a handshake answered 101 hands over the socket and the bytes past the head; one refused gives its status", BACKSTOP, async () => {
  const s = createServer((_req, res) => res.writeHead(404).end("no")).listen(0, "127.0.0.1");
  s.on("upgrade", (_req, socket) => socket.end(Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"), Buffer.from([0x81, 0x01, 0x61])])));
  const port = await listening(s, "the push server");
  try {
    const t = heldTimer();
    const up = await opened(port, { path: "/v1/market/push", headers: { Origin: "https://app.test" } }, "the push server", { timer: t.timer });
    assert.equal(up.status, 101);
    assert.ok(up.socket !== undefined && up.head !== undefined);
    let got = up.head; // the frame's bytes: in the head, or on the socket next when TCP split them
    while (got.length < 3) got = Buffer.concat([got, await new Promise<Buffer>((ok) => up.socket!.once("data", ok))]);
    up.socket.destroy();
    assert.deepEqual([...got], [0x81, 0x01, 0x61]);
    t.fire(); // cleared: nothing to end
    const plain = createServer((_req, res) => res.writeHead(404).end("no")).listen(0, "127.0.0.1");
    try {
      assert.equal((await opened(await listening(plain, "the plain server"), { path: "/v1/health" }, "the plain server")).status, 404);
    } finally {
      await close(plain);
    }
  } finally {
    await close(s);
  }
});
