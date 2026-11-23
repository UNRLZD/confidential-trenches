// node --test scripts/live-checks/relayer-fresh-near.test.mjs: the live check replays recorded runs
// (relayer-fresh-near.answers.json). good: this branch's quoter (apps/helper/src/withdraw/fee.ts) served on NEAR mainnet
// reads, 30 quotes 7 s apart (23 Nov 08:55-08:59Z): every epoch's answers name one fee while NEAR's price moved: PASS;
// its two 503 upstream answers (a public RPC's 429 to the keyless quoter) are not judged. bad_per_block: the deployed
// helper (main before this card, which prices each block afresh) read the same way (08:51Z): two fees in one epoch:
// FAIL. Made from the good run: a fee changed inside an epoch, an answer that is not 200 (a 503 that is not upstream,
// a 500), providers that disagree on a block, one answer per epoch only: each FAIL; a 503 upstream in place of a good
// answer is not judged. The creation half: absent until a withdrawal to a fresh id is recorded
// (held); its judge is held to a created id (exactly its own key), a missing one, one with a second key, and one read on
// one provider only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { idKeyOf, judge } from "./relayer-fresh-near.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "relayer-fresh-near.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good run: this branch's quoter on mainnet reads answers one fee in each epoch while the price moves: PASS, the creation half held", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /px moved [1-9]/.test(l)), "NEAR's price moved inside an epoch of the recording");
  assert.ok(r.lines.some((l) => l.startsWith("--  held: no withdrawal to a fresh id is recorded")));
});

test("recorded bad_per_block run: a helper that prices each block afresh answers two fees in one epoch: FAIL", () => {
  const r = judge(A.bad_per_block);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("more than one fee in one epoch")), bad(r).join("\n"));
});

test("made from the good run: a fee changed inside an epoch, an answer not 200, a block the providers disagree on, no epoch with two answers: each FAIL", () => {
  const g = A.good;
  const body = (r, f) => ({ ...r, body: JSON.stringify(f(JSON.parse(r.body))) });
  const last = g.reads.length - 1;
  const cases = {
    "a fee changed": { ...g, reads: g.reads.map((r, i) => (i === 1 ? body(r, (b) => ({ ...b, relay_fee: String(BigInt(b.relay_fee) + 1n) })) : r)) },
    "not 200": { ...g, reads: g.reads.map((r, i) => (i === last ? { ...r, status: 503 } : r)) },
    "500 upstream": { ...g, reads: g.reads.map((r, i) => (i === last ? { ...r, status: 500, body: JSON.stringify({ error: { code: "upstream" } }) } : r)) },
    "503 not upstream": { ...g, reads: g.reads.map((r, i) => (i === last ? { ...r, status: 503, body: JSON.stringify({ error: { code: "relayer_low" } }) } : r)) },
    "providers disagree": { ...g, reads: g.reads.map((r, i) => (i === 0 ? { ...r, block: { ...r.block, ns: [r.block.ns[0], "1"] } } : r)) },
    "one answer per epoch": { ...g, reads: [g.reads[0]] },
  };
  for (const [why, run] of Object.entries(cases)) assert.equal(judge(run).ok, false, why);
  // the helper's 503 upstream (its providers did not answer; the device asks again) in place of a judged answer
  const busy = judge({ ...g, reads: g.reads.map((r, i) => (i === last ? { ...r, status: 503, body: JSON.stringify({ error: { code: "upstream" } }), block: { error: "no valid_until_block" } } : r)) });
  assert.ok(busy.lines.some((l) => l.startsWith(`--  [${last}] `) && l.includes("503 upstream")), busy.lines.join("\n"));
  assert.equal(bad(busy).length, 0, bad(busy).join("\n"));
});

test("the creation half: a created id holding exactly its own key on both providers passes; absent, a second key, a function-call key or one provider only fails", () => {
  const id = "0b".repeat(32);
  const own = { public_key: idKeyOf(id), permission: "FullAccess" };
  const fee = { reads: A.good.reads };
  const at = (answers) => judge({ ...fee, created: { id, height: 1, answers } });
  assert.equal(at([{ account: true, keys: [own] }, { account: true, keys: [own] }]).ok, true);
  assert.equal(at([{ absent: true }, { absent: true }]).ok, false);
  assert.equal(at([{ account: true, keys: [own] }, { absent: true }]).ok, false);
  assert.equal(at([{ account: true, keys: [own, { public_key: idKeyOf("0c".repeat(32)), permission: "FullAccess" }] }, { account: true, keys: [own] }]).ok, false);
  assert.equal(at([{ account: true, keys: [{ ...own, permission: { FunctionCall: {} } }] }, { account: true, keys: [own] }]).ok, false);
  assert.equal(at([{ account: true, keys: [own] }]).ok, false);
  // the id key: the base58 of the id's 32 bytes, as send.ts idKeyOf writes it (all-zero bytes are 32 ones)
  assert.equal(idKeyOf("00".repeat(32)), `ed25519:${"1".repeat(32)}`);
});
