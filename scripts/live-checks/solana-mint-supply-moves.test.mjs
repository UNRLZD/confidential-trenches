// node --test scripts/live-checks/solana-mint-supply-moves.test.mjs: the live check replays recorded runs
// (solana-mint-supply-moves.answers.json), each a real read of HELPER_HOST and two public Solana RPCs, through the kit's
// own reference read (readSolanaReference) and checks (S6, S10) (card solana-mint-supply-moves).
// - good: a pump.fun token with a SOL pool, one dry buy built through the helper, 20 rounds of the mint and the
//   reference read on both RPCs; and the burning token, one dry buy, its mint read on both RPCs until a round read two
//   different supplies (a burn between the two providers' slots): PASS. That round is one main's kit before this card
//   refused (it held the two reads byte for byte): the test pins it so.
// Made from good: the reference token's round 1 on provider B with the supply a burn moves, in the mint read and the
// reference read's mint (PASS, the line saying so); its reference read's supply 3% lower, outside the reserves' band
// (FAIL: no reference); its mint read's freeze authority (FAIL: S10 names it); a reference round dropped (FAIL); the
// burn rounds that read a moved supply read equal (INCONCLUSIVE, never PASS); a burn round's freeze authority (FAIL);
// a burn round dropped below 20 (FAIL).
// - slotApart (card solana-reference-read-holds-a-slot-apart): 20 recorded rounds of 9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump
//   (rounds 12-31 of a run of 60 on 11 Nov 00:03-00:07Z, the burn rounds of the same run). In its round 10 provider A read
//   the pool at slot 467915586 and B at 467915587 with a trade between them: the pool's virtual_quote_reserves (bytes
//   245..261) and fee buckets moved, the vaults inside the band. Its re-read is answered with that same recorded pair, a
//   second trade between the slots as helper live run 42926088151's round 11 had. PASS on this kit, which holds
//   virtual_quote_reserves in the quote reserve's band; main's kit (it compared those bytes as static) printed "BAD round
//   10: ...; no reference; S6,S10 pass" on it, FAIL. Made from it: B's virtual_quote_reserves moving the quote reserve
//   3% (FAIL, the line naming the band).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { solanaMintDisagreement } from "../../packages/kit/src/index.ts";
import { ROUNDS, judge } from "./solana-mint-supply-moves.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-mint-supply-moves.answers.json"), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (b64, f) => { const d = Buffer.from(b64, "base64"); f(d); return d.toString("base64"); };
const supply = (m) => Buffer.from(m.data, "base64").readBigUInt64LE(36);
const read = (m) => ({ owner: m.owner, data: Uint8Array.from(Buffer.from(m.data, "base64")) });
const movedRounds = (r) => r.burn.rounds.map((x, i) => [x, i]).filter(([x]) => x.mint[0] && x.mint[1] && supply(x.mint[0]) !== supply(x.mint[1]));
/** good, with round 1's mint read on provider B changed by `mintRead`, and the mint in each of B's reference reads by
 * `refRead`; a re-read the kit asks is answered as the first read was, on both providers (the record has none: no
 * round of good disagreed), so a refusal is the kit's, never a call the record lacks. */
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
    for (const p of [0, 1]) x.calls[p] = [...x.calls[p], ...copy(x.calls[p])];
  }
  return r;
}
const burn = (d) => d.writeBigUInt64LE(d.readBigUInt64LE(36) - 559_661n, 36);
const freeze = (d) => { d.writeUInt32LE(1, 46); d.fill(9, 50, 82); };

test("recorded good run: every reference round and every burn round agree on both providers, and a burn round read a moved supply: PASS", async () => {
  const r = await judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(A.good.rounds.length, ROUNDS);
  assert.ok(A.good.burn.rounds.length >= ROUNDS);
  assert.equal(r.lines.filter((l) => /^ok {2}round \d+: .*; reference on (pump-curve|pumpswap)\S*, E \d+; S6,S10 pass$/.test(l)).length, ROUNDS, r.lines.join("\n"));
  const moved = movedRounds(A.good);
  assert.ok(moved.length >= 1, "a burn landed between the two providers' reads in the recorded run");
  for (const [, i] of moved) {
    assert.ok(r.lines.some((l) => l.startsWith(`ok  burn round ${i + 1}: `) && /; read on both providers, the same but for its supply \(\d+ \/ \d+\) or withheld fees, owner \S+; S6,S10 pass$/.test(l)), r.lines.join("\n"));
  }
  assert.ok(r.lines.includes(`--  ${moved.length} of ${A.good.burn.rounds.length} burn rounds read the mint at two different supplies`), r.lines.join("\n"));
});

test("recorded good run: its moved-supply rounds are ones main's kit before this card refused (the mint held byte for byte), and the kit agrees on them", () => {
  assert.ok(movedRounds(A.good).length >= 1);
  for (const [x] of movedRounds(A.good)) {
    const [a, b] = x.mint;
    assert.ok(a.owner !== b.owner || a.data !== b.data, "main's S10 and reference read compared the bytes: refused");
    assert.equal(solanaMintDisagreement(read(a), read(b)), null, "the kit's: every field but the supply agrees");
  }
});

test("planted: the reference token's round 1 on provider B reads the supply a burn moved, in its mint read and its reference read: PASS, the line says so", async () => {
  const r = await judge(planted({ mintRead: burn, refRead: burn }));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.find((l) => l.startsWith("ok  round 1:")), /; read on both providers, the same but for its supply \(\d+ \/ \d+\) or withheld fees, owner \S+; reference on \S+, E \d+; S6,S10 pass$/);
  assert.ok(r.lines.includes(`--  1 of ${ROUNDS} reference rounds read the mint at two different supplies`), r.lines.join("\n"));
});

test("planted: round 1's reference read on provider B reads the supply 3% lower, outside the band: FAIL, no reference", async () => {
  const r = await judge(planted({ refRead: (d) => d.writeBigUInt64LE((d.readBigUInt64LE(36) * 97n) / 100n, 36) }));
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD round 1: .*; no reference: pumpswap: the mint's supply is outside the band \(\d+ \/ \d+\), after a re-read; S6,S10 pass$/);
});

const S = A.slotApart;
const I128 = 245;
const vqr = (b64) => { const d = Buffer.from(b64, "base64"); return BigInt.asIntN(128, d.readBigUInt64LE(I128) + (d.readBigUInt64LE(I128 + 8) << 64n)); };
/** Each provider's pool-venue reads of slotApart's round 10, in call order. */
const poolCalls = (r, p) => r.rounds[9].calls[p].filter((c) => JSON.parse(c.key)[1][0].length === 7);
test("recorded slotApart run: a trade between the two providers' slots of round 10, its re-read the same pair: PASS, every round a reference", async () => {
  const r = await judge(S);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(S.mint, "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump");
  assert.equal(S.rounds.length, ROUNDS);
  assert.equal(r.lines.filter((l) => /^ok {2}round \d+: .*; reference on pumpswap, E \d+; S6,S10 pass$/.test(l)).length, ROUNDS, r.lines.join("\n"));
});
test("recorded slotApart run: round 10's two pool reads are a slot apart and differ only in virtual_quote_reserves, the fee buckets and the vaults, the bytes main's kit compared as static", () => {
  const [a, b] = [poolCalls(S, 0)[0].result, poolCalls(S, 1)[0].result];
  assert.deepEqual([a.context.slot, b.context.slot], [467915586, 467915587]);
  const pa = Buffer.from(a.value[1].data[0], "base64");
  const pb = Buffer.from(b.value[1].data[0], "base64");
  const off = [...pa.keys()].filter((i) => pa[i] !== pb[i]);
  assert.ok(off.some((i) => i >= I128 && i < I128 + 16), "virtual_quote_reserves moved");
  assert.ok(off.every((i) => (i >= I128 && i < I128 + 16) || (i >= 271 && i < 287)), `only the moving fields: ${off}`);
  assert.deepEqual([vqr(a.value[1].data[0]), vqr(b.value[1].data[0])], [-14063185n, -14367986n]);
  // its re-read on each provider: the same pair again
  for (const p of [0, 1]) assert.deepEqual(poolCalls(S, p)[1].result, poolCalls(S, p)[0].result);
});
test("every recorded pool pair (good and slotApart, 40 rounds, each pool read on both providers) differs only inside the kit's two pool masks, virtual_quote_reserves 245..261 and the fee buckets 271..287", () => {
  let pairs = 0;
  let moved = 0;
  const offsets = new Set();
  for (const run of [A.good, S]) {
    for (const round of run.rounds) {
      const reads = [0, 1].map((p) => round.calls[p].filter((c) => JSON.parse(c.key)[1][0].length === 7)[0]?.result);
      assert.ok(reads[0] && reads[1], "each round read the pool on both providers");
      const [pa, pb] = reads.map((r) => Buffer.from(r.value[1].data[0], "base64"));
      assert.equal(pa.length, 301);
      assert.equal(pb.length, 301);
      const off = [...pa.keys()].filter((i) => pa[i] !== pb[i]);
      for (const i of off) offsets.add(i);
      pairs++;
      if (off.length) moved++;
    }
  }
  assert.equal(pairs, 40);
  assert.ok(moved > 0, "some pair moved");
  const outside = [...offsets].filter((i) => !((i >= 245 && i < 261) || (i >= 271 && i < 287)));
  assert.deepEqual(outside, [], `bytes outside the masks: ${outside}`);
});

test("planted: slotApart's round 10 with provider B's virtual_quote_reserves moving its quote reserve 3%, every read: FAIL, the line naming the band", async () => {
  const r = copy(S);
  for (const c of poolCalls(r, 1)) {
    const v = c.result.value;
    const q = Buffer.from(v[6].data[0], "base64").readBigUInt64LE(64);
    v[1].data[0] = edit(v[1].data[0], (d) => {
      const x = vqr(d.toString("base64")) + ((q + vqr(d.toString("base64"))) * 3n) / 100n;
      d.writeBigUInt64LE(BigInt.asUintN(64, x), I128);
      d.writeBigUInt64LE(BigInt.asUintN(64, x >> 64n), I128 + 8);
    });
  }
  const v = await judge(r);
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v).map((l) => l.replace(/^BAD round 10: .*?; no reference: /, "")), ["pumpswap: the pool's quote reserve is outside the band, after a re-read; S6,S10 pass"], v.lines.join("\n"));
});

test("planted: round 1's mint read on provider B differs in its freeze authority: FAIL, S10 names it", async () => {
  const r = await judge(planted({ mintRead: freeze }));
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD round 1: slots \d+\/\d+; the providers disagree on the mint's freeze authority; reference on \S+, E \d+; refused: S10 the providers disagree on the mint's freeze authority$/);
});

test("planted: 19 reference rounds, fewer than the check's 20: FAIL", async () => {
  const r = copy(A.good);
  r.rounds.pop();
  const v = await judge(r);
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v), [`BAD ${ROUNDS - 1} reference rounds (at least ${ROUNDS}) of ${A.good.mint}`]);
});

test("planted: no burn round read a moved supply (each B read made A's): INCONCLUSIVE, never PASS", async () => {
  const r = copy(A.good);
  for (const [x] of movedRounds(r)) x.mint[1] = { ...x.mint[0] };
  const v = await judge(r);
  assert.equal(v.ok, false);
  assert.equal(v.inconclusive, true);
  assert.deepEqual(bad(v), []);
  assert.equal(v.lines.at(-1), "--  no burn landed between two reads: the run proves nothing either way");
});

test("planted: a burn round's mint read on provider B differs in its freeze authority: FAIL, S10 names it", async () => {
  const r = copy(A.good);
  const x = r.burn.rounds[0];
  x.mint[1] = { ...x.mint[1], data: edit(x.mint[1].data, freeze) };
  const v = await judge(r);
  assert.equal(v.ok, false);
  assert.equal(v.inconclusive, false);
  assert.equal(bad(v).length, 1, v.lines.join("\n"));
  // S6 too when the route moves the token a second time (C5xph…pump's does)
  assert.match(bad(v)[0], /^BAD burn round 1: slots \d+\/\d+; the providers disagree on the mint's freeze authority; refused: (S6 [^;]*: the providers disagree on the mint's freeze authority; )?S10 the providers disagree on the mint's freeze authority$/);
});

test("planted: 19 burn rounds, fewer than the check's 20: FAIL", async () => {
  const r = copy(A.good);
  const keep = movedRounds(r).map(([x]) => x);
  r.burn.rounds = [...keep, ...r.burn.rounds.filter((x) => !keep.includes(x))].slice(0, ROUNDS - 1);
  const v = await judge(r);
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v), [`BAD ${ROUNDS - 1} burn rounds (at least ${ROUNDS}) of ${A.good.burn.mint}`]);
});
