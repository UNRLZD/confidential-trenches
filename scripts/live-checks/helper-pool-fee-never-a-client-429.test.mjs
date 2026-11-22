// node --test scripts/live-checks/helper-pool-fee-never-a-client-429.test.mjs: the live check replays recorded runs
// (helper-pool-fee-never-a-client-429.answers.json). good: ct-api.unrealized.trade read 2026-11-22, nine fee asks of the
// mainnet pool, each 200 with its fee: PASS. bad: MADE from good, one ask answered 429 rate_limited as helper-25 on
// ee5c7dac4 answered (live run 45032297159): FAIL. Made from good: other faults, each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EPOCH_MS, EPOCHS_BACK, judge, read } from "./helper-pool-fee-never-a-client-429.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-pool-fee-never-a-client-429.answers.json"), "utf8"));

test("the recorded good run PASSes and the recorded bad run (one 429) FAILs, naming the 429", () => {
  const g = judge(A.good.run);
  assert.equal(g.ok, true, g.lines.join("\n"));
  const b = judge(A.bad.run);
  assert.equal(b.ok, false);
  assert.ok(b.lines.some((l) => l.startsWith("BAD") && l.includes("429 rate_limited")), b.lines.join("\n"));
});

test("made from good: a 503, a missing fee, a fee for another epoch, an ask short and no pool each FAIL", () => {
  const made = (f) => {
    const r = structuredClone(A.good.run);
    f(r);
    return judge(r).ok;
  };
  assert.equal(made((r) => (r.pools[0].asks[1] = { ...r.pools[0].asks[1], status: 503, body: '{"error":{"code":"upstream"}}' })), false);
  assert.equal(made((r) => (r.pools[0].asks[2].body = JSON.stringify({ ...JSON.parse(r.pools[0].asks[2].body), fee: undefined }))), false);
  assert.equal(made((r) => (r.pools[0].asks[2].body = JSON.stringify({ ...JSON.parse(r.pools[0].asks[2].body), epoch_start_ms: r.pools[0].asks[2].epoch + EPOCH_MS }))), false);
  assert.equal(made((r) => r.pools[0].asks.pop()), false);
  assert.equal(made((r) => (r.pools = [])), false);
});

test("read asks the fee now and each of the EPOCHS_BACK epochs before it, on the 60 s grid, oldest last", async () => {
  const urls = [];
  const fetchFn = async (u) => (urls.push(u), new Response('{"fee":"1"}', { status: 200 }));
  const now = 1_795_360_567_890;
  const run = await read("https://helper.invalid", fetchFn, now, { mainnet: "Pool1111111111111111111111111111111" });
  assert.equal(urls.length, EPOCHS_BACK + 1);
  assert.equal(urls[0], "https://helper.invalid/v1/pool/fee?pool=Pool1111111111111111111111111111111");
  assert.deepEqual(run.pools[0].asks.slice(1).map((a) => a.epoch), Array.from({ length: EPOCHS_BACK }, (_, k) => 1_795_360_560_000 - (k + 1) * EPOCH_MS));
});
