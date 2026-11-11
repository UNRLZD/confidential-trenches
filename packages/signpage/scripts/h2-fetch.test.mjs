// Card sol-buy-reads-side-by-side: the devnet scripts read their RPCs as a browser does, the reads sent at once on one
// HTTP/2 connection per origin (scripts/h2-fetch.mjs), not Node's HTTP/1.1 fetch with a TLS socket per read, whose
// handshakes made the helper's answers look one after another (runs 1 and 2 of card pool-buy-filled-2s).
import assert from "node:assert/strict";
import http2 from "node:http2";
import { test } from "node:test";
import { h2Fetch } from "./h2-fetch.mjs";

const server = async (hold = 0) => {
  const sessions = new Set();
  const s = http2.createServer();
  s.on("session", (x) => sessions.add(x));
  s.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (d) => (body += d));
    stream.on("end", () =>
      setTimeout(() => {
        if (stream.destroyed || stream.closed) return; // the read was aborted
        stream.respond({ ":status": headers[":path"] === "/busy" ? 429 : 200, "content-type": "application/json", "retry-after": "1" });
        stream.end(JSON.stringify({ path: headers[":path"], method: headers[":method"], type: headers["content-type"], body }));
      }, hold),
    );
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  return { origin: `http://127.0.0.1:${s.address().port}`, sessions, close: () => new Promise((ok) => s.close(ok)) };
};

test("six reads sent at once go on one HTTP/2 connection, side by side, each with its own answer", async () => {
  const s = await server(50);
  const f = h2Fetch();
  try {
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => f(`${s.origin}/v1/rpc/x`, { method: "POST", headers: { "content-type": "application/json" }, body: `{"id":${i}}` })));
    assert.equal(s.sessions.size, 1, "one connection");
    for (const [i, r] of rs.entries()) {
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { path: "/v1/rpc/x", method: "POST", type: "application/json", body: `{"id":${i}}` });
    }
  } finally {
    f.close();
    await s.close();
  }
});

test("a status and its headers are the server's (a 429 with its Retry-After); an aborted read rejects", async () => {
  const s = await server(200);
  const f = h2Fetch();
  try {
    const r = await f(`${s.origin}/busy`, { method: "POST", body: "{}" });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "1");
    await assert.rejects(f(`${s.origin}/x`, { method: "POST", body: "{}", signal: AbortSignal.timeout(20) }));
  } finally {
    f.close();
    await s.close();
  }
});
