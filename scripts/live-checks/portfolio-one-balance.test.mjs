// node --test scripts/live-checks/portfolio-one-balance.test.mjs: the live check's verdict replays recorded runs
// (portfolio-one-balance.answers.json), each read on 9 Nov by portfolio-one-balance.mjs collect() in headless Chromium,
// the stand-in shell sending accountAt's account (the vault's $40.50, 0.5 SOL at $150, 0.01 ETH at $3,000, an empty
// Robinhood pool with a pool deposit in transit):
//   good: this card's build served at APP_HOST's name (--harness): Cash and the header $145.50, and the parts NEAR $40.50,
//         Solana $75.00, Base $30.00, Robinhood $0.00 moving, hidden until the hover or tap, at 1440 and 390: PASS;
//   bad:  the deployed APP_HOST on 9 Nov, before this card: Cash and the header the vault's $40.50 alone, no parts: FAIL.
// Planted from the good run: a Cash or header that leaves a pool out, a part off by a cent, a deposit in flight counted
// or not marked, parts shown before the tap, a missing run, a terminal outside the shell, no entry script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { accountAt, CASH, judge, PARTS } from "./portfolio-one-balance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "portfolio-one-balance.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w) => rec.runs.find((r) => r.width === w);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the account: the vault and three pools priced at the run's time; Cash $145.50 and each chain's part", () => {
  const now = Date.parse("2026-11-09T23:00:00Z");
  const a = accountAt(now);
  assert.equal(a.vault_balance, "40.50");
  assert.deepEqual(a.pools.map((p) => [p.chain, p.asset, p.balance]), [["solana", "SOL", "0.5"], ["base", "ETH", "0.01"], ["robinhood", "ETH", "0"]]);
  for (const p of a.pools) assert.equal(p.price.published_s, Math.floor(now / 1000) - 2);
  assert.deepEqual(a.ops.map((o) => [o.kind, o.chain, o.stage]), [["pool_deposit", "robinhood", "in_transit"]]);
  assert.equal(CASH, "$145.50");
  assert.deepEqual(PARTS.map((p) => p[0]), ["near", "solana", "base", "robinhood"]);
});

test("recorded good answer: Cash and the header are the vault and every pool, the parts each chain's, at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 2);
  for (const x of ANSWERS.good.runs) assert.deepEqual([x.cash, x.header, x.hiddenBefore], [CASH, CASH, true], x.width);
});

test("recorded bad answer: the deployed app before this card draws the vault's $40.50 alone and no parts: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const w of ["desktop", "phone"]) assert.ok(bad(r).some((l) => new RegExp(`^BAD ${w}: Portfolio's Cash is \\$40\\.50, not the vault and every pool's \\$145\\.50; the header's balance is \\$40\\.50.*the parts are null`).test(l)), r.lines.join("\n"));
});

test("planted: a Cash or header that leaves a pool out fails", () => {
  fails(mut((rec) => (run(rec, "desktop").cash = "$115.50")), /^BAD desktop: Portfolio's Cash is \$115\.50, not the vault and every pool's \$145\.50/);
  fails(mut((rec) => (run(rec, "phone").header = "$40.50")), /^BAD phone: the header's balance is \$40\.50, not \$145\.50/);
});

test("planted: a part off by a cent, a deposit in flight counted or not marked, a part missing fails", () => {
  fails(mut((rec) => (run(rec, "desktop").parts[1][1] = "7499")), /^BAD desktop: the parts are /);
  fails(mut((rec) => (run(rec, "phone").parts[3] = ["robinhood", "2000", true])), /^BAD phone: the parts are /);
  fails(mut((rec) => (run(rec, "phone").parts[3][2] = false)), /^BAD phone: the parts are /);
  fails(mut((rec) => run(rec, "desktop").parts.pop()), /^BAD desktop: the parts are /);
});

test("planted: parts shown before the hover or tap, a missing run, a terminal outside the shell, no entry script fail", () => {
  fails(mut((rec) => (run(rec, "phone").hiddenBefore = false)), /^BAD phone: the parts show before a hover or tap/);
  fails(mut((rec) => rec.runs.pop()), /^BAD 1 run\(s\) of 2/);
  fails(mut((rec) => (run(rec, "desktop").framed = false)), /^BAD desktop: not inside SIGN_HOST's shell/);
  fails(mut((rec) => (run(rec, "desktop").screen = null)), /^BAD desktop: drew no screen on route portfolio, not Portfolio/);
  fails(mut((rec) => (rec.entry = null)), /^BAD the served \/ names its entry script none/);
});
