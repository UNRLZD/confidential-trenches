// node --test scripts/live-checks/app-pool-withdraw.test.mjs: the live check's verdict replays recorded runs
// (app-pool-withdraw.answers.json), each read by app-pool-withdraw.mjs collect() in headless Chromium, APP_HOST framed by
// the stand-in shell signed in with POOLS, at 390 and 1440, the shell refusing pool.withdraw and opening it:
//   good:   the deployed APP_HOST at release 146, read 15 Nov 01:45Z: Withdraw on for Solana and Base, off for the empty
//           Robinhood pool; Base's row opens the app's form on Base and hands the shell no open; the form's Withdraw asks
//           one pool.withdraw {amount, chain, id, return_key, to, type, v}; refused draws its line under the form and
//           unlocks, opened closes the form and holds the controls: PASS;
//   noLine: release 146's terminal built with the form's HopLine taken out (15 Nov, --harness): a refused withdraw
//           drawn nowhere: FAIL;
//   bad:    the deployed APP_HOST on 4 Nov, before card app-pool-withdraw: no pool row Withdraw, nothing asked: FAIL.
// Planted from the good run: the row's tap handing the shell an open or an amount, the form not opened or on another
// chain, a dest, another address or amount, another chain or two requests from the form's Withdraw, the empty pool's
// Withdraw on, a pool row pushed out of its panel, the refused line missing, the refused form closed, a line on an opened
// run, an opened form left up, a refused control left locked, an opened control unlocked before the shell's screen, a
// missing run.
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

test("recorded good answer: release 146 live, both widths, refused and opened, the form's request, each answer drawn: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 4);
});

test("recorded no-line answer: a refused withdraw the form draws nowhere: FAIL", () => {
  const r = judge(ANSWERS.noLine);
  assert.equal(r.ok, false, r.lines.join("\n"));
  const b = bad(r);
  assert.equal(b.length, 2, r.lines.join("\n"));
  assert.ok(b.every((l) => /refused: the answer drawn no line/.test(l)), r.lines.join("\n"));
});

test("recorded bad answer: the deployed app before card app-pool-withdraw has no pool row Withdraw: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /pool Withdraw on/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /asks the shell nothing/.test(l)), r.lines.join("\n"));
});

test("planted: the row's tap handing the shell an open or a typed field, or no form on Base, fails", () => {
  fails(planted((r) => r.runs[0].row.push({ ...r.runs[0].asked[0] })), /row Withdraw/);
  fails(planted((r) => r.runs[1].row.push({ v: 1, id: "x", type: "withdraw.open" })), /row Withdraw/);
  fails(planted((r) => (r.runs[2].row[1].origin_asset = "nep141:usdc")), /row Withdraw/);
  fails(planted((r) => (r.runs[3].form = null)), /opens no app Withdraw/);
  fails(planted((r) => (r.runs[0].form = "solana")), /row Withdraw/);
  fails(planted((r) => delete r.runs[0].row), /requests unread/);
});

test("planted: a dest, another address, amount or chain, or two requests from the form fail", () => {
  fails(planted((r) => (r.runs[0].asked[0].dest = "solana")), /form's Withdraw asks/);
  fails(planted((r) => (r.runs[1].asked[0].to = "0x00000000000000000000000000000000000dEaD1")), /form's Withdraw asks/);
  fails(planted((r) => (r.runs[2].asked[0].amount = "0.01")), /form's Withdraw asks/);
  fails(planted((r) => (r.runs[3].asked[0].chain = "solana")), /form's Withdraw asks/);
  fails(planted((r) => r.runs[3].asked.push(r.runs[3].asked[0])), /form's Withdraw asks/);
  fails(planted((r) => (r.runs[0].asked[0].return_key = "deposit")), /form's Withdraw asks/);
  fails(planted((r) => (r.runs[0].asked = [])), /form's Withdraw asks the shell nothing/);
});

test("planted: the empty pool's Withdraw on, an answer not drawn, a locked control, a missing run fail", () => {
  fails(planted((r) => (r.runs[0].on.robinhood = true)), /pool Withdraw on/);
  const refused = ANSWERS.good.runs.findIndex((x) => x.shell === "refused");
  const opened = ANSWERS.good.runs.findIndex((x) => x.shell === "opened");
  fails(planted((r) => (r.runs[refused].line = null)), /the answer drawn no line/);
  fails(planted((r) => (r.runs[refused].sheet = false)), /the form closed/);
  fails(planted((r) => (r.runs[opened].line = "refused")), /the answer drawn line refused/);
  fails(planted((r) => (r.runs[opened].sheet = true)), /the form up/);
  fails(planted((r) => (r.runs[refused].unlocked = false)), /still locked/);
  fails(planted((r) => (r.runs[opened].unlocked = true)), /control unlocked/);
  fails(planted((r) => r.runs.pop()), /run\(s\) of 4/);
  fails(planted((r) => (r.runs[0].framed = false)), /not inside/);
  fails(planted((r) => (r.runs[refused].inside = false)), /a pool row outside its panel/);
});
