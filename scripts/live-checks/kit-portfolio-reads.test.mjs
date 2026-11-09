// node --test scripts/live-checks/kit-portfolio-reads.test.mjs: the live check's verdict on its recorded answers, with
// no network. Each record is a real run of the check (9 Nov 2026):
// - good: this card's build (--local: build-app from the branch's sources) served at / and /app.js: PASS;
// - bad_live_before: SIGN_HOST before this card's release, whose ops carry id, kind, stage and txs only: FAIL on the
//   three marks alone;
// - and the good record with its integrity naming another script, and with each mark gone: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as check from "./kit-portfolio-reads.mjs";
import { FILL, judge, localFetch, probe, SELL, SIGN_ORIGIN, TRADE } from "./kit-portfolio-reads.mjs";
import { copyChange, plantedFetch } from "./planted-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "kit-portfolio-reads.answers.json"), "utf8"));
const BAD = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
const FILL_LINE = "/app.js sends each op's time, chain, token, units and USD size its record holds";
const SELL_LINE = "/app.js keeps a pool sell's chain, token and units on its record";
const TRADE_LINE = "/app.js keeps a trade's chain, token and a buy's USD size on its record";
const SAME = "/app.js is the script / names: its sha384 is the integrity";

test("the recorded good answer (the card's build) passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.deepEqual(answers.good.app.marks, { fill: 1, sell: 1, trade: 1 });
});

test("the recorded live SIGN_HOST before the release fails, on the three marks alone", () => {
  assert.equal(answers.bad_live_before.url, SIGN_ORIGIN);
  assert.equal(judge(answers.bad_live_before).pass, false);
  assert.deepEqual(BAD(answers.bad_live_before), [FILL_LINE, SELL_LINE, TRADE_LINE]);
});

test("the good script under a page whose integrity names another script fails; each mark gone fails", () => {
  const other = structuredClone(answers.good);
  other.index.integrity = answers.bad_live_before.index.integrity;
  assert.deepEqual(BAD(other), [SAME]);
  for (const [k, line] of [["fill", FILL_LINE], ["sell", SELL_LINE], ["trade", TRADE_LINE]]) {
    const gone = structuredClone(answers.good);
    gone.app.marks[k] = 0;
    assert.deepEqual(BAD(gone), [line], k);
  }
});

test("the build of this tree passes the live rule", async () => {
  const rec = await probe(SIGN_ORIGIN, localFetch);
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
});

test("a rebuilt bundle with an unrelated copy change passes with no re-record; one whose op reader sends no detail, or whose records keep none, fails", async () => {
  const copy = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => copyChange(js, [FILL, SELL, TRADE])));
  assert.equal(judge(copy).pass, true, judge(copy).lines.join("\n"));
  // the walk copies nothing (the record's value never set on the op), the build before this card
  const none = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => {
    const m = new RegExp(FILL.source).exec(js);
    const end = m.index + m[0].length;
    const set = /&&\([\w$]+\[[\w$]+\]=[\w$]+\[[\w$]+\]\)$/.exec(m[0])[0];
    return js.slice(0, end - set.length) + js.slice(end);
  }));
  assert.equal(none.app.marks.fill, 0);
  assert.deepEqual(BAD(none), [FILL_LINE]);
  // a pool sell's record with no units, a trade's with no USD size
  const sell = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(/,units:[\w$]+\(([\w$]+)\.amount,\1\.decimals\)/, "")));
  assert.deepEqual(BAD(sell), [SELL_LINE]);
  const trade = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(/,\.\.\.[\w$]+===`buy`\?\{amount_usd:[\w$]+\}:\{\}/, "")));
  assert.deepEqual(BAD(trade), [TRADE_LINE]);
});

test("the check has the shape scripts/ci/bundle-checks.mjs runs: read(fetch) on SIGN_HOST, then judge", async () => {
  assert.equal(typeof check.read, "function");
  const asked = [];
  const rec = await check.read((u, o) => (asked.push(new URL(String(u)).origin), localFetch(u, o)));
  assert.deepEqual([...new Set(asked)], [SIGN_ORIGIN]);
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
});
