// node --test apps/helper/src/limits/loop-busy.test.ts: card robinhood-tapes-read-ahead-bounded. The helper's reads ahead
// stand down while the event loop is busy (loop-busy.ts): a sample LOOP_BUSY_MS late makes it busy for BUSY_HOLD_MS, and
// no sample for SAMPLE_MS + LOOP_BUSY_MS is a loop held now.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSY_HOLD_MS, LOOP_BUSY_MS, loopBusy, loopProbe, SAMPLE_MS } from "./loop-busy.ts";

test("card robinhood-tapes-read-ahead-bounded: a sample on time is no busy loop; one LOOP_BUSY_MS late is, for BUSY_HOLD_MS; a loop that sends no sample past SAMPLE_MS + LOOP_BUSY_MS is busy now", () => {
  const clk = { t: 1_000 };
  const p = loopProbe(() => clk.t);
  for (let i = 0; i < 5; i++) {
    clk.t += SAMPLE_MS + LOOP_BUSY_MS - 1;
    p.sample(clk.t - LOOP_BUSY_MS + 1);
    assert.equal(p.busy(), false, `a sample ${LOOP_BUSY_MS - 1} ms late is no busy loop`);
  }
  clk.t += SAMPLE_MS + LOOP_BUSY_MS;
  p.sample(clk.t - LOOP_BUSY_MS);
  assert.equal(p.busy(), true, `a sample ${LOOP_BUSY_MS} ms late is a busy loop`);
  for (const dt of [SAMPLE_MS, SAMPLE_MS, SAMPLE_MS]) {
    clk.t += dt;
    p.sample(clk.t);
  }
  assert.equal(p.busy(), true, "still busy inside BUSY_HOLD_MS of the late sample, however on time the samples since");
  while (clk.t < 1_000 + 5 * (SAMPLE_MS + LOOP_BUSY_MS - 1) + SAMPLE_MS + LOOP_BUSY_MS + BUSY_HOLD_MS) {
    clk.t += SAMPLE_MS;
    p.sample(clk.t);
  }
  assert.equal(p.busy(), false, "not busy once BUSY_HOLD_MS has passed with samples on time");
  clk.t += SAMPLE_MS + LOOP_BUSY_MS;
  assert.equal(p.busy(), true, "no sample for SAMPLE_MS + LOOP_BUSY_MS: the loop is held now");
});

test("card robinhood-tapes-read-ahead-bounded: the process's own probe sees a loop held synchronously past LOOP_BUSY_MS", async () => {
  loopBusy();
  await new Promise((go) => setTimeout(go, 2 * SAMPLE_MS));
  // hold the loop: three times LOOP_BUSY_MS of synchronous work, so the next sample fires that late
  const until = performance.now() + 3 * LOOP_BUSY_MS;
  while (performance.now() < until);
  assert.equal(loopBusy(), true, "held right now: no sample has come");
  await new Promise((go) => setTimeout(go, SAMPLE_MS));
  assert.equal(loopBusy(), true, "the late sample keeps it busy");
});
