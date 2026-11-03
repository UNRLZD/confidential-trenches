// node --test scripts/live-checks/app-no-test-token.test.mjs: the live check's verdict replays recorded runs
// (app-no-test-token.answers.json), each read on 2026-11-03 by app-no-test-token.mjs collect() in headless Chromium:
//   good: this card's build served at APP_HOST's name inside the stand-in shell (--build), HELPER_HOST answered live:
//         / at 1440 and 390 and /?fx=curve draw the top Trending token of the lists each page read: PASS;
//   bad:  APP_HOST as deployed before this card (the fixture source): its JS holds GlowFixtureCurve and the other
//         fixture ids, the page draws the fixture token G1owFixtureCurve... and reads no lists: FAIL.
// Planted from the good run: a script holding a fixture id, a page token other than the top, a failed lists read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LISTS_URL, LOADS, topOf, TOKEN_URL } from "./app-no-test-token.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-no-test-token.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: / at both widths and /?fx=curve draw the lists' top Trending token, no fixture in the JS: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.loads.length, LOADS.length);
  for (const l of ANSWERS.good.loads) {
    const top = topOf(l.lists.trending);
    assert.equal(l.lists.url, LISTS_URL);
    assert.equal(l.shown, top);
    assert.equal(`${l.token.url}?chain=${l.token.chain}&token=${l.token.mint}`, TOKEN_URL(top));
    assert.ok(l.scripts.length > 0 && l.scripts.every((s) => s.hits === 0));
    assert.ok(r.lines.includes(`ok  ${l.width} ${l.path}: ready, data-token ${top} (${l.symbol}) = the top of Trending in the lists it read (200), its token read 200 for that mint`), r.lines.join("\n"));
  }
});

test("recorded bad answer: the deployed fixture source (GlowFixtureCurve in the JS, the fixture token drawn, no lists read): FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /desktop \/: the served JS .* fixture hit\(s\): .*G1owFixtureCurve/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/: .*data-token G1owFixtureCurve1111111111111111111111pump is a fixture/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/: .*the page read no lists answer/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/\?fx=curve: /.test(l)), r.lines.join("\n"));
});

test("planted: one script holding a fixture id fails the JS line", () => {
  const r = mut((rec) => {
    rec.loads[0].scripts[0].hits = 1;
    rec.loads[0].scripts[0].samples = ["curve:`G1owFixtureCurve1111"];
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD desktop \/: the served JS .*1 fixture hit/.test(l)), r.lines.join("\n"));
});

test("planted: a page token other than the lists' top fails, and so does a page left loading", () => {
  const other = mut((rec) => {
    rec.loads[1].shown = rec.loads[1].lists.trending.at(-1).mint;
  });
  assert.equal(other.ok, false);
  assert.ok(bad(other.lines).some((l) => /^BAD phone \/: data-token \S+, the lists' top Trending token is/.test(l)), other.lines.join("\n"));
  const loading = mut((rec) => {
    rec.loads[0].state = "loading";
  });
  assert.equal(loading.ok, false);
});

test("planted: a failed lists read or a token read for another mint fails", () => {
  const lists = mut((rec) => {
    rec.loads[0].lists.status = 503;
  });
  assert.ok(bad(lists.lines).some((l) => /lists status 503/.test(l)), lists.lines.join("\n"));
  const token = mut((rec) => {
    rec.loads[2].token.rowMint = "So11111111111111111111111111111111111111112";
  });
  assert.ok(bad(token.lines).some((l) => /^BAD desktop \/\?fx=curve: token row So111/.test(l)), token.lines.join("\n"));
});
