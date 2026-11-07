// node --test scripts/live-checks/pool-deposits.test.mjs: the live check replays recorded answers
// (pool-deposits.answers.json). good: the slice 2 devnet deposit (pool-deposits.run.json, built and priced by the kit)
// read on two devnet RPCs, and SIGN_HOST's /app.js with no testnet pin: PASS. bad: the same reads with another
// precommitment in the run's place, whose mark does not exist: FAIL. Planted on the good one: the deposit tx failed, the
// mark's value another, a state leaf another, U not emptied (the cost priced above what the program took): FAIL.
// Slice 3 (the EVM same-chain deposit): good.evm is the release-77 build's index.html and app.js, which pin each other
// and carry the EVM deposit's marks: PASS; bad.evm is SIGN_HOST's release-72 page, which carries none: FAIL. Planted on
// the good one: an index.html that pins another bundle, and a bundle with one mark gone: FAIL. The review fold:
// planted.unrouted is a real build of the fold with the flow's EVM deposit route removed (it still carries every mark,
// since the load's settle pass calls the runner): FAIL, as no release list names it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EVM_MARKS, RUN, check } from "./pool-deposits.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-deposits.answers.json", import.meta.url), "utf8"));
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
const run = (rec, plant, sign = rec.sign, evm = rec.evm) => check({ run: R, precommitment: rec.precommitment, fetchFn: replay(rec.answers, plant), rpcs: rec.rpcs, sleep: async () => {}, sign, evm });
const bad = (r, start) => {
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD  ${start}`)), r.lines.join("\n"));
};

test("recorded good answer: the slice 2 deposit, its mark and both leaves on two devnet RPCs, U at 0, SIGN_HOST the mainnet build: PASS", async () => {
  assert.equal(A.good.precommitment, R.precommitment);
  assert.match(R.by, /pool-deposit-devnet\.mjs/);
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(new Set(A.good.answers.map((a) => a.url)).size, 2, "two RPCs");
  for (const s of ["deposit ", "mark ", "label page ", "state page ", "U "]) assert.equal(r.lines.filter((l) => l.startsWith(`ok   ${s}`)).length, 2, s);
  assert.equal(r.lines.filter((l) => l.startsWith("ok   EVM: ")).length, 2 + Object.keys(EVM_MARKS).length, "the pin, every EVM mark and the released build");
});

test("recorded bad answer: another precommitment in the run's place: FAIL", async () => {
  const r = await run(A.bad);
  bad(r, "the precommitment read is the run's");
  bad(r, "mark ");
  for (const k of Object.keys(EVM_MARKS)) bad(r, `EVM: SIGN_HOST's bundle carries the EVM deposit's ${k}`);
});

test("recorded bad EVM answer alone: SIGN_HOST's release-72 page, before the EVM deposit, with the good Solana reads: FAIL", async () => {
  const r = await run(A.good, undefined, A.good.sign, A.bad.evm);
  assert.equal(r.ok, false);
  assert.ok(!r.lines.some((l) => l.startsWith("BAD ") && !l.startsWith("BAD  EVM: ")), r.lines.join("\n"));
  bad(r, "EVM: SIGN_HOST's bundle carries the EVM deposit's U^evm derivation");
});

test("planted on the good EVM answer: an index.html that pins another bundle, or a bundle with one mark gone: FAIL", async () => {
  bad(await run(A.good, undefined, A.good.sign, { ...A.good.evm, pin: A.bad.evm.pin }), "EVM: SIGN_HOST's served /app.js is the one index.html pins");
  bad(await run(A.good, undefined, A.good.sign, { ...A.good.evm, pin: null }), "EVM: SIGN_HOST's served /app.js is the one index.html pins");
  for (const k of Object.keys(EVM_MARKS)) bad(await run(A.good, undefined, A.good.sign, { ...A.good.evm, marks: { ...A.good.evm.marks, [k]: false } }), `EVM: SIGN_HOST's bundle carries the EVM deposit's ${k}`);
});

test("planted: a real build with pool.deposit on Base and Robinhood no longer routed to the runner, every mark still in it: FAIL", async () => {
  const u = A.planted.unrouted;
  assert.equal(u.pin, u.sha384, "it pins itself");
  assert.ok(Object.keys(EVM_MARKS).every((k) => u.marks[k] === true), "every mark present");
  const r = await run(A.good, undefined, A.good.sign, u);
  bad(r, "EVM: SIGN_HOST's /app.js is a release-77-or-later build");
  assert.ok(!r.lines.some((l) => l.startsWith("BAD ") && !l.includes("release-77-or-later")), r.lines.join("\n"));
});

test("planted on the good answer: the deposit failed, the mark another value, a state leaf another, U not emptied: FAIL", async () => {
  bad(await run(A.good, (a) => (a.method === "getTransaction" && a.json?.result ? ((a.json.result.meta.err = { InstructionError: [0, "Custom"] }), a.json) : a.json)), "deposit ");
  const account = (pick, edit) => (a) => {
    const v = a.json?.result?.value;
    if (a.method !== "getAccountInfo" || !v || !pick(Buffer.from(v.data[0], "base64"))) return a.json;
    const d = Buffer.from(v.data[0], "base64");
    edit(d);
    v.data[0] = d.toString("base64");
    return a.json;
  };
  bad(await run(A.good, account((d) => d.length === 17, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(0) + 1n, 0))), "mark ");
  const o = 16 + Number(BigInt(R.leafIndex) % 1024n) * 72;
  bad(await run(A.good, account((d) => d.subarray(0, 8).toString() === "bfpage01" && d[8] === 0, (d) => (d[o + 31] ^= 1))), "state page ");
  bad(await run(A.good, (a) => (a.method === "getBalance" ? ((a.json.result.value = 1), a.json) : a.json)), "U ");
});
