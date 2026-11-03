// node --test scripts/live-checks/helper-pool-senders.test.mjs: the live check replays recorded runs
// (helper-pool-senders.answers.json). good: apps/helper at this card with a devnet pool set: PASS. bad: the same helper
// with no pool set, as the deployed helper is before this card: FAIL. Made from the good run: a planted transaction
// carried, two callers given two fees, a fee other than the kit's for the rent read (2,000,000 for both callers, M362
// (2)), rent reads missing or disagreeing, another pool answered: each FAIL.
// The planted transactions are checked against the helper's own checks, so the check plants what the route reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSolanaPoolTx } from "../../apps/helper/src/pool/solana.ts";
import { solanaDecodeTransaction, solanaPoolPriorityBudget } from "../../packages/kit/src/index.ts";
import { b58decode, b58encode, judge, kitFee, MAINNET_PLANTS, plant, PLANTS, plantsFor, read, RENT_RPCS } from "./helper-pool-senders.mjs";

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
  // M362 (2): a fee on its step and above the cost, the same for both callers, but not the kit's for the rent read
  const two = judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "2000000" }))));
  assert.equal(two.ok, false);
  assert.ok(bad(two).some((l) => l.includes('fee "2000000"') && l.includes("the kit's fee for the rent read 1300000")), bad(two).join("\n"));
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "1100000" })))).ok, false);
  // the rent reads: missing, one only, from other RPCs, or disagreeing
  assert.equal(judge({ ...g, rent: undefined }).ok, false);
  assert.equal(judge({ ...g, rent: g.rent.slice(0, 1) }).ok, false);
  assert.equal(judge({ ...g, rent: [g.rent[1], g.rent[0]] }).ok, false);
  const r17 = Buffer.alloc(17);
  r17.writeBigUInt64LE(3_480n, 0);
  r17.writeDoubleLE(1, 8);
  r17[16] = 50;
  const other = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { owner: "Sysvar1111111111111111111111111111111111111", data: [r17.toString("base64"), "base64"] } } });
  assert.equal(judge({ ...g, rent: [g.rent[0], { ...g.rent[1], body: other }] }).ok, false, "the two RPCs disagree");
  for (const [asked] of PLANTS) {
    assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.asked !== asked) }).ok, false, `${asked} missing`);
    assert.equal(judge(edit(g, asked, (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false, `${asked} carried`);
  }
});

test("plant() builds what the helper's checks read: each plant gets its own code from the bytes alone, as is: ok", () => {
  const f = JSON.parse(A.good.reads[0].body);
  const kit = kitFee(A.good, f.cluster);
  assert.ok(kit);
  const fee = BigInt(f.fee);
  assert.equal(fee, kit.fee);
  const budget = solanaPoolPriorityBudget(kit.rent, fee);
  assert.equal(kit.budget, budget);
  const cfg = { program: f.program, pool: f.pool, feePayer: f.fee_payer, budget };
  const nowMs = 1_800_000_000_000;
  // M369 (M2): every plant as a devnet helper (no Jito) and as a mainnet one (Jito on) checks it
  for (const jito of [false, true]) {
    const at = (wire) => {
      const c = checkSolanaPoolTx(new Uint8Array(wire), { ...cfg, fee, budget, nowMs, jito });
      return c.ok ? "ok" : c.code;
    };
    for (const [asked, code] of plantsFor(jito ? "mainnet" : "devnet")) assert.equal(at(asked === "fee_off" ? plant({ ...cfg, relayFee: fee + 100_000n, nowMs }) : plant({ ...cfg, relayFee: fee, kind: asked, nowMs })), code, `${asked}, Jito ${jito ? "on" : "off"}`);
    assert.equal(at(plant({ ...cfg, relayFee: fee, nowMs })), "ok", `the good tag 2, Jito ${jito ? "on" : "off"}`);
    assert.equal(at(plant({ ...cfg, relayFee: fee, kind: "tip_low", nowMs })), jito ? "tip_low" : "ok", "tip_low: refused only where a bundle is sent, so it is planted only on mainnet");
  }
  assert.deepEqual(plantsFor("mainnet"), [...PLANTS, ...MAINNET_PLANTS]);
  assert.deepEqual(plantsFor("devnet"), PLANTS);
  const at = (wire) => {
    const c = checkSolanaPoolTx(new Uint8Array(wire), { ...cfg, fee, budget, nowMs });
    return c.ok ? "ok" : c.code;
  };
  assert.equal(b58encode(b58decode(f.pool)), f.pool);
  // M362 (4): fee_below_cost's priority is exactly the budget plus one lamport, so a helper whose budget lost even the
  // page reserve (budget + 715) would carry it and fail the check; at the budget itself the helper carries it
  const pr = (wire) => {
    const m = solanaDecodeTransaction(new Uint8Array(wire)).message;
    const ixs = m.instructions.filter((i) => m.staticKeys[i.programIndex] === "ComputeBudget111111111111111111111111111111");
    const limit = ixs.find((i) => i.data[0] === 2);
    const price = ixs.find((i) => i.data[0] === 3);
    const l = BigInt(Buffer.from(limit.data).readUInt32LE(1));
    const p = Buffer.from(price.data).readBigUInt64LE(1);
    return (p * l + 999_999n) / 1_000_000n;
  };
  assert.equal(pr(plant({ ...cfg, relayFee: fee, kind: "fee_below_cost", nowMs })), budget + 1n);
  assert.equal(at(plant({ ...cfg, budget: budget - 1n, relayFee: fee, kind: "fee_below_cost", nowMs })), "ok", "a priority of exactly the budget is carried");
  const looser = checkSolanaPoolTx(new Uint8Array(plant({ ...cfg, relayFee: fee, kind: "fee_below_cost", nowMs })), { ...cfg, fee, budget: budget + 715n, nowMs });
  assert.equal(looser.ok, true, "a budget without the page reserve would let the plant through, so the check catches it");
});

test("read() asks the fee twice and plants two transactions for the pool (replayed helper)", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const rent = A.good.rent.find((x) => x.url === url);
    asked.push(rent ? `rent ${url}` : `${init.method ?? "GET"} ${u.pathname}`);
    if (rent) return new Response(rent.body, { status: rent.status });
    const r = u.pathname === "/v1/pool/fee" ? A.good.reads[0] : A.good.reads.find((x) => x.asked === "changed");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const run = await read("http://h.invalid", A.good.pool, fetchFn);
  const cluster = JSON.parse(A.good.reads[0].body).cluster;
  assert.deepEqual(asked, ["GET /v1/pool/fee", "GET /v1/pool/fee", ...RENT_RPCS[cluster].map((u) => `rent ${u}`), ...PLANTS.map(() => "POST /v1/pool/solana/send")]);
  assert.deepEqual(run.reads.map((x) => x.asked), ["fee", "fee", ...PLANTS.map(([a]) => a)]);
  assert.equal(run.rent.length, 2);
});

// M369 (M2): a mainnet helper, made from the good run (the same rent on mainnet's two RPCs, the cluster mainnet, and the
// mainnet plant tip_low refused): PASS; without the tip_low read, or with it carried: FAIL. And read() plants it there.
const mainnetRun = () => {
  const g = A.good;
  const urls = RENT_RPCS.mainnet;
  return {
    ...g,
    rent: g.rent.map((x, i) => ({ ...x, url: urls[i] })),
    reads: [
      ...g.reads.map((x) => (x.asked === "fee" ? body(x, (b) => ({ ...b, cluster: "mainnet" })) : x)),
      { ...g.reads.find((x) => x.asked === "inner_program"), asked: "tip_low", body: '{"error":{"code":"tip_low"}}' },
    ],
  };
};
test("M369 (M2): a mainnet helper refusing every plant and tip_low: PASS; tip_low missing or carried: FAIL", () => {
  const m = mainnetRun();
  const r = judge(m);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(judge({ ...m, reads: m.reads.filter((x) => x.asked !== "tip_low") }).ok, false);
  assert.equal(judge(edit(m, "tip_low", (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false);
  // a mainnet answer for a plant other than its own code (the bug M369 (M2) found: tip_low for every tag 3): FAIL
  assert.equal(judge(edit(m, "inner_program", (x) => ({ ...x, body: '{"error":{"code":"tip_low"}}' }))).ok, false);
});

test("M369 (M2): read() plants tip_low on a mainnet pool (replayed helper)", async () => {
  const m = mainnetRun();
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const rent = m.rent.find((x) => x.url === url);
    asked.push(rent ? "rent" : `${init.method ?? "GET"} ${u.pathname}`);
    if (rent) return new Response(rent.body, { status: rent.status });
    const r = u.pathname === "/v1/pool/fee" ? m.reads[0] : m.reads.find((x) => x.asked === "changed");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const run = await read("http://h.invalid", m.pool, fetchFn);
  assert.deepEqual(run.reads.map((x) => x.asked), ["fee", "fee", ...plantsFor("mainnet").map(([a]) => a)]);
  assert.ok(run.reads.some((x) => x.asked === "tip_low"));
});
