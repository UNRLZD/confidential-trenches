// node --test scripts/live-checks/helper-rpc-one-read-many-pages.test.mjs: the live check's verdict replays recorded runs
// (helper-rpc-one-read-many-pages.answers.json):
//   good: the branch helper at b9a41e97f on the Mac: 4 price reads at once, one result, 3 served shared; 2 reads of an
//         account off the list each its own: PASS;
//   bad:  the deployed helper at 27c4d830a: 4 price reads at once, 2 different results, none shared: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
