// Replays buy-carry-helper-round.answers.json: the good answer (this card's helper, in process) passes and the bad one
// (the helper before the card: every lone round refused on its shape, 400 bad_shape) fails, with cases made from the
// good one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judgeAll, plants, poolsHere, WANT } from "./buy-carry-helper-round.mjs";

const A = JSON.parse(readFileSync(new URL("./buy-carry-helper-round.answers.json", import.meta.url), "utf8"));
const edit = (runs, asked, f) => runs.map((run) => ({ ...run, reads: run.reads.map((x) => (x.asked === asked ? f(x) : x)) }));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const W_AT = 1 + 64 * 2 + 4 + 32; // compact(2), two signatures, the message header (v0 prefix and 3 counts), compact keys, key 0

test("recorded good answer: both rounds reach the reads, two wallets refused wallets_differ, a nullifier twice bad_shape: PASS", () => {
  const r = judgeAll(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer, the helper before the card: every plant refused on its shape (400 bad_shape): FAIL on each, on every pool", () => {
  const r = judgeAll(A.bad_before_card);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, Object.keys(WANT).length * A.bad_before_card.length, b.join("\n"));
  assert.ok(b.every((l) => l.includes(" 400 ") && l.includes("bad_shape")), b.join("\n"));
});

test("made from the good answer: a round refused on its shape, a round answered with signatures, two wallets let through, a nullifier twice with another detail, a plant missing, the mainnet pool not read, no commit: each FAIL", () => {
  const g = A.good;
  const shape = (x) => ({ ...x, status: 400, body: '{"error":{"code":"bad_shape","detail":"every transaction a tag 2 but the last, a tag 3"}}' });
  assert.equal(judgeAll(edit(g, "round", shape)).ok, false);
  assert.equal(judgeAll(edit(g, "round_one", (x) => ({ ...x, status: 400, body: '{"error":{"code":"bad_shape","detail":"not 2 to 4 transactions"}}' }))).ok, false);
  assert.equal(judgeAll(edit(g, "round", (x) => ({ ...x, status: 200, body: '{"signatures":["a","b"]}' }))).ok, false);
  assert.equal(judgeAll(edit(g, "round", (x) => ({ ...x, body: JSON.stringify({ error: { code: "blockhash_not_found" }, signatures: ["x"] }) }))).ok, false);
  assert.equal(judgeAll(edit(g, "two_wallets", (x) => ({ ...x, status: 422, body: '{"error":{"code":"blockhash_not_found"}}' }))).ok, false);
  assert.equal(judgeAll(edit(g, "nullifier_twice", shape)).ok, false);
  assert.equal(judgeAll(g.map((run) => ({ ...run, reads: run.reads.filter((x) => x.asked !== "round") }))).ok, false);
  assert.equal(judgeAll(g.filter((run) => run.cluster !== "mainnet")).ok, false);
  assert.equal(judgeAll(edit(g, "fee", (x) => ({ ...x, headers: {} }))).ok, false);
  assert.equal(judgeAll([]).ok, false);
});

test("the pools: the mainnet deploy record's pool first, then poolsToRead's; the recorded runs read each", () => {
  const want = poolsHere();
  assert.equal(want[0].cluster, "mainnet");
  assert.equal(want[0].pool, JSON.parse(readFileSync(new URL("../../contracts/pool-solana/deployments/mainnet.json", import.meta.url), "utf8")).pool);
  assert.deepEqual(A.good.map((r) => `${r.cluster} ${r.pool}`), want.map((w) => `${w.cluster} ${w.pool}`));
});

test("the plants: every one tag 2s only; one W signs both of round, two Ws two_wallets, one nullifier twice in nullifier_twice", () => {
  const f = JSON.parse(A.good[0].reads[0].body);
  const p = plants({ program: f.program, pool: f.pool, feePayer: f.fee_payer, relayFee: BigInt(f.fee) });
  const w = (b64) => Buffer.from(b64, "base64").subarray(W_AT, W_AT + 32).toString("hex");
  // a tag 2's 387 data bytes end the message's last instruction, before the lookup count (0, one byte)
  const data = (b64) => {
    const b = Buffer.from(b64, "base64");
    assert.equal(b[b.length - 1], 0, "no lookup table");
    return b.subarray(b.length - 1 - 387, b.length - 1);
  };
  for (const txs of Object.values(p)) assert.ok(txs.every((t) => data(t)[0] === 2), "every plant a tag 2");
  assert.equal(p.round.length, 2);
  assert.equal(w(p.round[0]), w(p.round[1]));
  assert.equal(p.round_one.length, 1);
  assert.notEqual(w(p.two_wallets[0]), w(p.two_wallets[1]));
  const nul = (b64) => data(b64).subarray(1 + 256 + 32, 1 + 256 + 64).toString("hex"); // tag, proof, newCommitmentHash
  assert.equal(nul(p.nullifier_twice[0]), nul(p.nullifier_twice[1]));
  assert.notEqual(nul(p.round[0]), nul(p.round[1]));
});
