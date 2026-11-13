// node --test scripts/live-checks/pool-balance-counts-the-remainder.test.mjs: the live check's verdict replays recorded
// runs (pool-balance-counts-the-remainder.answers.json), each read by pool-balance-counts-the-remainder.mjs collect() in
// headless Chromium, the stand-in shell signed in with money at each pool's U_X, at 390 and 1440:
//   today: this card's build at APP_HOST's name (--harness), and the deployed SIGN_HOST's scripts as served, which name
//          deposit_wallets only in the kit's schema (the page fills none yet): every app read right, INCONCLUSIVE;
//   good:  the same record with SIGN_HOST's read as it reads once the page fills deposit_wallets (one use outside the
//          schema; planted, since no deployed page fills it yet): PASS;
//   bad:   the deployed APP_HOST at main 1496cde17, before the card: the pool rows and Cash leave the U_X money out and
//          the scripts hold no send rule: FAIL, whatever the page reads.
// Planted from the good run: a double count, a row that says remainder, a send rule missing, a width not run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { expected, judge } from "./pool-balance-counts-the-remainder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "pool-balance-counts-the-remainder.answers.json"), "utf8"));
const GOOD = { ...structuredClone(ANSWERS.today), page: { ...ANSWERS.today.page, named: ANSWERS.today.page.named + 1, uses: 1 } };
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(GOOD);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the account's own sums: each pool its notes and its U_X, Cash each pool at its price, rounded down per chain", () => {
  const w = expected(ANSWERS.today.account);
  assert.deepEqual(w.rows, { solana: "512500000", base: "12000000000000000", robinhood: "300000000000000" });
  // $12.34 + 0.5125 SOL at $150 ($76.87) + 0.012 ETH at $3,000 ($36.00) + 0.0003 ETH at $3,000 ($0.90)
  assert.equal(w.cash, "$126.11");
});

test("recorded today: the app right, the deployed page fills no deposit_wallets: INCONCLUSIVE, never PASS", () => {
  const r = judge(ANSWERS.today);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), []);
  assert.equal(ANSWERS.today.page.uses, 0);
  assert.ok(ANSWERS.today.page.read > 0 && ANSWERS.today.page.named >= 1, JSON.stringify(ANSWERS.today.page));
});

test("good: the same app reads and a page that fills deposit_wallets: PASS", () => {
  const r = judge(GOOD);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.ok, true);
});

test("recorded bad: main's deployed build leaves the U_X money out and holds no send rule: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: Portfolio's pool balances`)), `${w}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: Cash`)), `${w}\n${r.lines.join("\n")}`);
  }
  assert.ok(bad(r).some((l) => /the app's scripts: .*missing/.test(l)), r.lines.join("\n"));
  // a page that fills deposit_wallets does not save it
  assert.equal(judge({ ...ANSWERS.bad, page: GOOD.page }).verdict, "FAIL");
});

test("planted: a double count, a row that says remainder, a send rule missing, a width not run: FAIL", () => {
  fails(mut((rec) => (rec.runs[0].pools.rows.find((x) => x[0] === "solana")[1] = "525000000")), /phone: Portfolio's pool balances/);
  fails(mut((rec) => (rec.runs[1].cash = "$128.00")), /desktop: Cash/);
  fails(mut((rec) => (rec.runs[1].pools.text += " Remainder")), /desktop: the pool rows say/);
  fails(mut((rec) => (rec.scripts.found = rec.scripts.found.filter((w) => !w.includes("Robinhood")))), /missing "Send only ETH on Robinhood\."/);
  fails(mut((rec) => rec.runs.pop()), /1 run\(s\) of 2/);
  fails(mut((rec) => (rec.runs[0].framed = false)), /phone: not inside/);
  fails(mut((rec) => delete rec.account), /not recorded/);
});
