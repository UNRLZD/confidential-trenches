// node --test scripts/live-checks/app-portfolio-mount.test.mjs: the live check's verdict replays recorded runs
// (app-portfolio-mount.answers.json), each read on 4 Nov by app-portfolio-mount.mjs collect() in headless Chromium, the
// stand-in shell sending the fixed signed-in account (ACCOUNT):
//   good: this card's build served at APP_HOST's name (--harness --build): /portfolio draws Portfolio at 390 and 1440,
//         dark and light, the header's balance is Portfolio's Total ($83.05), and Withdraw, Export, Deposit and Sell
//         go where they belong: PASS;
//   bad:  the deployed APP_HOST on 4 Nov 06:20Z, before this card: signed in, /portfolio draws nothing: FAIL.
// Planted from the good run: a header that differs from the Total, a Total that is not the account's, a tap that asks
// for the wrong kind, a Sell that opens something, an empty route, a missing run, a terminal outside the shell.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ACCOUNT, judge, TOTAL } from "./app-portfolio-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-portfolio-mount.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w, s) => rec.runs.find((r) => r.width === w && r.scheme === s);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the account's total is what the check expects: 40.50 + 7.25 + 20.12 + 10.12 + 3.06 + 2.00", () => {
  const cents = (s) => Math.round(Number(s) * 100);
  const sum = cents(ACCOUNT.vault_balance) + cents(ACCOUNT.pools.find((p) => p.asset === "USDC").balance) + ACCOUNT.wallets.reduce((a, w) => a + cents(w.size), 0) + ACCOUNT.positions.reduce((a, p) => a + cents(p.cost), 0);
  assert.equal(`$${(sum / 100).toFixed(2)}`, TOTAL);
});

test("recorded good answer: Portfolio at both widths and schemes, header = Total, every tap where it belongs: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const x of ANSWERS.good.runs) assert.equal(x.header, TOTAL, `${x.width} ${x.scheme}`);
});

test("recorded bad answer: the deployed app before this card draws nothing at /portfolio signed in: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop dark: \/portfolio draws no Portfolio/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone light: \/portfolio draws no Portfolio/.test(l)), r.lines.join("\n"));
});

test("planted: a header that differs from Portfolio's Total fails, and so does a Total that is not the account's", () => {
  fails(mut((rec) => (run(rec, "desktop", "dark").header = "$75.81")), /^BAD desktop dark: the header's balance \$75\.81, Portfolio's Total \$83\.05/);
  fails(mut((rec) => Object.assign(run(rec, "phone", "light"), { total: "7581", header: "$75.81" })), /^BAD phone light: the header's balance \$75\.81, Portfolio's Total \$75\.81, the account's total \$83\.05/);
});

test("planted: a tap that asks for the wrong kind, or a Sell that opens something, fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "dark").taps.withdraw = "signout")), /^BAD desktop dark: Withdraw asks the shell for signout/);
  fails(mut((rec) => (run(rec, "phone", "dark").taps.export = "backup.open")), /^BAD phone dark: Export asks the shell for backup\.open/);
  fails(mut((rec) => (run(rec, "phone", "dark").taps.deposit = null)), /^BAD phone dark: Deposit opens nothing/);
  fails(mut((rec) => (run(rec, "desktop", "dark").taps.sell = "a sheet")), /^BAD desktop dark: Sell opens a sheet/);
});

test("planted: an empty route, a missing run, or a terminal outside the shell fails", () => {
  fails(mut((rec) => Object.assign(run(rec, "phone", "dark"), { screen: null, state: null, text: 0 })), /^BAD phone dark: \/portfolio draws no Portfolio/);
  fails(mut((rec) => (run(rec, "desktop", "light").state = "S10.1")), /^BAD desktop light: \/portfolio draws Portfolio in S10\.1/);
  fails(mut((rec) => rec.runs.pop()), /^BAD 3 run\(s\) of 4/);
  fails(mut((rec) => (run(rec, "desktop", "dark").framed = false)), /^BAD desktop dark: not inside SIGN_HOST's shell/);
});
