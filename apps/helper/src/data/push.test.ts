// The live push channel's Origin rule (card market-data-push): the helper's push socket, GET /v1/market/push upgraded
// to a WebSocket, sends updates to APP_HOST's Origin only. Every other Origin, SIGN_HOST, a foreign one, "*", "null",
// one that differs by case or a slash, and no Origin at all, is answered 403 before the handshake, with no read made.
// The client below is a bare RFC 6455 upgrade over node:http, so the test runs against any helper, this one's base too.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";
import { HELPER_CORS } from "@blindfill/kit";
import { start } from "../server.ts";

const COMMIT = "a".repeat(40);
const APP = "https://ct-app.unrealized.trade";
const SIGN = "https://confidential.unrealized.trade";
const MINT = "So11111111111111111111111111111111111111112";

type Upgrade = { status: number; headers: Record<string, unknown>; frame?: string; socket?: Socket };

/** One WebSocket upgrade of `path` with `origin` (none when undefined): its status, and on a 101 its first text frame. */
function upgrade(port: number, path: string, origin: string | undefined, waitMs = 3_000): Promise<Upgrade> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") };
    if (origin !== undefined) headers.Origin = origin;
    const req = request({ host: "127.0.0.1", port, path, headers });
    req.on("error", fail);
    req.on("response", (res) => {
      res.resume();
      ok({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on("upgrade", (res, socket, head) => {
      let buf = head;
      const timer = setTimeout(() => (socket.destroy(), ok({ status: 101, headers: res.headers, socket })), waitMs);
      const read = () => {
        // a server frame is unmasked: FIN+text, then a 7-bit, 16-bit or 64-bit length
        if (buf.length < 2) return;
        let len = buf[1]! & 0x7f;
        let at = 2;
        if (len === 126) [len, at] = [buf.length < 4 ? -1 : buf.readUInt16BE(2), 4];
        else if (len === 127) [len, at] = [buf.length < 10 ? -1 : Number(buf.readBigUInt64BE(2)), 10];
        if (len < 0 || buf.length < at + len) return;
        clearTimeout(timer);
        socket.destroy();
        ok({ status: 101, headers: res.headers, frame: buf.subarray(at, at + len).toString("utf8"), socket });
      };
      socket.on("data", (d: Buffer) => ((buf = Buffer.concat([buf, d])), read()));
      read();
    });
    req.end();
  });
}

const TAPE = (n: number) => JSON.stringify({ trades: Array.from({ length: n }, (_, i) => ({ t_ms: 1_000 + i, side: "buy", usd: "1.5", amt: "2", trader: null, tx: `tx${i}` })), src: "chain", as_of_ms: 5 });

function helper(reads: string[]): { server: Server; port: () => number; tape: { n: number } } {
  const tape = { n: 1 };
  const trades = async (token: string, limit: number) => (reads.push(token), token === MINT && limit >= 1 ? { status: 200, body: TAPE(tape.n), src: "chain", asOfMs: 5 } : { status: 404, body: JSON.stringify({ error: { code: "not_found" } }) });
  const swaps = { solana: { trades } } as never;
  const server = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, swaps);
  return { server, port: () => (server.address() as AddressInfo).port, tape };
}

const listening = (s: Server) => new Promise<void>((ok) => (s.listening ? ok() : s.once("listening", () => ok())));
const PATH = `/v1/market/push?chain=solana&token=${MINT}`;

test("APP_HOST's Origin is upgraded and receives the token's tape as its first update", async (t) => {
  const reads: string[] = [];
  const h = helper(reads);
  t.after(() => h.server.close());
  await listening(h.server);
  const r = await upgrade(h.port(), PATH, APP);
  assert.equal(r.status, 101, "APP_HOST's upgrade is accepted");
  assert.ok(r.frame !== undefined, "APP_HOST receives an update");
  assert.deepEqual(JSON.parse(r.frame!).trades.length, 1);
  assert.equal(r.headers["access-control-allow-origin"], undefined, "an upgrade answer carries no CORS allow header");
});

test("every Origin but APP_HOST's, and no Origin, is refused 403 before the handshake and makes no read", async (t) => {
  const reads: string[] = [];
  const h = helper(reads);
  t.after(() => h.server.close());
  await listening(h.server);
  assert.ok(HELPER_CORS.origins.includes(SIGN), "SIGN_HOST is a CORS origin, so the push rule is narrower than CORS");
  for (const origin of [SIGN, "https://example.com", "*", "null", "", APP.toUpperCase(), `${APP}/`, `${APP}:443`, "http://ct-app.unrealized.trade", `${APP}.example.com`, undefined]) {
    const r = await upgrade(h.port(), PATH, origin);
    assert.equal(r.status, 403, `Origin ${JSON.stringify(origin)} is refused`);
    assert.equal(r.frame, undefined, `Origin ${JSON.stringify(origin)} receives no update`);
    assert.equal(r.headers["x-helper-commit"], COMMIT, "the refusal carries X-Helper-Commit, as every answer");
    assert.equal(r.headers["access-control-allow-origin"], undefined, "never an allow header, never *");
  }
  assert.deepEqual(reads, [], "a refused Origin makes the helper read nothing");
});

test("APP_HOST's socket is pushed each change of the tape, and nothing when it does not change", async (t) => {
  const reads: string[] = [];
  const h = helper(reads);
  t.after(() => h.server.close());
  await listening(h.server);
  const frames: string[] = [];
  const done = new Promise<void>((ok) => {
    const req = request({ host: "127.0.0.1", port: h.port(), path: PATH, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Origin: APP } });
    req.on("upgrade", (_res, socket, head) => {
      let buf = head;
      const take = () => {
        while (buf.length >= 2) {
          let len = buf[1]! & 0x7f;
          let at = 2;
          if (len === 126) [len, at] = [buf.length < 4 ? Infinity : buf.readUInt16BE(2), 4];
          if (buf.length < at + len) return;
          if ((buf[0]! & 0x0f) === 1) frames.push(buf.subarray(at, at + len).toString("utf8"));
          buf = buf.subarray(at + len);
        }
      };
      socket.on("data", (d: Buffer) => ((buf = Buffer.concat([buf, d])), take()));
      take();
      setTimeout(() => (h.tape.n = 2), 700);
      setTimeout(() => (socket.destroy(), ok()), 2_200);
    });
    req.end();
  });
  await done;
  assert.deepEqual(frames.map((f) => JSON.parse(f).trades.length), [1, 2], "the first tape, then one update for the one change");
});

test("an upgrade off the push path, or a token the reads do not know, is not upgraded", async (t) => {
  const h = helper([]);
  t.after(() => h.server.close());
  await listening(h.server);
  assert.equal((await upgrade(h.port(), "/v1/health", APP)).status, 404);
  assert.equal((await upgrade(h.port(), "/v1/market/push?chain=solana&token=nope", APP)).status, 404);
  assert.equal((await upgrade(h.port(), `/v1/market/push?chain=ethereum&token=${MINT}`, APP)).status, 404);
  assert.equal((await upgrade(h.port(), `/v1/market/push?chain=solana&chain=solana&token=${MINT}`, APP)).status, 404);
});

/** An APP_HOST socket held open: its handshake status, and a promise of the close code the server sends (0: none). */
function hold(port: number): Promise<{ status: number; closed: Promise<number>; end: () => void }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: PATH, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Origin: APP } });
    req.on("error", fail);
    req.on("response", (res) => (res.resume(), ok({ status: res.statusCode ?? 0, closed: Promise.resolve(0), end: () => undefined })));
    req.on("upgrade", (_res, socket) => {
      let buf = Buffer.alloc(0);
      const closed = new Promise<number>((done) => {
        socket.on("data", (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          // walk the frames for a close (opcode 8), whose first two payload bytes are its code
          let at = 0;
          while (buf.length - at >= 2) {
            const len = buf[at + 1]! & 0x7f;
            const hdr = len === 126 ? 4 : 2;
            const size = len === 126 ? (buf.length - at < 4 ? Infinity : buf.readUInt16BE(at + 2)) : len;
            if (buf.length - at < hdr + size) break;
            if ((buf[at]! & 0x0f) === 8) return done(buf.readUInt16BE(at + hdr));
            at += hdr + size;
          }
        });
        socket.on("close", () => done(0));
      });
      ok({ status: 101, closed, end: () => socket.destroy() });
    });
    req.end();
  });
}

test("one client holds at most PUSH_CLIENT_MAX sockets; the next is refused 503 and one closed frees its place", async (t) => {
  const { PUSH_CLIENT_MAX } = await import("./push.ts");
  const h = helper([]);
  t.after(() => h.server.close());
  await listening(h.server);
  const held = [];
  for (let i = 0; i < PUSH_CLIENT_MAX; i++) held.push(await hold(h.port()));
  assert.deepEqual(held.map((x) => x.status), Array(PUSH_CLIENT_MAX).fill(101));
  assert.equal((await hold(h.port())).status, 503, "one past the client's sockets");
  held.pop()!.end();
  await new Promise((ok) => setTimeout(ok, 100));
  const again = await hold(h.port());
  assert.equal(again.status, 101, "a closed socket frees its place");
  again.end();
  for (const x of held) x.end();
});

test("a stop's drain tells every push socket the helper goes away (1001)", async (t) => {
  const { drainer } = await import("../server.ts");
  const h = helper([]);
  t.after(() => h.server.close());
  await listening(h.server);
  const s = await hold(h.port());
  assert.equal(s.status, 101);
  drainer(h.server)();
  assert.equal(await s.closed, 1001);
});

// A peer's message pieces (card helper-ws-fragment-flood). ws before 8.21.0 holds every fragment of an unfinished
// message and every data chunk of an unfinished frame, up to maxPayload (ws 8.21.0 release notes, fix 2b2abd45: a
// flood of tiny fragments and chunks exhausts a server's memory). The client below writes client frames by hand: FIN,
// the opcode, a set mask bit with a zero key (so the payload is sent as is), a 7-bit or 16-bit length.
const frame = (fin: boolean, op: number, payload: Buffer): Buffer => {
  const len = payload.length < 126 ? Buffer.from([payload.length | 0x80]) : Buffer.from([126 | 0x80, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op]), len, Buffer.alloc(4), payload]);
};
const PING = frame(true, 0x9, Buffer.alloc(0));

/** An APP_HOST socket that `feed` writes to; resolves with the server's close code, "pong" when the server answered the
 *  last ping (so it took every byte before it and is still open), or "cut" when the connection ended with neither. */
function attack(port: number, feed: (socket: Socket, closed: () => boolean) => Promise<void>): Promise<number | "pong" | "cut"> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: PATH, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Origin: APP } });
    req.on("error", fail);
    req.on("response", (res) => fail(new Error(`not upgraded: ${res.statusCode}`)));
    req.on("upgrade", (_res, socket: Socket, head) => {
      let buf = head;
      let end: number | "pong" | "cut" | null = null;
      const done = (v: number | "pong" | "cut") => {
        if (end !== null) return;
        end = v;
        socket.destroy();
        ok(v);
      };
      socket.setNoDelay(true);
      socket.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1]! & 0x7f;
          let at = 2;
          if (len === 126) [len, at] = [buf.length < 4 ? Infinity : buf.readUInt16BE(2), 4];
          if (buf.length < at + len) return;
          const op = buf[0]! & 0x0f;
          if (op === 0x8) return done(buf.readUInt16BE(at));
          if (op === 0xa) return done("pong");
          buf = buf.subarray(at + len);
        }
      });
      socket.on("error", () => done("cut"));
      socket.on("close", () => done("cut"));
      void feed(socket, () => end !== null).then(() => end === null && socket.write(PING));
    });
    req.end();
  });
}

test("a message in more fragments than PUSH_IN_FRAGMENTS is closed 1008; before, all PUSH_IN_MAX were held", async (t) => {
  const h = helper([]);
  t.after(() => h.server.close());
  await listening(h.server);
  const { PUSH_IN_MAX } = await import("./push.ts");
  // one unfinished binary message of PUSH_IN_MAX one-byte fragments, the most maxPayload lets a message carry, then a ping
  const pieces = [frame(false, 0x2, Buffer.from([0]))];
  for (let i = 1; i < PUSH_IN_MAX; i++) pieces.push(frame(false, 0x0, Buffer.from([0])));
  const end = await attack(h.port(), async (s) => void s.write(Buffer.concat(pieces)));
  assert.equal(end, 1008, `the server answered ${end}: "pong" means it held all ${PUSH_IN_MAX} fragments and stayed open`);
});

test("a frame sent in more data chunks than PUSH_IN_CHUNKS is closed 1008; before, all PUSH_IN_MAX were held", async (t) => {
  const h = helper([]);
  t.after(() => h.server.close());
  await listening(h.server);
  const { PUSH_IN_MAX } = await import("./push.ts");
  // a binary frame of PUSH_IN_MAX bytes, its header in one write and its payload one byte a write, each read on its own
  // (the server's read of each byte comes before the next write: setImmediate runs after the loop's I/O poll)
  const header = frame(true, 0x2, Buffer.alloc(PUSH_IN_MAX)).subarray(0, 8);
  const end = await attack(h.port(), async (s, closed) => {
    s.write(header);
    for (let i = 0; i < PUSH_IN_MAX && !closed(); i++) {
      await new Promise((go) => setImmediate(go));
      if (!s.destroyed) s.write(Buffer.from([0]));
    }
    await new Promise((go) => setImmediate(go));
  });
  assert.equal(end, 1008, `the server answered ${end}: "pong" means it held all ${PUSH_IN_MAX} chunks and stayed open`);
});

test("a message within the bounds, and the pongs, keep the socket open and pushed to", async (t) => {
  const h = helper([]);
  t.after(() => h.server.close());
  await listening(h.server);
  const { PUSH_IN_FRAGMENTS, PUSH_IN_CHUNKS, PUSH_IN_MAX } = await import("./push.ts");
  assert.ok(Number.isSafeInteger(PUSH_IN_FRAGMENTS) && PUSH_IN_FRAGMENTS >= 2 && PUSH_IN_FRAGMENTS < PUSH_IN_MAX, "PUSH_IN_FRAGMENTS is a bound below what maxPayload alone allows");
  assert.ok(Number.isSafeInteger(PUSH_IN_CHUNKS) && PUSH_IN_CHUNKS >= 2 && PUSH_IN_CHUNKS < PUSH_IN_MAX, "PUSH_IN_CHUNKS is a bound below what maxPayload alone allows");
  // PUSH_IN_FRAGMENTS fragments of one text message, the last FIN, then a ping: answered, the socket open
  const pieces = [frame(false, 0x1, Buffer.from("{"))];
  for (let i = 1; i < PUSH_IN_FRAGMENTS; i++) pieces.push(frame(i === PUSH_IN_FRAGMENTS - 1, 0x0, Buffer.from(i === PUSH_IN_FRAGMENTS - 1 ? "}" : " ")));
  assert.equal(await attack(h.port(), async (s) => void s.write(Buffer.concat(pieces))), "pong");
  // the largest message taken, PUSH_IN_MAX bytes in one frame, in two writes as two TCP segments carry it
  const big = frame(true, 0x2, Buffer.alloc(PUSH_IN_MAX));
  assert.equal(await attack(h.port(), async (s) => {
    s.write(big.subarray(0, 536));
    await new Promise((go) => setImmediate(go));
    s.write(big.subarray(536));
  }), "pong");
  // a subscriber is still sent the tape
  assert.ok((await upgrade(h.port(), PATH, APP)).frame !== undefined, "APP_HOST still receives an update");
});

test("a plain GET of the push path, with no upgrade, is answered 426 and reads nothing", async (t) => {
  const reads: string[] = [];
  const h = helper(reads);
  t.after(() => h.server.close());
  await listening(h.server);
  const r = await fetch(`http://127.0.0.1:${h.port()}${PATH}`, { headers: { origin: APP } });
  assert.equal(r.status, 426);
  assert.equal(r.headers.get("upgrade"), "websocket");
  assert.deepEqual(reads, []);
});
