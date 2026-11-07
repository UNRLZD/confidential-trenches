// Replays evm-quote-warm-round.answers.json through the live check. The good answer is a real run of the check at the
// card's build (fc7f1b1, on the box, 2026-11-04): every listed provider's preflight and its POST's answer allow the app's origin, every quote ends as
// its case says, both cases under a second at warm p95; it passes. The bad answer is a real run before the card
// (db834f9, 2026-11-04): base-hook with two rpc_error quotes and one of 20,986 ms, warm p95 20,986 ms, no
// base-partial-v4, and the preflights read on the providers bc189de listed, whose base-public.nodies.app allows no
// origin; it fails on each of those.
//   node --test scripts/live-checks/evm-quote-warm-round.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./evm-quote-warm-round.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-quote-warm-round.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (fc7f1b1, the box) passes: every preflight allows the app, both cases under a second at warm p95", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, /^PASS base-hook: warm p50 533 ms, p95 653 ms over 20/);
  has(r.lines, /^PASS base-partial-v4: warm p50 557 ms, p95 718 ms over 20/);
  // bloXroute's Base host left the kit's list (card base-rpc-list-fix): the replay reads no line for it
  assert.ok(!r.lines.some((l) => /base\.rpc\.blxrbdn\.com/.test(l)), r.lines.join("\n"));
  has(r.lines, /^PASS base-hook: 21 of 21 quotes end ok$/);
  has(r.lines, /^PASS base-partial-v4: 21 of 21 quotes end partial_fill$/);
});

test("the bad answer (db834f9) fails: base-hook's slow p95, its rpc_errors, its short count, the missing case, the Nodies preflight", () => {
  const r = check(A.bad, A.bad.venues);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base base-public\.nodies\.app preflight from https:\/\/ct-app\.unrealized\.trade: 200, allow-origin none/);
  has(r.lines, /^PASS base base-rpc\.publicnode\.com preflight/);
  has(r.lines, /^FAIL base-hook: warm p50 \d+ ms, p95 20986 ms over 19/);
  has(r.lines, /^FAIL base-hook: 18 of 20 quotes end ok \(others: rpc_error\)$/);
  has(r.lines, /^FAIL base-hook: 20 quotes, 21 needed/);
  has(r.lines, /^FAIL base-partial-v4: 0 quotes, 21 needed/);
});

test("each rule fails alone on the good answer with one thing changed", () => {
  const slow = structuredClone(A.good);
  for (const q of slow.cases["base-hook"].quotes.slice(1, 3)) q.ms = 20986; // two slow quotes of twenty lift the p95
  assert.equal(check(slow).ok, false);
  const refused = structuredClone(A.good);
  refused.cases["base-partial-v4"].quotes[5].code = "rpc_error"; // a fast refusal never counts as a fast quote
  assert.equal(check(refused).ok, false);
  const short = structuredClone(A.good);
  short.cases["base-hook"].quotes.pop();
  assert.equal(check(short).ok, false);
  const venues = { base: { providers: ["https://a.example/1", "https://a.example/2", "https://b.example"] }, robinhood: { providers: ["https://c.example", "https://d.example", "https://e.example"] } };
  const fine = { status: 204, allow: "*", headers: "content-type", post: "*" };
  const pre = Object.fromEntries([...venues.base.providers, ...venues.robinhood.providers, "https://f.example"].map((u) => [u, fine]));
  assert.equal(check({ ...A.good, preflight: pre }, venues).ok, false); // two providers on one host
  assert.equal(check({ ...A.good, preflight: pre }, { ...venues, base: { providers: ["https://a.example/1", "https://b.example"] } }).ok, false); // two
  const three = { ...venues, base: { providers: ["https://a.example/1", "https://b.example", "https://f.example"] } };
  assert.equal(check({ ...A.good, preflight: pre }, three).ok, true, "the same run on three hosts, each preflight fine");
  // each preflight rule alone: no answer, another origin, content-type not allowed, a failed preflight, a POST answer
  // with no allow-origin or another
  for (const bad of [undefined, { ...fine, allow: "https://other.example" }, { ...fine, headers: "authorization" }, { ...fine, status: 403 }, { ...fine, post: null }, { ...fine, post: "https://other.example" }]) {
    assert.equal(check({ ...A.good, preflight: { ...pre, "https://f.example": bad } }, three).ok, false, JSON.stringify(bad));
  }
});

test("a refused quote's line names its code, its place, its time and the kit's message (re-review of 037627c, MEDIUM-1)", () => {
  const run = structuredClone(A.good);
  run.cases["base-partial-v4"].quotes[0] = { ms: 99444, code: "rpc_error", message: "the scan provider answered no logs" };
  const r = check(run);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base-partial-v4: 20 of 21 quotes end partial_fill \(others: rpc_error at quote 0, 99444 ms: the scan provider answered no logs\)$/);
});

test("card base-rpc-list-fix: no Base provider of the kit's list is one whose POST answered no allow-origin on GitHub's runner", () => {
  // run 42114981904 (2026-11-05 21:42-21:50Z), its job log: "FAIL base base.rpc.blxrbdn.com preflight from
  // https://ct-app.unrealized.trade: 204, allow-origin *, allow-headers Content-Type, Authorization, User-Agent;
  // POST allow-origin none". A browser quote that reaches it fails, so the list must not hold it.
  const run = structuredClone(A.good);
  run.preflight["https://base.rpc.blxrbdn.com"] = { status: 204, allow: "*", headers: "Content-Type, Authorization, User-Agent", post: null };
  const r = check(run);
  assert.equal(r.ok, true, r.lines.join("\n"));
});
