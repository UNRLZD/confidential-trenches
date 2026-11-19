// node --test scripts/live-checks/helper-answers-through-a-burst.test.mjs: the live check replays recorded answers
// (helper-answers-through-a-burst.answers.json), each the check run against a copy of the helper behind Caddy on the
// real Caddyfile while apps/helper/deploy/burst.mjs opened 300 pages at once (apps/helper/deploy/burst-proof.sh, on the
// test box). good: the card's helper: PASS. bad_main: main 0092e5692 the same way: FAIL. Each other bad answer plants one
// fault in the good one (a 502, an answer with no CORS header, one unanswered, a p99 past the bound, a page short, a
// push socket refused, unanswered or missing): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP, judge, P99_MAX_MS, PAGES, pagePaths, PUSH, read, READS, SOCKETS, upgrade } from "./helper-answers-through-a-burst.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-answers-through-a-burst.answers.json"), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("recorded good answer (the card's helper through a 300-page burst): PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer (main 0092e5692 through the same burst): FAIL", () => {
  const v = judge(A.bad_main);
  assert.equal(v.ok, false, v.lines.join("\n"));
});

test("the good answer with one fault planted: FAIL", () => {
  const plant = {
    "a 502": (r) => Object.assign(r.answers[3], { status: 502, cors: null }),
    "a push socket answered 502": (r) => Object.assign(r.answers.find((a) => a.route === PUSH), { status: 502 }),
    "a push socket with no answer": (r) => Object.assign(r.answers.find((a) => a.route === PUSH), { status: null, error: "timeout" }),
    "a socket short": (r) => r.answers.splice(r.answers.findIndex((a) => a.route === PUSH), 1),
    "a 200 with no CORS header": (r) => Object.assign(r.answers[0], { cors: null }),
    "a 503 with no CORS header": (r) => Object.assign(r.answers[0], { status: 503, cors: null }),
    "a CORS header for another origin": (r) => Object.assign(r.answers[1], { cors: "https://evil.example" }),
    "one unanswered": (r) => Object.assign(r.answers[5], { status: null, error: "ConnectTimeoutError" }),
    "a p99 past the bound": (r) => r.answers.forEach((a, i) => i % 50 === 0 && (a.ms = P99_MAX_MS + 1)),
    "a page short": (r) => r.answers.splice(0, READS),
    "a 503 with no CORS header, not a socket": (r) => Object.assign(r.answers.find((a) => a.route !== PUSH), { status: 503, cors: null }),
    "no coin read": (r) => ((r.coin = null), (r.answers = [])),
  };
  for (const [name, f] of Object.entries(plant)) {
    const r = copy(A.good);
    f(r);
    assert.equal(judge(r).ok, false, name);
  }
});

test("the check sends PAGES pages of the first screen's reads and SOCKETS push sockets at once, with Origin APP_HOST, for the coin the Solana lists name first", async () => {
  const coin = A.good.coin;
  const seen = [];
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.origin, APP);
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    if (seen.length === 1) return new Response(JSON.stringify({ lists: { trending: [{ token: coin }] } }), { status: 200, headers: { "access-control-allow-origin": APP } });
    return new Response("{}", { status: 200, headers: { "access-control-allow-origin": APP } });
  };
  const opened = [];
  const upgradeFn = async (base, c) => (opened.push([base, c]), { route: PUSH, status: 101, ms: 0 });
  const got = await read("https://ct-api.unrealized.trade", fetchFn, () => 0, upgradeFn);
  assert.deepEqual(opened, Array.from({ length: SOCKETS }, () => ["https://ct-api.unrealized.trade", coin]));
  assert.equal(got.answers.filter((a) => a.route === PUSH).length, SOCKETS);
  assert.equal(got.coin, coin);
  assert.equal(seen.length, 1 + PAGES * READS);
  assert.deepEqual(seen.slice(1), Array.from({ length: PAGES }, () => pagePaths(coin)).flat());
  assert.equal(judge(got).ok, true, judge(got).lines.join("\n"));
  assert.ok(PAGES * READS < 120, "under one client's API window (the helper's API_RATE_MAX)");
  assert.ok(SOCKETS < 8, "under one client's sockets at once (the helper's PUSH_CLIENT_MAX)");
});

test("upgrade(): 101 from a server that upgrades with Origin APP_HOST, the status from one that answers instead, null when nothing listens", async (t) => {
  const seen = [];
  const up = http.createServer((_q, res) => res.writeHead(502).end());
  up.on("upgrade", (q, socket) => (seen.push([q.url, q.headers.origin, q.headers.upgrade]), socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")));
  const no = http.createServer((_q, res) => res.writeHead(502).end());
  await Promise.all([up, no].map((s) => new Promise((ok) => s.listen(0, "127.0.0.1", ok))));
  t.after(() => (up.close(), no.close()));
  const at = (s) => `http://127.0.0.1:${s.address().port}`;
  assert.deepEqual(await upgrade(at(up), "C0in", () => 0), { route: PUSH, status: 101, ms: 0 });
  assert.deepEqual(seen, [[`${PUSH}?chain=solana&token=C0in`, APP, "websocket"]]);
  assert.equal((await upgrade(at(no), "C0in", () => 0)).status, 502);
  const port = no.address().port;
  await new Promise((ok) => no.close(ok));
  const gone = await upgrade(`http://127.0.0.1:${port}`, "C0in", () => 0);
  assert.equal(gone.status, null);
  assert.equal(gone.error, "ECONNREFUSED");
});

test("a lists read that names no coin (Caddy's 502 with no CORS header) is kept in the record, and the run FAILs on it", async () => {
  const fetchFn = async () => new Response("", { status: 502 });
  const got = await read("https://ct-api.unrealized.trade", fetchFn, () => 0, async () => assert.fail("no socket without a coin"));
  assert.equal(got.coin, null);
  assert.deepEqual(got.answers, [{ route: "/v1/market/lists", status: 502, ms: 0, cors: null, body: "" }]);
  const v = judge(got);
  assert.equal(v.ok, false);
  assert.ok(v.lines.some((l) => l.startsWith("BAD 500, 502 or 504: 1")), v.lines.join("\n"));
});
