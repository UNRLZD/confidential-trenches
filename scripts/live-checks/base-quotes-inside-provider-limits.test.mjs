// node --test scripts/live-checks/base-quotes-inside-provider-limits.test.mjs: the live check
// base-quotes-inside-provider-limits, replayed. base-quotes-inside-provider-limits.answers.json holds three real mainnet
// runs from the Mac (`--record`, read only; each as recorded, a `from` field added):
// - bad_before: main 606fc443c (release 133), 2026-11-14 02:47Z: FAIL, Robinhood 79 answers of 429 over 28 taps
//   (rpc.mainnet.chain.robinhood.com 51, robinhood.drpc.org 28), warm taps up to 25 s; Base 0 that run, its not_allowed
//   coins' warm taps 2.1-2.6 s;
// - after_fix: c6e8e7a2a (a throttled request moves to the next provider at once), 02:54Z: Robinhood 3 answers of 429 over
//   32 taps; Base read while base-rpc.publicnode.com throttled this address before any tap (the index sync, which the
//   change does not touch, got 12 answers of 429 and was not served, so every tap scanned): FAIL;
// - after_merged_base: 60d3f3a6e (FRONG f37e3560a merged), Base alone, 03:15Z: 5 answers of 429, all
//   base-rpc.publicnode.com's to quote reads (none to a getLogs post) in one warm tap, the next taps on the other three:
//   FAIL (no Robinhood read, the 429s, warm taps past 2 s).
// No recorded run passes yet (the card is partial). The judge's pass is held by a plant on after_fix whose taps carry no
// 429 and whose warm taps are inside the bound, and each other plant fails on its own line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, COINS, judge } from "./base-quotes-inside-provider-limits.mjs";
import { NAMED, WARM_MAX_MS } from "./evm-buy-and-sell-on-mainnet.mjs";

const A = JSON.parse(readFileSync(new URL("./base-quotes-inside-provider-limits.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const by = (run, chain) => {
  const out = {};
  for (const r of run.quotes.chains[chain]?.rows ?? []) for (const u of r.runs) for (const [h, x] of Object.entries(u.hosts)) if (x.s429) out[h] = (out[h] ?? 0) + x.s429;
  return out;
};
const sum = (o) => Object.values(o).reduce((n, k) => n + k, 0);
// after_fix with no answer of 429, every tap ending in a quote or a named refusal, the index served and every warm tap
// inside the bound
const inside = () => {
  const a = structuredClone(A.after_fix);
  for (const chain of CHAINS) {
    const c = a.quotes.chains[chain];
    c.index.served = true;
    for (const r of c.rows) {
      for (const u of r.runs) {
        for (const h of Object.values(u.hosts)) h.s429 = 0;
        if (u.kind === "warm") u.ms = Math.min(u.ms, WARM_MAX_MS);
        if (!u.ok && !NAMED.includes(u.code)) Object.assign(u, { ok: true });
      }
    }
  }
  return a;
};

test("the run before the fix fails on Robinhood's answers of 429, each line naming its hosts", () => {
  const v = judge(A.bad_before);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(by(A.bad_before, "robinhood"), { "rpc.mainnet.chain.robinhood.com": 51, "robinhood.drpc.org": 28 });
  const b = bad(v).join("\n");
  assert.match(b, /\[robinhood\] WALLET taps got 31 answers of 429 \(rpc\.mainnet\.chain\.robinhood\.com 22, robinhood\.drpc\.org 9\)/);
  assert.match(b, /\[base\] AO D F warm taps end within 2000 ms/);
});

test("the run after the fix has under a tenth of Robinhood's answers of 429 before it", () => {
  assert.equal(judge(A.after_fix).verdict, "FAIL");
  const after = sum(by(A.after_fix, "robinhood"));
  assert.equal(after, 3);
  assert.ok(after * 10 < sum(by(A.bad_before, "robinhood")));
  // its Base half was read while publicnode throttled this address: the index sync itself drew 429s, not served
  const ix = A.after_fix.quotes.chains.base.index;
  assert.equal(ix.served, false);
  assert.equal(ix.hosts["base-rpc.publicnode.com"].s429, 12);
});

test("the merged branch's Base run: publicnode's 5 answers of 429 are all quote reads in one warm tap, and the taps after it ask it no quote read", () => {
  const rows = A.after_merged_base.quotes.chains.base.rows;
  const runs = rows.flatMap((r) => r.runs.map((u) => ({ ...u, symbol: r.symbol })));
  const hit = runs.filter((u) => u.hosts["base-rpc.publicnode.com"]?.s429 > 0);
  assert.equal(hit.length, 1);
  assert.deepEqual([hit[0].hosts["base-rpc.publicnode.com"].s429, hit[0].hosts["base-rpc.publicnode.com"].s429Logs], [5, 0]);
  // the next two taps send it the scan's posts alone (4 posts, 2 of them getLogs)
  const k = runs.indexOf(hit[0]);
  for (const u of runs.slice(k + 1, k + 3)) assert.ok(u.hosts["base-rpc.publicnode.com"].requests <= 4, JSON.stringify(u.hosts));
  assert.equal(judge(A.after_merged_base).verdict, "FAIL");
});

test("a run with no 429 and warm taps inside the bound passes; each plant on it fails on its own line", () => {
  const ok = judge(inside());
  assert.equal(ok.verdict, "PASS", bad(ok).join("\n"));
  const plant = (chain, f, re) => {
    const a = inside();
    f(a.quotes.chains[chain]);
    assert.match(bad(judge(a)).join("\n"), re);
  };
  for (const chain of CHAINS) {
    plant(chain, (c) => (c.rows[0].runs[1].hosts["x.example"] = { requests: 1, calls: 1, s429: 1 }), new RegExp(`\\[${chain}\\] .* taps got 1 answers of 429 \\(x\\.example 1\\)`));
    plant(chain, (c) => (c.rows[0].runs[0].hosts["x.example"] = { requests: 1, calls: 1, s429: 2 }), /taps got 2 answers of 429/);
    plant(chain, (c) => (c.rows[0].runs[2].ms = WARM_MAX_MS + 1), new RegExp(`\\[${chain}\\] .* warm taps end within`));
    plant(chain, (c) => Object.assign(c.rows[0].runs[0], { ok: false, code: "quote_check_failed" }), /true named refusal/);
    plant(chain, (c) => c.rows[0].runs.pop(), /true named refusal/);
    plant(chain, (c) => (c.index.served = false), new RegExp(`\\[${chain}\\] the pool index synced and served`));
    const [coin, name] = Object.entries(COINS[chain])[0];
    plant(chain, (c) => (c.rows = c.rows.filter((r) => String(r.coin).toLowerCase() !== coin)), new RegExp(`${name} ${coin} is quoted`));
    plant(chain, (c) => (c.rows = []), new RegExp(`\\[${chain}\\] rows read: 0`));
  }
  const noRobinhood = inside();
  delete noRobinhood.quotes.chains.robinhood;
  assert.equal(judge(noRobinhood).verdict, "FAIL", "one chain missing");
  assert.equal(judge({}).verdict, "FAIL", "nothing read");
});
