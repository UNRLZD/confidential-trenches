// Replays card evm-buy-quote-ends-on-node's live check on its recorded answers (evm-buy-quote-ends-on-node.answers.json).
// Good: `good`, a real run of the check on the card's kit (2026-11-08T11:55Z): both chains' quotes end within the
// bound and the request cap with a refusal the kit names; no quote fitted the window (Base stale_quote at 31 s, its
// scans; Robinhood rpc_error at 33 s, a provider had dropped the block's state; card evm-buy-quote-in-window). Bad:
// `bad`, the same check on a copy of the kit with quote.ts at 3a73b181, before the card (11:59Z): both quotes ran to
// the scan's 60 s bound.
//   node --test scripts/live-checks/evm-buy-quote-ends-on-node.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOUND_MS, MAX_REQUESTS, judge } from "./evm-buy-quote-ends-on-node.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-buy-quote-ends-on-node.answers.json", import.meta.url), "utf8"));

test("the good answer (the card's kit) passes: both quotes end in time, under the cap, with a named refusal", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 6);
  assert.ok(A.good.runs.every((x) => x.ms <= BOUND_MS && x.requests <= MAX_REQUESTS && x.end !== "quote"), "no quote fitted the window");
});

test("the bad answer (the kit before the card) fails: both quotes run past the bound", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => l.startsWith("BAD") && / past /.test(l)).length, 2, r.lines.join("\n"));
});

test("planted: quotes in time pass; late, too many requests, a quote of 0, an unnamed error, no run fail", () => {
  const plant = (f) => {
    const a = structuredClone(A.good);
    f(a);
    return judge(a).ok;
  };
  assert.equal(plant((a) => Object.assign(a.runs[0], { end: "quote", amountOut: "22371547" })), true, "a quote in time");
  assert.equal(plant((a) => (a.runs[0].ms = BOUND_MS + 1)), false, "past the bound");
  assert.equal(plant((a) => (a.runs[1].requests = MAX_REQUESTS + 1)), false, "past the request cap");
  assert.equal(plant((a) => Object.assign(a.runs[0], { end: "quote", amountOut: "0" })), false, "a quote of 0");
  assert.equal(plant((a) => (a.runs[1].end = "error")), false, "a failure the kit does not name");
  assert.equal(plant((a) => (a.runs = a.runs.slice(0, 1))), false, "no Robinhood run");
  assert.equal(judge({}).ok, false, "an empty answer");
});
