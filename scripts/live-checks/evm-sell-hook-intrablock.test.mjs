// Replays evm-sell-hook-intrablock.answers.json through the live check. The good answer is the check's own run on the
// card's branch (7 Nov 19:10Z, the prestate asked with disableCode, each trace its own request): both trace providers
// answer each transaction's prestate and call traces, equal, holding ArbOS's state, and the replay at the prestate
// without ArbOS runs on two quote providers; it passes. The bad answer is
// a real read of the same kind with the override as before the card's exclusion (ArbOS's state kept in): Nitro refuses
// it on every replay; it fails on those lines alone.
//   node --test scripts/live-checks/evm-sell-hook-intrablock.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./evm-sell-hook-intrablock.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-sell-hook-intrablock.answers.json", import.meta.url), "utf8"));

test("the good answer (ArbOS left out of the replay) passes", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(A.good.txs.length, 3);
});

test("the bad answer (ArbOS kept in the override) fails: every replay refused, and only that", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const bad = r.lines.filter((l) => l.startsWith("BAD"));
  // each refused replay, and each transaction then replayed on no two operators (the refusal is no walk)
  const refused = bad.filter((l) => /the replay at its prestate runs on .*"code":-32000,"message":"overriding address 0xA4b05FffffFffFFFFfFFfffFfffFFfffFfFfFFFf {2}not allowed"/.test(l));
  assert.equal(refused.length, 6, bad.join("\n"));
  assert.deepEqual(bad.filter((l) => !refused.includes(l)).map((l) => l.replace(/^BAD \[0x[0-9a-f]+\] /, "")), Array(3).fill("replayed on two operators: none"), bad.join("\n"));
});

test("each rule fails alone on the good answer with one thing changed", () => {
  const one = (f) => {
    const g = structuredClone(A.good);
    f(g);
    return judge(g).ok;
  };
  assert.equal(one((g) => (g.trace = [g.trace[0], g.trace[0]])), false, "one trace company");
  assert.equal(one((g) => g.txs.pop()), false, "too few transactions");
  assert.equal(one((g) => (g.txs[0].traces[1].digest = { ok: false, answer: '{"http":499,"body":""}' })), false, "a trace unanswered");
  assert.equal(one((g) => (g.txs[0].traces[1].digest.pre = "00".repeat(32))), false, "the prestates differ");
  assert.equal(one((g) => g.txs[0].traces.pop()), false, "one trace provider read");
  for (const i of [0, 1]) assert.equal(one((g) => (g.txs[1].traces[i].digest.accounts = g.txs[1].traces[i].digest.accounts.filter((a) => !a.startsWith("0xa4b05f")))), false, `no ArbOS in provider ${i + 1}'s prestate`);
  assert.equal(one((g) => (g.txs[2].replays[0].answer = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "historical state not available" } })), false, "the state refused");
  assert.equal(one((g) => g.txs[2].replays.pop()), false, "one quote provider");
});

// card device-evm-fee-read-walks-operators: the 10 Nov 20:30Z run failed on robinhood.drpc.org's "Unknown state" alone;
// the replay walks the kit's read list past a seat that refuses the state, and still holds only on two operators
test("planted: a replay seat that refuses the state is walked past to two operators that ran it: PASS; one operator twice, one only, or any other refusal: FAIL", () => {
  const STATE = { jsonrpc: "2.0", id: 1, error: { message: "Unknown state. First available state is 1", code: 27 } };
  const ran = A.good.txs[0].replays[0].answer;
  const run = (replays) => {
    const g = structuredClone(A.good);
    for (const t of g.txs) t.replays = replays.map(([url, answer]) => ({ url, answer }));
    return judge(g);
  };
  const DR = "https://robinhood.drpc.org", RH = "https://rpc.mainnet.chain.robinhood.com", PK = "https://robinhood.api.pocket.network";
  const pass = run([[RH, ran], [DR, STATE], [PK, ran]]);
  assert.equal(pass.ok, true, pass.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  assert.ok(pass.lines.some((l) => /walked past robinhood\.drpc\.org/.test(l)));
  assert.equal(run([[RH, ran], [DR, { http: 400, body: "" }], [PK, ran]]).ok, true, "no JSON-RPC answer walks on");
  assert.equal(run([[RH, ran], [DR, STATE]]).ok, false, "one operator only");
  assert.equal(run([[RH, ran], ["https://customer-origin.offchainlabs.com", ran]]).ok, false, "one operator twice");
  assert.equal(run([[RH, ran], [DR, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "overriding address 0xA4b05FffffFffFFFFfFFfffFfffFFfffFfFfFFFf  not allowed" } }], [PK, ran]]).ok, false, "the override refused is no walk");
});
