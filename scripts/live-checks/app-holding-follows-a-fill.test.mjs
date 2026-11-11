// node --test scripts/live-checks/app-holding-follows-a-fill.test.mjs: the live check replays its recorded answers
// (app-holding-follows-a-fill.answers.json). good: this card's build (apps/terminal/dist), the fills overlay in it:
// PASS. liveBefore: APP_HOST before this card's deploy (read 11 Nov 05:2xZ): FAIL, the three marks named. Planted on the
// good one: another script, no pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./app-holding-follows-a-fill.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./app-holding-follows-a-fill.answers.json", import.meta.url), "utf8"));
const NO_SHOWS = "BAD the app keeps no trade's own amount: what you hold waits for the holdings read";
const NO_BUY = "BAD a buy's Filled does not set what you hold: the Sell side waits for the buy's Final";
const NO_SELL = "BAD a sell's Filled does not set what you hold: a sold holding stays shown";

test("recorded good answer: this card's build, the fills overlay in it: PASS", () => {
  assert.deepEqual(judge(ANSWERS.good), { ok: true, lines: [] });
});

test("recorded bad answer liveBefore: APP_HOST before this card: FAIL, the three marks named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_SHOWS, NO_BUY, NO_SELL]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ app: { ...g.app, sha384: "sha384-other" } }).lines, ["BAD APP_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(judge({ app: { ...g.app, index: "<html></html>" } }).lines, ["BAD APP_HOST's index.html pins no script"]);
  assert.deepEqual(judge({ app: { ...g.app, shows: false } }).lines, [NO_SHOWS]);
  assert.deepEqual(judge({ app: { ...g.app, buy: false } }).lines, [NO_BUY]);
  assert.deepEqual(judge({ app: { ...g.app, sell: false } }).lines, [NO_SELL]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from the script, each mark its own code", () => {
  const js = "function a(e,t){let n=s(t??`0`,e.after);return n?e.side===`buy`?n.a>=n.b:n.a<=n.b:!0}x.note(o({id:d.id,side:`buy`,amount:d.amount,at:r},t.held));x.note(o({id:p.id,side:`sell`,amount:t.amount,at:q},t.held));";
  const f = facts({ index: "", js });
  assert.deepEqual([f.app.shows, f.app.buy, f.app.sell], [true, true, true]);
  // the vault's sell request (amount: its base units, an identifier) is no sell's fill
  assert.equal(facts({ index: "", js: "e(`buy`,{chain:c,token:t,side:`sell`,amount:o,slippage_bps:s})" }).app.sell, false);
  assert.equal(facts({ index: "", js: js.replace("n.a>=n.b:n.a<=n.b", "n.a>=n.b:n.a>=n.b") }).app.shows, false, "one rule for both sides is not the overlay's");
});
