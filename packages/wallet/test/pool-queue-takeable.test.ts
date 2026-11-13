// Card buy-spends-several-pieces: the queue offers only what take() hands out. A newest-root proof is takeable until
// its epoch's end + NEWEST_GRACE_MS; while its remake runs past that (a slow prover, tier 2 made in the pass after tier
// 1), ready() and readyWith leave it out and name its note as making, and readyAt reads the take's own clock, so a
// screen never shows, and a pick never takes, a proof the tap is then refused (on the mainnet copy a Max of 4 pieces
// answered "failed" in 2 of 3 runs this way).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { proofLate } from "../src/pool/queue.ts";
import { closeVaults } from "./withdraw-fixture.ts";
import { E, L, START, lateSetup as setup } from "./queue-late-fixture.ts";

after(closeVaults);

test("proofLate: one rule for the take and the list (the previous epoch, the newest root's grace, the send margin)", () => {
  const pool = { epochMs: E, sendMarginMs: 120_000n };
  const r = (root: "epoch" | "newest") => ({ epochStartMs: START, root, deadlineMs: START + L });
  assert.equal(proofLate(r("newest"), START + E + 14_999n, pool), undefined);
  assert.match(proofLate(r("newest"), START + E + 15_000n, pool)!, /newest root/);
  assert.equal(proofLate(r("epoch"), START + E + 59_999n, pool), undefined);
  assert.match(proofLate(r("epoch"), START + 2n * E, pool)!, /previous epoch/);
  assert.match(proofLate({ ...r("epoch"), deadlineMs: START + 120_000n + 15_000n - 1n }, START, pool)!, /send margin/);
});

for (const piecesMax of [undefined, 4]) {
  test(`a newest-root proof past the boundary + 15 s, its remake not done: out of ready(), readyAt and readyWith, its note making; the rested one stays${piecesMax ? " (both tiers)" : ""}`, async () => {
    const { pool, q, fresh, clock, shut, open } = await setup(piecesMax);
    const before = q.ready();
    assert.ok(before.some((r) => r.noteId === fresh.id && r.root === "newest"), "the fresh note is ready on the newest root");
    if (piecesMax) assert.ok(before.some((r) => r.own !== true), "a tier 2 proof is ready");
    // the boundary: the pass's remakes wait on the slow prover
    shut();
    pool.t.now = START + E + 1_000n;
    const pass = q.refresh();
    try {
      for (let k = 0; k < 50; k++) await new Promise((ok) => setTimeout(ok, 1));
      // 9 s in (the pass read the pool's time 1 s in): takeable for over NOW_REUSE_MS more, still offered
      clock.ms += 8_000;
      pool.t.now = START + E + 9_000n;
      assert.ok(q.ready().some((r) => r.noteId === fresh.id), "offered inside the grace, the reuse window before its end");
      // 11 s in: still takeable for 4 s, but inside the reuse window before the take would refuse it: no list offers it
      clock.ms += 2_000;
      pool.t.now = START + E + 11_000n;
      assert.ok(!q.ready().some((r) => r.noteId === fresh.id && r.root === "newest"), "offered inside the reuse window before the take refuses it (review P3-1)");
      assert.ok(!(await q.readyAt(Promise.resolve({ ms: START + E + 11_000n, at: performance.now(), wall: Date.now() }))).some((r) => r.noteId === fresh.id && r.root === "newest"), "readyAt(early) offers it inside that window");
      clock.ms += 5_000;
      pool.t.now = START + E + 16_000n;
      const late = (await q.readyWith(async () => null));
      assert.ok(!q.ready().some((r) => r.noteId === fresh.id && r.root === "newest"), "ready() offers the late newest-root proof");
      assert.ok(!late.ready.some((r) => r.noteId === fresh.id && r.root === "newest"), "readyWith offers the late newest-root proof");
      assert.ok(!(await q.readyAt()).some((r) => r.noteId === fresh.id && r.root === "newest"), "readyAt offers the late newest-root proof");
      assert.ok(late.making.includes(fresh.id), "the late note is not named making");
      // the rested note's epoch-root proof stays takeable all of the next epoch
      const rested = q.ready().filter((r) => r.noteId !== fresh.id && r.own === true);
      assert.equal(rested.length, 1);
      const t = await q.take(rested[0]!.noteId, rested[0]!.attempt);
      assert.equal(t.noteId, rested[0]!.noteId);
    } finally {
      open();
      await pass.catch(() => {});
      await q.close();
    }
  });
}

test("readyAt on the take's clock: an early read of the pool's time stands for it (the buy's pick and take on one clock)", async () => {
  const { pool, q, fresh, clock, shut, open } = await setup();
  shut();
  pool.t.now = START + E + 1_000n;
  const pass = q.refresh();
  try {
    for (let k = 0; k < 50; k++) await new Promise((ok) => setTimeout(ok, 1));
    // the list's own clock has not moved, but the buy's early read is 16 s in: readyAt goes by the read
    const early = Promise.resolve({ ms: START + E + 16_000n, at: performance.now(), wall: Date.now() });
    assert.ok(q.ready().some((r) => r.noteId === fresh.id), "the list's clock is still inside the grace");
    assert.ok(!(await q.readyAt(early)).some((r) => r.noteId === fresh.id && r.root === "newest"), "readyAt(early) offers what the take at that time refuses");
    void clock;
  } finally {
    open();
    await pass.catch(() => {});
    await q.close();
  }
});

// review of b57f4eb28 (P3-1, P3-3): the guards no test killed, from the review's probes A, B and D
// setup's passes read the pool's time START + 11_000 with the monotonic clock at 0; the fresh note's newest-root proof
// (epoch START) is late from START + E + 15_000, 64_000 ms of device time later, and out of every list 5 s before
const LATE_IN = 64_000;

test("a late note with no pass run since (nothing in flight) is named making by its lateness alone", async () => {
  const { q, fresh, clock } = await setup();
  try {
    clock.ms += LATE_IN + 1;
    const r = await q.readyWith(async () => null);
    assert.ok(!r.ready.some((p) => p.noteId === fresh.id && p.root === "newest"), "the late proof offered");
    assert.ok(r.making.includes(fresh.id), `the late note not named making: ${JSON.stringify(r.making)}`);
  } finally {
    await q.close();
  }
});

test("a sleep (the wall clock runs, the monotonic one stops) takes the late proof out of ready()", async () => {
  const { q, fresh } = await setup();
  const real = Date.now;
  let off = 0;
  Date.now = () => real() + off;
  try {
    assert.ok(q.ready().some((p) => p.noteId === fresh.id && p.root === "newest"), "offered before the sleep");
    off = LATE_IN + 1;
    assert.ok(!q.ready().some((p) => p.noteId === fresh.id && p.root === "newest"), "after a sleep ready() still offers the late newest-root proof");
  } finally {
    Date.now = real;
    await q.close();
  }
});

test("a pool read that answers an earlier time (a lagging provider) never moves the queue's time back", async () => {
  const { q, fresh, pool, clock } = await setup();
  try {
    clock.ms += LATE_IN + 1;
    assert.ok(!q.ready().some((p) => p.noteId === fresh.id && p.root === "newest"), "late before the read");
    // the take's own read (no early) answers a time before the passes' read: the list keeps the later one
    const saved = pool.t.now;
    pool.t.now = START + 10_000n;
    await q.readyAt();
    pool.t.now = saved;
    assert.ok(!q.ready().some((p) => p.noteId === fresh.id && p.root === "newest"), "an earlier read put the late proof back on the list");
  } finally {
    await q.close();
  }
});

test("the pick-to-take window: readyAt(early) never offers a newest-root proof with under NOW_REUSE_MS of its grace left", async () => {
  const { q, fresh } = await setup();
  try {
    const at = (ms: bigint) => Promise.resolve({ ms, at: performance.now(), wall: Date.now() });
    assert.ok((await q.readyAt(at(START + E + 9_000n))).some((p) => p.noteId === fresh.id && p.root === "newest"), "offered with over 5 s left");
    assert.ok(!(await q.readyAt(at(START + E + 15_000n - 100n))).some((p) => p.noteId === fresh.id && p.root === "newest"), "offered 100 ms before its take would refuse it");
  } finally {
    await q.close();
  }
});
