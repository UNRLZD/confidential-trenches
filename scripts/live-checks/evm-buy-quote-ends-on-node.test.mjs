// Replays card evm-buy-quote-ends-on-node's live check on its recorded answers (evm-buy-quote-ends-on-node.answers.json).
// Good: `good`, a real run of the check on the card's kit (see its `from`): both chains' quotes read at their agreed
// block and end within the bound and the request cap with a refusal the kit names; no quote fitted the window (card
// evm-buy-quote-in-window). Bad: `bad`, the same check on a copy of the kit with quote.ts at 3a73b181, before the card
// (11:59Z): both quotes ran to the scan's 60 s bound. Bad: `atOnce`, the check's own run with every request failing to
// connect: the kit refuses rpc_error in time and under the cap, but before any read, which the floor fails.
//   node --test scripts/live-checks/evm-buy-quote-ends-on-node.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOUND_MS, MAX_REQUESTS, judge } from "./evm-buy-quote-ends-on-node.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-buy-quote-ends-on-node.answers.json", import.meta.url), "utf8"));

test("the good answer (the card's kit) passes: both quotes read at their block and end in time, under the cap, with a named refusal", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 8);
  assert.ok(A.good.runs.every((x) => x.reads > 0), "reads at the agreed block");
  assert.ok(A.good.runs.every((x) => x.ms <= BOUND_MS && x.requests <= MAX_REQUESTS && x.end !== "quote"), "no quote fitted the window");
});

test("the bad answer (the kit before the card) fails: both quotes run past the bound", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => l.startsWith("BAD") && / past /.test(l)).length, 2, r.lines.join("\n"));
});

test("the refuses-at-once answer fails on the floor alone: in time, under the cap, a named refusal, no read", () => {
  const r = judge(A.atOnce);
  assert.equal(r.ok, false);
  assert.ok(A.atOnce.runs.every((x) => x.reads === 0 && x.end === "rpc_error" && x.ms <= BOUND_MS && x.requests <= MAX_REQUESTS), JSON.stringify(A.atOnce.runs));
  assert.deepEqual(
    r.lines.filter((l) => l.startsWith("BAD")),
    ["BAD base: no read at an agreed block: it ended before quoting", "BAD robinhood: no read at an agreed block: it ended before quoting"],
  );
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
  assert.equal(plant((a) => (a.runs[0].reads = 0)), false, "no read at the agreed block");
  assert.equal(plant((a) => delete a.runs[1].reads), false, "reads not counted");
  assert.equal(plant((a) => (a.runs = a.runs.slice(0, 1))), false, "no Robinhood run");
  assert.equal(judge({}).ok, false, "an empty answer");
});
