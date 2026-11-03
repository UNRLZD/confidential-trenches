// node --test apps/helper/src/pool/rate.test.ts: the pool routes' per-client rate limit (M356 (3)).
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { clientOf, POOL_RATE_MAX, poolRateLimit } from "./rate.ts";

test("one client gets POOL_RATE_MAX requests a window, then refusals; another client and the next window are free", () => {
  let now = 1_000_000;
  const r = poolRateLimit(() => now);
  for (let i = 0; i < POOL_RATE_MAX; i++) assert.equal(r.take("a"), true);
  assert.equal(r.take("a"), false);
  assert.equal(r.take("b"), true);
  now += 10_000;
  assert.equal(r.take("a"), true);
});

test("the memory is bounded: past the most clients the oldest goes", () => {
  const r = poolRateLimit(() => 0, 1, 10_000, 2);
  assert.equal(r.take("a"), true);
  assert.equal(r.take("b"), true);
  assert.equal(r.take("c"), true);
  assert.equal(r.take("a"), true, "a was evicted, so it starts over");
});

test("the client is the proxy's last X-Forwarded-For entry, else the socket's peer", () => {
  const req = (h: Record<string, string>, peer = "10.0.0.9") => ({ headers: h, socket: { remoteAddress: peer } }) as unknown as IncomingMessage;
  assert.equal(clientOf(req({ "x-forwarded-for": "198.51.100.1, 203.0.113.7" })), "203.0.113.7");
  assert.equal(clientOf(req({})), "10.0.0.9");
});
