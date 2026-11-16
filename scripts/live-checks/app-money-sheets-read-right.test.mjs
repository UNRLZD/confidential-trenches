// node --test scripts/live-checks/app-money-sheets-read-right.test.mjs: the live check replays its recorded answers
// (app-money-sheets-read-right.answers.json, each read by app-money-sheets-read-right.mjs read() on the live hosts with a
// fresh $0 account, at 390 and 1440):
//   good: this card's build answering APP_HOST (--app-dir), SIGN_HOST and the helper live: 5 typed, the main button is
//         Deposit, on; the list was asked before its tap; the sheet fills; Min at 2 decimals; Withdraw labels From,
//         draws no deposit risk line and Max 0 USDC in the line's tone: PASS;
//   bad:  APP_HOST as deployed before this card: Buy, off, no Deposit; the sheet (opened from the header, cold) draws
//         Min with six decimals; Withdraw's row has no label, the deposit risk line, and the 0 lifted: FAIL.
// Planted from good: each fact taken away FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { coinOf, FILL_MAX_MS, judge, WIDTHS } from "./app-money-sheets-read-right.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./app-money-sheets-read-right.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const planted = (f) => {
  const a = structuredClone(ANSWERS.good);
  for (const w of WIDTHS) f(a.widths[w]);
  return judge(a);
};

test("recorded good (this card's build, a fresh account on the live hosts): PASS at 390 and 1440", () => {
  const v = judge(ANSWERS.good);
  assert.deepEqual(bad(v), []);
  assert.equal(v.ok, true);
});

test("recorded bad (APP_HOST before this card): FAIL on items 7, 11, 12 and 13 at both widths", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  for (const w of WIDTHS) {
    const b = bad(v).filter((l) => l.startsWith(`BAD ${w}:`));
    for (const item of ["item 7", "item 11", "item 12", "item 13"]) assert.ok(b.some((l) => l.includes(item)), `${w} ${item}: ${b.join(" | ")}`);
  }
});

test("planted from good: each fact taken away FAILs", () => {
  const cases = {
    "Buy, off": (r) => (r.cta = { text: "Buy GG", disabled: true }),
    "Deposit, off": (r) => (r.cta.disabled = true),
    "no sheet": (r) => (r.opened = false),
    "asked at the tap": (r) => delete r.askedBeforeTap,
    "never filled": (r) => (r.fillMs = null),
    "filled past the read's deadline": (r) => (r.fillMs = FILL_MAX_MS + 1),
    "six decimals": (r) => (r.min.shown = "1.015576"),
    "under the minimum": (r) => (r.min.shown = "1.01"),
    "no From": (r) => (r.withdraw.fromLabel = null),
    "the risk line on Withdraw": (r) => (r.withdraw.notice = true),
    "the zero lifted": (r) => (r.withdraw.max.lifted = true),
    "money in the account": (r) => (r.balance = "$5.00 available"),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(planted(f).ok, false, name);
  const one = structuredClone(ANSWERS.good);
  delete one.widths.phone;
  assert.equal(judge(one).ok, false, "a width not read");
});

test("coinOf: the first pump.fun mint of the Solana lists, trending first", () => {
  assert.equal(coinOf({ lists: { trending: [{ chain: "solana", token: "Abc" }, { chain: "solana", token: "Defpump" }], new: [{ chain: "solana", token: "Ghipump" }] } }), "Defpump");
  assert.equal(coinOf({ lists: { trending: [{ chain: "base", token: "0xpump" }] } }), null);
  assert.equal(coinOf(null), null);
});
