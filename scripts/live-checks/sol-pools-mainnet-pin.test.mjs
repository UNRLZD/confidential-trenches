// node --test scripts/live-checks/sol-pools-mainnet-pin.test.mjs: the mark scan's two helper routes check replays its
// recorded runs (sol-pools-mainnet-pin.answers.json): a local helper at this card's branch PASSes, the deployed helper
// before it (route B 404) FAILs; planted runs fail on each rule, and a no-answer is INCONCLUSIVE, never a PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKS_A_ENV, RPC_UPSTREAMS } from "../../apps/helper/src/rpc/rpc.ts";
import { A_NAME, B_NAMES, bucket0, judge, providerOf, read } from "./sol-pools-mainnet-pin.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const A = JSON.parse(readFileSync(new URL("./sol-pools-mainnet-pin.answers.json", import.meta.url), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the check's names and shape are the helper's: route A's one name, route B's list, the scan's bucket 0 bytes", () => {
  assert.equal(A_NAME, MARKS_A_ENV);
  assert.deepEqual(B_NAMES, [...RPC_UPSTREAMS["solana-marks"].keyed]);
  // the two requests the wallet's solanaMarks sends for bucket 0 (apps/helper/src/rpc/rpc.test.ts SPENT and PRE)
  assert.equal(bucket0(13), "1112");
  assert.equal(bucket0(17), "11111112");
  assert.equal(providerOf('rpc-wait;dur=0, rpc;dur=69;desc="SOLANA_RPC_URL"'), "SOLANA_RPC_URL");
  assert.equal(providerOf('rpc-keyed;dur=3;desc="fell back", rpc-wait;dur=0, rpc;dur=5;desc="public"'), null);
});

test("recorded good run: a local helper at this branch, both routes answer the scan alike from two names: PASS", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.verdict, "PASS");
});

test("recorded bad run: the deployed helper before this card, route B 404: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /\[B size 13\] a list with its slot: HTTP 404/.test(l)), bad(r).join("\n"));
  assert.ok(bad(r).some((l) => /getSlot refused: HTTP 404/.test(l)));
});

test("planted: each rule FAILs on its own", () => {
  const planted = {
    "route A answered by a spare": (g) => (g.reads.find((x) => x.route === "A").headers["server-timing"] = 'rpc;dur=5;desc="SOLANA_RPC_URL_QUICKNODE"'),
    "route B answered by route A's name": (g) => (g.reads.find((x) => x.route === "B").headers["server-timing"] = 'rpc;dur=5;desc="SOLANA_RPC_URL"'),
    "route B answered by the public endpoint": (g) => (g.reads.find((x) => x.route === "B").headers["server-timing"] = 'rpc;dur=5;desc="public"'),
    "the two lists differ": (g) => g.reads.find((x) => x.route === "B" && x.size === 17).answer.result.value.push({ pubkey: "x" }),
    "a route with no list": (g) => (g.reads.find((x) => x.route === "A" && x.size === 13).answer = { result: { context: { slot: 1 }, value: null } }),
    "no slot": (g) => delete g.reads.find((x) => x.route === "B" && x.size === 13).answer.result.context,
    "no commit": (g) => delete g.reads[0].headers["x-helper-commit"],
    "another origin allowed": (g) => (g.reads[1].headers["access-control-allow-origin"] = "*"),
    "route B forwards getSlot": (g) => (g.refusal.status = 200),
    "a size not read": (g) => (g.reads = g.reads.filter((x) => x.size !== 17)),
    "no program": (g) => (g.program = null),
  };
  for (const [name, plant] of Object.entries(planted)) {
    const g = copy(A.good);
    plant(g);
    assert.equal(judge(g).verdict, "FAIL", name);
  }
});

test("a route with no usable answer is named and not judged: INCONCLUSIVE, and FAIL beside a wrong answer", () => {
  const g = copy(A.good);
  g.reads.find((x) => x.route === "B" && x.size === 13).answer = { noAnswer: "ct-api HTTP 429: 429 Too Many Requests" };
  const r = judge(g);
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.ok(r.lines.some((l) => l.startsWith("--- [B size 13]")));
  g.refusal.status = 200;
  assert.equal(judge(g).verdict, "FAIL");
});

test("live read on fakes: each route asked the exact scan with Origin SIGN_HOST, a differing pair read again once", async () => {
  const sent = [];
  let n = 0;
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, method: body.method, origin: init.headers.origin, params: body.params });
    if (url.endsWith("/solana-marks") && body.method === "getSlot") return new Response('{"error":{"code":"method_not_allowed"}}', { status: 400 });
    // the first B read of size 13 holds one account more, as a mark landing between the two reads
    const extra = url.endsWith("/solana-marks") && body.params[1].filters[0].dataSize === 13 && n++ === 0 ? [{ pubkey: "x" }] : [];
    const timing = url.endsWith("/solana-marks") ? 'rpc;dur=5;desc="SOLANA_RPC_URL_QUICKNODE"' : 'rpc;dur=5;desc="SOLANA_RPC_URL"';
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 9 }, value: extra } }), {
      status: 200,
      headers: { "x-helper-commit": "a".repeat(40), "access-control-allow-origin": "https://confidential.unrealized.trade", "server-timing": timing },
    });
  };
  const run = await read("https://helper.test", fakeFetch, "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF");
  assert.equal(judge(run).verdict, "PASS", judge(run).lines.join("\n"));
  const scans = sent.filter((s) => s.method === "getProgramAccounts");
  assert.equal(scans.length, 6, "size 13 read twice (differing), size 17 once");
  assert.ok(sent.every((s) => s.origin === "https://confidential.unrealized.trade"));
  assert.deepEqual(scans[0].params[1].filters, [{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }]);
});
