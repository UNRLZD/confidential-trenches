// node --test scripts/live-checks/near-quote-blackdragon.test.mjs: the live check replays recorded runs
// (near-quote-blackdragon.answers.json). good: this branch's build at SIGN_HOST's name (2026-11-16 09:08Z): out for
// blackdragon.tkn.near as the providers answer, "down" with the page's dRPC answering 429: PASS. bad: the live SIGN_HOST
// (release 165) the same minute: out, then tap_max alone under the fault, a provider's fault read as the coin's no out:
// FAIL. Made from the good run: no out as the providers answer, another refusal under the fault and no sign-in each FAIL;
// the providers' own "down" or "busy" on the first ask INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./near-quote-blackdragon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "near-quote-blackdragon.answers.json"), "utf8"));
const edit = (fn) => {
  const r = structuredClone(A.good.run);
  fn(r);
  return judge(r).verdict;
};

test("good: the branch's build answers out, then down under the provider fault: PASS", () => {
  const j = judge(A.good.run);
  assert.equal(j.verdict, "PASS", j.lines.join("\n"));
});

test("bad: the live page before this card reads the fault as the coin's answer (tap_max alone): FAIL", () => {
  const j = judge(A.bad.run);
  assert.equal(j.verdict, "FAIL");
  assert.ok(j.lines.some((l) => l.startsWith("BAD") && l.includes("a fault read as the coin's answer")), j.lines.join("\n"));
});

test("planted: no out as the providers answer, another refusal under the fault, or no sign-in: FAIL", () => {
  assert.equal(edit((r) => delete r.asks[0].result.out), "FAIL");
  assert.equal(edit((r) => (r.asks[1].code = "failed")), "FAIL");
  assert.equal(edit((r) => (r.asks[0] = { as: "providers", ok: false, code: "not_funded" })), "FAIL");
  assert.equal(edit((r) => (r.signedIn = false)), "FAIL");
  assert.equal(edit((r) => r.asks.pop()), "FAIL");
});

test("planted: the providers' own down or busy on the first ask: INCONCLUSIVE", () => {
  for (const code of ["down", "busy"]) assert.equal(edit((r) => (r.asks[0] = { as: "providers", ok: false, code })), "INCONCLUSIVE", code);
});
