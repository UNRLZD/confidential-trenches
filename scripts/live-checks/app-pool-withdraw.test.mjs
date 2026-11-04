// node --test scripts/live-checks/app-pool-withdraw.test.mjs: the live check's verdict replays recorded runs
// (app-pool-withdraw.answers.json), each read on 4 Nov by app-pool-withdraw.mjs collect() in headless Chromium, APP_HOST
// framed by the stand-in shell signed in with POOLS, at 390 and 1440, the shell refusing pool.withdraw and opening it:
//   good: this card's build at APP_HOST's name (--harness --build): Withdraw on for Solana and Base, off for the empty
//         Robinhood pool; Base's tap asks one pool.withdraw {chain, id, return_key, type, v}; refused draws its line,
//         opened draws none: PASS;
//   bad:  the deployed APP_HOST on 4 Nov, before this card: no pool row Withdraw, nothing asked: FAIL.
// Planted from the good run: an address or an amount in the request, another chain, two requests, the empty pool's
// Withdraw on, a pool row pushed out of its panel, the refused line missing, a line on an opened run, a control left locked, a missing run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./app-pool-withdraw.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-pool-withdraw.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const fails = (rec, re) => {
  const r = judge(rec);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};
const planted = (edit) => {
  const rec = structuredClone(ANSWERS.good);
  edit(rec);
  return rec;
};

test("recorded good answer: both widths, refused and opened, the chain only asked, each answer drawn: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 4);
});

test("recorded bad answer: the deployed app before this card has no pool row Withdraw: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /pool Withdraw on/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /asks the shell nothing/.test(l)), r.lines.join("\n"));
});

test("planted: an address, an amount, another chain or two requests fail", () => {
  fails(planted((r) => (r.runs[0].asked[0].address = "0x00000000000000000000000000000000000dEaD1")), /asks the shell/);
  fails(planted((r) => (r.runs[1].asked[0].amount = "0.01")), /asks the shell/);
  fails(planted((r) => (r.runs[2].asked[0].chain = "solana")), /asks the shell/);
  fails(planted((r) => r.runs[3].asked.push(r.runs[3].asked[0])), /asks the shell/);
  fails(planted((r) => (r.runs[0].asked[0].return_key = "deposit")), /asks the shell/);
});

test("planted: the empty pool's Withdraw on, an answer not drawn, a locked control, a missing run fail", () => {
  fails(planted((r) => (r.runs[0].on.robinhood = true)), /pool Withdraw on/);
  const refused = ANSWERS.good.runs.findIndex((x) => x.shell === "refused");
  const opened = ANSWERS.good.runs.findIndex((x) => x.shell === "opened");
  fails(planted((r) => (r.runs[refused].line = null)), /the answer drawn/);
  fails(planted((r) => (r.runs[opened].line = "refused")), /the answer drawn/);
  fails(planted((r) => (r.runs[opened].unlocked = false)), /still locked/);
  fails(planted((r) => r.runs.pop()), /run\(s\) of 4/);
  fails(planted((r) => (r.runs[0].framed = false)), /not inside/);
  fails(planted((r) => (r.runs[refused].inside = false)), /a pool row outside its panel/);
});
