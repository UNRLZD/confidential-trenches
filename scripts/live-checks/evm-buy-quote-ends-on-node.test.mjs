// Replays card evm-buy-quote-ends-on-node's live check on its recorded answers (evm-buy-quote-ends-on-node.answers.json).
// `now`: a real run of the check on the card's kit: both chains' quotes end within the bound and the request cap, Base
// stale_quote at 31 s (its scans) and Robinhood rpc_error at 33 s (a provider had dropped the block's state), so it
// fails on the end the card's brief asks, a quote. `bad`: the same check on the kit before the card (3a73b181): its
// quotes run past the bound. No recorded run passes yet; the planted cases below hold what a pass is.
//   node --test scripts/live-checks/evm-buy-quote-ends-on-node.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOUND_MS, MAX_REQUESTS, judge } from "./evm-buy-quote-ends-on-node.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-buy-quote-ends-on-node.answers.json", import.meta.url), "utf8"));

test("now (the card's kit): both quotes end in time and under the cap, and the check fails on their ends, neither a quote", () => {
  const r = judge(A.now);
  assert.equal(r.ok, false);
  const bad = r.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(bad.length, 2, r.lines.join("\n"));
  assert.ok(bad.every((l) => / it ended /.test(l)), r.lines.join("\n"));
  assert.ok(A.now.runs.every((x) => x.ms <= BOUND_MS && x.requests <= MAX_REQUESTS));
});

test("bad (the kit before the card): a quote runs past the bound", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && / past /.test(l)), r.lines.join("\n"));
});

test("planted: quotes on both chains in time pass; a Robinhood stale_quote passes; late, too many requests, another end, no run fail", () => {
  const good = () => ({
    runs: [
      { chain: "base", ms: 20_897, requests: 503, end: "quote", amountOut: "22371547" },
      { chain: "robinhood", ms: 25_000, requests: 700, end: "quote", amountOut: "1" },
    ],
  });
  const plant = (f) => {
    const a = good();
    f(a);
    return judge(a).ok;
  };
  assert.equal(plant(() => {}), true, "both quote in time");
  assert.equal(plant((a) => Object.assign(a.runs[1], { end: "stale_quote", amountOut: undefined, message: "stale" })), true, "Robinhood refuses stale_quote in time");
  assert.equal(plant((a) => Object.assign(a.runs[0], { end: "stale_quote", amountOut: undefined })), false, "Base without a quote");
  assert.equal(plant((a) => (a.runs[1].end = "rpc_error")), false, "Robinhood rpc_error");
  assert.equal(plant((a) => (a.runs[0].ms = BOUND_MS + 1)), false, "past the bound");
  assert.equal(plant((a) => (a.runs[1].requests = MAX_REQUESTS + 1)), false, "past the request cap");
  assert.equal(plant((a) => (a.runs[0].amountOut = "0")), false, "a quote of 0");
  assert.equal(plant((a) => (a.runs = a.runs.slice(0, 1))), false, "no Robinhood run");
  assert.equal(judge({}).ok, false, "an empty answer");
});
