// node --test scripts/live-checks/app-orders-coming-soon.test.mjs: the live check's verdict replays recorded answers
// (app-orders-coming-soon.answers.json), each read on 10 Nov 2026 by app-orders-coming-soon.mjs collect():
//   good: this card's terminal build (vite build, read from disk): Coming soon at each of the nine orders places, the
//         My orders label, the tabs' empty-state rule, and no exit plan switch, Add exit plan button or order tab
//         drawn off: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: no Coming soon anywhere, the switch, the button and
//         the four order tabs drawn off: FAIL.
// Planted from the good answer: one place without its mark, an order control back, the words gone, a script or a
// stylesheet the host did not answer. The patterns are read on the minified and the source forms.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksOf, PLACES, refsOf, soonRuleIn } from "./app-orders-coming-soon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-orders-coming-soon.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const some = (r, re) => assert.ok(!r.ok && bad(r.lines).some((l) => re.test(l)), r.lines.join("\n"));

test("recorded good answer: this card's build says Coming soon at every orders place, with no order control: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const p of PLACES) assert.ok(ANSWERS.good.js.some((f) => f.marks[`place:${p}`] > 0), p);
});

test("recorded bad answer: APP_HOST before this card has no Coming soon and its order controls: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  some(r, /no Coming soon at: buy-limit, buy-tpsl, buy-exit, sell-limit, sell-tpsl, token-orders, portfolio-exit, portfolio-sheet-exit, orders/);
  some(r, /an order control is still drawn: the exit plan switch \(1\), the Add exit plan button \(2\), an order tab drawn off \(4\)/);
});

test("planted: each place without its mark, each order control back, the words or the rule gone, a file not answered, fail", () => {
  for (const p of PLACES) some(mut((rec) => { for (const f of rec.js) f.marks[`place:${p}`] = 0; }), new RegExp(`no Coming soon at: ${p}$`));
  some(mut((rec) => { rec.js[0].marks.exitSwitch = 1; }), /the exit plan switch \(1\)/);
  some(mut((rec) => { rec.js[0].marks.addExit = 1; }), /the Add exit plan button \(1\)/);
  some(mut((rec) => { rec.js[0].marks.tabOff = 2; }), /an order tab drawn off \(2\)/);
  some(mut((rec) => { rec.js[0].marks.words = 0; }), /hold the words "Coming soon" \(0\)/);
  some(mut((rec) => { rec.js[0].marks.soonEl = 5; }), /in 5 places, at least 6/);
  some(mut((rec) => { rec.js[0].marks.myOrders = 0; }), /"My orders"/);
  some(mut((rec) => { rec.css[0].rule = false; }), /\.trb-soon/);
  some(mut((rec) => { rec.js[0].status = 404; }), /script\(s\) named by the page/);
  some(mut((rec) => { rec.css = []; }), /0 stylesheet\(s\)/);
});

test("the patterns: the minified and the source forms; the route id alone is not the Orders place", () => {
  const min = 'k(`span`,{className:`addx`,"data-testid":`orders-soon`,"data-place":`portfolio-exit`}),soon:K(`Coming soon`,`x`),{id:`orders`,path:`/orders`}';
  const m = marksOf(min);
  assert.equal(m.words, 1);
  assert.equal(m.soonEl, 1);
  assert.equal(m["place:portfolio-exit"], 1);
  assert.equal(m["place:orders"], 0, "a route id is not the Orders place");
  assert.equal(marksOf('<div data-testid="orders-soon" data-place="orders">')["place:orders"], 0, "an HTML attribute is not the JSX object form");
  assert.equal(marksOf('{"data-testid": "orders-soon", "data-place": "orders"}')["place:orders"], 1);
  assert.equal(marksOf('(0,U.jsx)(`button`,{type:`button`,role:`tab`,className:`trb-tab`,"aria-selected":`false`,disabled:!0,children:x})').tabOff, 1);
  assert.equal(marksOf('{className:"trb-tab", "aria-selected": "false", disabled: true}').tabOff, 1);
  assert.equal(marksOf('{className:`trb-tab`,"aria-selected":e===`limit`,disabled:t&&e!==`limit`}').tabOff, 0, "a live tab is not one drawn off");
  assert.equal(marksOf('"data-control":`exit`,onClick').addExit, 1);
  assert.equal(marksOf("(0,U.jsx)(W,{id:`addExit`})").addExit, 1);
  assert.equal(marksOf("addExit:W(`Add exit plan`,`x`)").addExit, 0, "the word kept in its table is not drawn");
  assert.equal(soonRuleIn(".a{top:0}.trb-soon{min-height:200px}"), true);
  assert.equal(soonRuleIn("/* .trb-soon{} */.trb-soonTag{flex:none}"), false);
  assert.deepEqual(refsOf('<script type="module" crossorigin src="/assets/a.js" integrity="x"></script><link rel="stylesheet" href="/assets/a.css">'), { js: ["/assets/a.js"], css: ["/assets/a.css"] });
});
