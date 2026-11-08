// node --test scripts/live-checks/signpage-pool-flow.test.mjs: the live check replays recorded answers
// (signpage-pool-flow.answers.json). good: the testnet build's devnet pin read on two devnet RPCs, and SIGN_HOST's
// /app.js with no testnet pin: PASS. bad: the same reads for the devnet program before the re-pin in the pin's place:
// another code and none of the record's deposit: FAIL. bad_table: the pool account read in the table's place: FAIL.
// Planted on the good one: SIGN_HOST serving a testnet pin, a pool account another program owns, an upgrade authority
// set, the buy failed or another tx's bytes in its place, the sell not W's alone, and the helper naming another fee
// payer: FAIL.
// Card signpage-pool-flow-answers, each the good run's answers changed as it names: throttled (nine of the second
// provider's reads answering 429 with a Retry-After): PASS after waiting it; null_behind (a null at a slot behind the other provider's value): read again,
// PASS; null_same_slot (a null at the other provider's own slot): FAIL, never read again, the line naming the answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PIN, RUN, check, getRead } from "./signpage-pool-flow.mjs";
import { REREADS, account, answerOf, b58decode, behindOf, devnetPin, onTwoOperators, retryAfterMs } from "./pool-sol-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-pool-flow.answers.json", import.meta.url), "utf8"));
/** The pin every recording is judged on: today's (pool-sol-deploy.devnet.json), as a live run reads it. */
const OLD = devnetPin();
/** The devnet pool before the re-pin (f2d9c7bf), on which no recording may pass. */
const BEFORE = Object.freeze({ program: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", pool: "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr" });

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
    return { ok: a.status === 200, status: a.status, headers: new Headers(a.retry_after ? { "retry-after": a.retry_after } : {}), json: async () => json };
  };
}
const run = (rec, plant, sign = rec.sign, helper = rec.helper, sleep = async () => {}) => check({ program: rec.program, table: rec.table, fetchFn: replay(rec.answers, plant), rpcs: rec.rpcs, sleep, sign, helper });
/** A run the answers file keeps as changes on another (`from`): `set` gives the answer at index i another status, a
 * Retry-After or another body, `copy` serves those answers again after the rest. */
function derived(name) {
  const d = A[name];
  const base = A[d.from];
  const answers = structuredClone(base.answers);
  for (const { i, ...change } of d.set ?? []) {
    if (change.json) answers[i] = { ...answers[i], status: change.status ?? 200, json: change.json };
    if (change.retry_after) answers[i].retry_after = change.retry_after;
  }
  for (const i of d.copy ?? []) answers.push(structuredClone(base.answers[i]));
  return { ...base, answers };
}
const waits = () => {
  const ms = [];
  return { ms, sleep: async (t) => void ms.push(t) };
};

test("recorded good answer: the pinned devnet program and pool, read on two devnet RPCs: PASS", async () => {
  assert.equal(A.good.program, OLD.program);
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(new Set(A.good.answers.map((a) => a.url)).size, 2, "two RPCs");
  assert.ok(r.lines.some((l) => l.startsWith("ok   upgrade authority is none")));
  assert.ok(r.lines[0].startsWith("ok   SIGN_HOST's /app.js is the mainnet build"), r.lines[0]);
  for (const [name, sig] of Object.entries(RUN)) assert.ok(r.lines.some((l) => l.startsWith(`ok   ${name} ${sig}: succeeded on both RPCs`)), name);
  assert.ok(r.lines.some((l) => l.startsWith(`ok   table ${A.good.table}`)));
});

test("recorded bad answer: the pool account in the table's place: FAIL", async () => {
  const r = await run(A.bad_table);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD  the table read is the pin's: ${A.bad_table.table}`));
  assert.ok(r.lines.some((l) => l.startsWith(`BAD  table ${A.bad_table.table}: the ALT program's`)), r.lines.join("\n"));
});

test("planted on the good answer: the buy failed on one RPC or another tx's bytes in its place, the buy's bytes in the sell's place, or the helper naming another fee payer: FAIL", async () => {
  const failed = await run(A.good, (a) => (a.method === "getTransaction" && a.params[0] === RUN.buy && a.url === A.good.rpcs[1] ? ((a.json.result.meta.err = { InstructionError: [0, "Custom"] }), a.json) : a.json));
  assert.equal(failed.ok, false);
  assert.ok(failed.lines.some((l) => l.startsWith(`BAD  buy ${RUN.buy}`)), failed.lines.join("\n"));
  // the deposit's bytes in the buy's place: paid by U, no table, no pump.fun
  const depositTx = A.good.answers.find((a) => a.method === "getTransaction" && a.params[0] === RUN.deposit).json.result.transaction;
  const payer = await run(A.good, (a) => (a.method === "getTransaction" && a.params[0] === RUN.buy ? ((a.json.result.transaction = depositTx), a.json) : a.json));
  assert.equal(payer.ok, false);
  assert.ok(payer.lines.some((l) => l.startsWith(`BAD  buy ${RUN.buy}`)));
  // the buy's bytes in the sell's place: paid by the helper's fee payer, not W
  const buyTx = A.good.answers.find((a) => a.method === "getTransaction" && a.params[0] === RUN.buy).json.result.transaction;
  const sell = await run(A.good, (a) => (a.method === "getTransaction" && a.params[0] === RUN.sell ? ((a.json.result.transaction = buyTx), a.json) : a.json));
  assert.equal(sell.ok, false);
  assert.ok(sell.lines.some((l) => l.startsWith(`BAD  sell ${RUN.sell}`)), sell.lines.join("\n"));
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
  const owner = await run(A.good, (a) => (a.method === "getAccountInfo" && a.params[0] === OLD.pool && a.json?.result?.value ? ((a.json.result.value.owner = "11111111111111111111111111111111"), a.json) : a.json));
  assert.equal(owner.ok, false);
  assert.ok(owner.lines.some((l) => l.startsWith(`BAD  pool ${OLD.pool}`)), owner.lines.join("\n"));
  const authority = await run(A.good, (a) => {
    const v = a.json?.result?.value;
    if (a.method !== "getAccountInfo" || !v || a.params[0] === OLD.program || v.owner !== "BPFLoaderUpgradeab1e11111111111111111111111") return a.json;
    const d = Buffer.from(v.data[0], "base64");
    if (d[0] !== 3) return a.json;
    d[12] = 1;
    v.data[0] = d.toString("base64");
    return a.json;
  });
  assert.equal(authority.ok, false);
  assert.ok(authority.lines.some((l) => l.startsWith("BAD  upgrade authority is none")), authority.lines.join("\n"));
});

test("card signpage-pool-flow-answers, recorded throttled run: each 429 read again after its Retry-After, then PASS", async () => {
  const w = waits();
  const r = await run(derived("throttled"), undefined, A.good.sign, A.good.helper, w.sleep);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(w.ms.length >= 9, `${w.ms.length} waits`);
  assert.deepEqual([...new Set(w.ms)], [2000], `the waits: ${w.ms.join(", ")}`);
});

test("card signpage-pool-flow-answers, recorded null_behind run: a null at a slot behind the other provider's value is read again, then PASS", async () => {
  const w = waits();
  const r = await run(derived("null_behind"), undefined, A.good.sign, A.good.helper, w.sleep);
  assert.equal(r.ok, true, r.lines.join("\n"));
  const again = r.lines.filter((l) => l.startsWith("info ") && l.includes("answered behind"));
  assert.equal(again.length, 1, r.lines.join("\n"));
  const behind = A.null_behind.set[0].json.result.context.slot;
  const ahead = A.good.answers.find((a) => a.url === A.good.rpcs[0] && a.method === "getAccountInfo" && a.params[0] === OLD.pool).json.result.context.slot;
  assert.ok(behind < ahead, `${behind} is behind ${ahead}`);
  assert.ok(again[0].includes(`getAccountInfo "${OLD.pool}" null at slot ${behind}, ${A.good.rpcs[0]} a value at slot ${ahead}`), again[0]);
  assert.ok(r.lines.some((l) => l.startsWith(`ok   pool ${OLD.pool}`) && l.includes(A.good.rpcs[1])), r.lines.join("\n"));
});

test("card signpage-pool-flow-answers, recorded null_same_slot run: a null at the other provider's own slot FAILs, never read again, naming the answer", async () => {
  const w = waits();
  const r = await run(derived("null_same_slot"), undefined, A.good.sign, A.good.helper, w.sleep);
  assert.equal(r.ok, false);
  const slot = A.null_same_slot.set[0].json.result.context.slot;
  assert.ok(r.lines.some((l) => l.startsWith(`BAD  pool ${OLD.pool}`) && l.endsWith(`on ${A.good.rpcs[1]}: missing (HTTP 200, null at slot ${slot})`)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.includes("answered behind")), r.lines.join("\n"));
});

test("card signpage-pool-flow-answers: a null behind that stays behind FAILs at the bound; a transaction's null and a JSON-RPC error name the answer", async () => {
  // a provider that answers null behind the other on every read: read again REREADS times, then its FAIL stands
  let reads = 0;
  const lagging = async (url) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ jsonrpc: "2.0", result: { context: { slot: url === "a" ? 10 : 11 }, value: url === "a" ? null : { owner: "o", executable: false, lamports: 1, data: ["", "base64"] } } }) });
  const walk = await onTwoOperators(["a", "b"], (u) => u, lagging, async (url, say, f) => {
    if (url === "a") reads++;
    const v = await account(f, url, OLD.pool, async () => {});
    say(!!v, `pool on ${url}: ${v ? "a value" : `missing (${answerOf(f, "getAccountInfo", OLD.pool)})`}`);
  }, { sleep: async () => {} });
  assert.equal(reads, 1 + REREADS);
  assert.ok(walk.lines.some(([p, t]) => p === false && t === "pool on a: missing (HTTP 200, null at slot 10)"), JSON.stringify(walk.lines));
  assert.ok(walk.lines.some(([p, t]) => p === null && t.startsWith(`a still answers behind b after ${REREADS} read(s) again`)), JSON.stringify(walk.lines));
  const pool = (slot, value) => ({ method: "getAccountInfo", params: [OLD.pool], status: 200, json: { result: { context: { slot }, value } } });
  assert.equal(behindOf([pool(10, null)], [pool(11, {})]).length, 1);
  assert.equal(behindOf([pool(11, null)], [pool(11, {})]).length, 0, "the same slot is a disagreement");
  assert.equal(behindOf([pool(12, null)], [pool(11, {})]).length, 0, "a slot past it is a disagreement");
  const tx = (result) => ({ method: "getTransaction", params: ["sig"], status: 200, json: { result } });
  assert.equal(behindOf([tx(null), pool(99, {})], [tx({ slot: 100 })]).length, 1, "a tx null on a provider whose reads stand before the tx's slot");
  assert.equal(behindOf([tx(null), pool(100, {})], [tx({ slot: 100 })]).length, 0, "a tx null on a provider at the tx's slot");
  const gone = await run(A.good, (a) => (a.method === "getTransaction" && a.params[0] === RUN.sell && a.url === A.good.rpcs[1] ? ((a.json.result = null), a.json) : a.json));
  assert.equal(gone.ok, false);
  assert.ok(gone.lines.some((l) => l.startsWith(`BAD  sell ${RUN.sell}`) && l.includes(`not found (HTTP 200, null on ${A.good.rpcs[1]})`)), gone.lines.join("\n"));
  const refused = await run(A.good, (a) => (a.method === "getAccountInfo" && a.params[0] === A.good.table && a.url === A.good.rpcs[1] && a.json.result ? { jsonrpc: "2.0", error: { code: -32602, message: "Invalid param" } } : a.json));
  assert.equal(refused.ok, false);
  assert.ok(refused.lines.some((l) => l === `BAD  read on ${A.good.rpcs[1]}: getAccountInfo: HTTP 200 {"code":-32602,"message":"Invalid param"}`), refused.lines.join("\n"));
});

test("card signpage-pool-flow-answers: Retry-After in seconds or as an HTTP date; the helper's and SIGN_HOST's GET read again on a 429", async () => {
  const h = (v) => ({ headers: new Headers(v === undefined ? {} : { "retry-after": v }) });
  assert.equal(retryAfterMs(h("7")), 7000);
  assert.equal(retryAfterMs(h(new Date(Date.parse("2026-11-06T13:00:10Z")).toUTCString()), Date.parse("2026-11-06T13:00:00Z")), 10000);
  assert.equal(retryAfterMs(h()), null);
  assert.equal(retryAfterMs(h("soon")), null);
  const answers = [{ status: 429, ra: "3" }, { status: 200 }];
  const w = waits();
  const r = await getRead(async () => { const a = answers.shift(); return { status: a.status, headers: new Headers(a.ra ? { "retry-after": a.ra } : {}) }; }, "u", w.sleep);
  assert.equal(r.status, 200);
  assert.deepEqual(w.ms, [3000]);
});

test("the pin is today's: the good recording names today's program, pool and table; the run's transactions on the pool before the re-pin FAIL; no record or table pin is handed in", async () => {
  const now = devnetPin();
  assert.equal(A.good.deployment.program_id, now.program);
  assert.equal(A.good.deployment.pool, now.pool);
  assert.equal(A.good.pin_table, PIN.table);
  assert.equal(PIN.program, now.program);
  assert.equal(PIN.pool, now.pool);
  // the same answers with every transaction on the pool before the re-pin (2S5wpE7U, its program 5V9iJECf): the keys in
  // the base64 bytes and the logs both moved
  const swap = (bytes) => {
    const out = Buffer.from(bytes);
    for (const [from, to] of [[now.pool, BEFORE.pool], [now.program, BEFORE.program]]) {
      const f = Buffer.from(b58decode(from));
      for (let i = out.indexOf(f); i >= 0; i = out.indexOf(f, i + 32)) Buffer.from(b58decode(to)).copy(out, i);
    }
    return out;
  };
  const before = (a) => {
    if (a.method !== "getTransaction" || !a.json?.result) return a.json;
    const j = JSON.parse(JSON.stringify(a.json).replaceAll(now.pool, BEFORE.pool).replaceAll(now.program, BEFORE.program));
    const t = j.result.transaction;
    if (Array.isArray(t) && t[1] === "base64") j.result.transaction = [swap(Buffer.from(t[0], "base64")).toString("base64"), "base64"];
    return j;
  };
  const r = await run(A.good, before);
  assert.equal(r.ok, false);
  for (const name of Object.keys(RUN)) assert.ok(r.lines.some((l) => l.startsWith(`BAD  ${name} ${RUN[name]}`)), `${name}\n${r.lines.join("\n")}`);
  // the helper's fee answer for the pool before the re-pin: refused
  const helper = { ...A.good.helper, json: { ...A.good.helper.json, program: BEFORE.program, pool: BEFORE.pool } };
  assert.ok((await run(A.good, undefined, A.good.sign, helper)).lines.some((l) => l.startsWith("BAD  the helper's fee answer names the pin's program")));
  // a replay may not hand the check its recording's deploy record or table pin
  for (const extra of [{ deployment: A.good.deployment }, { pinTable: A.good.pin_table }]) await assert.rejects(check({ ...extra, program: A.good.program, table: A.good.table, fetchFn: replay(A.good.answers), rpcs: A.good.rpcs, sleep: async () => {}, sign: A.good.sign, helper: A.good.helper }), /today's devnet pin and table only/);
});
