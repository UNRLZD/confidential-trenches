// node --test scripts/live-checks/app-trade-box-mount.test.mjs: the live check's verdict replays recorded runs
// (app-trade-box-mount.answers.json), each read on 3 Nov by app-trade-box-mount.mjs collect() in headless Chrome, signed
// out, HELPER_HOST live:
//   good: this card's build served at APP_HOST's name inside the stand-in shell (--build): at 1440 the right column holds the
//         box (— available, the exit plan off, Sign in to trade, S8.1) with the 12-cell grid under it matching the page's own
//         token read, and the button opens the sign-in sheet; at 390 the bar's Buy opens the sheet with the same box and
//         grid, and its button opens the sign-in sheet above it: PASS;
//         Recorded again on 12 Nov from the ui-parity tree's build (entry at 2026-11-12T22:37Z), on the token's own page,
//         app-sell-mount's PATH (the phone's / draws the Trenches list since UNRLZD parity), with the grid's first three
//         labels UNRLZD's (Top 10, Dev, Snipers) and the balance line `— available`: PASS;
//   bad:  APP_HOST's build before this card (card app-token-route's a3b7068): the right column is empty and the Buy button
//         opens nothing: FAIL.
// Planted from the good run: a balance of $0 or the old `Bal —`, a Buy button in place of Sign in to trade, an exit plan left on,
// a box left of the chart or outside its column, the grid above the Route & fees line, a wrong or missing grid cell, a token
// read for another token, a sheet outside the window, a sign-in sheet under the trade sheet or not opened.
// A page still filling (card trade-box-check-reads-a-filling-page): on 13 Nov 03:42Z, minutes after an app deploy, the live
// run read the desktop grid while the helper's quick token answer was the page's only one; the page drew its skeleton in
// the nine cells with no value and the check, which wanted a dash there, failed a correct deploy. That run kept no record
// (its log and shots only), so the filling cases are planted from the good run too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CELLS, expectedCells, judge, LOADS, SKELETON } from "./app-trade-box-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-trade-box-mount.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const some = (r, re) => assert.ok(bad(r.lines).some((l) => re.test(l)), r.lines.join("\n"));

test("recorded good answer: the box and its grid in the right column and in the phone sheet, the button opens sign-in: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.loads.length, LOADS.length);
  for (const l of ANSWERS.good.loads) {
    assert.equal(l.token.status, 200);
    assert.equal(l.token.rowMint, l.shown);
    assert.equal(l.signin.opened, true);
  }
  const desk = ANSWERS.good.loads[0].page.box;
  assert.equal(desk.cells.length, CELLS.length);
  assert.deepEqual([desk.state, desk.balance, desk.cta.text], ["S8.1", "— available", "Sign in to trade"]);
});

test("recorded bad answer: the build before this card (an empty right column, the Buy button opens nothing): FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  some(r, /^BAD desktop .*no trade box on the page/);
  some(r, /^BAD phone .*the Buy button did not open the trade sheet/);
});

test("planted: a balance of $0 (or the old Bal line), a Buy button and an exit plan left on each fail", () => {
  some(mut((rec) => { rec.loads[0].page.box.balance = "$0 available"; }), /the balance reads "\$0 available"/);
  some(mut((rec) => { rec.loads[0].page.box.balance = "Bal —"; }), /the balance reads "Bal —", not "— available"/);
  some(mut((rec) => { rec.loads[0].page.box.cta.text = "Buy DJT"; }), /the main button reads "Buy DJT"/);
  some(mut((rec) => { rec.loads[0].page.box.cta.disabled = true; }), /the main button is disabled/);
  some(mut((rec) => { rec.loads[0].page.box.exit.pressed = "true"; }), /the exit plan is not off/);
  some(mut((rec) => { rec.loads[0].page.box.state = "S8.3"; }), /not S8\.1/);
});

test("card app-orders-coming-soon: the block with Coming soon and no switch passes; Coming soon beside a switch, or other words, fail", () => {
  const soon = mut((rec) => {
    for (const l of rec.loads) for (const m of [l.page, l.sheet]) if (m?.box) Object.assign(m.box.exit, { text: "Exit plan Sells automatically once this buy fills Coming soon", pressed: null });
  });
  assert.equal(soon.ok, true, soon.lines.join("\n"));
  some(mut((rec) => { Object.assign(rec.loads[0].page.box.exit, { text: "Exit plan Sells automatically once this buy fills Coming soon", pressed: "false" }); }), /the exit plan is not off/);
  some(mut((rec) => { Object.assign(rec.loads[0].page.box.exit, { text: "Exit plan Coming soon", pressed: null }); }), /the exit plan block reads "Exit plan Coming soon"/);
});

test("planted: a box left of the chart, outside its column or the window, or a grid above the Route & fees line fails", () => {
  some(mut((rec) => { rec.loads[0].page.box.left = 100; }), /not to the right of the chart/);
  some(mut((rec) => { rec.loads[0].page.box.inColumn = false; }), /not inside the page's right column/);
  some(mut((rec) => { rec.loads[0].page.box.right = 1500; }), /outside the window/);
  some(mut((rec) => { rec.loads[0].page.box.gridTop = rec.loads[0].page.box.lineBottom - 40; }), /not under the Route & fees line/);
});

test("planted: a grid cell that is not what the token read holds, or a missing cell, fails", () => {
  some(mut((rec) => { rec.loads[0].page.box.cells[0].value = "99%"; }), /cell 0 \(Top 10\)/);
  some(mut((rec) => { rec.loads[0].page.box.cells[8].cross = !rec.loads[0].page.box.cells[8].cross; }), /cell 8 \(Mint auth\)/);
  some(mut((rec) => { rec.loads[0].page.box.cells[3].tone = "bad"; }), /cell 3 \(Holders\)/);
  some(mut((rec) => { rec.loads[0].page.box.cells[1].label = "Dev %"; }), /cell 1 \(Dev\)/);
  some(mut((rec) => { rec.loads[0].page.box.cells.pop(); }), /11 grid cells, not 12/);
  // the read the grid is held to changes: a token read that holds a tax makes a 0% cell wrong
  some(mut((rec) => { rec.loads[0].token.read.risk.tax = { buy_bps: 500, sell_bps: 500 }; }), /cell 7 \(Tax\)/);
});

/** The good run as a page still filling: the read holds no Jupiter field and says so, the page says so, and every cell
 *  with no value draws `empty` (the skeleton, as the page does). */
const fillingRun = (empty = SKELETON) => (rec) => {
  for (const l of rec.loads) {
    Object.assign(l.token, { filling: true });
    Object.assign(l.token.read.row, { top10_bps: null, dev_bps: null, snipers_bps: null, holders: null, liq_usd: null, created_s: null });
    const want = expectedCells(l.token.read);
    for (const m of [l.page, l.sheet]) {
      if (!m) continue;
      m.filling = true;
      if (m.box) m.box.cells = want.map((w) => ({ id: w.id, label: w.label, value: w.tone === "unknown" ? empty : m.box.cells.find((c) => c.id === w.id).value, cross: w.cross, tone: w.tone }));
    }
  }
};

test("a page still filling: the skeleton in every cell with no value passes, at both widths; the values the read holds are still held", () => {
  const r = mut(fillingRun());
  assert.equal(r.ok, true, r.lines.join("\n"));
  // the 03:42Z shape: nine skeleton cells, Tax and the two authorities drawn
  const rec = structuredClone(ANSWERS.good);
  fillingRun()(rec);
  assert.equal(rec.loads[0].page.box.cells.filter((c) => c.value === SKELETON).length, 9);
  some(mut((x) => { fillingRun()(x); x.loads[0].page.box.cells[7].value = "5.0%"; }), /cell 7 \(Tax\)/);
});

test("planted: a dash on a filling page, a skeleton on a filled page, and a page and a read that disagree on filling each fail", () => {
  some(mut(fillingRun("—")), /^BAD desktop .*cell 0 \(Top 10\)/);
  some(mut(fillingRun("—")), /^BAD phone .*sheet: cell 0 \(Top 10\)/);
  // a filled page (the good run: Snipers has no value, a dash) that draws the skeleton there
  some(mut((rec) => { rec.loads[0].page.box.cells[2].value = SKELETON; }), /cell 2 \(Snipers\)/);
  some(mut((rec) => { fillingRun()(rec); rec.loads[0].token.filling = false; }), /the page draws a filling row, its last token read is filled/);
  some(mut((rec) => { rec.loads[1].token.filling = true; }), /^BAD phone .*the page draws a filled row, its last token read is filling/);
});

test("planted: a token read that is not the page's token, a failed read, or a page left loading fails", () => {
  some(mut((rec) => { rec.loads[0].token.rowMint = "So11111111111111111111111111111111111111112"; }), /the token read's row is So111/);
  some(mut((rec) => { rec.loads[0].token.status = 503; }), /token read status 503/);
  assert.equal(mut((rec) => { rec.loads[0].state = "loading"; }).ok, false);
});

test("planted: on the phone, a box already on the page, a sheet outside the window, and a sign-in sheet under the trade sheet or not opened each fail", () => {
  some(mut((rec) => { rec.loads[1].page.box = structuredClone(rec.loads[1].sheet.box); }), /the page behind the sheet already draws a box/);
  some(mut((rec) => { rec.loads[1].sheet.right = 500; }), /the sheet is outside the window/);
  some(mut((rec) => { rec.loads[1].sheet.name = "Sell"; }), /the sheet's name is/);
  some(mut((rec) => { rec.loads[1].sheet.box.cta.text = "Buy"; }), /sheet: the main button reads/);
  some(mut((rec) => { rec.loads[1].signin.above = false; }), /not above the trade sheet/);
  some(mut((rec) => { rec.loads[1].signin.opened = false; }), /did not open the sign-in sheet/);
  some(mut((rec) => { rec.loads[0].signin.opened = false; }), /did not open the sign-in sheet/);
});

test("the grid's expected cells: percent, thresholds, authorities, tax, LP and honeypot from the token read's numbers alone", () => {
  const row = { top10_bps: 2298, dev_bps: 1000, snipers_bps: 1500, holders: 71294, liq_usd: "561882.088225", created_s: 1788976680, mint_auth: false, freeze_auth: true, launchpad: "pump.fun", curve_bps: 6400 };
  const risk = { insiders_bps: 4, tax: { buy_bps: 100, sell_bps: 500 }, lp: { class: "curve" }, honeypot: false };
  const c = Object.fromEntries(expectedCells({ row, risk }).map((x) => [x.id, x]));
  assert.deepEqual([c.top10.value, c.top10.tone, c.top10.cross], ["23%", "good", false]);
  assert.deepEqual([c.dev.value, c.dev.tone], ["10%", "warn"]);
  assert.deepEqual([c.snipers.value, c.snipers.tone], ["15%", "bad"]);
  assert.deepEqual([c.holders.value, c.liq.value], ["71.3K", "$561.9K"]);
  assert.deepEqual([c.insiders.value, c.insiders.tone], ["<0.1%", "plain"]);
  assert.deepEqual([c.tax.value, c.tax.tone], ["5.0%", "warn"]);
  assert.deepEqual([c.mintAuth.cross, c.mintAuth.tone, c.freezeAuth.cross, c.freezeAuth.tone], [false, "plain", true, "bad"]);
  assert.deepEqual([c.lp.value, c.honeypot.cross, c.honeypot.tone], ["Curve", false, "plain"]);
  // a token off its curve, no read of the rest: the dashes
  const none = Object.fromEntries(expectedCells({ row: { ...row, curve_bps: 10_000, mint_auth: null, created_s: null }, risk: {} }).map((x) => [x.id, x]));
  assert.deepEqual([none.lp.value, none.tax.value, none.insiders.value, none.honeypot.value, none.mintAuth.value, none.age.value], ["—", "—", "—", "—", "—", "—"]);
});
