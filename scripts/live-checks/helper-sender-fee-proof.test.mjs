// node --test scripts/live-checks/helper-sender-fee-proof.test.mjs: the live check replays recorded runs
// (helper-sender-fee-proof.answers.json). bad_deployed: HELPER_HOST today, its fee answers with no fee_collector and an
// older X-Helper-Commit, each collector's code read on both RPCs as the chains answer it: FAIL on the collector and the
// commit only. made (not a read: bad_deployed with the pinned collector and the run's commit, the base the plants are
// made from) passes; each plant breaks one thing and fails: another collector (a stand-in, the other testnet's), another
// sell sender, a record whose sink or address is not the pin, a kit pin that is not the record, another commit, the
// collector's code changed on one RPC, a fee answer that is not 200, a pool not read. The good answer is recorded on
// HELPER_HOST after this card's merge is redeployed with both POOL_EVM_FEE_COLLECTOR_ lines.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { collectorRecords, judge, read } from "./helper-sender-fee-proof.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-sender-fee-proof.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const at = (run) => judge(run, { commit: run.commit });
const editFee = (run, network, f) => {
  const r = copy(run);
  for (const p of r.pools) if (p.network === network) p.fee = f(p.fee);
  return r;
};
const body = (fee, f) => ({ ...fee, body: JSON.stringify(f(JSON.parse(fee.body))) });
const NETS = ["base-sepolia", "robinhood-testnet"];

test("bad_deployed, HELPER_HOST today: no fee_collector in its fee answers and an older commit fail; the collectors' code on both RPCs passes", async () => {
  const r = await at(A.bad_deployed);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 4, b.join("\n"));
  for (const n of NETS) {
    assert.ok(b.some((l) => l.startsWith(`BAD [${n} fee] 200: fee_collector none is the kit's pin`)), b.join("\n"));
    assert.ok(b.some((l) => l.startsWith(`BAD [${n} fee] X-Helper-Commit "f21d4be2`)), b.join("\n"));
    assert.ok(r.lines.filter((l) => l.startsWith(`ok  [${n} collector]`)).length >= 20, `${n}: the collector's check on both RPCs`);
  }
});

test("the made base (the pinned collector, the run's commit) passes, so each plant below fails on its own", async () => {
  const r = await at(A.made);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("planted: another collector, another sell sender, a record or a pin off the other, another commit, changed code, a non-200 fee, a pool not read: each FAIL", async () => {
  const fails = async (run, opts, re, why) => {
    const r = await judge(run, { commit: run.commit, ...opts });
    assert.equal(r.ok, false, why);
    assert.ok(bad(r).some((l) => re.test(l)), `${why}: ${bad(r).join("\n")}`);
  };
  const venues = evmPoolVenues();
  for (const n of NETS) {
    const other = NETS.find((x) => x !== n);
    await fails(editFee(A.made, n, (f) => body(f, (b) => ({ ...b, fee_collector: "0x00000000000000000000000000000000c011ec70" }))), {}, new RegExp(`^BAD \\[${n} fee\\] 200: fee_collector "0x0+c011ec70"`), `${n}: the old stand-in`);
    await fails(editFee(A.made, n, (f) => body(f, (b) => ({ ...b, fee_collector: venues[other].feeCollector }))), {}, new RegExp(`^BAD \\[${n} fee\\] 200: fee_collector`), `${n}: the other testnet's collector`);
    await fails(editFee(A.made, n, (f) => body(f, (b) => ({ ...b, fee_collector: null }))), {}, new RegExp(`^BAD \\[${n} fee\\] 200: fee_collector null`), `${n}: null`);
    await fails(editFee(A.made, n, (f) => body(f, (b) => ({ ...b, sell_sender: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" }))), {}, new RegExp(`^BAD \\[${n} fee\\] sell_sender`), `${n}: another sell sender`);
    await fails(editFee(A.made, n, (f) => ({ ...f, status: 503 })), {}, new RegExp(`^BAD \\[${n} fee\\] 503`), `${n}: fee 503`);
    await fails(editFee(A.made, n, (f) => ({ ...f, headers: { ...f.headers, "x-helper-commit": "f21d4be2cd160f6971170913178961f5674fd38e" } })), {}, new RegExp(`^BAD \\[${n} fee\\] X-Helper-Commit`), `${n}: an older commit`);
    // the record's sink is not the sell sender pin, or its address is not the pin: the fee line and the collector's check fail
    const recs = collectorRecords();
    const sunk = { ...recs, [n]: { ...recs[n], contracts: { FeeCollector: { ...recs[n].contracts.FeeCollector, sink: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" } } } };
    await fails(A.made, { collectors: sunk }, new RegExp(`^BAD \\[${n} fee\\] sell_sender .* the collector's sink "0x70997970`), `${n}: the record's sink another`);
    const moved = { ...recs, [n]: { ...recs[n], contracts: { FeeCollector: { ...recs[n].contracts.FeeCollector, address: "0x00000000000000000000000000000000c011ec70" } } } };
    await fails(A.made, { collectors: moved }, new RegExp(`^BAD \\[${n} fee\\] 200: fee_collector .* FeeCollector "0x0+c011ec70"`), `${n}: the record another address`);
    const pinned = { ...venues, [n]: { ...venues[n], feeCollector: "0x00000000000000000000000000000000c011ec70" } };
    await fails(editFee(A.made, n, (f) => body(f, (b) => ({ ...b, fee_collector: "0x00000000000000000000000000000000c011ec70" }))), { venues: pinned }, new RegExp(`^BAD \\[${n} fee\\] 200: fee_collector`), `${n}: a kit pin that is not the record`);
    // the collector's code as one RPC answers it, one byte changed
    const code = copy(A.made);
    const ans = code.rpc[n].find((a) => a.method === "eth_getCode" && a.params[0] === recs[n].contracts.FeeCollector.address);
    ans.json.result = `${ans.json.result.slice(0, -2)}${ans.json.result.endsWith("00") ? "01" : "00"}`;
    await fails(code, {}, new RegExp(`^BAD \\[${n} collector\\] FeeCollector .* code is the build's`), `${n}: changed code`);
    await fails({ ...A.made, pools: A.made.pools.filter((p) => p.network !== n) }, {}, /^BAD pools read/, `${n} not read`);
  }
  await fails(A.made, { commit: "0".repeat(40) }, /X-Helper-Commit/, "the check at another commit");
  await fails({ ...A.made, pools: [] }, {}, /^BAD pools read/, "no pool read");
});

test("read() asks HELPER_HOST's fee answer for each testnet pool and reads each collector on both of its chain's RPCs (replayed)", async () => {
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    const p = A.made.pools.find((x) => url.endsWith(`pool=${x.pool}`));
    return new Response(p.fee.body, { status: p.fee.status, headers: p.fee.headers });
  };
  const left = Object.fromEntries(Object.entries(A.made.rpc).map(([n, a]) => [n, [...a]]));
  const rpcFetch = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    for (const list of Object.values(left)) {
      const i = list.findIndex((a) => a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
      if (i >= 0) return new Response(JSON.stringify(list.splice(i, 1)[0].json));
    }
    throw new Error(`unrecorded ${method}`);
  };
  const run = await read("https://helper.invalid", fetchFn, { rpcFetch });
  assert.deepEqual(asked.map((u) => new URL(u).pathname), ["/v1/pool/fee", "/v1/pool/fee"]);
  const r = await judge(run, { commit: A.made.commit });
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const n of NETS) assert.equal(new Set(run.rpc[n].map((a) => a.url)).size, 2, `${n}: two RPCs`);
});
