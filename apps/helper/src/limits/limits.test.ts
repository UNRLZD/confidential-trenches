// node --test apps/helper/src/limits/limits.test.ts: the helper's abuse limits (card helper-abuse-limits). The clock
// is a fake that moves with time (each take advances it), never a frozen one.
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { clientOf, clientWindow, heldPerClient, RETRY_AFTER_MAX_S, throttled, upstreamBudget, upstreamRetryAfterS } from "./limits.ts";

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
  const b = upstreamBudget(10, 4, c.now);
  for (let i = 0; i < 4; i++) assert.equal(b.take("solana", "heavy"), 0);
  assert.ok(b.take("solana", "heavy") > 0, "the heavy caller is throttled at its share");
  for (let i = 0; i < 20; i++) b.take("solana", "heavy"); // hammering on draws nothing more
  assert.equal(b.take("solana", "honest"), 0, "an honest caller still draws in the same window");
  assert.equal(b.take("base", "heavy"), 0, "another chain's budget is its own");
  // two more callers at their share fill the total: then everyone waits
  for (let i = 0; i < 4; i++) b.take("solana", "second");
  assert.equal(b.take("solana", "third"), 0, "the tenth draw");
  const w = b.take("solana", "fourth");
  assert.ok(w >= 1 && w <= 10, "past the total, the wait to the window's end");
  c.jump(w * 1000);
  assert.equal(b.take("solana", "heavy"), 0, "the next window draws again");
  assert.throws(() => upstreamBudget(4, 4), /under the shared total/);
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
