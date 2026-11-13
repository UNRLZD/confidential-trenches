// node --test packages/signpage/test/pool-withdraw-every-lamport.test.ts: a Solana withdraw never leaves a note no step
// can move, and never releases an exact off-grid amount from a note it does not finish (card every-lamport-can-move).
// Over note sets and typed amounts at mainnet's costs: every part's chunk is its whole note or a multiple of 0.001 SOL,
// every change is 0 or at least the floor and on the grid, and an amount no plan sends exactly is offered the nearest
// ones that plan. Test values only.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { nearestPlannable, planPoolWithdraw, poolWithdrawable, runPoolWithdraw, type WithdrawCosts, type WithdrawSource } from "../src/pool-withdraw.ts";
import { ASK, closers, COST, TO, world } from "./pool-withdraw-world.ts";
import { changeMoves, isReleaseSize, pieceChunk, SOL_GRID } from "../../wallet/src/pool/pieces.ts";
import { SOL_PIECES } from "../../wallet/src/pool/solana.ts";

const fee = 1_300_000n;
const wFee = 5_000n;
const C: WithdrawCosts = { fee, wFee, minPart: fee - wFee, pieces: SOL_PIECES };
const M = 1_000_000n;

after(async () => {
  for (const c of closers.splice(0)) await c();
});

const SETS: WithdrawSource[][] = [
  [{ id: "a", value: 50n * M }],
  [{ id: "a", value: 20n * M }, { id: "b", value: 7n * M }],
  [{ id: "a", value: 13n * M }, { id: "b", value: 5n * M }, { id: "c", value: 8n * M }],
  [{ id: "a", value: 200n * M }, { id: "b", value: 27n * M }, { id: "c", value: 9n * M }, { id: "d", value: 6n * M }],
  // notes made before the rule, off the grid: the owner's shape
  [{ id: "a", value: 9_517_440n }, { id: "b", value: 4_120_333n }, { id: "c", value: 2_731_005n }],
  // on the grid, under the floor: main's planner left these (review P3-2 of 00d6bef00)
  [{ id: "a", value: 4n * M }, { id: "b", value: 3n * M }, { id: "c", value: 20n * M }],
];

test("every lamport: each withdraw part is its whole note or on the grid, and every change moves", () => {
  for (const notes of SETS) {
    const most = poolWithdrawable(notes, C);
    let planned = 0;
    for (let amount = C.minPart; amount <= most; amount += 137_731n) {
      const plan = planPoolWithdraw(notes, amount, C);
      if (plan === null) {
        const near = nearestPlannable(notes, amount, C);
        for (const x of [near.below, near.above]) if (x !== undefined) assert.notEqual(planPoolWithdraw(notes, x, C), null, `${amount}: the offered ${x} plans`);
        continue;
      }
      planned++;
      const sent = plan.reduce((t, p) => t + p.part, 0n);
      assert.ok(sent >= amount && sent - amount < SOL_GRID, `${amount}: sends ${sent}, at least it and under one grid step more`);
      for (const p of plan) {
        const n = notes.find((x) => x.id === p.noteId)!;
        assert.equal(p.chunk, p.part + fee + wFee);
        const whole = p.chunk === n.value;
        // every release a rung, but a note made before the rule finishing whole where the piece rule takes it whole (no
        // rung of it leaves a change that moves; card pool-amounts-are-standard-sizes), or under the floor
        assert.ok(isReleaseSize(SOL_PIECES, p.chunk) || (whole && (pieceChunk(SOL_PIECES, n.value) === n.value || n.value < SOL_PIECES.floor)), `${amount}: ${p.chunk} from ${n.value} is not on the list`);
        assert.ok(whole || changeMoves(SOL_PIECES, n.value - p.chunk) || n.value % SOL_GRID !== 0n, `${amount}: change ${n.value - p.chunk}`);
        assert.ok(whole || n.value - p.chunk >= SOL_PIECES.floor, `${amount}: change ${n.value - p.chunk} under the floor`);
      }
    }
    assert.ok(planned > 0, "some amounts plan");
    assert.notEqual(planPoolWithdraw(notes, most, C), null, "withdraw-all plans");
  }
});

test("every lamport: the run plans with the pool's piece rule: a plannable amount's chunk is a rung, To gets all of it, W at 0", async () => {
  // card pool-amounts-are-standard-sizes: 5,000,000 plans no part (its chunk would be 6,305,000, no rung); the nearest
  // amount above it that plans is the 10,000,000 rung's part
  const notes = [{ id: "a", value: 30_000_000n }];
  assert.equal(planPoolWithdraw(notes, 5_000_000n, C), null);
  const above = nearestPlannable(notes, 5_000_000n, C).above!;
  assert.equal(above, 10_000_000n - fee - wFee);
  const wd = await world([30_000_000n]);
  const host = { ...wd.host, pool: { ...wd.host.pool, pieces: SOL_PIECES } };
  const a = await runPoolWithdraw(host, ASK, TO, above, COST);
  assert.equal(a.stage, "sent", `stopped: ${a.cause}`);
  assert.equal(wd.binds.length, 1);
  assert.equal(wd.binds[0]!.chunk, 10_000_000n, "a rung (0.01 SOL)");
  assert.equal(wd.balance.get(TO), 10_000_000n - COST, "W sends all it holds");
  // the change, 20,000,000, is a rung and at least the floor
  assert.ok(changeMoves(SOL_PIECES, 30_000_000n - wd.binds[0]!.chunk));
  assert.ok(isReleaseSize(SOL_PIECES, 30_000_000n - wd.binds[0]!.chunk));
});

test("every lamport: a note made before the rule on the grid but under the floor withdraws whole (review P3-2 of 00d6bef00)", () => {
  for (const v of [4n * M, 3n * M]) {
    const notes = [{ id: "a", value: v }];
    assert.equal(poolWithdrawable(notes, C), v - fee - wFee, `${v}`);
    const plan = planPoolWithdraw(notes, v - fee - wFee, C);
    assert.deepEqual(plan?.map((p) => p.chunk), [v], `${v}: one whole part`);
  }
});
