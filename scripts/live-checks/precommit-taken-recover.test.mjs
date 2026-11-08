// node --test scripts/live-checks/precommit-taken-recover.test.mjs: the live check replays recorded answers
// (precommit-taken-recover.answers.json). good: the devnet front-run run (precommit-taken-recover.run.json) read on two
// devnet RPCs: PASS. bad: the same reads with another precommitment in the restored note's place, whose mark does not
// exist: FAIL. Planted on the good one: the restored note's mark of the rung U signed (not the value the stranger's
// deposit carried), a record claiming the note restored at the rung, the stranger's deposit failed or paid by U, a
// state leaf another, an answer that did not fill: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RUN, RUNG, check, notesOf } from "./precommit-taken-recover.mjs";

const A = JSON.parse(readFileSync(new URL("./precommit-taken-recover.answers.json", import.meta.url), "utf8"));
const R = JSON.parse(readFileSync(RUN, "utf8"));

/** Answers served in recorded order by (url, method, params); `plant` may change one recorded result. */
function replay(answers, plant = (a) => a.json) {
  const used = new Set();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = answers.findIndex((a, j) => !used.has(j) && a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
    if (i < 0) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    used.add(i);
    const a = answers[i];
    const json = plant(structuredClone(a));
    return { ok: a.status === 200, status: a.status, json: async () => json };
  };
}
const run = (rec, plant, r = R) => check({ run: r, deployment: rec.deployment, precommitment: rec.precommitment, fetchFn: replay(rec.answers, plant), rpcs: rec.rpcs, sleep: async () => {} });
const bad = (r, start) => {
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD  ${start}`)), r.lines.join("\n"));
};
const markAccount = (pick, edit) => (a) => {
  const v = a.json?.result?.value;
  if (a.method !== "getAccountInfo" || !v || !pick(a, Buffer.from(v.data[0], "base64"))) return a.json;
  const d = Buffer.from(v.data[0], "base64");
  edit(d);
  v.data[0] = d.toString("base64");
  return a.json;
};

test("recorded good answer: the stranger's deposit, U's next deposit, and both notes' marks and leaves on two devnet RPCs: PASS", async () => {
  assert.equal(A.good.precommitment, notesOf(R).restored.precommitment);
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(new Set(A.good.answers.map((a) => a.url)).size, 2, "two RPCs");
  for (const s of ["the stranger's deposit ", "U's deposit ", "restored note's mark ", "next note's mark ", "restored note's state page ", "next note's state page "]) assert.equal(r.lines.filter((l) => l.startsWith(`ok   ${s}`)).length, 2, s);
});

test("recorded bad answer: another precommitment in the restored note's place, no such mark: FAIL", async () => {
  const r = await run(A.bad);
  bad(r, "the precommitment read is the restored note's");
  bad(r, "restored note's mark ");
});

test("planted: the restored note's mark says the rung U signed, not the value the stranger's deposit carried: FAIL", async () => {
  const { restored } = notesOf(R);
  // the restored mark is the 17-byte account whose value is MIN_DEPOSIT in the recording
  const r = await run(A.good, markAccount((_, d) => d.length === 17 && d.readBigUInt64LE(0) === BigInt(restored.leaf.value), (d) => d.writeBigUInt64LE(RUNG, 0)));
  bad(r, "restored note's mark ");
});

test("planted: a record claiming the note restored at the rung, or the rung's note missing, or the answer not filled: FAIL", async () => {
  const at = (edit) => {
    const r = structuredClone(R);
    edit(r);
    return r;
  };
  bad(await run(A.good, undefined, at((r) => (notesOf(r).restored.leaf.value = String(RUNG)))), "the restored note is the deposit note");
  bad(await run(A.good, undefined, at((r) => (r.notes = r.notes.filter((n) => n.ref.kind !== "second")))), "the rung landed on U's next note");
  bad(await run(A.good, undefined, at((r) => (r.answer = { error: "failed" }))), "the run's answer is filled");
});

test("planted on the good answer: the stranger's deposit failed, or paid by U; a state leaf another: FAIL", async () => {
  const sig = R.taken.signature;
  bad(await run(A.good, (a) => (a.method === "getTransaction" && a.params[0] === sig && a.json?.result ? ((a.json.result.meta.err = { InstructionError: [0, "Custom"] }), a.json) : a.json)), "the stranger's deposit ");
  bad(await run(A.good, (a) => (a.method === "getTransaction" && a.params[0] === sig && a.json?.result ? ((a.json.result.transaction.message.accountKeys[0] = R.U), a.json) : a.json)), "the stranger's deposit ");
  const { restored } = notesOf(R);
  const o = 16 + Number(BigInt(restored.leaf.leafIndex) % 1024n) * 72;
  bad(await run(A.good, markAccount((_, d) => d.subarray(0, 8).toString() === "bfpage01" && d[8] === 0 && d.length >= o + 32, (d) => (d[o + 31] ^= 1))), "restored note's state page ");
});

// card signpage-pool-flow-answers: a null read names the provider's own answer (HTTP status, the null and its slot)
/** `kinds` of the good run's reads answered null on every provider (so neither stands behind a value): "tx", "mark"
 * (a 17-byte account), "page" ("bfpage01"). Each planted null's context slot is collected in `slots`. */
const nulls = (kinds, slots) => (a) => {
  if (a.method === "getTransaction" && kinds.includes("tx") && a.json?.result) return ((a.json.result = null), a.json);
  const v = a.json?.result?.value;
  if (a.method !== "getAccountInfo" || !v) return a.json;
  const d = Buffer.from(v.data[0], "base64");
  const kind = d.length === 17 ? "mark" : d.subarray(0, 8).toString() === "bfpage01" ? "page" : null;
  if (!kinds.includes(kind)) return a.json;
  slots.add(a.json.result.context.slot);
  a.json.result.value = null;
  return a.json;
};
const namesNull = (r, start, slots) => {
  const got = r.lines.filter((l) => l.startsWith(`BAD  ${start}`));
  assert.ok(got.length >= 2, r.lines.join("\n"));
  for (const l of got) {
    const m = slots ? l.match(/: missing \(HTTP 200, null at slot (\d+)\)$/) : l.match(/: not found \(HTTP 200, null\)$/);
    assert.ok(m && (!slots || slots.has(Number(m[1]))), l);
  }
};

test("card signpage-pool-flow-answers, planted on the good answer: both deposits and both notes' marks, or the pages, answered null name HTTP 200, null at slot N: FAIL", async () => {
  const slots = new Set();
  const r = await run(A.good, nulls(["tx", "mark"], slots));
  assert.equal(r.ok, false);
  namesNull(r, "the stranger's deposit ");
  namesNull(r, "U's deposit ");
  namesNull(r, "restored note's mark ", slots);
  namesNull(r, "next note's mark ", slots);
  const pageSlots = new Set();
  const p = await run(A.good, nulls(["page"], pageSlots));
  namesNull(p, "restored note's label page ", pageSlots);
  namesNull(p, "next note's state page ", pageSlots);
});

test("the pin is the deploy record's: the good recording PASSES against its own record and FAILS against today's", async () => {
  const { devnetPin } = await import("./pool-sol-deploy.mjs");
  const now = devnetPin();
  assert.equal(devnetPin(A.good.deployment).program, "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ");
  assert.equal((await run(A.good)).ok, true);
  const r = await run({ ...A.good, deployment: now.record });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD  the run is on the pinned devnet pool ${now.pool}`)), r.lines.join("\n"));
});
