// node --test scripts/live-checks/pool-buy-record-never-stays-sent.test.mjs: the live check replays its recorded answers
// (pool-buy-record-never-stays-sent.answers.json). good: recorded from this card's build: PASS. bad: SIGN_HOST's served
// page before it (a RESERVED note held to its deadline, the balance leaving it out): FAIL, each fact named. Planted on
// the good one: another /app.js, no pin, each mark taken away: each FAIL. Planted in the good build's own bundle text
// (facts() over the good answer's marks, cut out in place): each rule broken FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-buy-record-never-stays-sent.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-buy-record-never-stays-sent.answers.json", import.meta.url), "utf8"));
const STORE = "BAD the note store frees a RESERVED note only past its deadline, takes a last height on another move, or keeps it in the note record";
const TAKE = "BAD a take does not write the signed transaction's last height on the RESERVED note";
const PASS = "BAD the settle pass does not free a RESERVED note once both RPCs' finalized height is past its last height";
const BALANCE = "BAD the pool balance leaves out a RESERVED note: a buy in flight reads its money gone";
const OLD = "BAD the bundle still holds a RESERVED note until its deadline only";

test("recorded good answer: this card's build: PASS", () => {
  assert.deepEqual(judge(A.good), { ok: true, lines: [] });
});

test("recorded bad answer: SIGN_HOST's page before the card: FAIL, each fact named", () => {
  assert.deepEqual(judge(A.bad), { ok: false, lines: [STORE, TAKE, PASS, BALANCE, OLD] });
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, store: false }).lines, [STORE]);
  assert.deepEqual(judge({ ...g, take: false }).lines, [TAKE]);
  assert.deepEqual(judge({ ...g, pass: false }).lines, [PASS]);
  assert.deepEqual(judge({ ...g, balance: false }).lines, [BALANCE]);
  assert.deepEqual(judge({ ...g, old: true }).lines, [OLD]);
  assert.equal(judge(null).ok, false);
});

// the marks as the build minifies them (read from this card's public/app.js), each broken in place
const JS = [
  "throw Error(`note ${e} is RESERVED until block time is past its deadline_ms, or the finalized height past its last height: its proof can still land`)",
  "throw Error(`a last height or nullifier is written with the move HELD -> RESERVED only`)",
  "JE=[`UNSPENT`,`HELD`,`RESERVED`,`SPENT`],YE=`owed/reserved-notes`;",
  "`leaf`,`deadlineMs`,`attempt`,`tab`,`calls`,`searchFrom`,`sends`,`evmSends`,`evmSpent`,`contexts`,`request`],`note ${e}`)",
  "await n.move(e,`HELD`,`RESERVED`,{attempt:c.attempt,...a===void 0?{}:{lastHeight:a},...o===void 0?{}:{nullifier:o}})",
  "await n.move(r.noteId,`HELD`,`RESERVED`,{attempt:f,...o===void 0?{}:{lastHeight:o}})",
  "let c=await e.take(t.noteId,t.attempt,s?.early,BigInt(a));",
  "l!==void 0&&s(t)!==void 0&&l>s(t)?(await e.notes.move(t.id,`RESERVED`,`UNSPENT`,{finalHeight:l}),n.freed.push(t.id)):n.held.push(t.id)",
  "throw Error(`getEpochInfo: no finalized height`)",
  "if(n.scope!==p.scope||n.state!==`UNSPENT`&&n.state!==`HELD`&&n.state!==`RESERVED`)continue;",
  "throw Error(`note ${n.id}: its landed release withdrew more than it holds`)",
].join(";");

test("planted in the bundle's marks: each rule broken in place FAILs", () => {
  const index = '<script src="/app.js" integrity="x"></script>';
  const f = (js) => facts(index, js);
  assert.deepEqual(f(JS), { index, sha384: f(JS).sha384, store: true, take: true, pass: true, balance: true, old: false }, "the marks hold every rule");
  const broken = (from, to) => {
    assert.ok(JS.includes(from), from);
    return f(JS.replace(from, to));
  };
  assert.equal(broken(", or the finalized height past its last height", "").store, false, "freed past the deadline only");
  assert.equal(broken(", or the finalized height past its last height", "").old, true);
  assert.equal(broken("written with the move HELD -> RESERVED only", "written anywhere").store, false);
  assert.equal(broken("YE=`owed/reserved-notes`", "YE=`x`").store, false, "no marks");
  assert.equal(broken("`contexts`,`request`]", "`contexts`,`request`,`lastHeight`]").store, false, "the height in the note record, which release 116 refuses");
  assert.equal(broken("{attempt:c.attempt,...a===void 0?{}:{lastHeight:a},", "{attempt:c.attempt,").take, false, "the queue's take writes no height");
  assert.equal(broken("{attempt:f,...o===void 0?{}:{lastHeight:o}}", "{attempt:f}").take, false, "the withdraw's take writes no height");
  assert.equal(broken(",BigInt(a))", ")").take, false, "the send hands the take no height");
  assert.equal(broken("{finalHeight:l}", "{blockTimeMs:l}").pass, false, "the pass frees on time only");
  assert.equal(broken("l>s(t)", "l>=s(t)").pass, false, "a height at the last one frees nothing");
  assert.equal(broken("getEpochInfo: no finalized height", "x").pass, false);
  assert.equal(broken("&&n.state!==`RESERVED`", "").balance, false, "a RESERVED note left out of the balance");
  assert.equal(broken("its landed release withdrew more than it holds", "x").balance, false);
});
