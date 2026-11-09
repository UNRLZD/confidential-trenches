// node --test scripts/live-checks/helper-sol-fee-payer-mainnet.test.mjs: the live check replays recorded runs
// (helper-sol-fee-payer-mainnet.answers.json, whose note says where each was read). good: a local helper on the lines
// apps/helper/deploy/sol-fee-payer-key.sh wrote (a fresh test key), the rent and a funded balance from two local RPCs:
// PASS. bad_not_found: today's deployed helper, no mainnet pool: FAIL. bad_unfunded: the same local helper on the real
// mainnet pair, the new fee payer at 0 lamports: FAIL on its balance only. Made from the good run: each break of the
// fee, the record, the RPC pair or the balance FAILs. Card live-checks-provider-no-answer: each shared no-answer kind
// planted on one RPC's rent or balance read is named and the run is INCONCLUSIVE (exit 3), a FAIL beside a wrong
// answer; a live read whose RPC refuses the connection is read again once, named, and never a crash.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, judge, loadRecord, read, RPCS } from "./helper-sol-fee-payer-mainnet.mjs";
import { RETRY } from "./provider-answer.mjs";
import { NO_ANSWERS } from "./provider-answer.plants.mjs";

// a no-answer is read again at once here, not after provider-answer.mjs's pause
RETRY.ms = 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-sol-fee-payer-mainnet.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const withFee = (run, f) => {
  const body = JSON.parse(run.fee.body);
  return { ...run, fee: { ...run.fee, body: JSON.stringify(f(body)) } };
};
const withBalance = (run, values) => ({ ...run, balance: run.balance.map((r, i) => ({ ...r, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: values[i] } }) })) });

test("recorded good run: the fee answer is the kit's for the rent both RPCs read, the record's program and pool, its fee payer over the low mark on both: PASS", () => {
  const g = judge(A.good, loadRecord());
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(g.lines.some((l) => l === "ok  fee \"1300000\" is the kit's solanaPoolFee for the rent read, 1300000"), g.lines.join("\n"));
});

test("recorded bad run: today's deployed helper answers the mainnet pool 404 not_found: FAIL", () => {
  const d = judge(A.bad_not_found, loadRecord());
  assert.equal(d.ok, false);
  assert.deepEqual(A.bad_not_found.rpcs, RPCS, "read on the check's own pair");
  assert.deepEqual(bad(d), ["BAD GET /v1/pool/fee?cluster=mainnet&pool=7ijWvp3xEk5yUfGYQJfgoabReCTpSyZhiWjmCt3TQDz8: 404 (the helper carries no mainnet pool: POOL_SOLANA_*_MAINNET not set; run apps/helper/deploy/sol-fee-payer-key.sh, then redeploy) (want 200)"]);
});

test("recorded bad run: the key step's fee payer before the owner's send holds 0 lamports on both real RPCs: FAIL on that alone", () => {
  const u = judge(A.bad_unfunded, loadRecord());
  assert.equal(u.ok, false);
  assert.deepEqual(A.bad_unfunded.rpcs, RPCS);
  const b = bad(u);
  assert.equal(b.length, 2, b.join("\n"));
  assert.ok(b.every((l) => / holds 0 lamports, the low mark 2681045: fund it/.test(l)), b.join("\n"));
});

test("made from the good run: each break FAILs", () => {
  const g = A.good;
  const mark = 2_681_045;
  const fails = {
    "a fee over the kit's": withFee(g, (b) => ({ ...b, fee: "1400000" })),
    "a fee under the kit's": withFee(g, (b) => ({ ...b, fee: "1200000" })),
    "another program": withFee(g, (b) => ({ ...b, program: "HAQSdJEJb1bomc3Cdam9VJ25RV6zTs75vqiPh6FZ78L7" })),
    "another pool": withFee(g, (b) => ({ ...b, pool: "D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef" })),
    "devnet": withFee(g, (b) => ({ ...b, cluster: "devnet" })),
    "the fee payer is the pool": withFee(g, (b) => ({ ...b, fee_payer: b.pool })),
    "no fee payer": withFee(g, (b) => ({ ...b, fee_payer: undefined })),
    "an extra field": withFee(g, (b) => ({ ...b, note: "x" })),
    "another step": withFee(g, (b) => ({ ...b, step: "1" })),
    "under the mark on one RPC": withBalance(g, [mark - 1, 3_000_000]),
    "under the mark on the other": withBalance(g, [3_000_000, mark - 1]),
    "a balance not a number": withBalance(g, ["3000000", 3_000_000]),
    "one balance read": { ...g, balance: g.balance.slice(0, 1) },
    "the rent read on one RPC twice": { ...g, rpcs: [g.rpcs[0], g.rpcs[0]], rent: [g.rent[0], { ...g.rent[1], url: g.rpcs[0] }], balance: [g.balance[0], { ...g.balance[1], url: g.rpcs[0] }] },
    "the RPCs disagree on rent": { ...g, rent: [g.rent[0], { ...g.rent[1], body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { ...JSON.parse(g.rent[0].body).result.value, data: [Buffer.from([0xec, 0x09, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f, 50]).toString("base64"), "base64"] } } }) }] },
    "a 503": { ...g, fee: { ...g.fee, status: 503 } },
    "another origin": { ...g, fee: { ...g.fee, headers: { ...g.fee.headers, "access-control-allow-origin": "*" } } },
    "no commit": { ...g, fee: { ...g.fee, headers: { ...g.fee.headers, "x-helper-commit": null } } },
  };
  for (const [why, run] of Object.entries(fails)) assert.equal(judge(run, loadRecord()).ok, false, why);
  // at exactly the mark it passes: the mark is the least that carries
  assert.equal(judge(withBalance(g, [mark, mark]), loadRecord()).ok, true);
  // a record whose pool is not its program's fails
  assert.equal(judge(g, { ...loadRecord(), pool: "D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef" }).ok, false);
});

// card live-checks-provider-no-answer: an RPC that answers nothing usable is named and left out, never a wrong answer
const planted = (status, body) => ({ status, body });
const at = (reads, i, r) => reads.map((x, k) => (k === i ? { ...x, ...r } : x));

test("planted: each shared no-answer kind on one RPC's rent read or balance read is named, INCONCLUSIVE (exit 3), never a PASS", () => {
  const g = A.good;
  const hostB = new URL(g.rpcs[1]).host;
  const hostA = new URL(g.rpcs[0]).host;
  for (const [name, status, body] of NO_ANSWERS) {
    const r = judge({ ...g, rent: at(g.rent, 1, planted(status, body)) }, loadRecord());
    assert.equal(r.verdict, "INCONCLUSIVE", `${name}: ${r.lines.join("\n")}`);
    assert.equal(EXIT[r.verdict], 3);
    assert.equal(r.ok, false);
    assert.deepEqual(bad(r), [], `${name}: ${r.lines.join("\n")}`);
    assert.ok(r.lines.some((l) => l.startsWith(`--- the Rent sysvar: no answer: ${hostB} HTTP ${status}: `)), `${name}: ${r.lines.join("\n")}`);
    assert.ok(r.lines.some((l) => l.startsWith(`--- fee "1300000": not judged`)), `${name}: ${r.lines.join("\n")}`);
    const b = judge({ ...g, balance: at(g.balance, 0, planted(status, body)) }, loadRecord());
    assert.equal(b.verdict, "INCONCLUSIVE", `${name}: ${b.lines.join("\n")}`);
    assert.deepEqual(bad(b), [], `${name}: ${b.lines.join("\n")}`);
    assert.ok(b.lines.some((l) => l.startsWith(`--- [${g.rpcs[0]}] `) && l.includes(`'s balance: no answer: ${hostA} HTTP ${status}: `)), `${name}: ${b.lines.join("\n")}`);
  }
  // a fetch that failed (status 0, its reason kept) on both rent reads
  const both = judge({ ...g, rent: g.rent.map((x) => ({ ...x, status: 0, body: "ECONNREFUSED" })) }, loadRecord());
  assert.equal(both.verdict, "INCONCLUSIVE", both.lines.join("\n"));
  assert.ok(both.lines.includes(`--- the Rent sysvar: no answer: ${hostA}: no answer (ECONNREFUSED)`), both.lines.join("\n"));
  assert.ok(both.lines.includes(`--- the Rent sysvar on ${JSON.stringify(g.rpcs)}: 0 of 2 RPCs answered, so the kit's fee and the fee payer's low mark are not judged`), both.lines.join("\n"));
});

test("planted: a no-answer beside a wrong answer still FAILs; a JSON-RPC error that is not a no-answer is judged", () => {
  const g = A.good;
  const empty = planted(200, "");
  const fails = {
    "a no-answer on the rent, the helper names another program": withFee({ ...g, rent: at(g.rent, 1, empty) }, (b) => ({ ...b, program: "HAQSdJEJb1bomc3Cdam9VJ25RV6zTs75vqiPh6FZ78L7" })),
    "a no-answer on the rent, the other RPC answers no rent": { ...g, rent: at(at(g.rent, 1, empty), 0, planted(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } }))) },
    "a no-answer on one balance, the other under the mark": (({ balance, ...w }) => ({ ...w, balance: at(balance, 1, empty) }))(withBalance(g, [2_681_044, 3_000_000])),
    "a JSON-RPC error on a balance": { ...g, balance: at(g.balance, 1, planted(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param: WrongSize" } }))) },
    "a 404 helper beside a no-answer": { ...g, rent: at(g.rent, 0, empty), fee: { ...g.fee, status: 404 } },
  };
  for (const [why, run] of Object.entries(fails)) {
    const r = judge(run, loadRecord());
    assert.equal(r.verdict, "FAIL", `${why}: ${r.lines.join("\n")}`);
    assert.equal(EXIT[r.verdict], 1);
  }
});

test("planted live read: an RPC that refuses the connection is read again once, kept as status 0 with its reason, and named: INCONCLUSIVE, no crash", async () => {
  const g = A.good;
  const record = loadRecord();
  const calls = new Map();
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.startsWith(g.base)) return new Response(g.fee.body, { status: g.fee.status, headers: Object.fromEntries(Object.entries(g.fee.headers).filter(([, v]) => v !== null)) });
    calls.set(u, (calls.get(u) ?? 0) + 1);
    if (u === g.rpcs[1]) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const method = JSON.parse(init.body).method;
    const src = method === "getAccountInfo" ? g.rent[0] : g.balance[0];
    return new Response(src.body, { status: src.status });
  };
  const run = await read(g.base, fetchFn, record, g.rpcs);
  assert.deepEqual(run.rent[1], { url: g.rpcs[1], status: 0, body: "ECONNREFUSED" });
  assert.equal(calls.get(g.rpcs[1]), 4, "each of its two reads asked twice");
  assert.equal(calls.get(g.rpcs[0]), 2, "the answering RPC asked once a read");
  const r = judge(run, record);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.deepEqual(bad(r), [], r.lines.join("\n"));
  const hostB = new URL(g.rpcs[1]).host;
  assert.ok(r.lines.includes(`--- the Rent sysvar: no answer: ${hostB}: no answer (ECONNREFUSED)`), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.includes(`'s balance: no answer: ${hostB}: no answer (ECONNREFUSED)`)), r.lines.join("\n"));
  // the same live read with both RPCs answering is the recorded good run's PASS
  const whole = await read(g.base, async (url, init) => {
    const u = String(url);
    if (u.startsWith(g.base)) return fetchFn(url, init);
    const i = g.rpcs.indexOf(u);
    const src = JSON.parse(init.body).method === "getAccountInfo" ? g.rent[i] : g.balance[i];
    return new Response(src.body, { status: src.status });
  }, record, g.rpcs);
  assert.equal(judge(whole, record).verdict, "PASS");
});
