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
import { SOLANA_RELEASE_COST } from "../../apps/helper/src/pool/fee.ts";
import { b58decode, b58encode, COST_MIN, judge, plant, read } from "./helper-pool-senders.mjs";

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
  assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.asked !== "fee_off") }).ok, false);
  assert.equal(COST_MIN, SOLANA_RELEASE_COST, "the check's floor is the helper's");
});

test("plant() builds what the helper's checks read: a changed byte is bad_signature, a fee one step off is fee_off, as is: ok", () => {
  const f = JSON.parse(A.good.reads[0].body);
  const cfg = { program: f.program, pool: f.pool, feePayer: f.fee_payer };
  const fee = BigInt(f.fee);
  const at = (wire) => {
    const c = checkSolanaPoolTx(new Uint8Array(wire), { ...cfg, fee });
    return c.ok ? "ok" : c.code;
  };
  assert.equal(at(plant({ ...cfg, relayFee: fee, flip: true })), "bad_signature");
  assert.equal(at(plant({ ...cfg, relayFee: fee + 100_000n })), "fee_off");
  assert.equal(at(plant({ ...cfg, relayFee: fee })), "ok");
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
  assert.deepEqual(asked, ["GET /v1/pool/fee", "GET /v1/pool/fee", "POST /v1/pool/solana/send", "POST /v1/pool/solana/send"]);
  assert.deepEqual(run.reads.map((x) => x.asked), ["fee", "fee", "changed", "fee_off"]);
});
