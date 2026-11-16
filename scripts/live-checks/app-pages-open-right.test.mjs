// node --test scripts/live-checks/app-pages-open-right.test.mjs: the live check's verdict replays recorded runs
// (app-pages-open-right.answers.json), each read on 16 Nov by app-pages-open-right.mjs collect() in headless Chromium,
// the stand-in shell signed in:
//   good: this card's build at APP_HOST's name (--harness --build): every page opens at its top, Back puts Trenches back,
//         the paths with nothing to draw keep their address and link to Trenches, no Account row filled: PASS;
//   bad:  the build before this card (main at 6df1ca4e2, --harness --build): the token page and Portfolio open where
//         the last page was scrolled, an unknown path goes to "/", the bad tokens have no way back, Sign out is filled
//         under the pointer: FAIL.
// Planted from the good run: each of those one at a time, a run that never scrolled, a missing width.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, NOWHERE } from "./app-pages-open-right.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-pages-open-right.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const run = (rec, w) => rec.runs.find((r) => r.width === w);
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: pages open at their top, Back keeps Trenches, a way back from nowhere, no filled row: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) assert.deepEqual(run(ANSWERS.good, w).nowhere.map((x) => x.path), NOWHERE);
});

test("recorded bad answer: the build before this card: FAIL on every item", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  const has = (re) => assert.ok(b.some((l) => re.test(l)), `${re}\n${r.lines.join("\n")}`);
  has(/^BAD phone Trenches row to its token page: .*the token page opened \d+ px down/);
  has(/^BAD phone Discover to the Portfolio tab: .*Portfolio opened \d+ px down/);
  has(/^BAD phone \/nope\/not-a-route: the address moved to \//);
  has(/^BAD desktop \/nope\/not-a-route: the address moved to \//);
  has(/^BAD phone \/token\/eth\/abc: no way back/);
  has(/^BAD desktop \/token\/solana\/notarealmint: no way back/);
  has(/^BAD phone Account rows, .*acct-signout filled/);
});

test("planted: a page that opens part way down fails, and so does Back that loses the list's place", () => {
  fails(mut((rec) => (run(rec, "phone").toToken.after = 640)), /^BAD phone Trenches row to its token page: the token page opened 640 px down/);
  fails(mut((rec) => (run(rec, "phone").toToken.back = 0)), /^BAD phone Trenches row to its token page: Back put Trenches at 0 px/);
  fails(mut((rec) => (run(rec, "phone").toPortfolio.after = 310)), /^BAD phone Discover to the Portfolio tab: Portfolio opened 310 px down/);
});

test("planted: a run that never scrolled proves nothing and fails", () => {
  fails(mut((rec) => (run(rec, "phone").toToken.before = 0)), /Trenches scrolled only 0 px before the tap/);
  fails(mut((rec) => (run(rec, "phone").toPortfolio.before = 12)), /Discover scrolled only 12 px before the tap/);
});

test("planted: a tap that draws no token page fails", () => {
  fails(mut((rec) => (run(rec, "phone").toToken.page = "empty")), /the tap drew token \(empty\), not its token page/);
});

test("planted: nowhere with no state, no link, a moved address or a link that lands elsewhere fails", () => {
  const at = (rec, w, p) => run(rec, w).nowhere.find((x) => x.path === p);
  fails(mut((rec) => (at(rec, "phone", "/nope/not-a-route").state = null)), /^BAD phone \/nope\/not-a-route: drew notfound with no not-found state/);
  fails(mut((rec) => (at(rec, "desktop", "/token/eth/abc").home = null)), /^BAD desktop \/token\/eth\/abc: no way back \(no link\)/);
  fails(mut((rec) => (at(rec, "phone", "/token/solana/notarealmint").landed = "/token/solana/notarealmint")), /its link landed on \/token\/solana\/notarealmint/);
  fails(mut((rec) => (run(rec, "desktop").nowhere = run(rec, "desktop").nowhere.filter((x) => x.path !== "/token/eth/abc"))), /^BAD desktop \/token\/eth\/abc: not read/);
});

test("planted: a filled Account row, no rows or no Sign out fails", () => {
  fails(mut((rec) => (run(rec, "phone").account.rows.at(-1).fill = "rgb(26, 26, 26)")), /acct-signout filled rgb\(26, 26, 26\) with no tap/);
  fails(mut((rec) => (run(rec, "phone").account.rows = [])), /no Account rows drawn/);
  fails(mut((rec) => (run(rec, "phone").account.rows = run(rec, "phone").account.rows.filter((x) => x.control !== "acct-signout"))), /no Sign out row/);
});

test("planted: a missing width or the shell not around the app fails", () => {
  fails(mut((rec) => rec.runs.pop()), /^BAD 1 run\(s\) of 2/);
  fails(mut((rec) => (run(rec, "phone").framed = false)), /^BAD phone: not inside SIGN_HOST's shell/);
});
