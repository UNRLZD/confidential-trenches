// node --test apps/helper/src/limits/limits.test.ts: the helper's abuse limits (card helper-abuse-limits). The clock
// is a fake that moves with time (each take advances it), never a frozen one.
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { budgetFromEnv, clientOf, clientWindow, heldPerClient, keyOf, RETRY_AFTER_MAX_S, throttled, throttleOf, upstreamBudget, upstreamRetryAfterS } from "./limits.ts";

/** A clock that moves `step` ms at every read, from `t0`. */
const moving = (t0: number, step: number) => {
  let t = t0;
  const now = () => (t += step);
  return { now, jump: (ms: number) => (t += ms), at: () => t };
};

test("clientWindow: one client gets `max` a window, then a wait to the window's end; another client and the next window are free", () => {
  const c = moving(1_000_000, 7);
  const r = clientWindow(30, c.now);
  for (let i = 0; i < 30; i++) assert.equal(r.take("a"), 0);
  const wait = r.take("a");
  // the window is [1_000_000, 1_010_000): 31 reads of 7 ms in, 9,783 ms are left, so the wait is 10 s rounded up
  assert.equal(wait, Math.ceil((1_010_000 - c.at()) / 1000));
  assert.ok(wait >= 1 && wait <= 10);
  assert.equal(r.take("b"), 0, "another client in the same window goes ahead");
  c.jump(wait * 1000);
  assert.equal(r.take("a"), 0, "after the named wait, the client goes ahead");
});

test("clientWindow: the memory is bounded: past the most clients the oldest goes", () => {
  const r = clientWindow(1, moving(0, 1).now, 10_000, 2);
  assert.equal(r.take("a"), 0);
  assert.equal(r.take("b"), 0);
  assert.equal(r.take("c"), 0);
  assert.equal(r.take("a"), 0, "a was evicted, so it starts over");
});

test("upstreamBudget: one heavy caller is throttled at its share while an honest one still draws; only the shared total stops everyone", () => {
  const c = moving(2_000_000, 3);
  const b = upstreamBudget(() => ({ total: 10, perClient: 4 }), c.now);
  for (let i = 0; i < 4; i++) assert.equal(b.take("solana", "heavy"), 0);
  assert.ok(b.take("solana", "heavy") > 0, "the heavy caller is throttled at its share");
  for (let i = 0; i < 20; i++) b.take("solana", "heavy"); // hammering on draws nothing more
  assert.equal(b.take("solana", "honest"), 0, "an honest caller still draws in the same window");
  assert.equal(b.take("base", "heavy"), 0, "another chain's budget is its own");
  // two more callers at their share fill the total: then everyone waits
  for (let i = 0; i < 4; i++) b.take("solana", "second");
  assert.equal(b.take("solana", "third"), 0, "the tenth draw");
  const w = b.take("solana", "fourth");
  assert.ok(w >= 1 && w <= 11, "past the total, the wait until the oldest draws leave the provider's window (10 s and a second)");
  c.jump(w * 1000);
  assert.equal(b.take("solana", "heavy"), 0, "once they have left, a draw goes ahead again");
});

test("upstreamBudget: a batch of n draws n in one step, checked whole against the share and the total (review F-A)", () => {
  const c = moving(3_000_000, 1);
  const b = upstreamBudget(() => ({ total: 10, perClient: 4 }), c.now);
  assert.ok(b.take("solana", "a", 5) > 0, "a batch past the share is refused whole");
  assert.equal(b.take("solana", "a", 4), 0, "a batch at the share draws");
  assert.ok(b.take("solana", "a", 1) > 0, "the share is spent by the batch");
  assert.equal(b.take("solana", "b", 4), 0);
  assert.ok(b.take("solana", "c", 3) > 0, "a batch past the total is refused whole");
  assert.equal(b.take("solana", "c", 2), 0, "the total's last two");
});

test("upstreamBudget: a share-only draw (a cache hit) counts in the caller's share, never in the total (review F-C2)", () => {
  const b = upstreamBudget(() => ({ total: 5, perClient: 3 }), moving(4_000_000, 1).now);
  for (let i = 0; i < 3; i++) assert.equal(b.take("v", "hits", 1, true), 0);
  assert.ok(b.take("v", "hits", 1, true) > 0, "cache hits past the share are throttled");
  for (let i = 0; i < 3; i++) assert.equal(b.take("v", "x"), 0);
  for (let i = 0; i < 2; i++) assert.equal(b.take("v", "y"), 0);
  assert.ok(b.take("v", "y") > 0, "the total is the five provider draws, the hits took none of it");
});

test("upstreamBudget: hold(key) stops every caller's draw on that key until the provider's reset, capped at a minute; other keys draw (review F-B)", () => {
  const c = moving(5_000_000, 0);
  const b = upstreamBudget(() => ({ total: 100, perClient: 10 }), c.now);
  b.hold("solana", c.at() + 30_000);
  assert.equal(b.heldFor("solana"), 30);
  assert.equal(b.take("solana", "never-drew"), 30, "a caller that drew nothing waits the reset too");
  assert.equal(b.take("base", "never-drew"), 0, "another key is its own");
  c.jump(29_500);
  assert.equal(b.take("solana", "x"), 1);
  c.jump(500);
  assert.equal(b.take("solana", "x"), 0, "at the reset, draws go ahead");
  b.hold("solana", c.at() + 3_600_000);
  assert.equal(b.heldFor("solana"), RETRY_AFTER_MAX_S, "a provider's hour is held to a minute");
  c.jump(RETRY_AFTER_MAX_S * 1000);
  assert.equal(b.heldFor("solana"), 0);
});

test("upstreamBudget: the total is counted over the provider's own sliding window, so no stretch of it ever holds more than the total, the fixed windows' edges included (re-check F-D)", () => {
  // a vendor's minute: 60 a sliding minute; callers at a 10 s share of 4, 40 addresses drawing as fast as they may
  let t = 7_000_000;
  const b = upstreamBudget(() => ({ total: 60, perClient: 4, windowMs: 60_000 }), () => t);
  const sent: number[] = [];
  for (; t < 7_000_000 + 300_000; t += 250) for (let a = 0; a < 40; a++) if (b.take("jupiter", `a${a}`) === 0) sent.push(t);
  let worst = 0;
  for (let i = 0, j = 0; i < sent.length; i++) {
    while (sent[i]! - sent[j]! >= 60_000) j++;
    worst = Math.max(worst, i - j + 1);
  }
  assert.equal(worst, 60, `the most sent in any 60 s: ${worst}`);
  assert.ok(sent.length >= 60 * 4, `the budget is used, not starved: ${sent.length} in 5 min`);
});

test("upstreamBudget: a refused total names the seconds until the oldest draws leave the window, and is then right", () => {
  let t = 8_000_000;
  const b = upstreamBudget(() => ({ total: 3, perClient: 3, windowMs: 60_000 }), () => t);
  assert.equal(b.take("v", "a"), 0);
  t += 20_000;
  assert.equal(b.take("v", "b", 2), 0);
  const w = b.take("v", "c");
  assert.equal(w, 41, "the first draw (second 8000) leaves at the end of second 8060");
  t += (w - 1) * 1000;
  assert.ok(b.take("v", "c") > 0, "a second early is still refused");
  t += 1000;
  assert.equal(b.take("v", "c"), 0, "on time it goes ahead");
});

test("upstreamBudget: the helper's own read (no client) draws from the total and from no share; a share-only one draws nothing (re-check F-D)", () => {
  let t = 9_000_000;
  const b = upstreamBudget(() => ({ total: 5, perClient: 2, windowMs: 60_000 }), () => t);
  for (let i = 0; i < 5; i++) assert.equal(b.take("jupiter", undefined), 0, `own read ${i + 1}, past a caller's share`);
  assert.ok(b.take("jupiter", "device") > 0, "own reads spent the vendor's total: a device waits");
  assert.ok(b.take("jupiter", undefined) > 0, "and so does the next own read");
  t += 10_000;
  assert.ok(b.take("jupiter", undefined) > 0, "a new 10 s window frees no total: the vendor's minute still holds them");
  assert.equal(b.take("jupiter", undefined, 1, true), 0, "a share-only own read reaches no vendor and draws nothing");
});

test("upstreamBudget: takeEach draws on every key or on none; one key full refuses the whole draw (re-check F-D solana)", () => {
  let t = 10_000_000;
  const b = upstreamBudget((k) => (k === "solana" ? { total: 100, perClient: 16 } : { total: 3, perClient: Infinity }), () => t);
  assert.equal(b.takeEach([["solana", 3], ["solana getSignatureStatuses", 3]], "a"), 0);
  assert.ok(b.takeEach([["solana", 1], ["solana getSignatureStatuses", 1]], "b") > 0, "the method's total is spent");
  assert.equal(b.takeEach([["solana", 14], ["solana getBalance", 3]], "a") > 0, true, "past the caller's share of the chain: refused whole");
  assert.equal(b.takeEach([["solana", 3], ["solana getBalance", 3]], "b"), 0, "nothing of the refused draws was counted: b's share and getBalance's total are whole");
  assert.equal(b.takeEach([["solana", 2], ["solana x", 1], ["solana x", 1], ["solana x", 1]], "c"), 0, "one key named three times draws three");
  assert.ok(b.take("solana x", "c") > 0, "x's three are spent");
});

test("budgetFromEnv rules: a share under `minShare` (a batch's size) and a method's limit outside minShare..total stop the start, naming the variable only (re-check env)", () => {
  const fb = { total: 100, perClient: 16, perMethod: 40 };
  const rules = { minShare: 10, perMethod: true };
  assert.deepEqual(budgetFromEnv({}, "RPC_BUDGET_SOLANA", fb, rules), fb);
  assert.deepEqual(budgetFromEnv({ RPC_BUDGET_SOLANA: "500,50" }, "RPC_BUDGET_SOLANA", fb, rules), { total: 500, perClient: 50 }, "two numbers: no limit per method");
  assert.deepEqual(budgetFromEnv({ RPC_BUDGET_SOLANA: "100,10,10" }, "RPC_BUDGET_SOLANA", fb, rules), { total: 100, perClient: 10, perMethod: 10 });
  assert.deepEqual(budgetFromEnv({ RPC_BUDGET_SOLANA: "100,16,100" }, "RPC_BUDGET_SOLANA", fb, rules), { total: 100, perClient: 16, perMethod: 100 });
  for (const bad of ["100,5", "100,9", "100,16,9", "100,16,101", "100,16,0", "100,16,", "100,16,40,1", "100,16, 40", "100,16,04"])
    assert.throws(() => budgetFromEnv({ RPC_BUDGET_SOLANA: bad }, "RPC_BUDGET_SOLANA", fb, rules), (e: Error) => /^RPC_BUDGET_SOLANA must be/.test(e.message) && !e.message.includes(bad), bad);
  assert.throws(() => budgetFromEnv({ X: "100,16,40" }, "X", fb), /X must be/, "a third number only where the rules allow one");
});

test("budgetFromEnv: \"<total>,<per client>\" with the share under the total, else a start stops naming the variable only", () => {
  const fb = { total: 100, perClient: 16 };
  assert.deepEqual(budgetFromEnv({}, "RPC_BUDGET_SOLANA", fb), fb);
  assert.deepEqual(budgetFromEnv({ RPC_BUDGET_SOLANA: "" }, "RPC_BUDGET_SOLANA", fb), fb);
  assert.deepEqual(budgetFromEnv({ RPC_BUDGET_SOLANA: "400,40" }, "RPC_BUDGET_SOLANA", fb), { total: 400, perClient: 40 });
  for (const bad of ["40,40", "40,400", "0,0", "1e3,10", "100", "100,16,1", " 100,16", "-1,1"])
    assert.throws(() => budgetFromEnv({ RPC_BUDGET_SOLANA: bad }, "RPC_BUDGET_SOLANA", fb), (e: Error) => /^RPC_BUDGET_SOLANA must be/.test(e.message) && !e.message.includes(bad), bad);
});

test("heldPerClient: at most `max` held at once per client; a leave frees one; the address goes with its last request", () => {
  const h = heldPerClient(2);
  assert.equal(h.enter("x"), true);
  assert.equal(h.enter("x"), true);
  assert.equal(h.enter("x"), false);
  assert.equal(h.enter("y"), true, "another client");
  h.leave("x");
  assert.equal(h.enter("x"), true);
  h.leave("x");
  h.leave("x");
  h.leave("y");
  assert.equal(h.size, 0, "no address is kept once nothing is held");
});

test("throttled: 429, the code only, and the wait in whole seconds; an upstream's reset is held to 1 to 60 s", () => {
  assert.deepEqual(throttled(7), { status: 429, headers: { "Retry-After": "7" }, body: '{"error":{"code":"rate_limited"}}' });
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(upstreamRetryAfterS(h({ "retry-after": "3" }), 0), 3);
  assert.equal(upstreamRetryAfterS(h({ "retry-after": "0.2" }), 0), 1);
  assert.equal(upstreamRetryAfterS(h({ "retry-after": "3600" }), 0), RETRY_AFTER_MAX_S);
  assert.equal(upstreamRetryAfterS(h({}), 0), 1);
  assert.equal(upstreamRetryAfterS(h({ "retry-after": "soon" }), 0), 1);
});

test("the client is the proxy's last X-Forwarded-For entry, else the socket's peer", () => {
  const req = (h: Record<string, string>, peer = "10.0.0.9") => ({ headers: h, socket: { remoteAddress: peer } }) as unknown as IncomingMessage;
  assert.equal(clientOf(req({ "x-forwarded-for": "198.51.100.1, 203.0.113.7" })), "203.0.113.7");
  assert.equal(clientOf(req({})), "10.0.0.9");
});

test("an IPv6 client is keyed by its /64, so one subscriber's block is one client; IPv4, mapped ones included, is itself (review finding 8)", () => {
  const req = (peer: string) => ({ headers: {}, socket: { remoteAddress: peer } }) as unknown as IncomingMessage;
  assert.equal(clientOf(req("2001:db8:1:2::1")), "2001:db8:1:2::/64");
  assert.equal(clientOf(req("2001:db8:1:2:ffff:ffff:ffff:fffe")), "2001:db8:1:2::/64");
  assert.equal(clientOf(req("2001:0db8:0001:0002:0:0:0:9")), "2001:db8:1:2::/64");
  assert.notEqual(clientOf(req("2001:db8:1:3::1")), clientOf(req("2001:db8:1:2::1")), "the next /64 is another client");
  assert.equal(keyOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(keyOf("::1"), "0:0:0:0::/64");
  assert.equal(keyOf("fe80::1%en0"), "fe80:0:0:0::/64");
  assert.equal(keyOf("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(keyOf("203.0.113.7"), "203.0.113.7");
});

test("throttleOf: a provider read that threw for a throttle names 1 s; any other failure 0", () => {
  assert.equal(throttleOf(new Error("HTTP 429")), 1);
  assert.equal(throttleOf(new Error("rpc: rate limit exceeded")), 1);
  assert.equal(throttleOf(new Error("Too Many Requests")), 1);
  assert.equal(throttleOf(new Error("HTTP 4290")), 0);
  assert.equal(throttleOf(new Error("HTTP 503")), 0);
  assert.equal(throttleOf(new Error("blockhash not found")), 0);
  assert.equal(throttleOf(undefined), 0);
  // EIP-1474's -32005 is a throttle on an EVM chain only, and no other -320xx is
  assert.equal(throttleOf(new Error("RPC error -32005: project ID request rate exceeded"), true), 1);
  assert.equal(throttleOf(new Error("RPC error -32005: Node is behind by 42 slots")), 0);
  for (const m of ["RPC error -32002: resource unavailable", "RPC error -32004: method not supported", "RPC error -320050: x", "x RPC error -32005: y"]) assert.equal(throttleOf(new Error(m), true), 0, m);
});
