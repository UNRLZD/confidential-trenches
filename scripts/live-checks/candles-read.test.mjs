// node --test scripts/live-checks/candles-read.test.mjs: the candles reader every live check reads the helper's
// /v1/market/candles through (candles-read.mjs), on a planted clock: a 429 is read again at its Retry-After, the run's
// one span (the page's THROTTLE_SPAN_S, 75 s) shared by all its reads, and the answer after it kept with its waits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WINDOW_MS } from "../../apps/helper/src/data/gecko.ts";
import { candlesReader, THROTTLE_SPAN_S, waitsText } from "./candles-read.mjs";

function planted() {
  const clock = { t: 0 };
  return { clock, now: () => clock.t, wait: async (ms) => void (clock.t += ms) };
}
const answers = (...xs) => {
  let i = 0;
  return async () => xs[Math.min(i++, xs.length - 1)];
};
const r429 = (s) => ({ status: 429, headers: { "retry-after": String(s) }, body: "" });
const ok = { status: 200, headers: {}, body: "{}" };

test("the span is the page's: one GeckoTerminal window of the helper", () => {
  assert.equal(THROTTLE_SPAN_S * 1000, WINDOW_MS);
});

test("a 429 that clears inside the span: the 200 after it, with the waits it took", async () => {
  const p = planted();
  const r = await candlesReader(p).read(answers(r429(30), r429(40), ok));
  assert.equal(r.status, 200);
  assert.deepEqual(r.waits, [30_000, 40_000]);
  assert.equal(waitsText(r), " after 70 s of reads at each Retry-After (30, 40 s)");
});

test("a 429 that never clears: the 429 once the span is waited, its waits named", async () => {
  const p = planted();
  const r = await candlesReader(p).read(answers(r429(60)));
  assert.equal(r.status, 429);
  assert.deepEqual(r.waits, [60_000, 15_000]);
  assert.equal(p.clock.t, THROTTLE_SPAN_S * 1000);
});

test("the span is the run's: a later read waits only what is left of it, and none once it ended", async () => {
  const p = planted();
  const reader = candlesReader(p);
  assert.deepEqual((await reader.read(answers(r429(50), ok))).waits, [50_000]);
  assert.deepEqual((await reader.read(answers(r429(50), ok))).waits, [25_000], "75 s from the run's first 429");
  const late = await reader.read(answers(r429(50), ok));
  assert.equal(late.status, 429);
  assert.equal(late.waits, undefined, "no wait left");
});

test("an answer that is not a 429 is returned at once, unchanged; a Response keeps its own shape", async () => {
  const p = planted();
  const reader = candlesReader(p);
  assert.equal(await reader.read(answers(ok)), ok);
  const res = new Response("{}", { status: 429, headers: { "Retry-After": "2" } });
  const after = await reader.read(answers(res, new Response("{}", { status: 200 })));
  assert.ok(after instanceof Response);
  assert.equal(after.status, 200);
  assert.deepEqual(after.waits, [2_000]);
  assert.equal(p.clock.t, 2_000);
  assert.equal((await reader.read(answers({ status: 503, headers: {} }))).status, 503);
});
