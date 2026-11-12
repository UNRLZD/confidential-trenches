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
      // 14 s in (the pass read the pool's time 1 s in): still takeable, still offered
      clock.ms += 13_000;
      pool.t.now = START + E + 14_000n;
      assert.ok(q.ready().some((r) => r.noteId === fresh.id), "offered inside the grace");
      // 16 s in: the take refuses the newest-root proof, so nothing offers it
      clock.ms += 2_000;
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
