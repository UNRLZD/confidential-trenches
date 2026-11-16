// node --test scripts/live-checks/deposit-sheet-reads-right-on-phone.test.mjs: the live check replays its recorded answers
// (deposit-sheet-reads-right-on-phone.answers.json, each read by deposit-sheet-reads-right-on-phone.mjs read() on the live
// hosts with a fresh $0 account, at 400 and 1440):
//   good: this card's build answering APP_HOST (--app-dir): Deposit's tap closes the phone trade sheet, one grab bar is
//         drawn, and Get address is off with no amount: PASS;
//   bad:  the build before it (card app-money-sheets-read-right, 8ebd11463, --app-dir): the deposit sheet over the open
//         trade sheet, two grab bars on the phone, and Get address on with no amount: FAIL.
// Planted from good: each fact taken away FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { coinOf, judge, WIDTHS } from "./deposit-sheet-reads-right-on-phone.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./deposit-sheet-reads-right-on-phone.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const planted = (f, widths = WIDTHS) => {
  const a = structuredClone(ANSWERS.good);
  for (const w of widths) f(a.widths[w]);
  return judge(a);
};

test("recorded good (this card's build, a fresh account on the live hosts): PASS at 400 and 1440", () => {
  const v = judge(ANSWERS.good);
  assert.deepEqual(bad(v), []);
  assert.equal(v.ok, true);
});

test("recorded bad (the build before this card): FAIL on the stacked sheets on the phone and Get address at both widths", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  const b = bad(v);
  assert.ok(b.some((l) => l.startsWith("BAD phone:") && l.includes("trade sheet")), b.join(" | "));
  assert.ok(b.some((l) => l.startsWith("BAD phone:") && l.includes("grab bars")), b.join(" | "));
  for (const w of WIDTHS) assert.ok(b.some((l) => l.startsWith(`BAD ${w}:`) && l.includes("Get address")), `${w}: ${b.join(" | ")}`);
});

test("planted from good: each fact taken away FAILs", () => {
  const cases = {
    "Buy, off": (r) => (r.cta = { text: "Buy GG", disabled: true }),
    "no deposit sheet": (r) => (r.depositOpen = false),
    "the trade sheet still open": (r) => (r.tradeOpen = true),
    "two grab bars": (r) => (r.grabs = 2),
    "grab bars not read": (r) => (r.grabs = null),
    "Get address on with no amount": (r) => (r.get.disabled = false),
    "Get address not drawn": (r) => (r.get = null),
    "an amount typed": (r) => (r.get.amount = "5"),
  };
  for (const [name, f] of Object.entries(cases)) for (const w of WIDTHS) assert.equal(planted(f, [w]).ok, false, `${name} @${w}`);
  assert.equal(planted((r) => (r.grabs = 0), ["phone"]).ok, false, "no grab bar on the phone");
  const one = structuredClone(ANSWERS.good);
  delete one.widths.phone;
  assert.equal(judge(one).ok, false, "a width not read");
});

test("coinOf: the first pump.fun mint of the Solana lists, trending first", () => {
  assert.equal(coinOf({ lists: { trending: [{ chain: "solana", token: "Abc" }, { chain: "solana", token: "Defpump" }], new: [{ chain: "solana", token: "Ghipump" }] } }), "Defpump");
  assert.equal(coinOf({ lists: { trending: [{ chain: "base", token: "0xpump" }] } }), null);
  assert.equal(coinOf(null), null);
});
