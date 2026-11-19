// node --test scripts/live-checks/helper-answers-through-a-burst.test.mjs: the live check replays recorded answers
// (helper-answers-through-a-burst.answers.json), each the check run against a copy of the helper behind Caddy on the
// real Caddyfile while apps/helper/deploy/burst.mjs opened 300 pages at once (apps/helper/deploy/burst-proof.sh, on the
// test box). good: the card's helper: PASS. bad_main: main 0092e5692 the same way: FAIL. Each other bad answer plants one
// fault in the good one (a 502, an answer with no CORS header, one unanswered, a p99 past the bound, a page short): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP, judge, P99_MAX_MS, PAGES, pagePaths, read, READS } from "./helper-answers-through-a-burst.mjs";

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
    "a 200 with no CORS header": (r) => Object.assign(r.answers[0], { cors: null }),
    "a 503 with no CORS header": (r) => Object.assign(r.answers[0], { status: 503, cors: null }),
    "a CORS header for another origin": (r) => Object.assign(r.answers[1], { cors: "https://evil.example" }),
    "one unanswered": (r) => Object.assign(r.answers[5], { status: null, error: "ConnectTimeoutError" }),
    "a p99 past the bound": (r) => r.answers.forEach((a, i) => i % 50 === 0 && (a.ms = P99_MAX_MS + 1)),
    "a page short": (r) => r.answers.splice(0, READS),
    "no coin read": (r) => ((r.coin = null), (r.answers = [])),
  };
  for (const [name, f] of Object.entries(plant)) {
    const r = copy(A.good);
    f(r);
    assert.equal(judge(r).ok, false, name);
  }
});

test("the check sends PAGES pages of the first screen's reads at once, with Origin APP_HOST, for the coin the Solana lists name first", async () => {
  const coin = A.good.coin;
  const seen = [];
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.origin, APP);
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    if (seen.length === 1) return new Response(JSON.stringify({ lists: { trending: [{ token: coin }] } }), { status: 200, headers: { "access-control-allow-origin": APP } });
    return new Response("{}", { status: 200, headers: { "access-control-allow-origin": APP } });
  };
  const got = await read("https://ct-api.unrealized.trade", fetchFn, () => 0);
  assert.equal(got.coin, coin);
  assert.equal(seen.length, 1 + PAGES * READS);
  assert.deepEqual(seen.slice(1), Array.from({ length: PAGES }, () => pagePaths(coin)).flat());
  assert.equal(judge(got).ok, true, judge(got).lines.join("\n"));
  assert.ok(PAGES * READS < 120, "under one client's API window (the helper's API_RATE_MAX)");
});
