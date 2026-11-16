// node --test scripts/live-checks/base-reads-never-throttled.test.mjs: the live check replays recorded answers
// (base-reads-never-throttled.answers.json). good: this card's helper RPC in process, every dRPC key answering and every
// read served with no wait: PASS. bad_deploy: the deployed helper at 841265f75 on 16 Nov 10:31Z, two Base dRPC keys held
// and every keyed Base eth_getLogs 429: FAIL. Planted from the good one: a key held, a read 429, a wait of a hold's
// second, a slow answer, no answer: FAIL or INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as check from "./base-reads-never-throttled.mjs";

const { judge } = check;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "base-reads-never-throttled.answers.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

test("recorded good answer (this card's helper in process: every dRPC key answers, every read 200 with no wait): PASS", () => {
  const r = judge(A.good);
  assert.ok(r.ok, r.lines.join("\n"));
  assert.equal(r.verdict, "PASS");
  assert.ok(r.lines.includes("ok  health base: drpc.live key2 answers"), r.lines.join("\n"));
});

test("recorded bad answer (the deployed helper at 841265f75, 16 Nov 10:31Z: Base dRPC keys held, keyed Base logs 429): FAIL", () => {
  const r = judge(A.bad_deploy);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD health base: drpc.live key1 held"), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^BAD \[base keyed\] eth_getLogs answers 429/.test(l)), r.lines.join("\n"));
  assert.equal(r.stateOnly, false, "a read refused is no passing key state: no re-read");
});

test("planted from the good answer: a key held (a state only, read again), a read the helper held, a hold's wait, a slow answer, a non-result: FAIL", () => {
  const held = clone(A.good);
  held.health.body = held.health.body.replace("drpc.live key3 answers", "drpc.live key3 held");
  const h = judge(held);
  assert.equal(h.verdict, "FAIL");
  assert.equal(h.stateOnly, true);
  const refused = clone(A.good);
  Object.assign(refused.reads[1], { status: 429, result: undefined, noAnswer: "HTTP 429", kept: { "retry-after": "1", "server-timing": null } });
  assert.equal(judge(refused).verdict, "FAIL");
  const waited = clone(A.good);
  waited.reads[3].kept["server-timing"] = 'rpc-wait;dur=1004, rpc;dur=90;desc="ROBINHOOD_RPC_URL"';
  assert.ok(judge(waited).lines.some((l) => /^BAD \[robinhood keyed\] eth_getLogs the helper's wait before its send 1004 ms/.test(l)));
  const slow = clone(A.good);
  slow.reads[0].ms = 3_400;
  assert.equal(judge(slow).verdict, "FAIL");
  const err = clone(A.good);
  Object.assign(err.reads[2], { result: undefined, error: { code: -32005, message: "limit" } });
  assert.equal(judge(err).verdict, "FAIL");
  const few = clone(A.good);
  few.reads = few.reads.filter((r) => r.chain !== "base");
  assert.equal(judge(few).verdict, "FAIL");
});

test("no HTTP answer from the helper: INCONCLUSIVE, never PASS", () => {
  const quiet = clone(A.good);
  quiet.reads[0] = { chain: "base", method: "eth_blockNumber", keyed: false, ms: 15_000, noAnswer: "ct-api.unrealized.trade TimeoutError" };
  assert.equal(judge(quiet).verdict, "INCONCLUSIVE");
});

test("run() reads again while only a key's state fails, then stops at RETRY_MS", async () => {
  const held = clone(A.good);
  held.health.body = held.health.body.replace("drpc.live key3 answers", "drpc.live key3 held");
  let t = 0;
  let healthReads = 0;
  const replay = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/health") return healthReads++, new Response(held.health.body, { status: 200 });
    const req = JSON.parse(String(init.body));
    const r = held.reads.find((x) => x.chain === u.pathname.split("/").pop() && x.method === req.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: r.result }), { status: 200, headers: { "server-timing": r.kept["server-timing"], "access-control-allow-origin": check.SIGN } });
  };
  const r = await check.run("https://ct-api.unrealized.trade", replay, () => t, async (ms) => void (t += ms));
  assert.equal(r.verdict, "FAIL");
  assert.equal(healthReads, check.RETRY_MS / check.RETRY_EVERY_MS);
});
