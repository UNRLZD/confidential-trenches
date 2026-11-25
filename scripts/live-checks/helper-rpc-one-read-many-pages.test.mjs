// node --test scripts/live-checks/helper-rpc-one-read-many-pages.test.mjs: the live check's verdict replays recorded runs
// (helper-rpc-one-read-many-pages.answers.json):
//   good: the branch helper at b9a41e97f on the Mac: 4 price reads at once, one result, 3 served shared; 2 reads of an
//         account off the list each its own: PASS;
//   bad:  the deployed helper at 27c4d830a: 4 price reads at once, 2 different results, none shared: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, OTHER, PAGES, PYTH, read } from "./helper-rpc-one-read-many-pages.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-rpc-one-read-many-pages.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: the price reads at once are one shared read, the off-list reads each their own", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(A.good.reads.filter((x) => x.account === PYTH).length, PAGES);
  assert.match(r.lines.join("\n"), /3 of 4 price reads served from one shared read/);
});

test("the recorded bad answer (the deployed helper before this card) fails: no read shared, and the pages saw two results", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r), ["BAD 4 price reads at once: 2 result(s), each with its own id", "BAD 0 of 4 price reads served from one shared read (Server-Timing rpc-cache hit; at least 3)"]);
});

test("planted: an off-list account served a shared answer (a wallet's read joined) fails", () => {
  const r = edit((run) => {
    const o = run.reads.find((x) => x.account === OTHER);
    o.answer.kept["server-timing"] = `rpc-cache;desc="hit", ${o.answer.kept["server-timing"]}`;
  });
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r)[0], /an account off the list\): served a shared answer/);
});

test("planted: a price answer with another caller's id, or not one account, fails; a 400 fails; a 429, or an answer on the second try, is the moment's", () => {
  const p = (run) => run.reads.find((x) => x.account === PYTH && /rpc-cache/.test(x.answer.kept["server-timing"]));
  assert.equal(edit((run) => (p(run).answer.answerId = "price-9")).verdict, "FAIL");
  assert.equal(edit((run) => (p(run).answer.result = { context: { slot: 1 }, value: [] })).verdict, "FAIL");
  assert.equal(edit((run) => (p(run).answer = { error: "method_not_allowed", status: 400, acao: null, kept: { "server-timing": null }, answerId: undefined, tries: 1 })).verdict, "FAIL");
  assert.equal(edit((run) => (p(run).answer = { noAnswer: "ct-api.unrealized.trade HTTP 429" })).verdict, "INCONCLUSIVE");
  assert.equal(edit((run) => (p(run).answer.tries = 2)).verdict, "INCONCLUSIVE");
  assert.equal(edit((run) => (run.reads = run.reads.filter((x) => x.account === PYTH))).verdict, "INCONCLUSIVE");
});

test("read: the price reads and the off-list reads go out at once, each its own id, on POST /v1/rpc/solana with the signing page's Origin", async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    if (init.method === "OPTIONS") return new Response(null, { status: 204 });
    const b = JSON.parse(init.body);
    seen.push({ url, origin: init.headers.origin, id: b.id, account: b.params[0][0] });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: [{}] } }), { status: 200, headers: { "server-timing": 'rpc-cache;desc="hit"' } });
  };
  const run = await read("http://h", fetchFn);
  assert.equal(seen.length, PAGES + 2);
  assert.ok(seen.every((s) => s.url === "http://h/v1/rpc/solana" && s.origin === "https://confidential.unrealized.trade"));
  assert.equal(new Set(seen.map((s) => s.id)).size, PAGES + 2);
  assert.equal(run.reads.filter((r) => r.account === OTHER).length, 2);
  // each read through the shared module, its own id and Server-Timing back beside the answer
  assert.ok(run.reads.every((r) => r.answer.answerId === r.id && r.answer.tries === 1 && r.answer.kept["server-timing"] === 'rpc-cache;desc="hit"'));
});

// card helper-checks-read-over-the-pages-connection (red at 3019996c8: each read opened its own connection as it was
// sent, so on helper live run 45538634464 the reads at once reached the helper apart, 2 results, 2 of 4 shared)
test("read: every page opens its connection with the browser's preflight before the reads go at once, and each read rides a connection its page opened", async (t) => {
  const order = [];
  let sockets = 0;
  const server = http.createServer((req, res) => {
    const sock = (req.socket.id ??= ++sockets);
    if (req.method === "OPTIONS") {
      order.push({ m: "OPTIONS", sock, origin: req.headers.origin, method: req.headers["access-control-request-method"] });
      res.writeHead(204, { "access-control-allow-origin": req.headers.origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" });
      return res.end();
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      order.push({ m: "POST", sock, id: b.id });
      // the helper's shared read: the first price read goes upstream, the price reads after it are its answer, and a
      // read of an account off the list is its own
      const shared = b.params[0][0] === PYTH && order.some((x) => x.m === "POST" && x !== order.at(-1) && x.pyth);
      order.at(-1).pyth = b.params[0][0] === PYTH;
      res.writeHead(200, { "content-type": "application/json", "server-timing": shared ? 'rpc-cache;desc="hit"' : "rpc;dur=1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: [{}] } }));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const run = await read(`http://127.0.0.1:${server.address().port}`, fetch);
  const pre = order.filter((x) => x.m === "OPTIONS");
  const posts = order.filter((x) => x.m === "POST");
  assert.equal(pre.length, PAGES + 2, "one preflight a page");
  assert.ok(pre.every((x) => x.origin === "https://confidential.unrealized.trade" && x.method === "POST"));
  assert.equal(order.findIndex((x) => x.m === "POST"), PAGES + 2, "every preflight answered before the first read");
  assert.equal(posts.length, PAGES + 2);
  const opened = new Set(pre.map((x) => x.sock));
  assert.ok(posts.every((x) => opened.has(x.sock)), `each read on a connection its page opened: ${JSON.stringify(order)}`);
  assert.equal(new Set(posts.map((x) => x.sock)).size, PAGES + 2, "each page its own connection");
  assert.deepEqual(run.opened, Array.from({ length: PAGES + 2 }, () => 204));
  assert.equal(judge(run).verdict, "PASS", judge(run).lines.join("\n"));
});
