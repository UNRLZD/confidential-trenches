// node --test scripts/live-checks/signpage-pool-flow.test.mjs: the live check replays recorded answers
// (signpage-pool-flow.answers.json). good: the testnet build's devnet pin read on two devnet RPCs, and SIGN_HOST's
// /app.js with no testnet pin: PASS. bad: the same reads for the helper's earlier devnet program in the pin's place:
// another code and none of the record's deposit: FAIL. bad_table: the pool account read in the table's place: FAIL.
// Planted on the good one: SIGN_HOST serving a testnet pin, a pool account another program owns, an upgrade authority
// set, the buy failed or paid by another key, and the helper naming another fee payer: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PIN, RUN, check } from "./signpage-pool-flow.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-pool-flow.answers.json", import.meta.url), "utf8"));

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
const run = (rec, plant, sign = rec.sign, helper = rec.helper) => check({ program: rec.program, table: rec.table, fetchFn: replay(rec.answers, plant), rpcs: rec.rpcs, sleep: async () => {}, sign, helper });

test("recorded good answer: the pinned devnet program and pool, read on two devnet RPCs: PASS", async () => {
  assert.equal(A.good.program, PIN.program);
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(new Set(A.good.answers.map((a) => a.url)).size, 2, "two RPCs");
  assert.ok(r.lines.some((l) => l.startsWith("ok   upgrade authority is none")));
  assert.ok(r.lines[0].startsWith("ok   SIGN_HOST's /app.js is the mainnet build"), r.lines[0]);
  for (const [name, sig] of Object.entries(RUN)) assert.ok(r.lines.some((l) => l.startsWith(`ok   ${name} ${sig}: succeeded on both RPCs`)), name);
  assert.ok(r.lines.some((l) => l.startsWith(`ok   table ${PIN.table}`)));
});

test("recorded bad answer: the pool account in the table's place: FAIL", async () => {
  const r = await run(A.bad_table);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD  the table read is the pin's: ${A.bad_table.table}`));
  assert.ok(r.lines.some((l) => l.startsWith(`BAD  table ${A.bad_table.table}: the ALT program's`)), r.lines.join("\n"));
});

test("planted on the good answer: the buy failed on one RPC or another tx's bytes in its place, or the helper naming another fee payer: FAIL", async () => {
  const failed = await run(A.good, (a) => (a.method === "getTransaction" && a.params[0] === RUN.buy && a.url === A.good.rpcs[1] ? ((a.json.result.meta.err = { InstructionError: [0, "Custom"] }), a.json) : a.json));
  assert.equal(failed.ok, false);
  assert.ok(failed.lines.some((l) => l.startsWith(`BAD  buy ${RUN.buy}`)), failed.lines.join("\n"));
  // the deposit's bytes in the buy's place: paid by U, no table, no pump.fun
  const depositTx = A.good.answers.find((a) => a.method === "getTransaction" && a.params[0] === RUN.deposit).json.result.transaction;
  const payer = await run(A.good, (a) => (a.method === "getTransaction" && a.params[0] === RUN.buy ? ((a.json.result.transaction = depositTx), a.json) : a.json));
  assert.equal(payer.ok, false);
  assert.ok(payer.lines.some((l) => l.startsWith(`BAD  buy ${RUN.buy}`)));
  const helper = await run(A.good, undefined, A.good.sign, { ...A.good.helper, json: { ...A.good.helper.json, fee_payer: "11111111111111111111111111111111" } });
  assert.equal(helper.ok, false);
  assert.ok(helper.lines.some((l) => l.startsWith("BAD  the helper's fee answer")));
});

test("recorded bad answer: another devnet program in the pin's place: FAIL", async () => {
  const r = await run(A.bad);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD  the program read is the pin's: ${A.bad.program}`));
  assert.ok(r.lines.some((l) => l.startsWith("BAD  mark ")), r.lines.join("\n"));
});

test("planted on the good answer: SIGN_HOST serving a testnet pin, or not read: FAIL", async () => {
  for (const sign of [{ ...A.good.sign, found: [PIN.program] }, { ...A.good.sign, status: 404 }, null]) {
    const r = await run(A.good, undefined, sign);
    assert.equal(r.ok, false);
    assert.ok(r.lines[0].startsWith("BAD  SIGN_HOST's /app.js is the mainnet build"), r.lines[0]);
  }
});

test("planted on the good answer: the pool owned by another program, or an upgrade authority set: FAIL", async () => {
  const owner = await run(A.good, (a) => (a.method === "getAccountInfo" && a.params[0] === PIN.pool && a.json?.result?.value ? ((a.json.result.value.owner = "11111111111111111111111111111111"), a.json) : a.json));
  assert.equal(owner.ok, false);
  assert.ok(owner.lines.some((l) => l.startsWith(`BAD  pool ${PIN.pool}`)), owner.lines.join("\n"));
  const authority = await run(A.good, (a) => {
    const v = a.json?.result?.value;
    if (a.method !== "getAccountInfo" || !v || a.params[0] === PIN.program || v.owner !== "BPFLoaderUpgradeab1e11111111111111111111111") return a.json;
    const d = Buffer.from(v.data[0], "base64");
    if (d[0] !== 3) return a.json;
    d[12] = 1;
    v.data[0] = d.toString("base64");
    return a.json;
  });
  assert.equal(authority.ok, false);
  assert.ok(authority.lines.some((l) => l.startsWith("BAD  upgrade authority is none")), authority.lines.join("\n"));
});
