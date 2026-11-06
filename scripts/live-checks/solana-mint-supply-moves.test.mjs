// node --test scripts/live-checks/solana-mint-supply-moves.test.mjs: the live check replays recorded runs
// (solana-mint-supply-moves.answers.json), each a real read of HELPER_HOST and two public Solana RPCs, through the kit's
// own reference read (readSolanaReference) and checks (S6, S10) (card solana-mint-supply-moves).
// - good: a pump.fun token with a moved supply, one dry buy built through the helper, 20 rounds of the mint and the
//   reference read on both RPCs: PASS.
// Made from good, round 1 changed on provider B: the supply a burn moves, in the mint read and in the reference read's
// mint (PASS, the round's line saying so); the reference read's supply 3% lower, outside the reserves' band (FAIL: no
// reference); the mint read's freeze authority (FAIL: S10 names it); a round dropped, 19 rounds (FAIL).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROUNDS, judge } from "./solana-mint-supply-moves.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-mint-supply-moves.answers.json"), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (b64, f) => { const d = Buffer.from(b64, "base64"); f(d); return d.toString("base64"); };
/** good, with round 1's mint read on provider B changed by `mintRead`, and the mint in each of B's reference reads by `refRead`. */
function planted({ mintRead, refRead }) {
  const r = copy(A.good);
  const x = r.rounds[0];
  if (mintRead) x.mint[1] = { ...x.mint[1], data: edit(x.mint[1].data, mintRead) };
  if (refRead) {
    for (const c of x.calls[1]) {
      const m = c.result?.value?.[0];
      assert.ok(JSON.parse(c.key)[1][0][0] === r.mint && m, "each reference read names the mint first");
      m.data[0] = edit(m.data[0], refRead);
    }
  }
  return r;
}
const burn = (d) => d.writeBigUInt64LE(d.readBigUInt64LE(36) - 559_661n, 36);

test("recorded good run: every round's reference read and S6, S10 agree on both providers: PASS", async () => {
  const r = await judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(A.good.rounds.length, ROUNDS);
  assert.equal(r.lines.filter((l) => /^ok {2}round \d+: .*; reference on (pump-curve|pumpswap)\S*, E \d+; S6,S10 pass$/.test(l)).length, ROUNDS, r.lines.join("\n"));
});

test("planted: round 1 on provider B reads the supply a burn moved, in its mint read and its reference read: PASS, the line says so", async () => {
  const r = await judge(planted({ mintRead: burn, refRead: burn }));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.find((l) => l.startsWith("ok  round 1:")), /; read on both providers, the same but for its supply \(\d+ \/ \d+\) or withheld fees, owner \S+; reference on \S+, E \d+; S6,S10 pass$/);
  assert.ok(r.lines.includes(`--  1 of ${ROUNDS} rounds read the mint at two different supplies`), r.lines.join("\n"));
});

test("planted: round 1's reference read on provider B reads the supply 3% lower, outside the band: FAIL, no reference", async () => {
  const r = await judge(planted({ refRead: (d) => d.writeBigUInt64LE((d.readBigUInt64LE(36) * 97n) / 100n, 36) }));
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD round 1: .*; no reference; S6,S10 pass$/);
});

test("planted: round 1's mint read on provider B differs in its freeze authority: FAIL, S10 names it", async () => {
  const r = await judge(planted({ mintRead: (d) => { d.writeUInt32LE(1, 46); d.fill(9, 50, 82); } }));
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD round 1: slots \d+\/\d+; the providers disagree on the mint's freeze authority; reference on \S+, E \d+; refused: S10 the providers disagree on the mint's freeze authority$/);
});

test("planted: 19 rounds, fewer than the check's 20: FAIL", async () => {
  const r = copy(A.good);
  r.rounds.pop();
  const v = await judge(r);
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v), [`BAD ${ROUNDS - 1} rounds (at least ${ROUNDS}) of ${A.good.mint}`]);
});
