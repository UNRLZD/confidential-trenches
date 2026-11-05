// node --test apps/helper/src/limits/refusals.test.ts (card app-console-429): every 429 a caller is answered is counted,
// one log line a window per route and reason with its count, never one per request and never the caller; a refused
// budget draw names what refused it. Before this card the helper's own refusals left no line (11:05Z: the first holders
// read after a swap answered 429 in 0.08 s and docker logs held nothing about it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { enableTimers, resetTimers } from "../../test/mock-timers.ts";
import { refusalLog, throttled, upstreamBudget } from "./limits.ts";

test("one line per route and reason a window, with its count; nothing for a window with none; never per request", () => {
  const lines: string[] = [];
  const r = refusalLog((l) => lines.push(l));
  for (let i = 0; i < 35; i++) r.count("/v1/market/candles", "geckoterminal budget");
  r.count("/v1/market/holders", "solana held");
  r.count("/v1/market/holders", "solana held");
  r.count("/v1/rpc", "solana share");
  r.flush();
  assert.deepEqual(lines, ["refused /v1/market/candles geckoterminal budget 35 in 10 s", "refused /v1/market/holders solana held 2 in 10 s", "refused /v1/rpc solana share 1 in 10 s"]);
  r.flush();
  assert.equal(lines.length, 3, "an empty window writes nothing");
});

test("the window's line is written by its own timer, at the window's end", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  const lines: string[] = [];
  const r = refusalLog((l) => lines.push(l));
  r.count("other", "client window");
  t.mock.timers.tick(9_999);
  assert.deepEqual(lines, []);
  t.mock.timers.tick(1);
  assert.deepEqual(lines, ["refused other client window 1 in 10 s"]);
});

test("the reason travels with the 429 and is never in what is sent", () => {
  const a = throttled(5, undefined, "geckoterminal budget");
  assert.equal(a.why, "geckoterminal budget");
  assert.ok(!a.body.includes("gecko") && !JSON.stringify(a.headers).includes("gecko"));
  assert.equal("why" in throttled(5), false);
});

test("a refused budget draw names what refused it: the provider's hold, the caller's share, the total", () => {
  const t = 1_800_000_000_000;
  const b = upstreamBudget(() => ({ total: 3, perClient: 2 }), () => t);
  assert.equal(b.take("solana", "a"), 0);
  assert.equal(b.take("solana", "a"), 0);
  assert.ok(b.take("solana", "a") > 0);
  assert.equal(b.refusedBy(), "solana share");
  assert.equal(b.take("solana", "b"), 0);
  assert.ok(b.take("solana", "c") > 0);
  assert.equal(b.refusedBy(), "solana total");
  b.hold("solana", t + 5_000);
  assert.ok(b.take("solana", "d") > 0);
  assert.equal(b.refusedBy(), "solana held");
});
