// node --test scripts/live-checks/token-page-fills-after.test.mjs: the live check's verdict replays recorded runs
// (token-page-fills-after.answers.json), each read on 6 Nov by token-page-fills-after.mjs collect() in headless Chrome,
// APP_HOST framed by the stand-in shell signed out, the token reads answered by the check, at 390 and 1440, and the
// helper's page of its top Trending token read live:
//   good: this card's build at APP_HOST's name (--harness --build) and this card's helper (--helper, run beside it):
//         fill: the symbol with the price loading, a second read 5 s later, the price drawn, no third read; unlisted:
//         the dash, no skeleton, read again at 5 s; the helper's Jupiter page filling false: PASS;
//   bad:  the deployed APP_HOST and helper on 6 Nov, before this card: fill: the dash, never read again; unlisted: never
//         read again; the helper's page has no filling: FAIL.
// Planted from the good run: no data-filling, the price drawn as a dash at first, a second read too soon or too late, a
// third read, the price still loading after, a skeleton on the unlisted page, an unlisted page not read again, the
// helper's filling true or absent, a page error, a missing shot, a missing run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./token-page-fills-after.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "token-page-fills-after.answers.json"), "utf8"));
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

test("recorded good answer: both widths, the name with the price loading, a read 5 s later fills it, reading stops: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 2);
});

test("recorded bad answer: the deployed app before this card draws the dash and never reads again: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /data-filling absent, price "—"/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /second token read never made/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD unlisted .*second token read never made/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD helper: .*filling "absent"/.test(l)), r.lines.join("\n"));
});

test("planted: no filling mark, a dash at first, a read too soon or late, a third read, still loading, an error, a missing shot or run fail", () => {
  fails(planted((r) => (r.runs[0].first.filling = null)), /data-filling absent/);
  fails(planted((r) => Object.assign(r.runs[1].first, { priceLoading: false, price: "—" })), /price "—"/);
  fails(planted((r) => (r.runs[0].readsAt = [0, 1_000])), /1000 ms after the first/);
  fails(planted((r) => (r.runs[1].readsAt = [0, 9_000])), /9000 ms after the first/);
  fails(planted((r) => (r.runs[0].readsAt = [0, 5_000, 10_000])), /3 token read/);
  fails(planted((r) => Object.assign(r.runs[1].after, { filling: "true", priceLoading: true, price: null })), /after it: data-filling true, price loading/);
  fails(planted((r) => (r.runs[0].first.symbol = null)), /symbol null/);
  fails(planted((r) => r.runs[0].errors.push("TypeError: x")), /page errors/);
  fails(planted((r) => delete r.runs[1].shots.filled), /screenshot missing/);
  fails(planted((r) => r.runs.pop()), /run\(s\) of 2/);
  fails(planted((r) => Object.assign(r.unlisted[0].first, { filling: "true", priceLoading: true, price: null })), /unlisted phone: data-filling true, price loading/);
  fails(planted((r) => (r.unlisted[1].readsAt = [0])), /unlisted desktop: second token read never made/);
  fails(planted((r) => r.unlisted.pop()), /unlisted: 1 run\(s\) of 2/);
  fails(planted((r) => (r.helper.reads.at(-1).filling = true)), /helper: .*filling true/);
  fails(planted((r) => (r.helper.reads.at(-1).src = "chain")), /helper: .*src "chain"/);
  fails(planted((r) => (r.helper = {})), /helper: .*not read/);
  fails({ runs: [] }, /run\(s\) of 2/);
});
