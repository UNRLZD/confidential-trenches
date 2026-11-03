// node --test scripts/live-checks/helper-pool-senders.test.mjs: the live check replays recorded runs
// (helper-pool-senders.answers.json). good: apps/helper at this card with a devnet pool set: PASS. bad: the same helper
// with no pool set, as the deployed helper is before this card: FAIL. Made from the good run: a planted transaction
// carried, two callers given two fees, a fee under the worst cost or off its step, another pool answered: each FAIL.
// The planted transactions are checked against the helper's own checks, so the check plants what the route reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSolanaPoolTx } from "../../apps/helper/src/pool/solana.ts";
import { solanaPoolPriorityBudget, solanaPoolReleaseCost } from "../../packages/kit/src/index.ts";
import { b58decode, b58encode, COST_MIN, judge, plant, PLANTS, read } from "./helper-pool-senders.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-pool-senders.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (run, asked, f) => ({ ...run, reads: run.reads.map((x, i) => (x.asked === asked ? f(x, i) : x)) });
const body = (x, f) => ({ ...x, body: JSON.stringify(f(JSON.parse(x.body))) });

test("recorded good run: the fee published the same to two callers, both planted transactions refused: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad run: a helper with no pool (404): FAIL", () => {
  const r = judge(A.bad_unconfigured);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes("BAD [fee APP_HOST] GET /v1/pool/fee answers 404"), bad(r).join("\n"));
});

test("made from the good run: a planted transaction carried, two fees, a fee under cost or off step, another pool: each FAIL", () => {
  const g = A.good;
  assert.equal(judge(edit(g, "changed", (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false);
  assert.equal(judge(edit(g, "fee_off", (x) => ({ ...x, status: 422, body: '{"error":{"code":"simulation_failed"}}' }))).ok, false);
  let n = 0;
  assert.equal(judge(edit(g, "fee", (x) => (n++ === 1 ? body(x, (b) => ({ ...b, fee: "2100000" })) : x))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "1000000" })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "2000001" })))).ok, false);
  assert.equal(judge({ ...g, pool: "11111111111111111111111111111111" }).ok, false);
  for (const [asked] of PLANTS) {
    assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.asked !== asked) }).ok, false, `${asked} missing`);
    assert.equal(judge(edit(g, asked, (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false, `${asked} carried`);
  }
  assert.equal(COST_MIN, solanaPoolReleaseCost({ lamportsPerByte: 5_080n, factor: 1n }), "the check's floor is the kit's release cost at mainnet rent");
});

test("plant() builds what the helper's checks read: each plant gets its own code from the bytes alone, as is: ok", () => {
  const f = JSON.parse(A.good.reads[0].body);
  const cfg = { program: f.program, pool: f.pool, feePayer: f.fee_payer };
  const fee = BigInt(f.fee);
  const nowMs = 1_800_000_000_000;
  const at = (wire) => {
    const c = checkSolanaPoolTx(new Uint8Array(wire), { ...cfg, fee, budget: solanaPoolPriorityBudget({ lamportsPerByte: 5_080n, factor: 1n }, fee), nowMs });
    return c.ok ? "ok" : c.code;
  };
  for (const [asked, code] of PLANTS) assert.equal(at(asked === "fee_off" ? plant({ ...cfg, relayFee: fee + 100_000n, nowMs }) : plant({ ...cfg, relayFee: fee, kind: asked, nowMs })), code, asked);
  assert.equal(at(plant({ ...cfg, relayFee: fee, nowMs })), "ok");
  assert.equal(b58encode(b58decode(f.pool)), f.pool);
});

test("read() asks the fee twice and plants two transactions for the pool (replayed helper)", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    asked.push(`${init.method ?? "GET"} ${u.pathname}`);
    const r = u.pathname === "/v1/pool/fee" ? A.good.reads[0] : A.good.reads.find((x) => x.asked === "changed");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const run = await read("http://h.invalid", A.good.pool, fetchFn);
  assert.deepEqual(asked, ["GET /v1/pool/fee", "GET /v1/pool/fee", ...PLANTS.map(() => "POST /v1/pool/solana/send")]);
  assert.deepEqual(run.reads.map((x) => x.asked), ["fee", "fee", ...PLANTS.map(([a]) => a)]);
});
