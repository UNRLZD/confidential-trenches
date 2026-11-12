// node --test scripts/live-checks/portfolio-shows-pool-trades.test.mjs: the live check's verdict replays recorded answers
// (portfolio-shows-pool-trades.answers.json), each read on 2026-11-12 by portfolio-shows-pool-trades.mjs collect():
//   good: this card's two builds (the signing page's build-app.mjs and the terminal's vite build), read through
//         scripts/ci/bundle-checks.mjs buildFetch: each host's script is the one its page pins and holds each of its
//         marks: PASS;
//   bad:  SIGN_HOST and APP_HOST as deployed before this card (d97e984e), read over https: each script pinned, neither
//         holds one mark: FAIL.
// Planted from the good answer: a script that lost one mark (each in turn, on its host), a script the host did not
// answer, a script that is not the one its page pins or has no pin, a host read alone (its own deploy's run), no host
// at all. And the marks on the builds' own minified shapes,
// with the near misses they must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES, scriptsOf, sha384 } from "./portfolio-shows-pool-trades.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "portfolio-shows-pool-trades.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: both builds hold every mark: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const h of ["sign", "app"]) assert.deepEqual(new Set(ANSWERS.good[h].js.flatMap((f) => f.found)), new Set(NAMES[h]), h);
});

test("recorded bad answer: the hosts before this card hold none of them: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const h of ["sign", "app"]) assert.ok(bad(r.lines).includes(`BAD ${h}: the scripts lack: ${NAMES[h].join("; ")}`), r.lines.join("\n"));
});

test("planted: a script without any one mark fails, naming it and its host", () => {
  for (const h of ["sign", "app"])
    for (const n of NAMES[h]) {
      const r = mut((rec) => {
        for (const f of rec[h].js) f.found = f.found.filter((m) => m !== n);
      });
      assert.equal(r.ok, false, n);
      assert.ok(bad(r.lines).includes(`BAD ${h}: the scripts lack: ${n}`), r.lines.join("\n"));
    }
});

test("planted: a script the host did not answer, a page naming none, no host read; one host alone is its own run", () => {
  const miss = mut((rec) => void (rec.app.js[0].status = 404));
  assert.equal(miss.ok, false);
  assert.ok(bad(miss.lines).some((l) => /^BAD app: 1 script\(s\) named by the page, each answering 200$/.test(l)), miss.lines.join("\n"));
  assert.equal(mut((rec) => void (rec.sign.js = [])).ok, false);
  assert.equal(judge({ at: "x" }).ok, false);
  assert.equal(judge({ sign: ANSWERS.good.sign }).ok, true);
  assert.equal(judge({ app: ANSWERS.bad.app }).ok, false);
});

test("the marks on the builds' minified shapes, any quote; a near miss is no mark", () => {
  const sign = ["const ug=[`created_ms`,`chain`,`token`,`units`,`amount_usd`,`pool_amount`];", "{units:n.out,pool_amount:fk(n.spend,n.spendDecimals)}", "let l={units:fk(a,s),pool_amount:fk(o,9)}"].join(";");
  assert.deepEqual(marksIn("sign", sign), NAMES.sign);
  assert.deepEqual(marksIn("sign", sign.replaceAll("`", '"')), NAMES.sign);
  const app = ["c=th(e.pool_amount);e.kind===", '{"data-realized-asset":e.asset}'].join(";");
  assert.deepEqual(marksIn("app", app), NAMES.app);
  // the keys before this card, a buy with no SOL, a fill at another scale, the field never read, another attribute
  const near = ["[`created_ms`,`chain`,`token`,`units`,`amount_usd`]", "{units:n.out}", "pool_amount:fk(o,6)", "e.pool_amount", '{"data-realized":e.asset}'].join(";");
  assert.deepEqual(marksIn("sign", near), []);
  assert.deepEqual(marksIn("app", near), []);
});

test("planted: a script that is not the one its page pins, or has no pin, fails on its host, whatever marks it holds", () => {
  for (const h of ["sign", "app"]) {
    for (const pin of ["sha384-other", null]) {
      const r = mut((rec) => void (rec[h].js[0].integrity = pin));
      assert.equal(r.ok, false, `${h} ${pin}`);
      assert.deepEqual(bad(r.lines), [`BAD ${h}: not the script its page pins: ${ANSWERS.good[h].js[0].url}`], r.lines.join("\n"));
    }
    assert.equal(ANSWERS.good[h].js[0].integrity, ANSWERS.good[h].js[0].sha384, h);
    assert.equal(ANSWERS.bad[h].js[0].integrity, ANSWERS.bad[h].js[0].sha384, `${h}: the deployed host pins its own script`);
  }
});

test("the page's scripts: each script tag's src and its integrity; sha384 as an integrity attribute names it", () => {
  assert.deepEqual(scriptsOf('<script type="module" src="/app.js" integrity="sha384-x"></script><script>1</script><script src="/b.js"></script>'), [
    { src: "/app.js", integrity: "sha384-x" },
    { src: "/b.js", integrity: null },
  ]);
  assert.match(sha384("x"), /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.notEqual(sha384("x"), sha384("y"));
});
