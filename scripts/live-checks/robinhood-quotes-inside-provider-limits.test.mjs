// node --test scripts/live-checks/robinhood-quotes-inside-provider-limits.test.mjs: the live check
// robinhood-quotes-inside-provider-limits, replayed. robinhood-quotes-inside-provider-limits.answers.json holds two
// real mainnet runs from the Mac, 2026-11-14 23:1xZ (`--record`, read only; each as recorded, a `from` field added):
// - bad_live_before: the check run on the base 4fecb0326 (each currency's scan gap one request): FAIL, 279 answers of
//   429 over 24 taps, up to 128 posts a warm tap to rpc.mainnet.chain.robinhood.com (4 its pace takes in 2 s);
// - partial_after: the same on 95977bbbe (the gaps grouped): FAIL, 21 answers of 429, up to 46 posts a warm tap, warm
//   taps 2.7-9.5 s;
// - step2_after: the same on step 2 (each quote's later gaps read once a kind, Robinhood's own RPC out of the quote
//   list), 2026-11-14 23:4xZ (the helper's top rows moved: ARROW for PONS): FAIL, 0 answers of 429, up to 11 posts a warm
//   tap to rpc.mainnet.chain.robinhood.com, warm taps 2.9-9.8 s.
// No recorded run passes yet (the card is partial). The judge's pass is held by a plant on partial_after whose warm
// taps are put inside the bound and the pace, and each other plant fails on its own line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COINS, judge, paces } from "./robinhood-quotes-inside-provider-limits.mjs";
import { WARM_MAX_MS } from "./evm-buy-and-sell-on-mainnet.mjs";

const A = JSON.parse(readFileSync(new URL("./robinhood-quotes-inside-provider-limits.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const s429 = (run) => run.quotes.chains.robinhood.rows.flatMap((r) => r.runs).reduce((n, u) => n + Object.values(u.hosts).reduce((m, h) => m + h.s429, 0), 0);
// partial_after with no answer of 429, every tap ending in a quote or a named refusal, every warm tap inside the bound
// and every paced provider's count at its bound or under
const inside = () => {
  const a = structuredClone(A.partial_after);
  const pace = paces();
  for (const r of a.quotes.chains.robinhood.rows) {
    for (const u of r.runs) for (const h of Object.values(u.hosts)) h.s429 = 0;
    for (const u of r.runs) {
      if (u.kind !== "warm") continue;
      u.ms = Math.min(u.ms, WARM_MAX_MS);
      for (const [host, h] of Object.entries(u.hosts)) {
        const p = pace[host];
        if (p === undefined) continue;
        const bound = Math.floor(p.burst + (p.perS * WARM_MAX_MS) / 1000);
        if (p.unit === "post") h.requests = Math.min(h.requests, bound);
        else h.calls = Math.min(h.calls, bound);
      }
    }
    for (const u of r.runs) if (!u.ok && !["not_allowed", "too_many_pools", "no_reference"].includes(u.code)) Object.assign(u, { ok: true });
  }
  return a;
};

test("limits.ts paces the Robinhood providers the quote asks, the scan provider by the post", () => {
  const p = paces();
  assert.deepEqual(p["rpc.mainnet.chain.robinhood.com"], { perS: 1, burst: 2, unit: "post" });
  assert.equal(p["robinhood.drpc.org"]?.unit, "call");
  assert.deepEqual(paces("no pace here"), {});
  assert.equal(judge(A.partial_after, {}).verdict, "FAIL", "no pace read");
});

test("the recorded run before the fix fails: answers of 429 and warm taps past the scan provider's pace", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  assert.ok(s429(A.bad_live_before) > 0, "the run before got answers of 429");
  const b = bad(v).join("\n");
  assert.match(b, /taps got [1-9]\d* answers of 429/);
  assert.match(b, /rpc\.mainnet\.chain\.robinhood\.com \d+ posts of 4/);
});

test("the recorded run after the fix still fails, with under a tenth of the run before's answers of 429", () => {
  const v = judge(A.partial_after);
  assert.equal(v.verdict, "FAIL");
  assert.ok(s429(A.partial_after) * 10 < s429(A.bad_live_before), `${s429(A.partial_after)} of ${s429(A.bad_live_before)}`);
  for (const l of bad(v)) assert.match(l, /warm taps end within|stay inside each provider's pace|ends in a quote or a true named refusal|answers of 429/, l);
});

test("the recorded run after step 2 has no answer of 429 and asks Robinhood's own RPC 11 posts a warm tap at most; it fails on the warm bound, the pace and the refusals alone", () => {
  const v = judge(A.step2_after);
  assert.equal(v.verdict, "FAIL");
  assert.equal(s429(A.step2_after), 0);
  const posts = A.step2_after.quotes.chains.robinhood.rows.flatMap((r) => r.runs.filter((u) => u.kind === "warm").map((u) => u.hosts["rpc.mainnet.chain.robinhood.com"]?.requests ?? 0));
  assert.ok(Math.max(...posts) <= 11, posts.join(","));
  for (const l of bad(v)) assert.match(l, /warm taps end within|stay inside each provider's pace|ends in a quote or a true named refusal/, l);
});

test("a run whose warm taps are inside the bound and the pace passes; each plant on it fails on its own line", () => {
  const ok = judge(inside());
  assert.equal(ok.verdict, "PASS", bad(ok).join("\n"));
  const plant = (f, re) => {
    const a = inside();
    f(a.quotes.chains.robinhood);
    const b = bad(judge(a)).join("\n");
    assert.match(b, re);
  };
  plant((c) => (c.rows[0].runs[1].hosts["x.example"] = { requests: 1, calls: 1, s429: 1 }), /answers of 429/);
  plant((c) => (c.rows[0].runs[2].ms = WARM_MAX_MS + 1), /warm taps end within/);
  plant((c) => (c.rows[0].runs[3].hosts["rpc.mainnet.chain.robinhood.com"] = { requests: 5, calls: 5, s429: 0 }), /rpc\.mainnet\.chain\.robinhood\.com 5 posts of 4/);
  plant((c) => (c.rows[0].runs[3].hosts["robinhood.drpc.org"] = { requests: 20, calls: 46, s429: 0 }), /robinhood\.drpc\.org 46 calls of 45/);
  plant((c) => Object.assign(c.rows[0].runs[0], { ok: false, code: "quote_check_failed" }), /true named refusal/);
  plant((c) => c.rows[0].runs.pop(), /true named refusal/);
  plant((c) => (c.rows = c.rows.filter((r) => !Object.keys(COINS).includes(String(r.coin).toLowerCase()))), /FRONG .* is quoted/);
  plant((c) => (c.index.served = false), /pool index synced and served/);
  assert.equal(judge({}).verdict, "FAIL", "nothing read");
});
