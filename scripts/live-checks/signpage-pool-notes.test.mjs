// node --test scripts/live-checks/signpage-pool-notes.test.mjs: the live check replays recorded answers
// (signpage-pool-notes.answers.json). good: the signing page's devnet deposit (signpage-pool-notes.run.json) read on two
// devnet RPCs, and SIGN_HOST's /app.js with no testnet pin: PASS (with the deposit flow too, as SIGN_HOST's build carries
// it since card signpage-pool-mainnet). bad: the same reads with another precommitment in the run's place, whose mark
// does not exist: FAIL. Planted on the good one: SIGN_HOST serving a testnet pin, the deposit tx failed, the mark's value another, a state leaf another, U not emptied, a record naming
// another deposit's leaf and commitment: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RUN, check } from "./signpage-pool-notes.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-pool-notes.answers.json", import.meta.url), "utf8"));
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
const run = (rec, plant, sign = rec.sign) => check({ run: R, precommitment: rec.precommitment, fetchFn: replay(rec.answers, plant), rpcs: rec.rpcs, sleep: async () => {}, sign });
const bad = (r, start) => {
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD  ${start}`)), r.lines.join("\n"));
};

test("recorded good answer: the run's deposit, mark and both leaves on two devnet RPCs, SIGN_HOST the mainnet build: PASS", async () => {
  assert.equal(A.good.precommitment, R.precommitment);
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(new Set(A.good.answers.map((a) => a.url)).size, 2, "two RPCs");
  for (const s of ["deposit ", "mark ", "label page ", "state page ", "U "]) assert.equal(r.lines.filter((l) => l.startsWith(`ok   ${s}`)).length, 2, s);
});

test("recorded bad answer: another precommitment in the run's place: FAIL", async () => {
  const r = await run(A.bad);
  bad(r, "the precommitment read is the run's");
  bad(r, "mark ");
});

test("planted on the good answer: SIGN_HOST serving a testnet pin, or not read: FAIL", async () => {
  for (const sign of [{ ...A.good.sign, found: [R.program] }, { ...A.good.sign, status: 404 }, null]) bad(await run(A.good, undefined, sign), "SIGN_HOST's /app.js");
});

test("SIGN_HOST's mainnet build carrying the deposit flow (card signpage-pool-mainnet) still passes: the flow is recorded, not judged", async () => {
  assert.equal((await run(A.good, undefined, { ...A.good.sign, flow: true })).ok, true);
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

test("planted: a record naming another deposit's leaf (the deploy run's, state leaf 0) and its commitment: FAIL", async () => {
  const page = A.good.answers.find((a) => a.method === "getAccountInfo" && a.json?.result?.value?.owner === R.program && Buffer.from(a.json.result.value.data[0], "base64").subarray(0, 9).equals(Buffer.concat([Buffer.from("bfpage01"), Buffer.of(0)])));
  const other = Buffer.from(page.json.result.value.data[0], "base64").subarray(16, 48).toString("hex");
  assert.notEqual(other, R.commitment);
  const r = await check({ run: { ...R, leafIndex: "0", commitment: other }, precommitment: R.precommitment, fetchFn: replay(A.good.answers), rpcs: A.good.rpcs, sleep: async () => {}, sign: A.good.sign });
  bad(r, "the run's recorded commitment");
  bad(r, "state page 0 entry 0");
});

// card live-check-devnet-pair: the second provider answering 503 (OnFinality on GitHub's runners, sign live run
// 42201131294) moves the reads to the next operator on the list, here the helper's route serving the same answers: PASS;
// with no other operator answering, two stay required: FAIL.
test("card live-check-devnet-pair: the second provider answering 503 moves the read to the next operator: PASS; one operator answering: FAIL", async () => {
  // the list's third operator (DEVNET_PROVIDERS) serves the second's answers once the second is out
  const [solana, second, helper] = A.good.rpcs;
  const answers = [...A.good.answers.filter((a) => a.url === solana), ...A.good.answers.filter((a) => a.url === second).map((a) => ({ ...a, url: helper }))];
  const down = (inner = replay(answers)) => async (url, init) => (url === second ? { ok: false, status: 503, json: async () => null } : inner(url, init));
  const r = await check({ run: R, precommitment: A.good.precommitment, fetchFn: down(), rpcs: [solana, second, helper], sleep: async () => {}, sign: A.good.sign });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`info ${second} is out`)), r.lines.join("\n"));
  for (const s of ["deposit ", "mark ", "label page ", "state page ", "U "]) assert.equal(r.lines.filter((l) => l.startsWith(`ok   ${s}`)).length, 2, s);
  const one = await check({ run: R, precommitment: A.good.precommitment, fetchFn: down(), rpcs: [solana, second], sleep: async () => {}, sign: A.good.sign });
  bad(one, "two operators answered: 1");
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

test("card signpage-pool-flow-answers, planted on the good answer: the deposit, the mark and both pages answered null name HTTP 200, null at slot N: FAIL", async () => {
  const slots = new Set();
  const r = await run(A.good, nulls(["tx", "mark", "page"], slots));
  assert.equal(r.ok, false);
  namesNull(r, "deposit ");
  namesNull(r, "mark ", slots);
  namesNull(r, "label page ", slots);
  namesNull(r, "state page ", slots);
});

test("the pin is today's: the good recording names today's pool; a run on the old pool 2S5wpE7U, or a deploy record handed in, FAILs", async () => {
  const { devnetPin } = await import("./pool-sol-deploy.mjs");
  const now = devnetPin();
  assert.equal(A.good.deployment.program_id, now.program);
  assert.equal(A.good.deployment.pool, now.pool);
  assert.equal(R.program, now.program);
  assert.equal(R.pool, now.pool);
  // the same reads for a run on the pool before the re-pin: refused on the run line, whatever the answers say
  const old = await check({ run: { ...R, program: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", pool: "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr" }, precommitment: A.good.precommitment, fetchFn: replay(A.good.answers), rpcs: A.good.rpcs, sleep: async () => {}, sign: A.good.sign, ...(A.good.evm ? { evm: A.good.evm } : {}) }).catch((e) => ({ ok: false, lines: [`BAD  ${e.message}`] }));
  bad(old, "the run is on the pinned devnet pool 92YuYhb4");
  // a replay may not hand the check its recording's deploy record: the check reads today's alone
  await assert.rejects(check({ run: R, deployment: A.good.deployment, precommitment: A.good.precommitment, fetchFn: replay(A.good.answers), rpcs: A.good.rpcs, sleep: async () => {}, sign: A.good.sign }), /today's devnet pin only/);
});
