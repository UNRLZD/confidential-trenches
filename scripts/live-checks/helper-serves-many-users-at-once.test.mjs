// node --test scripts/live-checks/helper-serves-many-users-at-once.test.mjs: the live check replays recorded runs
// (helper-serves-many-users-at-once.answers.json). good: this card's helper on the deployed provider list, 11 Nov
// 06:03:32Z: Solana 135,42 (3 pages at once), Base and Robinhood 155,30 (5): PASS. bad: the deployed helper before this
// card, 06:03:21Z: no RateLimit-Policy on any route: FAIL. Made from the good run: today's sizing (100,42: 2 pages), a
// share under a page's draw, a malformed field: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read, ROUTES, SIGN } from "./helper-serves-many-users-at-once.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-serves-many-users-at-once.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";
const withPolicy = (route, policy) => ({ routes: { ...A.good.routes, [route]: { status: 200, policy } } });

test("recorded good run: each route serves at least three pages at once: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.deepEqual(r.lines, ["ok  [solana] total 135, share 42 (a page's 42): 3 pages at once", "ok  [base] total 155, share 30 (a page's 30): 5 pages at once", "ok  [robinhood] total 155, share 30 (a page's 30): 5 pages at once"]);
});

test("recorded bad run: the deployed helper before this card reports no budget: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.lines.filter((l) => l.startsWith("BAD") && l.includes("no budget reported")).length, 3);
});

test("made from the good run: the first key's plan alone (100,42: two pages), a share under a page's, a malformed field: each FAIL", () => {
  assert.equal(judge(withPolicy("solana", '"chain";q=100;w=10, "client";q=42;w=10')).verdict, "FAIL");
  assert.equal(judge(withPolicy("base", '"chain";q=155;w=10, "client";q=16;w=10')).verdict, "FAIL");
  assert.equal(judge(withPolicy("robinhood", '"chain";q=155;w=60, "client";q=30;w=60')).verdict, "FAIL");
});

test("the read: one cheap read per route with the page's Origin, the field kept; replayed, it judges as recorded", async () => {
  for (const name of ["good", "bad"]) {
    const asked = [];
    const fetchFn = async (url, init) => {
      const route = url.slice(`${BASE}/v1/rpc/`.length);
      assert.equal(init.headers.origin, SIGN);
      asked.push([route, JSON.parse(init.body).method]);
      const p = A[name].routes[route].policy;
      return new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": SIGN, ...(p === null ? {} : { "ratelimit-policy": p }) } });
    };
    assert.equal(judge(await read(BASE, fetchFn)).verdict, name === "good" ? "PASS" : "FAIL");
    assert.deepEqual(asked, Object.entries(ROUTES), "three reads, one per route");
  }
});
