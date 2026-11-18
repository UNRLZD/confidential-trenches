// node --test scripts/live-checks/helper-scrubber-takes-the-kits-rule.test.mjs: the live check replays recorded answers
// (helper-scrubber-takes-the-kits-rule.answers.json). good: the deployed helper's two keyed-route refusals, recorded
// 18 Nov 05:51Z: PASS. bad_built: built from the good run (its note says so), a made-up dRPC URL and key in Robinhood's
// refusal: FAIL. Planted from the good one: a key alone, cut, percent-encoded or 40-hex in a no-answer's body: FAIL; a
// long 0x data string or a plain word: PASS; no answer or a result: INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, keyRuns } from "./helper-scrubber-takes-the-kits-rule.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-scrubber-takes-the-kits-rule.answers.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const KEYISH = ["Fk", "e0".repeat(10), "MadeUpNotAKey"].join("");

test("recorded good answer (the deployed helper's keyed-route refusals on Base and Robinhood, 18 Nov 05:51Z): PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("ok  ")).length, 2);
});

test("recorded bad answer (built from the good run: a made-up dRPC URL and key in Robinhood's refusal): FAIL, the run never printed", () => {
  assert.match(A.note, /bad_built: built from the good run, not recorded/);
  assert.equal(A.bad_built.at, "built from good");
  const r = judge(A.bad_built);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^BAD \[robinhood\] the answer holds 1 key-shaped run/.test(l)), r.lines.join("\n"));
  assert.ok(!r.lines.join("\n").includes(KEYISH.slice(0, 8)), "the key-shaped run is named by its start and length only");
});

test("planted from the good answer: a key alone, cut, percent-encoded or as a 40-hex path, in an error or a no-answer's body: FAIL", () => {
  for (const words of [`invalid key ${KEYISH}`, `key ${KEYISH.slice(0, 18)}… refused`, encodeURIComponent(`https://x.example/v2/${KEYISH}?a=1`), `quiknode.pro/${"ab12".repeat(10)}/`]) {
    const e = clone(A.good);
    e.reads[0].error.message = words;
    assert.equal(judge(e).verdict, "FAIL", words);
    const n = clone(A.good);
    n.reads[1] = { chain: "robinhood", noAnswer: `ct-api.unrealized.trade HTTP 503: a passing fault (${words})` };
    assert.equal(judge(n).verdict, "FAIL", words);
  }
});

test("planted: a long 0x data string, a Go type name and a plain long word are no key: PASS; no answer or a result: INCONCLUSIVE", () => {
  assert.deepEqual(keyRuns(`execution reverted 0x${"ab".repeat(68)} TransactionArgs.data hexutil.Bytes unmarshalling-failed`), []);
  const d = clone(A.good);
  d.reads[0].error.data = `0x${"08c379a0".repeat(20)}`;
  assert.equal(judge(d).verdict, "PASS");
  const quiet = clone(A.good);
  quiet.reads[0] = { chain: "base", noAnswer: "ct-api.unrealized.trade: no answer (TimeoutError)" };
  assert.equal(judge(quiet).verdict, "INCONCLUSIVE");
  const res = clone(A.good);
  res.reads[1] = { chain: "robinhood", status: 200, result: "0x" };
  assert.equal(judge(res).verdict, "INCONCLUSIVE");
  assert.equal(judge({ reads: [] }).verdict, "INCONCLUSIVE");
});
